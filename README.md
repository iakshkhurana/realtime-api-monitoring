# Real-Time API Monitoring Stack

A Dockerized Node.js REST API with a full monitoring stack: **Prometheus** metrics, **Grafana** dashboards, **Alertmanager** alerts sent to **Slack**, container metrics from **cAdvisor**, and **k6** load tests to check that the alerts fire.

The full build spec, including acceptance criteria and build order, is in [docs/requirements.md](docs/requirements.md).

Dashboards, data sources and alert rules are all provisioned as code, so the whole stack starts with one command:

```bash
docker compose up -d --build
```

## Architecture

![Architecture of the real-time API monitoring stack](docs/architecture.png)

> Editable source: [docs/architecture.excalidraw](docs/architecture.excalidraw). Open it at [excalidraw.com](https://excalidraw.com) with File → Open.

| Service      | URL                          | Purpose                                     |
|--------------|------------------------------|---------------------------------------------|
| API          | http://localhost:3000        | Instrumented Express REST API               |
| Grafana      | http://localhost:3001        | Dashboards (login `admin` / `admin`)        |
| Prometheus   | http://localhost:9090        | Metrics storage, recording and alert rules  |
| Alertmanager | http://localhost:9093        | Alert grouping, routing and Slack delivery  |
| cAdvisor     | http://localhost:8080        | Per-container CPU, memory and network usage |

## Project structure

```
.
├── docker-compose.yml          # The whole stack
├── Makefile                    # Shortcuts: up, down, load, chaos, test-rules, ...
├── .env.example                # Slack webhook and Grafana credentials
├── api/                        # Monitored Node.js service
│   ├── Dockerfile
│   └── src/
│       ├── server.js           # HTTP server and graceful shutdown
│       ├── app.js              # Express app, /health and /metrics
│       ├── metrics.js          # Prometheus registry and metric definitions
│       ├── middleware/metrics.js   # Records rate, latency, in-flight and size per route
│       └── routes/
│           ├── items.js        # CRUD endpoints
│           └── chaos.js        # Slow, failing and CPU-heavy endpoints for testing alerts
├── prometheus/
│   ├── prometheus.yml          # Scrape targets and Alertmanager wiring
│   ├── rules/
│   │   ├── recording.yml       # Precomputed request rate, error ratio and p95
│   │   └── alerts.yml          # Latency, error, availability and container alerts
│   └── tests/alerts.test.yml   # promtool unit tests for the alert rules
├── alertmanager/
│   ├── alertmanager.yml        # Routing by severity, inhibition, Slack receivers
│   ├── templates/slack.tmpl    # Slack message format
│   └── entrypoint.sh           # Loads the Slack webhook from the environment
├── grafana/
│   ├── provisioning/           # Data source and dashboard providers
│   └── dashboards/api-overview.json
└── k6/
    ├── smoke.js                # Checks every endpoint responds
    ├── load.js                 # Normal traffic, stays under the SLOs
    └── chaos.js                # Slow and failing traffic that fires the alerts
```

## Getting started

Requirements: Docker with the Compose plugin. `make` is optional; every target is a plain `docker compose` command.

```bash
cp .env.example .env        # add your Slack incoming-webhook URL
make up                     # or: docker compose up -d --build
```

Open Grafana at http://localhost:3001. The **API Overview** dashboard is the home page.

To get Slack alerts, create an [incoming webhook](https://api.slack.com/messaging/webhooks) and set `SLACK_WEBHOOK_URL` in `.env`. Without one, the stack still runs and alerts are still visible in Prometheus and Alertmanager. Only the Slack delivery fails.

## Metrics

The API exposes more than 30 metrics at `GET /metrics`.

**HTTP (custom)**

| Metric                          | Type      | Labels                          |
|---------------------------------|-----------|---------------------------------|
| `http_requests_total`           | Counter   | `method`, `route`, `status_code`|
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code`|
| `http_requests_in_flight`       | Gauge     |                                 |
| `http_response_size_bytes`      | Histogram | `method`, `route`               |

**Application (custom)**: `app_errors_total`, `app_items_in_store`, `app_item_operations_total`

**Runtime (prom-client defaults)**: process CPU (user/system), resident and virtual memory, heap used/total/per-space, external memory, GC duration, event loop lag (mean/p50/p90/p99), active handles and requests, open file descriptors, Node.js version.

Routes are labelled by their template (`/api/items/:id`) rather than the raw URL, so label cardinality stays bounded.

## Dashboard

`grafana/dashboards/api-overview.json` refreshes every 5 seconds and has four sections:

- **Overview**: request rate, 5xx error rate, p95 latency, in-flight requests, uptime, firing alerts
- **Traffic & latency**: rate by route, p50/p95/p99 latency (with the alert threshold marked), error rate, status codes, p95 by route, application errors
- **Containers (cAdvisor)**: CPU, memory and network I/O for each service in the stack
- **Node.js runtime**: heap and RSS, event loop lag, process CPU

## Alerts

| Alert                    | Condition                                        | For | Severity |
|--------------------------|--------------------------------------------------|-----|----------|
| `APIDown`                | Prometheus can't scrape the API                  | 30s | critical |
| `APIHighLatencyP95`      | p95 latency > 500 ms                             | 1m  | warning  |
| `APIHighErrorRate`       | 5xx responses > 5% of traffic (at > 0.5 req/s)   | 1m  | critical |
| `APIContainerHighCPU`    | API container > 80% of one core                  | 2m  | warning  |
| `APIContainerHighMemory` | API container > 85% of its memory limit          | 2m  | warning  |

Alertmanager groups alerts by name and severity, repeats critical alerts every 15 minutes, and holds back a warning while the same alert is already critical. Resolved notifications are also sent to Slack.

## Load testing and alert verification

k6 runs as a Compose service under the `loadtest` profile, so `docker compose up` doesn't start it.

```bash
make smoke    # 5 iterations, checks every endpoint responds
make load     # ~6 min of normal CRUD traffic up to 50 VUs; p95 < 500ms, errors < 1%
make chaos    # ~5 min of mixed traffic with slow (~900ms) and failing (40%) requests
```

During `make chaos`, the dashboard shows p95 latency and the error rate passing their thresholds. About a minute later, `APIHighLatencyP95` and `APIHighErrorRate` fire in Prometheus (http://localhost:9090/alerts) and arrive in Slack. Once the test stops, both resolve and Slack gets a resolved message.

The chaos endpoints can also be called by hand:

```bash
curl "localhost:3000/api/chaos/slow?ms=1200"   # delayed response
curl "localhost:3000/api/chaos/flaky?rate=0.5" # fails half the time
curl "localhost:3000/api/chaos/cpu?ms=500"     # blocks the event loop
```

## Testing the alert rules

The alert rules have unit tests that run in `promtool`, so they can be checked without generating real traffic:

```bash
make test-rules     # promtool test rules prometheus/tests/alerts.test.yml
make check-config   # promtool check config + amtool check-config
```

## API reference

| Method | Path                  | Description                  |
|--------|-----------------------|------------------------------|
| GET    | `/health`             | Liveness check               |
| GET    | `/metrics`            | Prometheus metrics           |
| GET    | `/api/items`          | List items                   |
| GET    | `/api/items/:id`      | Get one item                 |
| POST   | `/api/items`          | Create an item `{ "name" }`  |
| DELETE | `/api/items/:id`      | Delete an item               |
| GET    | `/api/chaos/slow`     | Delayed response (`?ms=`)    |
| GET    | `/api/chaos/flaky`    | Random 500s (`?rate=`)       |
| GET    | `/api/chaos/cpu`      | CPU burn (`?ms=`)            |

## Notes

- cAdvisor needs access to the Docker host's `/sys`, `/var/lib/docker` and `/dev/kmsg`. It works on Linux. On Docker Desktop (macOS/Windows), the container panels may be partly empty.
- `make clean` removes the Prometheus, Alertmanager and Grafana volumes.
