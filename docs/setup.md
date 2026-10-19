# Setup

## Requirements

- Docker with the Compose plugin.
- `make` is optional; every target is a plain `docker compose` / `docker run` command (see the [Makefile](../Makefile)).
- Node.js is only needed to run the API outside Docker: `cd api && npm install && npm run dev`.

## Start

```bash
cp .env.example .env        # add your Slack incoming-webhook URL
make up                     # or: docker compose up -d --build
```

Open Grafana at http://localhost:3001 (`admin` / `admin`). The **API Overview** dashboard is the home page.

To get Slack alerts, create an [incoming webhook](https://api.slack.com/messaging/webhooks) and set `SLACK_WEBHOOK_URL` in `.env`. Without one, the stack still runs and alerts are visible in Prometheus and Alertmanager; only the Slack delivery fails.

## Make targets

| Target | What it does |
|---|---|
| `make up` / `make down` | Start (build) / stop the stack |
| `make clean` | Stop and delete the Prometheus, Alertmanager and Grafana volumes |
| `make logs` / `make ps` | Follow logs / show status |
| `make smoke` / `make load` / `make chaos` | Run the k6 scripts (see [load-testing.md](load-testing.md)) |
| `make test-rules` | Unit-test the alert rules with promtool |
| `make check-config` | Validate the Prometheus and Alertmanager configs |
| `make reload` | Reload Prometheus config and rules without a restart |

## Environment variables (`.env`)

| Variable | Default | Used by |
|---|---|---|
| `SLACK_WEBHOOK_URL` | placeholder | Alertmanager (written to a file by `entrypoint.sh`, since Alertmanager can't expand env vars in its config) |
| `GRAFANA_ADMIN_USER` | `admin` | Grafana |
| `GRAFANA_ADMIN_PASSWORD` | `admin` | Grafana |

## Platform notes

- **Linux Docker Engine** (overlay2): everything works, including the cAdvisor container panels.
- **Docker Desktop (any OS)** with the *containerd image store* enabled (the default in recent versions): cAdvisor can't resolve container layers (`failed to identify the read-write layer ID`) and the container panels and container alerts stay empty. Everything else works. To get container metrics, turn off *Settings → General → Use containerd for pulling and storing images*, or run on a plain Docker Engine host.
- **Docker Desktop on Linux** only bind-mounts paths under its shared directories (`/home` by default). If the repo lives elsewhere (e.g. `/run/media/...`), add that path in *Settings → Resources → File sharing* or the config mounts come up empty.
- cAdvisor needs `/sys`, `/var/lib/docker` and `/dev/kmsg` from the host, which is why it runs `privileged`.
