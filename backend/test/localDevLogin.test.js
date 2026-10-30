'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { localDevLoginEmail } = require('../services/localDevLogin');

test('local dev sign-in is off by default and can never be enabled in production', () => {
  assert.equal(localDevLoginEmail({}), '');
  assert.equal(localDevLoginEmail({ LOCAL_DEV_LOGIN_EMAIL: ' Dev.Admin@Example.com ', NODE_ENV: 'development' }), 'dev.admin@example.com');
  assert.throws(() => localDevLoginEmail({ LOCAL_DEV_LOGIN_EMAIL: 'dev.admin@example.com', NODE_ENV: 'production' }), /NODE_ENV=production/);
  assert.throws(() => localDevLoginEmail({ LOCAL_DEV_LOGIN_EMAIL: 'not-an-email' }), /email address/);
});

test('seed:admin creates one approved administrator and the dev sign-in issues its session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-seed-admin-'));
  process.env.DB_PATH = path.join(directory, 'erp.db');
  process.env.USER_ACTIVITY_DB_PATH = path.join(directory, 'activity.db');
  process.env.LOGIN_SECURITY_DB_PATH = path.join(directory, 'login-security.db');
  process.env.LOCAL_DEV_LOGIN_EMAIL = 'dev.admin@example.com';

  const express = require('express');
  const { initDb, getDb } = require('../db/database');
  const { seedAdmin } = require('../scripts/seed-admin');
  const authRoutes = require('../routes/auth');
  const { SESSION_COOKIE_NAME } = require('../services/sessionCookie');
  const { stopUserActivity } = require('../services/userActivity');
  const { getLoginSecurityStore } = require('../services/loginSecurity');

  initDb();
  const db = getDb();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    stopUserActivity();
    getLoginSecurityStore().close?.();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const status = await (await fetch(`${baseUrl}/api/auth/access-status`)).json();
  assert.deepEqual(status.devLogin, { enabled: true, email: 'dev.admin@example.com' });

  const beforeSeed = await fetch(`${baseUrl}/api/auth/dev-login`, { method: 'POST' });
  assert.equal(beforeSeed.status, 403, 'no session before the account is seeded');
  assert.equal(beforeSeed.headers.get('set-cookie'), null);

  const created = seedAdmin(db, { email: 'Dev.Admin@Example.com', username: 'Dev Admin' });
  assert.equal(created.created, true);
  assert.equal(created.user.email, 'dev.admin@example.com');
  assert.equal(created.user.is_admin, 1);
  assert.equal(created.user.is_approved, 1);

  db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(created.user.id);
  const again = seedAdmin(db, { email: 'dev.admin@example.com' });
  assert.equal(again.created, false, 're-running promotes the same account');
  assert.equal(again.user.id, created.user.id);
  assert.equal(again.user.is_admin, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.throws(() => seedAdmin(db, { email: 'other@example.com', username: 'dev admin' }), /already taken/);
  assert.throws(() => seedAdmin(db, { email: 'nope' }), /valid email/);

  const response = await fetch(`${baseUrl}/api/auth/dev-login`, { method: 'POST' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.email, 'dev.admin@example.com');
  assert.equal(body.user.is_admin, true);
  assert.ok(body.csrfToken);
  assert.ok(response.headers.getSetCookie().some(value => value.startsWith(`${SESSION_COOKIE_NAME}=`)));
});
