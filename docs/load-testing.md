# Load testing with k6

k6 runs as a Compose service under the `loadtest` profile, so `docker compose up` doesn't start it. It runs on the stack's network and hits `http://api:3000` directly.

```bash
make smoke    # 5 iterations, checks every endpoint responds
make load     # ~6 min of normal CRUD traffic up to 50 VUs; p95 < 500ms, errors < 1%
make chaos    # ~5 min of mixed traffic with slow (~900ms) and failing (40%) requests
```

Without `make`: `docker compose run --rm k6 run /scripts/<name>.js`.

## Scripts

| Script | Profile | Thresholds | Expected |
|---|---|---|---|
| [smoke.js](../k6/smoke.js) | 1 VU × 5 iterations on `/health`, `/api/items`, `/metrics` | `checks: rate==1` | passes |
| [load.js](../k6/load.js) | ramp to 20 VUs, hold 3 m, ramp to 50, hold 1 m, ramp down; each iteration does list → create → get → delete | `http_req_failed < 1 %`, `p(95) < 500 ms` | passes, **no alerts fire** |
| [chaos.js](../k6/chaos.js) | 10 VUs of normal traffic for 5 m, plus 20 VUs on `/slow?ms=900` and 10 VUs on `/flaky?rate=0.4` for 4 m starting at 30 s | threshold on the baseline scenario only (expected to fail) | **`APIHighLatencyP95` and `APIHighErrorRate` fire**, then resolve |

## Sizing the chaos mix

About 13 % of chaos requests are ~900 ms; p95 only needs more than 5 % of requests above the threshold to cross it. Roughly 20 % of requests return 500, above the 5 % error threshold. With `for: 1m` on the rules plus `group_wait: 10s`, Slack gets the message about 70 s into the run.

## Load run result

`make load` on the first real run: 69,020 requests over 5m30s at up to 50 VUs, 0 failed, p95 = 1.45 ms (threshold 500 ms), 17,255 full CRUD iterations. No alerts fired.

## What a chaos run looks like

Measured on the first real run:

| | Before | During chaos |
|---|---|---|
| Request rate | ~0 | 117 req/s |
| p95 latency | 5 ms | ~920–940 ms |
| 5xx ratio | 0 % | 23 % |
| Alerts | none | both `pending` at ~1 m, `firing` at ~2 m, routed to `slack-critical` / `slack-warnings` |
| After stopping | | both resolved ~90 s later, `[RESOLVED]` posted to the webhook |

See [dashboard.md](dashboard.md) and [alerting.md](alerting.md) for the screenshots.
