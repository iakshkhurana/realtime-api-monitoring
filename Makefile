COMPOSE := docker compose
PROMETHEUS_IMAGE := prom/prometheus:v2.55.1
ALERTMANAGER_IMAGE := prom/alertmanager:v0.27.0

.PHONY: help up down clean logs ps smoke load chaos test-rules check-config reload

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## Build and start the whole stack
	$(COMPOSE) up -d --build

down: ## Stop the stack
	$(COMPOSE) down

clean: ## Stop the stack and delete stored metrics, alerts and Grafana data
	$(COMPOSE) down -v

logs: ## Follow logs from every service
	$(COMPOSE) logs -f

ps: ## Show service status
	$(COMPOSE) ps

smoke: ## Quick k6 check that every endpoint responds
	$(COMPOSE) run --rm k6 run /scripts/smoke.js

load: ## Normal k6 load test (stays under alert thresholds)
	$(COMPOSE) run --rm k6 run /scripts/load.js

chaos: ## k6 chaos test that fires the latency and error alerts
	$(COMPOSE) run --rm k6 run /scripts/chaos.js

test-rules: ## Unit-test the Prometheus alert rules with promtool
	docker run --rm -v "$(CURDIR)/prometheus:/prometheus:ro" -w /prometheus/tests \
		--entrypoint promtool $(PROMETHEUS_IMAGE) test rules alerts.test.yml

check-config: ## Validate the Prometheus and Alertmanager configs
	docker run --rm -v "$(CURDIR)/prometheus:/etc/prometheus:ro" \
		--entrypoint promtool $(PROMETHEUS_IMAGE) check config /etc/prometheus/prometheus.yml
	docker run --rm -v "$(CURDIR)/alertmanager:/etc/alertmanager:ro" \
		--entrypoint amtool $(ALERTMANAGER_IMAGE) check-config /etc/alertmanager/alertmanager.yml

reload: ## Reload Prometheus config and rules without a restart
	curl -fsS -X POST http://localhost:9090/-/reload && echo "Prometheus reloaded"
