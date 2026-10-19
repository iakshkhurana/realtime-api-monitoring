# Real-Time API Monitoring Stack

A Dockerized Node.js (TypeScript) REST API with a full monitoring stack: **Prometheus** metrics, **Grafana** dashboards, **Alertmanager** alerts to **Slack**, container metrics from **cAdvisor**, and **k6** load tests that prove the alerts fire. Dashboards and alert rules are provisioned as code, so the whole stack starts with one command.

![Architecture](docs/architecture.png)

## Quick start

```bash
cp .env.example .env            # add your Slack incoming-webhook URL
docker compose up -d --build    # or: make up
```

Grafana → http://localhost:3001 (`admin` / `admin`) · Prometheus → http://localhost:9090 · Alertmanager → http://localhost:9093

```bash
make chaos      # slow + failing traffic; both alerts fire in ~70s and reach Slack
make test-rules # promtool unit tests for the alert rules
```

## Docs

| | |
|---|---|
| [Architecture](docs/architecture.md) | Diagram, data flow, services and why they're wired this way |
| [Setup](docs/setup.md) | Requirements, `.env`, make targets, Docker Desktop notes |
| [Project structure](docs/project-structure.md) | What every folder and file is for |
| [API & metrics](docs/api.md) | Endpoints, the 36 metrics, how the instrumentation works |
| [Dashboard](docs/dashboard.md) | The Grafana panels and how they're provisioned |
| [Alerting](docs/alerting.md) | Rules, promtool tests, Alertmanager routing, the Slack payload |
| [Load testing](docs/load-testing.md) | The k6 scripts and what a chaos run looks like |
| [Build log](docs/build-log.md) | Step-by-step how it was built and the problems hit |
| [Requirements](docs/requirements.md) | The spec, with acceptance criteria ticked off |
| [Interview checklist](docs/interview-checklist.md) | Questions to be able to answer about this project |

## Stack

Node.js 20 · TypeScript · Express · prom-client · Prometheus 2.55 · Grafana 11.3 · Alertmanager 0.27 · cAdvisor 0.49 · k6 0.54 · Docker Compose
