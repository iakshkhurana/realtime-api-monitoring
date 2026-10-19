# Project structure

```
.
├── docker-compose.yml          # The whole stack (api, prometheus, cadvisor, alertmanager, grafana, k6)
├── Makefile                    # Shortcuts: up, down, load, chaos, test-rules, ...
├── .env.example                # Slack webhook and Grafana credentials
├── api/                        # Monitored Node.js service (TypeScript)
│   ├── Dockerfile              # Multi-stage: tsc build, then prod-only runtime
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts           # HTTP server and graceful shutdown
│       ├── app.ts              # Express app, /health and /metrics
│       ├── metrics.ts          # Prometheus registry and metric definitions
│       ├── middleware/metrics.ts   # Records rate, latency and in-flight per route
│       └── routes/
│           ├── items.ts        # CRUD endpoints
│           └── chaos.ts        # Slow, failing and CPU-heavy endpoints for testing alerts
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
├── k6/
│   ├── smoke.js                # Checks every endpoint responds
│   ├── load.js                 # Normal traffic, stays under the SLOs
│   └── chaos.js                # Slow and failing traffic that fires the alerts
└── docs/                       # Architecture, setup, API, alerting, build log, screenshots
```

## Where each concern lives

| Concern | Files |
|---|---|
| What is measured | `api/src/metrics.ts`, `api/src/middleware/metrics.ts` |
| How it is collected | `prometheus/prometheus.yml` |
| What it means | `prometheus/rules/recording.yml` |
| When to worry | `prometheus/rules/alerts.yml`, `prometheus/tests/alerts.test.yml` |
| Who gets told | `alertmanager/alertmanager.yml`, `alertmanager/templates/slack.tmpl` |
| How it looks | `grafana/provisioning/`, `grafana/dashboards/api-overview.json` |
| How it is proven | `k6/*.js` |
