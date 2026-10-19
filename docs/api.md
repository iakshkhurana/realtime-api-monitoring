# API and metrics

A small Express app in TypeScript ([api/src](../api/src)). The CRUD endpoints exist to give the monitoring real traffic; the chaos endpoints exist to make the alerts fire on demand.

## Endpoints

| Method | Path                  | Description                  |
|--------|-----------------------|------------------------------|
| GET    | `/health`             | Liveness check               |
| GET    | `/metrics`            | Prometheus metrics           |
| GET    | `/api/items`          | List items                   |
| GET    | `/api/items/:id`      | Get one item (404 if missing)|
| POST   | `/api/items`          | Create an item `{ "name" }` (400 if missing) |
| DELETE | `/api/items/:id`      | Delete an item (204 / 404)   |
| GET    | `/api/chaos/slow`     | Delayed response, `?ms=800` (±25 % jitter, max 10 s) |
| GET    | `/api/chaos/flaky`    | Random 500s, `?rate=0.3` (0–1) |
| GET    | `/api/chaos/cpu`      | Blocks the event loop, `?ms=200` (max 2 s) |

```bash
curl "localhost:3000/api/chaos/slow?ms=1200"   # delayed response
curl "localhost:3000/api/chaos/flaky?rate=0.5" # fails half the time
curl "localhost:3000/api/chaos/cpu?ms=500"     # blocks the event loop
```

## Metrics

`GET /metrics` exposes 36 metric families.

**HTTP (custom)**

| Metric                          | Type      | Labels                           |
|---------------------------------|-----------|----------------------------------|
| `http_requests_total`           | Counter   | `method`, `route`, `status_code` |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` |
| `http_requests_in_flight`       | Gauge     |                                  |

Histogram buckets: 5 ms, 10, 25, 50, 100, 250, **500 ms**, 1 s, 2.5 s, 5 s. The 0.5 bucket exists because the p95 alert threshold is 500 ms; `histogram_quantile` is exact at bucket boundaries.

**Application (custom)**: `app_errors_total{type}`, `app_items_in_store`

**Runtime (prom-client defaults)**: process CPU (user/system), resident and virtual memory, heap used/total/per-space, external memory, GC duration, event loop lag (mean/p50/p90/p99), active handles and requests, open file descriptors, Node.js version.

## How the instrumentation works

[middleware/metrics.ts](../api/src/middleware/metrics.ts) runs on every request: it starts a histogram timer and bumps the in-flight gauge, then on `res.on('finish')` records the duration, increments the request counter and decrements the gauge.

- **Route label uses the template, not the URL.** `GET /api/items/42` is labelled `route="/api/items/:id"` (from `req.baseUrl + req.route.path`). Labelling by raw URL would create one time series per item and blow up cardinality.
- **`/metrics` and `/health` are excluded**, otherwise Prometheus's own scrapes and Docker's health checks would inflate the request rate.
- **`/flaky` responds with its 500 directly** instead of `next(err)`: leaving a sub-router through `next()` resets `req.baseUrl`, and the label would come out as `/flaky` instead of `/api/chaos/flaky`.

## Container image

Multi-stage `node:20-alpine` [Dockerfile](../api/Dockerfile): stage one installs everything and runs `tsc`; stage two copies only `dist/` and installs production dependencies. Runs as the unprivileged `node` user with a `HEALTHCHECK` on `/health`, and handles `SIGTERM` so in-flight requests finish when the container stops.
