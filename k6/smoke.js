// Quick check that every endpoint responds.   make smoke
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://api:3000';

export const options = {
  vus: 1,
  iterations: 5,
  thresholds: { checks: ['rate==1'] },
};

export default function () {
  check(http.get(`${BASE_URL}/health`), { 'health: 200': (r) => r.status === 200 });
  check(http.get(`${BASE_URL}/api/items`), { 'items: 200': (r) => r.status === 200 });
  check(http.get(`${BASE_URL}/metrics`), {
    'metrics: exposes http_requests_total': (r) => r.body.includes('http_requests_total'),
  });
}
