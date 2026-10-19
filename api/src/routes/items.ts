import { Router } from 'express';
import { itemsInStore } from '../metrics';

interface Item {
  id: string;
  name: string;
  createdAt: string;
}

export const itemsRouter = Router();

// Simple in-memory store. Enough to give the API real CRUD traffic to measure.
const items = new Map<string, Item>();
let nextId = 1;

for (const name of ['keyboard', 'monitor', 'mouse']) {
  const id = String(nextId++);
  items.set(id, { id, name, createdAt: new Date().toISOString() });
}
itemsInStore.set(items.size);

itemsRouter.get('/', (_req, res) => {
  res.json([...items.values()]);
});

itemsRouter.get('/:id', (req, res) => {
  const item = items.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(item);
});

itemsRouter.post('/', (req, res) => {
  const name: unknown = req.body?.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: '"name" is required' });
  }
  const id = String(nextId++);
  const item: Item = { id, name: name.trim(), createdAt: new Date().toISOString() };
  items.set(id, item);
  itemsInStore.set(items.size);
  res.status(201).json(item);
});

itemsRouter.delete('/:id', (req, res) => {
  if (!items.delete(req.params.id)) {
    return res.status(404).json({ error: 'Item not found' });
  }
  itemsInStore.set(items.size);
  res.status(204).end();
});
