'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('HttpOnly cookie sessions require CSRF for writes and keep bearer migration compatibility', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-cookie-session-'));
  process.env.DB_PATH = path.join(directory, 'erp.db');
  process.env.USER_ACTIVITY_DB_PATH = path.join(directory, 'activity.db');
  process.env.SESSION_AUDIT_HMAC_KEY = 'test-session-audit-hmac-key';

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { initDb, getDb } = require('../db/database');
  const { jwtSecret } = require('../config/config');
  const { requireAuth } = require('../middleware/auth');
  const {
    REMEMBER_SESSION_MAX_AGE_SECONDS,
    SESSION_COOKIE_NAME,
    clearSessionCookie,
    setSessionCookie,
  } = require('../services/sessionCookie');
  const { stopUserActivity } = require('../services/userActivity');

  initDb();
  const db = getDb();
  const userId = Number(db.prepare(`
    INSERT INTO users (
      username, email, password, is_admin, is_approved,
      permissions, tab_permissions, auth_version
    ) VALUES (?, ?, NULL, 0, 1, '[]', '[]', 1)
  `).run('Cookie User', 'cookie.user@kpn-corp.com').lastInsertRowid);
  const csrfToken = 'csrf-token-for-test';
  const token = jwt.sign(
    { id: userId, auth_version: 1, jti: 'cookie-session-test', csrf: csrfToken },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
  const cookieHeader = `${SESSION_COOKIE_NAME}=${token}`;

  const app = express();
  app.use(express.json());
  app.get('/cookie', (_req, res) => {
    setSessionCookie(res, token);
    res.json({ ok: true });
  });
  app.get('/remember-cookie', (_req, res) => {
    setSessionCookie(res, token, REMEMBER_SESSION_MAX_AGE_SECONDS);
    res.json({ ok: true });
  });
  app.get('/clear-cookie', (_req, res) => {
    clearSessionCookie(res);
    res.status(204).end();
  });
  app.get('/protected', requireAuth, (_req, res) => res.json({ ok: true }));
  app.post('/protected', requireAuth, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    stopUserActivity();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const issued = await fetch(`${baseUrl}/cookie`);
  const setCookie = issued.headers.get('set-cookie');
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=None/i);
  assert.match(setCookie, /Path=\//i);
  assert.match(setCookie, /Max-Age=28800/i);
  assert.equal(Object.hasOwn(await issued.json(), 'token'), false);

  const remembered = await fetch(`${baseUrl}/remember-cookie`);
  assert.match(remembered.headers.get('set-cookie'), /Max-Age=2592000/i);

  assert.equal((await fetch(`${baseUrl}/protected`, {
    headers: { cookie: cookieHeader },
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/protected`, {
    method: 'POST', headers: { cookie: cookieHeader },
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/protected`, {
    method: 'POST', headers: { cookie: cookieHeader, 'x-erp-csrf': 'wrong' },
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/protected`, {
    method: 'POST', headers: { cookie: cookieHeader, 'x-erp-csrf': csrfToken },
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/protected`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  })).status, 200);

  const invalid = await fetch(`${baseUrl}/protected`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=invalid` },
  });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get('set-cookie'), /Max-Age=0/i);
  const cleared = await fetch(`${baseUrl}/clear-cookie`);
  assert.match(cleared.headers.get('set-cookie'), /Max-Age=0/i);
});
