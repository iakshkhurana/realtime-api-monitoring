// Endpoints that misbehave on purpose, so the latency and error alerts can be
// triggered on demand during load tests.
import { Router } from 'express';
import { appErrorsTotal } from '../metrics';

export const chaosRouter = Router();

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

// GET /api/chaos/slow?ms=800 -> responds after ~ms (with +-25% jitter)
chaosRouter.get('/slow', (req, res) => {
  const base = clamp(Number(req.query.ms) || 800, 0, 10_000);
  const delay = Math.round(base * (0.75 + Math.random() * 0.5));
  setTimeout(() => res.json({ delayedMs: delay }), delay);
});

// GET /api/chaos/flaky?rate=0.3 -> returns 500 for `rate` fraction of requests.
// Responds directly instead of next(err): leaving the router through next()
// resets req.baseUrl, which would turn the route label into "/flaky".
chaosRouter.get('/flaky', (req, res) => {
  const rate = clamp(Number(req.query.rate ?? 0.3), 0, 1);
  if (Math.random() < rate) {
    appErrorsTotal.inc({ type: 'SimulatedFailure' });
    return res.status(500).json({ error: 'Simulated upstream failure' });
  }
  res.json({ ok: true });
});

// GET /api/chaos/cpu?ms=200 -> blocks the event loop for `ms`
chaosRouter.get('/cpu', (req, res) => {
  const duration = clamp(Number(req.query.ms) || 200, 0, 2_000);
  const end = Date.now() + duration;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(Math.random());
  res.json({ burnedMs: duration, checksum: Math.round(x) });
});
