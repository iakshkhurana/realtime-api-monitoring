// Steady, realistic CRUD traffic. Stays under every alert threshold.   make load
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://api:3000';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '3m', target: 20 },
    { duration: '30s', target: 50 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

export default function () {
  const list = http.get(`${BASE_URL}/api/items`, { tags: { name: 'list items' } });
  check(list, { 'list: 200': (r) => r.status === 200 });

  const created = http.post(
    `${BASE_URL}/api/items`,
    JSON.stringify({ name: `item-${__VU}-${__ITER}` }),
    { ...JSON_HEADERS, tags: { name: 'create item' } },
  );
  check(created, { 'create: 201': (r) => r.status === 201 });

  if (created.status === 201) {
    const { id } = created.json();
    const fetched = http.get(`${BASE_URL}/api/items/${id}`, { tags: { name: 'get item' } });
    check(fetched, { 'get: 200': (r) => r.status === 200 });

    const deleted = http.del(`${BASE_URL}/api/items/${id}`, null, { tags: { name: 'delete item' } });
    check(deleted, { 'delete: 204': (r) => r.status === 204 });
  }

  sleep(Math.random() * 0.5 + 0.25);
}
