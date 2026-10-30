'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function waitForRejectedSocket(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Hostile WebSocket origin was not rejected')), 2000);
    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      finish();
    });
    socket.once('error', finish);
    socket.once('open', () => {
      clearTimeout(timeout);
      reject(new Error('Hostile WebSocket origin connected'));
    });
  });
}

test('WebSocket rejects hostile origins and accepts an authenticated same-origin client', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-websocket-security-'));
  process.env.DB_PATH = path.join(directory, 'erp.db');
  process.env.LOGIN_SECURITY_DB_PATH = path.join(directory, 'login-security.db');
  process.env.USER_ACTIVITY_DB_PATH = path.join(directory, 'activity.db');

  const jwt = require('jsonwebtoken');
  const { WebSocket } = require('ws');
  const { initDb, getDb } = require('../db/database');
  const { jwtSecret } = require('../config/config');
  const { attachRealtime, closeRealtime } = require('../services/realtime');
  const { SESSION_COOKIE_NAME } = require('../services/sessionCookie');
  const { getLoginSecurityStore } = require('../services/loginSecurity');
  const { stopUserActivity } = require('../services/userActivity');

  initDb();
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO users (
      username, email, password, is_admin, is_approved,
      permissions, tab_permissions, auth_version
    ) VALUES (?, ?, NULL, 0, 1, '[]', ?, 1)
  `).run('WebSocket User', 'websocket@kpn-corp.com', '["/logistics/vessel-status"]');
  const userId = Number(inserted.lastInsertRowid);
  const token = jwt.sign(
    { id: userId, auth_version: 1, jti: 'websocket-security-test' },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '5m' },
  );

  const server = http.createServer();
  attachRealtime(server, { allowedOrigins: new Set() });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;

  t.after(async () => {
    closeRealtime();
    await new Promise(resolve => server.close(resolve));
    getLoginSecurityStore().close();
    stopUserActivity();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const hostile = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
    origin: 'https://evil.example',
  });
  await waitForRejectedSocket(hostile);

  const sameOrigin = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
    origin: `http://127.0.0.1:${port}`,
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Authenticated WebSocket did not become ready')), 2000);
    sameOrigin.once('open', () => sameOrigin.send(JSON.stringify({ type: 'auth', token })));
    sameOrigin.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'ready') return;
      clearTimeout(timeout);
      resolve();
    });
    sameOrigin.once('error', reject);
  });
  sameOrigin.close();
  await new Promise(resolve => sameOrigin.once('close', resolve));

  const cookieAuthenticated = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
    origin: `http://127.0.0.1:${port}`,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Cookie-authenticated WebSocket did not become ready')), 2000);
    cookieAuthenticated.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'ready') return;
      clearTimeout(timeout);
      resolve();
    });
    cookieAuthenticated.once('error', reject);
  });
  cookieAuthenticated.close();
  await new Promise(resolve => cookieAuthenticated.once('close', resolve));
});
