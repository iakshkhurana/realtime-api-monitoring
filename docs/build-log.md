# Build log

How this project was put together, step by step, and why each piece looks the way it does. Read it top to bottom to understand the stack; each step matches one commit in `git log`.

---

## Step 1: Scaffold and architecture

**Commits:** `initial scaffold`, `architecture added`

Started with the docs: a README that describes the finished project, a requirements doc listing every piece with acceptance criteria, and an Excalidraw architecture diagram (`docs/architecture.excalidraw`, rendered to `docs/architecture.png`).

Writing the spec first fixed the decisions that everything else depends on:

- Port layout: API on 3000, Grafana on 3001 (not 3000, which the API takes), Prometheus 9090, Alertmanager 9093, cAdvisor 8080.
- Alert thresholds: p95 latency > 500 ms, 5xx ratio > 5 %.
- Everything provisioned from files, so `docker compose up` is the only setup command.

---

## Step 2: The API, instrumented

**Commit:** `feat(api): Express REST API in TypeScript with Prometheus instrumentation`

A small Express app in TypeScript under `api/src/`:

| File | What it does |
|---|---|
| `metrics.ts` | Creates one `prom-client` registry, turns on default runtime metrics, and defines the custom ones. |
| `middleware/metrics.ts` | Runs on every request. Starts a histogram timer, bumps the in-flight gauge, and records everything on `res.on('finish')`. |
| `routes/items.ts` | CRUD over an in-memory `Map`. Exists only to give the API real traffic to measure. |
| `routes/chaos.ts` | `/slow`, `/flaky` and `/cpu` endpoints that misbehave on demand. Without these there is no way to make an alert fire. |
| `app.ts` | Wires it up, plus `/health`, `/metrics`, a 404 handler and an error handler. |
| `server.ts` | Listens, and shuts down gracefully on `SIGTERM` so Docker stops don't drop requests. |

**Metrics exposed:** `collectDefaultMetrics()` gives about 30 series families for free (CPU, RSS, heap, GC, event loop lag, handles, fds). On top of that: `http_requests_total`, `http_request_duration_seconds`, `http_requests_in_flight`, `app_errors_total`, `app_items_in_store`.

**Decisions that matter:**

- **Route labels use the template, not the URL.** `GET /api/items/42` is labelled `route="/api/items/:id"`. Labelling by raw URL would create a new time series per item ID and blow up Prometheus memory. The middleware reads `req.baseUrl + req.route.path` after the handler ran.
- **Histogram buckets include 0.5.** The p95 alert threshold is 500 ms. `histogram_quantile` interpolates inside buckets, so putting the threshold exactly on a bucket boundary makes the alert accurate.
- **`/flaky` sends its 500 directly instead of `next(err)`.** When a sub-router hands an error back to the parent via `next()`, Express resets `req.baseUrl`, and the label would come out as `/flaky` instead of `/api/chaos/flaky`. Found this by reading how Express restores `baseUrl` on router exit.
- **`/metrics` and `/health` are excluded** from the HTTP metrics, otherwise Prometheus's own scrapes inflate the request rate.

**Dockerfile** is two stages: stage one installs everything and runs `tsc`; stage two copies only `dist/` and installs prod dependencies. The image runs as the unprivileged `node` user and has a `HEALTHCHECK` on `/health`.

---

## Step 3: Compose, Prometheus and cAdvisor

**Commit:** `feat: Docker Compose stack with Prometheus and cAdvisor`

`docker-compose.yml` gets `api`, `prometheus` and `cadvisor`. `prometheus/prometheus.yml` scrapes the API every 5 s and cAdvisor every 10 s.

**Decisions that matter:**

- **`name: api-monitoring` at the top of the compose file.** Compose normally derives the project name from the folder. cAdvisor labels every container with `com.docker.compose.project`, and the Grafana container panels filter on that label. A fixed name keeps the dashboard working no matter where the repo is cloned.
- **CPU and memory limits on the API container.** The memory alert is `working_set / spec_memory_limit`. With no limit, the denominator is 0 and the alert can never fire.
- **cAdvisor metrics are filtered with `metric_relabel_configs`.** cAdvisor exposes hundreds of series per container. Keeping only the five the dashboard and alerts use cuts Prometheus storage a lot.
- **cAdvisor is `privileged` with host mounts** for `/sys`, `/var/lib/docker` and `/dev/kmsg`. That's what it needs to read cgroup stats. Linux only; Docker Desktop gives partial data.
- `--web.enable-lifecycle` on Prometheus lets `make reload` push rule changes without a restart.

---

## Step 4: Grafana, provisioned

**Commit:** `feat(grafana): provisioned datasource and API overview dashboard`

Three files, all mounted read-only:

- `grafana/provisioning/datasources/prometheus.yml`: the Prometheus datasource with a **fixed `uid: prometheus`**. Dashboard JSON references datasources by uid, so without this the panels would come up "datasource not found".
- `grafana/provisioning/dashboards/dashboards.yml`: a file provider pointing at `/var/lib/grafana/dashboards`.
- `grafana/dashboards/api-overview.json`: 22 panels in four rows. Overview stats (rate, error %, p95, in-flight, uptime, firing alerts), traffic and latency time series, container CPU/memory/network from cAdvisor, Node.js heap and event loop.

The compose service sets `GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH` so the dashboard is the first thing you see after login, and `GF_USERS_ALLOW_SIGN_UP=false`.

The latency and error panels draw a red threshold band at the exact alert value, so you can see a chaos run cross the line before the alert goes to pending.

The dashboard JSON was generated from a script rather than hand-edited, so the panel grid is consistent. If you change it in the Grafana UI, export the JSON back into this file.

---

## Step 5: Rules, tests and Alertmanager

**Commit:** `feat(alerting): alert rules with promtool tests and Alertmanager Slack routing`

**Recording rules** (`prometheus/rules/recording.yml`) precompute request rate, 5xx ratio and p95 so the alert expressions stay readable and the dashboard and alerts use the same numbers.

**Alert rules** (`prometheus/rules/alerts.yml`):

| Alert | Fires when | For |
|---|---|---|
| `APIDown` | `up{job="api"} == 0` | 30 s |
| `APIHighLatencyP95` | p95 > 0.5 s | 1 m |
| `APIHighErrorRate` | 5xx ratio > 5 % **and** rate > 0.5 req/s | 1 m |
| `APIContainerHighCPU` | > 0.8 cores | 2 m |
| `APIContainerHighMemory` | > 85 % of limit | 2 m |

The `rate > 0.5` guard on the error alert stops one failed request during idle time from being "100 % errors". `clamp_min(..., 1e-9)` in the ratio avoids division by zero when there is no traffic.

**promtool unit tests** (`prometheus/tests/alerts.test.yml`) feed synthetic series into the rules and assert which alerts fire, including the exact rendered annotation text. They run with `make test-rules` in the Prometheus image, no running stack needed. Four cases: API down (pending vs firing), 20 % error ratio fires, healthy traffic stays quiet, all-slow traffic fires the latency alert with p95 = 975 ms.

**Alertmanager** (`alertmanager/alertmanager.yml`):

- Groups by `alertname, severity`; `group_wait 10s` so a burst becomes one message.
- A child route sends `severity=critical` to its own receiver with `repeat_interval: 15m`.
- An inhibit rule mutes a warning while the same alertname is critical.
- `send_resolved: true` so Slack gets the all-clear.
- `templates/slack.tmpl` formats the title (`[FIRING:2] APIHighErrorRate`) and body.

**The Slack webhook problem.** Alertmanager does not expand `${VAR}` in its config, and the webhook is a secret that must not be committed. Solution: `entrypoint.sh` writes `$SLACK_WEBHOOK_URL` to `/tmp/slack_webhook_url` and `exec`s Alertmanager; the config reads it with `api_url_file`. The compose service runs the script through `/bin/sh` so it doesn't depend on the file's execute bit, and `/tmp` is used because the image runs as `nobody` and can't write under `/etc`.

---

## Step 6: k6 load tests

**Commit:** `feat(k6): smoke, load and chaos tests with Makefile shortcuts`

k6 is a compose service under `profiles: ["loadtest"]`, so `docker compose up` doesn't start it; `make load` runs it on demand on the same network as the API.

| Script | What it does | Expected |
|---|---|---|
| `smoke.js` | 5 iterations hitting `/health`, `/api/items`, `/metrics` | all checks pass |
| `load.js` | ramps CRUD traffic 20 → 50 VUs over ~6 min | p95 < 500 ms, errors < 1 %, **no alerts** |
| `chaos.js` | 10 VUs of normal traffic, plus 20 VUs on `/slow?ms=900` and 10 VUs on `/flaky?rate=0.4` for 4 min | **both alerts fire**, then resolve |

The chaos mix was sized against the thresholds: about 13 % of requests are slow (more than the 5 % needed to push p95 over 500 ms) and roughly 20 % fail (above the 5 % error threshold). With `for: 1m` on the rules plus `group_wait: 10s`, Slack gets the message about 70–80 s into the run.

The `Makefile` wraps the long `docker compose run` and `docker run --entrypoint promtool` commands.

---

## Step 7: Documentation

**Commit:** `docs: build log and TypeScript updates`

This file, plus README and requirements updated to match the final code.

---

## Verifying it end to end

```bash
cp .env.example .env            # put your Slack webhook in
make up                         # build and start everything
make test-rules                 # promtool: 4 tests pass
make smoke                      # every endpoint responds
curl -s localhost:3000/metrics | grep -c '^# TYPE'   # 30+ metric families
make load                       # dashboard moves, nothing fires
make chaos                      # ~70s later: Slack gets APIHighLatencyP95 and APIHighErrorRate
```

Then look at http://localhost:9090/alerts (pending → firing) and http://localhost:9093 (grouped alerts) while the chaos run is going. When it ends, both alerts resolve and Slack gets a green message.

---

## First real run

**Commit:** `fix: route label trailing slash, Docker Desktop notes`

Started the stack with Docker Desktop on Linux and checked every layer:

| Check | Result |
|---|---|
| `docker compose up -d --build` | TypeScript compiled in the build stage, all 5 containers up, API healthy |
| `GET /metrics` | 36 metric families |
| Prometheus targets | `api`, `cadvisor`, `prometheus` all UP; 8 rules loaded and healthy; Alertmanager discovered |
| Grafana | datasource `prometheus` provisioned, *API Overview* in folder *API Monitoring*, set as home, PromQL proxy query works |
| `promtool test rules` | SUCCESS (4 cases) |
| `promtool check config` / `amtool check-config` | SUCCESS |
| k6 smoke | 15/15 checks |

Two things came out of it:

- **Route label had a trailing slash.** The list route is `router.get('/')`, so `req.baseUrl + req.route.path` gave `/api/items/`. Fixed by treating a route path of `/` as empty.
- **cAdvisor on Docker Desktop returns no per-container series.** Logs show `failed to identify the read-write layer ID ... /var/lib/docker/image/overlayfs/layerdb/...`. Docker Desktop stores images with containerd, and cAdvisor's Docker handler still looks for the classic overlay2 layer database. Tried `--enable_metrics=cpu,memory,network` and cAdvisor v0.52.1: same error, the lookup is unconditional. It's an upstream limitation, not a config problem; on a Linux Docker Engine host (overlay2) it works. Documented in the README with the Desktop setting that turns the containerd store off.

Also hit Docker Desktop's file-sharing rule: bind mounts from a path outside its shared directories come up empty. Ran the test from a clone under `/home`.

---

## Things that went wrong along the way

- **Route label lost its prefix on errors.** Fixed by responding from inside the router instead of `next(err)` (step 2).
- **Alertmanager ignored `${SLACK_WEBHOOK_URL}`.** It doesn't do env substitution. Fixed with `api_url_file` + entrypoint (step 5).
- **Container panels empty after cloning to a different folder.** Project name was coming from the directory. Fixed with `name:` in compose (step 3).
- **Memory alert could never fire.** No memory limit on the container meant `spec_memory_limit_bytes` was 0. Fixed by adding `deploy.resources.limits` (step 3).
