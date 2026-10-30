'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

test('password authentication never issues a session and the fourth attempt is decoyed', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-password-disabled-'));
  process.env.LOGIN_SECURITY_DB_PATH = path.join(directory, 'login-security.db');
  process.env.USER_ACTIVITY_DB_PATH = path.join(directory, 'activity.db');
  process.env.PASSWORD_AUDIT_HMAC_KEY = 'test-only-password-audit-key';

  const express = require('express');
  const authRoutes = require('../routes/auth');
  const { getLoginSecurityStore } = require('../services/loginSecurity');
  const { stopUserActivity } = require('../services/userActivity');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    getLoginSecurityStore().close();
    stopUserActivity();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const port = server.address().port;
  const gate = () => fetch(`http://127.0.0.1:${port}/api/auth/gate`, {
    headers: { 'x-forwarded-for': '203.0.113.90' },
  });
  const submit = () => fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.90' },
    body: JSON.stringify({ username: 'Matthew', password: 'historical-password' }),
  });

  assert.equal((await gate()).status, 204);

  const pageVisit = await fetch(`http://127.0.0.1:${port}/api/auth/page-visit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.90' },
    body: JSON.stringify({ page: 'login', referrer: 'https://example.test/' }),
  });
  assert.equal(pageVisit.status, 204);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await submit();
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.token, undefined);
    assert.equal(body.error, 'Invalid credentials');
  }

  const blockedResponse = await submit();
  const blockedBody = await blockedResponse.json();
  assert.equal(blockedResponse.status, 200);
  assert.equal(blockedBody.decoy, true);
  assert.equal(blockedBody.token, undefined);
  assert.equal((await gate()).status, 403);

  const auditDb = new Database(process.env.USER_ACTIVITY_DB_PATH, { readonly: true });
  const authEvents = auditDb.prepare('SELECT * FROM authentication_events ORDER BY id').all();
  const visits = auditDb.prepare('SELECT * FROM page_visit_events ORDER BY id').all();
  auditDb.close();
  assert.equal(authEvents.length, 4);
  assert.equal(new Set(authEvents.map(row => row.credential_fingerprint)).size, 1);
  assert.equal(authEvents[0].credential_length, 19);
  assert.equal(authEvents[0].credential_pattern, 'L10-S1-L8;common-term');
  assert.equal(JSON.stringify(authEvents).includes('historical-password'), false);
  assert.equal(visits.length, 1);
  assert.equal(visits[0].page, 'login');
});
