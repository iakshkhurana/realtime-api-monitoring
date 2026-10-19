// Mixes normal traffic with slow and failing requests for long enough that
// APIHighLatencyP95 and APIHighErrorRate fire and reach Slack.   make chaos
// The baseline threshold is expected to fail: the point is to break the SLOs.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://api:3000';

export const options = {
  scenarios: {
    baseline: {
      executor: 'constant-vus',
      vus: 10,
      duration: '5m',
      exec: 'baseline',
    },
    slow_requests: {
      executor: 'constant-vus',
      vus: 20,
      duration: '4m',
      startTime: '30s',
      exec: 'slow',
    },
    failing_requests: {
      executor: 'constant-vus',
      vus: 10,
      duration: '4m',
      startTime: '30s',
      exec: 'flaky',
    },
  },
  thresholds: {
    'http_req_duration{scenario:baseline}': ['p(95)<500'],
  },
};

export function baseline() {
  const res = http.get(`${BASE_URL}/api/items`, { tags: { name: 'list items' } });
  check(res, { 'list: 200': (r) => r.status === 200 });
  sleep(0.2);
}

export function slow() {
  http.get(`${BASE_URL}/api/chaos/slow?ms=900`, { tags: { name: 'slow' } });
}

export function flaky() {
  http.get(`${BASE_URL}/api/chaos/flaky?rate=0.4`, { tags: { name: 'flaky' } });
  sleep(0.1);
}
