import type { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDuration, httpRequestsInFlight } from '../metrics';

const EXCLUDED = new Set(['/metrics', '/health']);

// Label by route template (/api/items/:id), never the raw URL, so the number
// of label combinations stays small no matter how many items exist.
function routeLabel(req: Request): string {
  return req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (EXCLUDED.has(req.path)) return next();

  const stopTimer = httpRequestDuration.startTimer();
  httpRequestsInFlight.inc();

  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status_code: String(res.statusCode),
    };
    stopTimer(labels);
    httpRequestsTotal.inc(labels);
    httpRequestsInFlight.dec();
  });

  next();
}
