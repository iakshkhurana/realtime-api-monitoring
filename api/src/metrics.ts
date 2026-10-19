import client from 'prom-client';

export const register = new client.Registry();
register.setDefaultLabels({ service: 'monitored-api' });

// Node.js runtime metrics: CPU, memory, heap, GC, event loop lag, handles.
client.collectDefaultMetrics({ register });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  // 0.5 must be a bucket edge: the p95 alert threshold is 500ms.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently being served',
  registers: [register],
});

export const appErrorsTotal = new client.Counter({
  name: 'app_errors_total',
  help: 'Total number of application errors',
  labelNames: ['type'] as const,
  registers: [register],
});

export const itemsInStore = new client.Gauge({
  name: 'app_items_in_store',
  help: 'Current number of items in the in-memory store',
  registers: [register],
});
