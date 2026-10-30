'use strict';

// Read-only concurrency check for the go-live gate (PRD §8.2): N virtual users
// repeatedly load the page-data endpoints with a real session and report latency
// percentiles and error rates. It never calls a write endpoint.
//
//   ERP_BASE_URL=https://erp-staging.example.com \
//   ERP_SESSION_COOKIE='__Host-erp_session=…'   (copy from a signed-in admin browser) \
//   USERS=25 DURATION_SECONDS=600 node scripts/load-test.js
//
// Optional: ENDPOINTS=/api/sheets/vessel-status,/api/sheets/export-summary  THINK_MS=1000

const BASE_URL = String(process.env.ERP_BASE_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const COOKIE = String(process.env.ERP_SESSION_COOKIE || '');
const USERS = Math.max(1, Number(process.env.USERS || 25));
const DURATION_MS = Math.max(5, Number(process.env.DURATION_SECONDS || 60)) * 1000;
const THINK_MS = Math.max(0, Number(process.env.THINK_MS || 1000));
const ENDPOINTS = (process.env.ENDPOINTS || [
  '/api/auth/me',
  '/api/sheets/vessel-status',
  '/api/sheets/vessel-contract',
  '/api/sheets/open-shipments',
  '/api/sheets/contract-dashboard?limit=80&offset=0',
  '/api/sheets/export-summary',
  '/api/sheets/stock-summary',
  '/api/sheets/weekly-ops-meeting',
  '/api/sheets/vessel-update?status=open',
].join(',')).split(',').map(value => value.trim()).filter(Boolean);

const stats = new Map(ENDPOINTS.map(endpoint => [endpoint, { latencies: [], errors: 0, statuses: {} }]));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function virtualUser(id, deadline) {
  let index = id % ENDPOINTS.length;
  while (Date.now() < deadline) {
    const endpoint = ENDPOINTS[index];
    index = (index + 1) % ENDPOINTS.length;
    const entry = stats.get(endpoint);
    const started = performance.now();
    try {
      const response = await fetch(`${BASE_URL}${endpoint}`, {
        headers: { cookie: COOKIE, 'accept-encoding': 'gzip' },
        signal: AbortSignal.timeout(30 * 1000),
      });
      await response.arrayBuffer();
      entry.latencies.push(performance.now() - started);
      entry.statuses[response.status] = (entry.statuses[response.status] || 0) + 1;
      if (response.status >= 400) entry.errors += 1;
    } catch (error) {
      entry.errors += 1;
      entry.statuses[error.name] = (entry.statuses[error.name] || 0) + 1;
    }
    await sleep(THINK_MS * (0.5 + Math.random()));
  }
}

async function main() {
  if (!COOKIE) console.warn('ERP_SESSION_COOKIE is not set: data endpoints will answer 401.');
  console.log(`Load test: ${USERS} users, ${DURATION_MS / 1000}s, think ${THINK_MS}ms, ${BASE_URL}`);
  const deadline = Date.now() + DURATION_MS;
  await Promise.all(Array.from({ length: USERS }, (_, id) => virtualUser(id, deadline)));

  let total = 0;
  let failed = 0;
  const all = [];
  const rows = [];
  for (const [endpoint, entry] of stats) {
    const sorted = [...entry.latencies].sort((a, b) => a - b);
    const count = Object.values(entry.statuses).reduce((sum, value) => sum + value, 0);
    total += count;
    failed += entry.errors;
    all.push(...sorted);
    rows.push({
      endpoint,
      requests: count,
      p50_ms: Math.round(percentile(sorted, 50)),
      p95_ms: Math.round(percentile(sorted, 95)),
      p99_ms: Math.round(percentile(sorted, 99)),
      errors: entry.errors,
      statuses: JSON.stringify(entry.statuses),
    });
  }
  console.table(rows);
  all.sort((a, b) => a - b);
  const p95 = percentile(all, 95);
  const errorRate = total ? failed / total : 1;
  console.log(`Overall: ${total} requests, p95 ${Math.round(p95)} ms, error rate ${(errorRate * 100).toFixed(2)} %`);
  const pass = p95 < 2000 && errorRate < 0.01;
  console.log(pass ? 'PASS (p95 < 2 s and errors < 1 %)' : 'FAIL (target: p95 < 2 s and errors < 1 %)');
  process.exitCode = pass ? 0 : 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
