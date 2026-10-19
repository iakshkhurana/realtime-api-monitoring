# Requirements: Real-Time API Monitoring Stack

This document says what to build, how each part should behave, and how to check that it's done. The README describes the finished project.

**Stack:** Node.js + TypeScript (Express + prom-client), Docker Compose, Prometheus, Grafana, Alertmanager, cAdvisor, k6

**Resume claims this project must back up:**

1. A Dockerized Node.js REST API instrumented with Prometheus (prom-client) that exposes 20+ live metrics (latency, errors, CPU, memory).
2. Grafana dashboards for request rate, p95 latency, error rate, and container CPU/memory from cAdvisor.
3. Alert rules for latency and error spikes, sent to Slack through Alertmanager and verified with k6 load tests.
4. Dashboards and alert rules provisioned as code, so the whole stack starts with `docker compose up`.

---

## 1. Target structure

```
.
├── docker-compose.yml
├── Makefile                      # optional shortcuts
├── .env.example                  # SLACK_WEBHOOK_URL, Grafana credentials
├── .gitignore                    # node_modules, .env
├── api/
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts             # listen + graceful shutdown
│       ├── app.ts                # express app, /health, /metrics, error handler
│       ├── metrics.ts            # registry + all metric definitions
│       ├── middleware/metrics.ts # per-request instrumentation
│       └── routes/
│           ├── items.ts          # CRUD
│           └── chaos.ts          # slow / flaky / cpu endpoints
├── prometheus/
│   ├── prometheus.yml
│   ├── rules/recording.yml
│   ├── rules/alerts.yml
│   └── tests/alerts.test.yml     # promtool unit tests
├── alertmanager/
│   ├── alertmanager.yml
│   ├── templates/slack.tmpl
│   └── entrypoint.sh
├── grafana/
│   ├── provisioning/datasources/prometheus.yml
│   ├── provisioning/dashboards/dashboards.yml
│   └── dashboards/api-overview.json
└── k6/
    ├── smoke.js
    ├── load.js
    └── chaos.js
```

---

## 2. API service (`api/`)

### 2.1 Endpoints

| ID    | Method | Path               | Behavior |
|-------|--------|--------------------|----------|
| API-1 | GET    | `/health`          | `200 {status, uptimeSeconds}` |
| API-2 | GET    | `/metrics`         | Prometheus text format, `Content-Type` from `register.contentType` |
| API-3 | GET    | `/api/items`       | List all items |
| API-4 | GET    | `/api/items/:id`   | `200` item, or `404` |
| API-5 | POST   | `/api/items`       | Body `{name}`. Returns `201` with the new item, or `400` if `name` is missing or blank |
| API-6 | DELETE | `/api/items/:id`   | `204`, or `404` |
| API-7 | GET    | `/api/chaos/slow?ms=800`   | Waits about `ms` (±25% jitter, capped at 10s), then responds |
| API-8 | GET    | `/api/chaos/flaky?rate=0.3`| Returns `500` for a `rate` fraction of requests (0–1) |
| API-9 | GET    | `/api/chaos/cpu?ms=200`    | Busy-loops on the event loop for `ms` (capped at 2s) |
| API-10| *      | anything else      | `404 {error}` |

- Store items in memory (a `Map`), seeded with a few items at startup. No database.
- A central error handler returns `500` and increments `app_errors_total`.
- Handle `SIGTERM` by calling `server.close()`, with a forced exit after 10s.

### 2.2 Metrics (20 or more in total)

Use one `prom-client` `Registry` with the default label `service="monitored-api"`, and call `collectDefaultMetrics({ register })`. The defaults alone give about 25 series families: process CPU, RSS, heap, GC, event loop lag, handles and file descriptors.

Custom metrics:

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `http_requests_total` | Counter | method, route, status_code | |
| `http_request_duration_seconds` | Histogram | method, route, status_code | Buckets: `.005 .01 .025 .05 .1 .25 .5 1 2.5 5`. The 0.5 bucket must exist because the alert threshold is 500ms. |
| `http_requests_in_flight` | Gauge | — | inc on request, dec on `finish` |
| `app_errors_total` | Counter | type | |
| `app_items_in_store` | Gauge | — | |

### 2.3 Instrumentation middleware rules

- **M-1** Skip `/metrics` and `/health` so scrapes and health checks don't skew traffic numbers.
- **M-2** Set the `route` label from the route template, `req.baseUrl + req.route.path` (for example `/api/items/:id`). Never use the raw URL, because each item ID would create a new series. Use `unmatched` when no route matched.
- **M-3** Record metrics in `res.on('finish')`, not before the handler runs.
- **M-4** ⚠️ Gotcha: if a handler inside a sub-router calls `next(err)`, Express restores `req.baseUrl` when it leaves the router, and the label becomes `/flaky` instead of `/api/chaos/flaky`. Have the chaos routes send their `500` directly, or capture the route label before calling `next`.

### 2.4 Container

- Multi-stage `node:20-alpine` Dockerfile: compile with `tsc` in the first stage, copy `dist/` into a runtime stage with `npm install --omit=dev`, run as `USER node`, `EXPOSE 3000`.
- `HEALTHCHECK` using `wget -qO- http://localhost:3000/health`.
- In Compose, set limits of `cpus: 1.0` and `memory: 256M`. Without a memory limit, the memory-percentage alert has nothing to divide by.

---

## 3. Prometheus (`prometheus/`)

- **P-1** `scrape_interval: 5s` and `evaluation_interval: 5s`.
- **P-2** Scrape jobs: `api` (`api:3000`), `cadvisor` (`cadvisor:8080`, 10s), `prometheus`, `alertmanager`.
- **P-3** For the cAdvisor job, use `metric_relabel_configs` to keep only `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`, `container_spec_memory_limit_bytes` and the network rx/tx metrics. This keeps the number of series down.
- **P-4** Send alerts to `alertmanager:9093`, and load rules from `rules/*.yml`.
- **P-5** Run with `--web.enable-lifecycle` so `POST /-/reload` works.

### 3.1 Recording rules (`rules/recording.yml`)

```
api:http_requests:rate1m               = sum(rate(http_requests_total{job="api"}[1m]))
api:http_errors:ratio_rate1m           = sum(rate(...{status_code=~"5.."}[1m])) / clamp_min(sum(rate(...[1m])), 1e-9)
api:http_request_duration_seconds:p95_1m = histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="api"}[1m])))
```

### 3.2 Alert rules (`rules/alerts.yml`)

| Alert | Expression | `for` | severity |
|---|---|---|---|
| APIDown | `up{job="api"} == 0` | 30s | critical |
| APIHighLatencyP95 | `api:http_request_duration_seconds:p95_1m > 0.5` | 1m | warning |
| APIHighErrorRate | `api:http_errors:ratio_rate1m > 0.05 and api:http_requests:rate1m > 0.5` | 1m | critical |
| APIContainerHighCPU | API container CPU rate `> 0.8` | 2m | warning |
| APIContainerHighMemory | working set / limit `> 0.85` | 2m | warning |

- Every alert needs `summary` and `description` annotations. Use `humanizeDuration` and `humanizePercentage` to format values.
- The `rate > 0.5` guard on the error-rate alert keeps a single failed request during idle time from paging anyone.
- Select the API container in cAdvisor metrics with `container_label_com_docker_compose_service="api"`.

### 3.3 Rule unit tests (`tests/alerts.test.yml`)

Run with `promtool test rules`. Cover at least these cases:

- [ ] APIDown is not firing at 20s and is firing at 50s after `up` drops to 0.
- [ ] An error ratio of 20% fires APIHighErrorRate.
- [ ] Traffic with 100% `200` responses does **not** fire APIHighErrorRate.
- [ ] When every request falls in the `(0.5, 1]` bucket, APIHighLatencyP95 fires (p95 = 975ms).

---

## 4. Alertmanager (`alertmanager/`)

- **AM-1** The default receiver is `slack-warnings`. A child route sends `severity="critical"` to `slack-critical`, with `repeat_interval: 15m`.
- **AM-2** Group by `[alertname, severity]`, with `group_wait: 10s` and `group_interval: 1m`.
- **AM-3** Add an inhibit rule so a critical alert mutes the warning version of the same `alertname`.
- **AM-4** Set `send_resolved: true` on both receivers. Use a red, orange or green color depending on status.
- **AM-5** Define the Slack title and text in `templates/slack.tmpl`: status, number of firing alerts, alert name, summary, description and start or end time.
- **AM-6** ⚠️ Gotcha: Alertmanager **doesn't expand environment variables** in its config. Read the webhook from a file with `api_url_file`, and have a small `entrypoint.sh` write `$SLACK_WEBHOOK_URL` to that file before it runs `exec /bin/alertmanager "$@"`. Write the file somewhere writable, such as `/tmp`, because the image runs as `nobody`. Run the script with `entrypoint: ["/bin/sh", ...]` so it doesn't depend on the file's execute permission.
- **AM-7** Never commit the webhook. It belongs in `.env`, which is gitignored, and `.env.example` holds a placeholder.

---

## 5. Grafana (`grafana/`)

- **G-1** Provision the Prometheus data source with a fixed `uid: prometheus` so the dashboard JSON can refer to it.
- **G-2** Use a file-based dashboard provider that points at `/var/lib/grafana/dashboards`, in the folder "API Monitoring".
- **G-3** Set `GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH` to the API Overview dashboard. Read the admin user and password from `.env`, with `admin` as the default for both.
- **G-4** The dashboard `api-overview.json` has `uid: api-overview`, refreshes every 5s and shows the last 15 minutes by default.

### Dashboard panels

| Row | Panel | Query sketch |
|---|---|---|
| Overview | Request rate (stat) | `sum(rate(http_requests_total{job="api"}[1m]))` |
| | Error rate % (stat; turns orange above 1%, red above 5%) | 5xx rate / total rate |
| | p95 latency (stat; turns orange above 250ms, red above 500ms) | `histogram_quantile(0.95, sum by (le)(rate(..._bucket[1m])))` |
| | In-flight, Uptime, Firing alerts | `http_requests_in_flight`, `time() - process_start_time_seconds`, `count(ALERTS{alertstate="firing"}) or vector(0)` |
| Traffic & latency | Request rate by route (stacked) | `sum by (method, route)(rate(...))` |
| | p50/p95/p99 latency, with a threshold line at 0.5s | three `histogram_quantile` queries |
| | Error rate, with a threshold line at 5% | |
| | Responses by status code, p95 by route, app errors by type | |
| Containers (cAdvisor) | CPU, memory (working set) and network I/O per service | `sum by (container_label_com_docker_compose_service)(...)` |
| Node.js runtime | Heap used/total + RSS, event loop lag p99/mean, process CPU user/system | default metrics |

⚠️ Gotcha: add `name: api-monitoring` at the top of `docker-compose.yml`. The Compose project name normally comes from the directory name, and the container panels filter on `container_label_com_docker_compose_project`, so a fixed name keeps them working wherever the repo is cloned.

---

## 6. Docker Compose

| Service | Image | Host port | Notes |
|---|---|---|---|
| api | build `./api` | 3000 | resource limits (section 2.4) |
| prometheus | `prom/prometheus:v2.55.1` | 9090 | mount the config and `rules/` read-only; named volume for the data |
| alertmanager | `prom/alertmanager:v0.27.0` | 9093 | custom entrypoint, `SLACK_WEBHOOK_URL` from `.env` |
| grafana | `grafana/grafana:11.3.0` | **3001** (the API already uses 3000) | mount provisioning and dashboards read-only |
| cadvisor | `gcr.io/cadvisor/cadvisor:v0.49.1` | 8080 | `privileged`, `/dev/kmsg`, mounts for `/`, `/var/run`, `/sys`, `/var/lib/docker`, `/dev/disk` |
| k6 | `grafana/k6:0.54.0` | — | `profiles: ["loadtest"]` so `up` doesn't start it; mount `./k6:/scripts` |

- **DC-1** `docker compose up -d --build` with no `.env` file must still start every service healthy.
- **DC-2** Use named volumes for the Prometheus, Alertmanager and Grafana data.
- **DC-3** Set `restart: unless-stopped` on the long-running services.

---

## 7. k6 load tests (`k6/`)

All scripts read `BASE_URL` from the environment, defaulting to `http://api:3000`. Run them with `docker compose run --rm k6 run /scripts/<file>.js`.

| Script | Profile | Thresholds | Expected outcome |
|---|---|---|---|
| `smoke.js` | 1 VU × 5 iterations; checks `/health`, `/api/items`, `/metrics` | `checks: rate==1` | passes |
| `load.js` | ramp to 20 VUs, hold 3m, ramp to 50 VUs, hold 1m, ramp down. Each iteration runs the full CRUD flow (list → create → get → delete) | `http_req_failed < 1%`, `p(95) < 500ms` | passes, **no alerts fire** |
| `chaos.js` | baseline 10 VUs on `/api/items` for 5m, plus 20 VUs on `/slow?ms=900` and 10 VUs on `/flaky?rate=0.4` for 4m, starting at 30s | threshold on the baseline scenario only | **APIHighLatencyP95 and APIHighErrorRate fire**, then resolve after the test |

Check the chaos mix: about 13% of requests are slow, which is more than the 5% needed to push p95 above 500ms. About 20% of requests fail, which is more than the 5% error threshold.

---

## 8. Acceptance criteria

- [ ] `docker compose up -d --build` starts all 5 services from a clean clone.
- [ ] `curl localhost:3000/metrics | grep -c '^# TYPE'` returns **20 or more**.
- [ ] All Prometheus targets (http://localhost:9090/targets) are `UP`.
- [ ] Grafana opens on the API Overview dashboard with every panel showing data. No clicking or importing is needed.
- [ ] `make smoke` and `make load` pass, and no alerts fire during `load`.
- [ ] During `make chaos`, both alerts go from pending to firing in Prometheus and show up in Alertmanager (http://localhost:9093).
- [ ] Slack receives the firing message and, after the test ends, the resolved message.
- [ ] `promtool test rules` passes and `promtool check config` / `amtool check-config` are clean.
- [ ] No secrets are committed (`.env` is gitignored).
- [ ] Take screenshots for the README: the dashboard under load, the alert firing in Slack, and the Prometheus alerts page.

---

## 9. Suggested build order

1. **API**: endpoints and the `/metrics` middleware, run locally with `npm run dev`. Check that the route labels look right.
2. **Dockerize the API** and add a minimal `docker-compose.yml`.
3. **Prometheus**: add the service and the scrape config, and confirm the target is UP.
4. **cAdvisor**: add the service and confirm the container metrics have compose labels.
5. **Grafana**: provision the data source, build the dashboard in the UI, export the JSON into `grafana/dashboards/` and provision it.
6. **Rules**: write the recording and alert rules, then the promtool tests.
7. **Alertmanager**: set up routing, the template and the Slack webhook. Test it by stopping the API, which should fire `APIDown`.
8. **k6**: run smoke, load and chaos, and confirm the alerts end to end.
9. **Polish**: Makefile, README screenshots, `.env.example`.
