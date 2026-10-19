import express, { type ErrorRequestHandler } from 'express';
import { metricsMiddleware } from './middleware/metrics';
import { itemsRouter } from './routes/items';
import { chaosRouter } from './routes/chaos';
import { register, appErrorsTotal } from './metrics';

export const app = express();

app.disable('x-powered-by');
app.use(express.json());
app.use(metricsMiddleware);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use('/api/items', itemsRouter);
app.use('/api/chaos', chaosRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  appErrorsTotal.inc({ type: err?.name ?? 'Error' });
  const status: number = err?.status ?? err?.statusCode ?? 500;
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
};
app.use(errorHandler);
