'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('pending sessions are rejected and delegated admins can approve assigned access', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-account-approval-'));
  process.env.DB_PATH = path.join(directory, 'erp.db');
  process.env.USER_ACTIVITY_DB_PATH = path.join(directory, 'activity.db');

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { initDb, getDb } = require('../db/database');
  const { jwtSecret } = require('../config/config');
  const { requireAuth } = require('../middleware/auth');
  const usersRoutes = require('../routes/users');
  const { stopUserActivity } = require('../services/userActivity');

  initDb();
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO users (
      username, email, password, is_admin, is_approved,
      permissions, tab_permissions, auth_version
    ) VALUES (?, ?, 'unused', ?, ?, ?, ?, 1)
  `);
  const matthewId = Number(insert.run(
    'Matthew', 'matthew.chiu@kpn-corp.com', 1, 1, '["admin"]', '[]',
  ).lastInsertRowid);
  const otherAdminId = Number(insert.run(
    'Other Admin', 'other.admin@kpn-corp.com', 1, 1, '["admin"]', '[]',
  ).lastInsertRowid);
  const pendingId = Number(insert.run(
    'Pending User', 'pending@kpn-corp.com', 0, 0, '[]', '[]',
  ).lastInsertRowid);

  const tokenFor = id => jwt.sign({ id, auth_version: 1, jti: `test-${id}` }, jwtSecret, { expiresIn: '5m' });
  const app = express();
  app.use(express.json());
  app.get('/protected', requireAuth, (_req, res) => res.json({ ok: true }));
  app.use('/api/users', usersRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    stopUserActivity();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const pendingResponse = await fetch(`${baseUrl}/protected`, {
    headers: { authorization: `Bearer ${tokenFor(pendingId)}` },
  });
  assert.equal(pendingResponse.status, 403);
  assert.equal((await pendingResponse.json()).code, 'ACCOUNT_PENDING');

  const payload = {
    email: 'pending@kpn-corp.com',
    is_admin: false,
    is_approved: true,
    permissions: [],
    tab_permissions: ['/logistics/vessel-status'],
  };
  const otherAdminResponse = await fetch(`${baseUrl}/api/users/${pendingId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tokenFor(otherAdminId)}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(otherAdminResponse.status, 200);

  const noAccessResponse = await fetch(`${baseUrl}/api/users/${pendingId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tokenFor(matthewId)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, tab_permissions: [] }),
  });
  assert.equal(noAccessResponse.status, 400);

  const nonMatthewAdminResponse = await fetch(`${baseUrl}/api/users/${pendingId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tokenFor(matthewId)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, is_admin: true }),
  });
  assert.equal(nonMatthewAdminResponse.status, 400);

  const approvedResponse = await fetch(`${baseUrl}/api/users/${pendingId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tokenFor(matthewId)}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(approvedResponse.status, 200);
  const approved = db.prepare('SELECT is_approved, tab_permissions, auth_version FROM users WHERE id = ?').get(pendingId);
  assert.equal(approved.is_approved, 1);
  assert.deepEqual(JSON.parse(approved.tab_permissions), ['/logistics/vessel-status']);
  assert.equal(approved.auth_version, 3);

  initDb();
  const afterRestart = db.prepare('SELECT permissions, tab_permissions FROM users WHERE id = ?').get(pendingId);
  assert.deepEqual(JSON.parse(afterRestart.permissions), []);
  assert.deepEqual(JSON.parse(afterRestart.tab_permissions), ['/logistics/vessel-status']);
});
