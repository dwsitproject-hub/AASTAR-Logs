'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('only Matthew delegates admins; delegates manage ordinary users without identity or role escalation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-delegated-admin-'));
  process.env.DB_PATH = path.join(directory, 'erp.db');
  process.env.USER_ACTIVITY_DB_PATH = path.join(directory, 'activity.db');

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { initDb, getDb } = require('../db/database');
  const { jwtSecret } = require('../config/config');
  const { requireAuth, requireMatthew } = require('../middleware/auth');
  const { SESSION_COOKIE_NAME } = require('../services/sessionCookie');
  const { stopUserActivity } = require('../services/userActivity');
  initDb();
  const db = getDb();
  const insert = db.prepare(`INSERT INTO users
    (username, email, google_sub, password, is_admin, is_approved, permissions, tab_permissions, auth_version)
    VALUES (?, ?, ?, NULL, ?, ?, '[]', '[]', 1)`);
  const owner = Number(insert.run('Matthew', 'matthew.chiu@kpn-corp.com', 'owner-sub', 1, 1).lastInsertRowid);
  const delegate = Number(insert.run('Delegate', 'delegate@kpn-corp.com', 'delegate-sub', 0, 0).lastInsertRowid);
  const ordinary = Number(insert.run('Ordinary', 'ordinary@kpn-corp.com', 'ordinary-sub', 0, 0).lastInsertRowid);
  const unlinked = Number(insert.run('Unlinked', 'unlinked@kpn-corp.com', null, 0, 0).lastInsertRowid);
  const row = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = id => jwt.sign({ id, auth_version: row(id).auth_version, jti: `test-${id}`, csrf: 'test-csrf' }, jwtSecret, { expiresIn: '5m' });
  const payload = (id, values = {}) => ({
    email: row(id).email, is_admin: false, is_approved: true,
    permissions: [], tab_permissions: ['/logistics/vessel-status'], ...values,
  });
  const app = express();
  app.use(express.json());
  app.use('/users', require('../routes/users'));
  app.get('/protected', requireAuth, (_req, res) => res.json({ ok: true }));
  app.get('/owner-only', requireAuth, requireMatthew, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    stopUserActivity();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (actor, method, endpoint, body, headers = {}) => fetch(`${base}${endpoint}`, {
    method, headers: { authorization: `Bearer ${token(actor)}`, 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const put = (actor, target, values) => request(actor, 'PUT', `/users/${target}`, payload(target, values));

  assert.equal((await put(owner, unlinked, { is_admin: true })).status, 400);
  assert.equal((await put(owner, delegate, { is_admin: true, is_approved: false })).status, 400);
  const pendingToken = token(delegate);
  assert.equal((await put(owner, delegate, { is_admin: true, tab_permissions: [] })).status, 200);
  assert.equal(row(delegate).is_admin, 1);
  assert.equal(row(delegate).auth_version, 2);
  assert.equal((await fetch(`${base}/protected`, { headers: { authorization: `Bearer ${pendingToken}` } })).status, 401);

  initDb();
  assert.equal(row(delegate).is_admin, 1, 'delegated role must survive restart');
  assert.equal((await request(delegate, 'GET', '/users')).status, 200);
  assert.equal((await request(delegate, 'GET', '/owner-only')).status, 403);
  assert.equal((await put(delegate, owner, {})).status, 403);
  assert.equal((await put(delegate, delegate, {})).status, 403);
  assert.equal((await put(delegate, ordinary, { is_admin: true })).status, 403);
  assert.equal((await put(delegate, ordinary, { email: 'different@kpn-corp.com' })).status, 403);
  assert.equal((await put(delegate, ordinary, { permissions: ['admin'] })).status, 400);
  assert.equal((await put(delegate, ordinary, { tab_permissions: ['/admin'] })).status, 400);
  assert.equal((await put(delegate, ordinary, { tab_permissions: [] })).status, 400);
  assert.equal((await request(delegate, 'DELETE', `/users/${ordinary}`)).status, 403);
  assert.equal(row(ordinary).auth_version, 1, 'rejected operations must not modify the account');

  const cookieHeaders = { authorization: '', cookie: `${SESSION_COOKIE_NAME}=${token(delegate)}` };
  assert.equal((await request(delegate, 'PUT', `/users/${ordinary}`, payload(ordinary), cookieHeaders)).status, 403);
  assert.equal((await request(delegate, 'PUT', `/users/${ordinary}`, payload(ordinary), { ...cookieHeaders, 'x-erp-csrf': 'test-csrf' })).status, 200);
  assert.equal(row(ordinary).is_approved, 1);
  assert.deepEqual(JSON.parse(row(ordinary).tab_permissions), ['/logistics/vessel-status']);
  assert.equal((await request(ordinary, 'GET', '/users')).status, 403);
  assert.equal((await put(ordinary, ordinary, { is_admin: true })).status, 403);
  assert.equal((await put(owner, ordinary, { email: 'outside@example.com' })).status, 400);
  assert.equal((await put(owner, ordinary, { email: 'matthew.chiu@kpn-corp.com' })).status, 403);
  assert.equal((await put(owner, ordinary, { email: 'changed@kpn-corp.com' })).status, 400);
  assert.equal((await put(owner, owner, { is_admin: false })).status, 400);
  assert.equal((await request(owner, 'DELETE', `/users/${owner}`)).status, 400);

  const delegatedToken = token(delegate);
  assert.equal((await put(owner, delegate, {})).status, 200);
  assert.equal(row(delegate).is_admin, 0);
  assert.equal((await fetch(`${base}/protected`, { headers: { authorization: `Bearer ${delegatedToken}` } })).status, 401);
  assert.equal((await request(delegate, 'GET', '/users')).status, 403);
  initDb();
  assert.equal(row(delegate).is_admin, 0, 'demotion must survive restart');
});
