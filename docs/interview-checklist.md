# Interview checklist

Questions an interviewer is likely to ask about this project, with the short answer you should be able to give from memory. Tick each one once you can explain it without looking.

The resume line this backs up:

> Instrumented a Dockerized Node.js REST API with Prometheus (prom-client), exposing 20+ live metrics. Built Grafana dashboards for request rate, p95 latency, error rate and container CPU/memory via cAdvisor. Configured Alertmanager rules for latency and error spikes with Slack alerts, verified under k6 load tests. Provisioned dashboards and alert rules as code so the whole stack starts with a single `docker compose up`.

---

## 1. The big picture

- [ ] **Walk me through the architecture.**
  k6 sends traffic to a TypeScript Express API. The API exposes `/metrics`; Prometheus scrapes it every 5 s, and scrapes cAdvisor for container CPU/memory. Prometheus evaluates recording and alert rules and pushes firing alerts to Alertmanager, which groups them and posts to Slack. Grafana reads Prometheus for dashboards. All of it is six services in one `docker-compose.yml`.

- [ ] **Why did you build this?**
  To understand the full observability loop, not just "add a dashboard": what to measure, how to store it, how to alert on it without noise, and how to prove the alerts actually fire.

- [ ] **What does "provisioned as code" mean here?**
  Grafana's datasource and dashboard JSON, the Prometheus config and rules, and the Alertmanager config are all files in the repo, mounted read-only into the containers. A fresh clone plus `docker compose up` gives the full stack with no clicking in any UI.

- [ ] **Push vs pull: why does Prometheus scrape instead of the app pushing?**
  Pull keeps the app simple (it just serves text on `/metrics`), lets Prometheus detect that a target is down (`up == 0`), and means Prometheus controls the sampling rate, not the app.

---

## 2. Instrumentation (prom-client)

- [ ] **What are the four Prometheus metric types, and which did you use?**
  Counter (only goes up: `http_requests_total`), Gauge (goes up and down: `http_requests_in_flight`, `app_items_in_store`), Histogram (buckets of observations: `http_request_duration_seconds`), Summary (client-side quantiles; not used, because you can't aggregate summaries across instances).

- [ ] **How does the metrics middleware work?**
  On every request it starts a histogram timer and increments the in-flight gauge. On `res.on('finish')` it records duration, increments the request counter with `method`, `route`, `status_code` labels, and decrements the gauge.

- [ ] **What is label cardinality and how did you keep it bounded?**
  Every unique label combination is a separate time series. Labelling by raw URL (`/api/items/42`) would create one series per item. I label by the Express route template (`/api/items/:id`) using `req.baseUrl + req.route.path`, so the set of routes is fixed.

- [ ] **Why does the histogram have a bucket at exactly 0.5?**
  The p95 alert threshold is 500 ms. `histogram_quantile` interpolates linearly inside a bucket, so if the threshold sits on a bucket boundary the estimate at that point is exact.

- [ ] **Where do the "20+ metrics" come from?**
  `collectDefaultMetrics()` gives ~30 series families: process CPU, RSS, heap, GC duration, event loop lag, open handles/fds. I added 5 custom ones. `/metrics` shows 36 families.

- [ ] **Why are `/metrics` and `/health` excluded from the HTTP metrics?**
  Prometheus scrapes every 5 s and Docker health-checks every 10 s; counting those would inflate request rate and skew latency.

- [ ] **A bug you hit in the middleware?**
  When a sub-router handler called `next(err)`, Express reset `req.baseUrl` on the way out, so the label became `/flaky` instead of `/api/chaos/flaky`. Fixed by responding with the 500 inside the router. Also the list route's path is `/`, which gave `/api/items/` with a trailing slash; fixed by treating `/` as empty.

- [ ] **What are the chaos endpoints for?**
  `/api/chaos/slow`, `/flaky`, `/cpu` misbehave on demand so the alerts can be triggered deterministically in a load test. Without them there's no way to demonstrate an alert firing.

---

## 3. PromQL and rules

- [ ] **Write the query for request rate.**
  `sum(rate(http_requests_total{job="api"}[1m]))`. `rate()` handles counter resets and gives per-second rate over the window; `sum` collapses the labels.

- [ ] **Write the query for p95 latency.**
  `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="api"}[1m])))`. You must keep the `le` label when summing, since that's the bucket boundary.

- [ ] **Write the query for error rate.**
  `sum(rate(http_requests_total{status_code=~"5.."}[1m])) / sum(rate(http_requests_total[1m]))`. I wrap the denominator in `clamp_min(..., 1e-9)` to avoid dividing by zero when there's no traffic.

- [ ] **What are recording rules and why use them?**
  Precomputed queries stored as new series (`api:http_requests:rate1m`). The alerts and the dashboard use the same numbers, the alert expressions stay readable, and expensive queries run once instead of on every dashboard refresh.

- [ ] **Explain the `for:` clause on an alert.**
  The condition must stay true for that long before the alert moves from `pending` to `firing`. It stops a single bad scrape from paging anyone. Latency and error alerts use 1 m; container ones 2 m.

- [ ] **Why does the error-rate alert also require `rate > 0.5`?**
  At idle, one failed request out of one would be a "100 % error rate". The traffic guard means the ratio is only meaningful with real load.

- [ ] **How did you test the alert rules without running the stack?**
  `promtool test rules` with a YAML file of synthetic series. Four cases: API down goes pending then firing, 20 % errors fires, healthy traffic stays quiet, all-slow traffic fires the latency alert with p95 = 975 ms (and the test asserts the exact rendered annotation text).

- [ ] **What's the difference between `rate`, `irate` and `increase`?**
  `rate` = average per-second rate over the window (smooth, use for alerts). `irate` = rate from the last two samples (spiky, for graphs of fast-changing values). `increase` = `rate × window`, the total increase over the window.

---

## 4. Alertmanager

- [ ] **What does Alertmanager do that Prometheus doesn't?**
  Prometheus decides *what* is firing. Alertmanager decides *who hears about it and how often*: grouping, routing by label, silencing, inhibition, repeat intervals, and the actual delivery (Slack, email, PagerDuty).

- [ ] **Explain group_wait / group_interval / repeat_interval.**
  `group_wait` (10 s): wait after the first alert in a group so a burst becomes one message. `group_interval` (1 m): how long to wait before sending an update about new alerts in an existing group. `repeat_interval` (1 h, 15 m for critical): how often to re-send an alert that's still firing.

- [ ] **What is an inhibition rule? Which one did you use?**
  Mute one alert while another is firing. Mine: a `severity=critical` alert suppresses the `severity=warning` alert with the same `alertname`, so you don't get two Slack messages for one problem.

- [ ] **How is the Slack webhook kept out of git?**
  It's in `.env` (gitignored). Alertmanager can't read env vars in its config, so a tiny `entrypoint.sh` writes `$SLACK_WEBHOOK_URL` to a file and the config loads it with `api_url_file`.

- [ ] **How did you verify the alerts end to end?**
  Ran the k6 chaos script. Watched p95 go from 5 ms to ~940 ms and the error ratio to 23 %. Both alerts went pending → firing after the 1-minute hold, showed in Alertmanager routed to the right receivers, and resolved about 90 s after traffic stopped.

---

## 5. Grafana

- [ ] **How is the dashboard provisioned?**
  A datasource YAML with a fixed `uid: prometheus`, a dashboard provider YAML pointing at a folder, and the dashboard JSON in that folder. `GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH` makes it the home page.

- [ ] **Why does the datasource need a fixed uid?**
  The dashboard JSON references the datasource by uid. Without pinning it, each fresh Grafana would generate a random uid and every panel would show "datasource not found".

- [ ] **What's on the dashboard?**
  Four rows: Overview stats (rate, error %, p95, in-flight, uptime, firing alerts), Traffic & latency time series with the alert thresholds drawn as red bands, Containers (cAdvisor CPU/memory/network per service), Node.js runtime (heap, event loop lag, process CPU).

- [ ] **Stat panel vs time series: when do you use which?**
  Stat for "what's the number right now", with colour thresholds. Time series for "how did it get there". The overview row is stats; everything below is time series.

---

## 6. Docker and cAdvisor

- [ ] **What is cAdvisor and why do you need it?**
  It reads the kernel's cgroup accounting for every container and exposes CPU, memory and network per container. prom-client only knows about the Node process; cAdvisor gives the view from outside it.

- [ ] **Why set a memory limit on the API container?**
  The memory alert is `working_set / spec_memory_limit`. With no limit the denominator is 0 and the alert can never fire. It also makes the resource panels meaningful.

- [ ] **Why `name: api-monitoring` in the compose file?**
  cAdvisor labels containers with `com.docker.compose.project`, which defaults to the folder name. The Grafana panels filter on that label, so pinning the project name keeps the dashboard working no matter where the repo is cloned.

- [ ] **Why is the Dockerfile multi-stage?**
  Stage one installs dev dependencies and runs `tsc`. Stage two copies only `dist/` and installs production deps. Smaller image, no compiler or dev deps in production, and it runs as the unprivileged `node` user.

- [ ] **Why does k6 use a compose profile?**
  `profiles: ["loadtest"]` means `docker compose up` doesn't start it, but `docker compose run k6` works on the same network, so it can hit `http://api:3000` directly.

- [ ] **A platform issue you ran into?**
  Docker Desktop uses the containerd image store; cAdvisor's Docker handler still looks for the classic overlay2 layer database and errors with "failed to identify the read-write layer ID", so container panels are empty there. It works on a standard Linux Docker Engine host. Documented it rather than hacking around it.

---

## 7. Load testing (k6)

- [ ] **What are the three scripts?**
  `smoke.js` (1 VU, does every endpoint respond), `load.js` (ramp to 50 VUs of CRUD traffic; must pass p95 < 500 ms and errors < 1 %), `chaos.js` (adds slow and 40 %-failing traffic so the alerts fire).

- [ ] **How did you size the chaos mix?**
  About 13 % of requests are ~900 ms. p95 only needs > 5 % of requests above the threshold to cross it. Roughly 20 % of requests return 500, above the 5 % error threshold.

- [ ] **What are k6 thresholds?**
  Pass/fail criteria on metrics (`http_req_duration: ['p(95)<500']`). k6 exits non-zero if they fail, which is what makes it usable as a CI gate.

- [ ] **What's a VU?**
  Virtual user: one loop running the script concurrently. 50 VUs with a 0.25–0.75 s sleep is roughly 100 req/s.

---

## 8. "What would you do next?"

- [ ] **How would you run this in production?**
  Kubernetes with the Prometheus Operator / kube-prometheus-stack: ServiceMonitors instead of static targets, PrometheusRule CRDs for the rules, Grafana dashboards as ConfigMaps. Long-term storage with Thanos or Mimir.

- [ ] **What's missing from a full observability setup?**
  Logs (Loki) and traces (Tempo/OpenTelemetry), correlated with metrics via exemplars and trace IDs. SLOs with error budgets instead of static thresholds.

- [ ] **How would you reduce alert noise further?**
  Multi-window multi-burn-rate alerts on an SLO (e.g. 99.9 % over 30 d), severity tiers (page vs ticket), and silences for known maintenance windows.

- [ ] **How would you secure it?**
  Grafana behind SSO, Prometheus and Alertmanager not exposed publicly, secrets from a vault instead of `.env`, TLS between services.

- [ ] **What would you change about the API instrumentation?**
  Add exemplars to the histogram so a slow bucket links to a trace, and use OpenTelemetry so the same instrumentation can export to any backend.

---

## Numbers to remember

| | |
|---|---|
| Metric families on `/metrics` | 36 |
| Scrape interval | 5 s |
| Histogram buckets | 5 ms → 5 s, 10 buckets, 0.5 included |
| p95 alert | > 500 ms for 1 m, warning |
| Error alert | > 5 % 5xx (and > 0.5 req/s) for 1 m, critical |
| Container alerts | CPU > 80 % of a core, memory > 85 % of limit, both for 2 m |
| Chaos result | p95 5 ms → ~940 ms, errors 23 %, alerts fire at ~70 s |
| Dashboard | 22 panels, 4 rows, refresh 5 s |
| Services in compose | 6 (api, prometheus, cadvisor, alertmanager, grafana, k6) |
| Image versions | Prometheus 2.55.1, Alertmanager 0.27.0, Grafana 11.3.0, cAdvisor 0.49.1, k6 0.54.0 |
