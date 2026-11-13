'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('admins add, edit and delete users; the recovery account and their own admin access are protected', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-user-management-'));
  process.env.DB_PATH = path.join(directory, 'erp.db');
  process.env.USER_ACTIVITY_DB_PATH = path.join(directory, 'activity.db');

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { initDb, getDb } = require('../db/database');
  const { jwtSecret } = require('../config/config');
  const { requireAuth } = require('../middleware/auth');
  const { SESSION_COOKIE_NAME } = require('../services/sessionCookie');
  const { administratorRoleId, createRole } = require('../services/roles');
  const { stopUserActivity } = require('../services/userActivity');
  initDb();
  const db = getDb();
  const adminRole = administratorRoleId(db);
  const viewers = createRole(db, { name: 'Vessel viewers', tab_permissions: ['/logistics/vessel-status'] }, 'test');
  const finance = createRole(db, { name: 'Finance', permissions: ['finance'] }, 'test');
  const insert = db.prepare(`INSERT INTO users
    (username, email, hub_sub, password, role_id, is_admin, is_approved, permissions, tab_permissions, auth_version)
    VALUES (?, ?, ?, NULL, ?, ?, ?, '[]', '[]', 1)`);
  const owner = Number(insert.run('Matthew', 'matthew.chiu@kpn-corp.com', 'owner-sub', adminRole, 1, 1).lastInsertRowid);
  const delegate = Number(insert.run('Delegate', 'delegate@kpn-corp.com', 'delegate-sub', null, 0, 0).lastInsertRowid);
  const ordinary = Number(insert.run('Ordinary', 'ordinary@kpn-corp.com', 'ordinary-sub', viewers.id, 0, 1).lastInsertRowid);
  const row = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = id => jwt.sign({ id, auth_version: row(id).auth_version, jti: `test-${id}`, csrf: 'test-csrf' }, jwtSecret, { expiresIn: '5m' });
  const body = (id, values = {}) => ({ email: row(id).email, username: row(id).username, role_id: row(id).role_id, is_approved: row(id).is_approved === 1, ...values });

  const app = express();
  app.use(express.json());
  app.use('/users', require('../routes/users'));
  app.get('/protected', requireAuth, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    stopUserActivity();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (actor, method, endpoint, payload, headers = {}) => fetch(`${base}${endpoint}`, {
    method, headers: { authorization: `Bearer ${token(actor)}`, 'content-type': 'application/json', ...headers },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const put = (actor, target, values) => request(actor, 'PUT', `/users/${target}`, body(target, values));

  // Making someone an administrator = giving them the Administrator role; old sessions end.
  const pendingToken = token(delegate);
  assert.equal((await put(owner, delegate, { role_id: adminRole, is_approved: true })).status, 200);
  assert.equal(row(delegate).is_admin, 1);
  assert.equal(row(delegate).auth_version, 2);
  assert.equal((await fetch(`${base}/protected`, { headers: { authorization: `Bearer ${pendingToken}` } })).status, 401);
  initDb();
  assert.equal(row(delegate).is_admin, 1, 'the role survives a restart');

  // Any admin manages users, including other admins...
  const listed = await (await request(delegate, 'GET', '/users')).json();
  assert.equal(listed.find(user => user.id === owner).is_recovery, true);
  assert.equal(listed.find(user => user.id === ordinary).role_name, 'Vessel viewers');
  assert.equal((await put(delegate, ordinary, { role_id: finance.id, username: 'Ordinary Person' })).status, 200);
  assert.equal(row(ordinary).username, 'Ordinary Person');
  assert.deepEqual(JSON.parse(row(ordinary).permissions), ['finance']);
  assert.deepEqual(JSON.parse(row(ordinary).tab_permissions), []);

  // ...adds users before their first sign-in...
  const added = await request(delegate, 'POST', '/users', { email: 'New.Person@Energi-Up.com', username: 'New Person', role_id: viewers.id, is_approved: true });
  assert.equal(added.status, 201);
  const addedId = Number((await added.json()).id);
  assert.equal(row(addedId).email, 'new.person@energi-up.com');
  assert.deepEqual(JSON.parse(row(addedId).tab_permissions), ['/logistics/vessel-status']);
  assert.equal((await request(delegate, 'POST', '/users', { email: 'new.person@energi-up.com', role_id: viewers.id })).status, 409);
  assert.equal((await request(delegate, 'POST', '/users', { email: 'not-an-email', role_id: viewers.id })).status, 400);
  assert.equal((await request(delegate, 'POST', '/users', { email: 'x@kpn-corp.com', is_approved: true })).status, 400, 'approval needs a role');
  assert.equal((await request(delegate, 'POST', '/users', { email: 'matthew.chiu@kpn-corp.com', role_id: adminRole, is_approved: true })).status, 409, 'the recovery account already exists');

  // ...and deletes them.
  assert.equal((await request(delegate, 'DELETE', `/users/${addedId}`)).status, 200);
  assert.equal(row(addedId), undefined);

  // Protected: the recovery account, one's own admin access, linked emails.
  assert.equal((await put(delegate, owner, { role_id: viewers.id })).status, 400);
  assert.equal((await put(delegate, owner, { is_approved: false })).status, 400);
  assert.equal((await request(delegate, 'DELETE', `/users/${owner}`)).status, 403);
  assert.equal((await put(delegate, delegate, { role_id: viewers.id })).status, 400);
  assert.equal((await request(delegate, 'DELETE', `/users/${delegate}`)).status, 400);
  assert.equal((await put(delegate, ordinary, { email: 'different@kpn-corp.com' })).status, 400);
  const unlinked = Number((await (await request(delegate, 'POST', '/users', { email: 'unlinked@kpn-corp.com', role_id: viewers.id })).json()).id);
  assert.equal((await put(delegate, unlinked, { email: 'renamed@kpn-corp.com' })).status, 200, 'an unlinked email can be corrected');
  assert.equal((await put(delegate, unlinked, { email: 'matthew.chiu@kpn-corp.com' })).status, 403);
  assert.equal((await put(delegate, ordinary, { username: 'Matthew' })).status, 409);
  const ordinaryVersion = row(ordinary).auth_version;

  // Writes need the CSRF header when the session is a cookie.
  const cookieHeaders = { authorization: '', cookie: `${SESSION_COOKIE_NAME}=${token(delegate)}` };
  assert.equal((await request(delegate, 'PUT', `/users/${ordinary}`, body(ordinary), cookieHeaders)).status, 403);
  assert.equal(row(ordinary).auth_version, ordinaryVersion, 'rejected operations do not modify the account');
  assert.equal((await request(delegate, 'PUT', `/users/${ordinary}`, body(ordinary), { ...cookieHeaders, 'x-erp-csrf': 'test-csrf' })).status, 200);

  // Non-admins cannot manage users.
  assert.equal((await request(ordinary, 'GET', '/users')).status, 403);
  assert.equal((await put(ordinary, ordinary, { role_id: adminRole })).status, 403);

  // An admin can demote another admin; the demotion revokes sessions and survives a restart.
  const delegateToken = token(delegate);
  assert.equal((await put(owner, delegate, { role_id: viewers.id })).status, 200);
  assert.equal(row(delegate).is_admin, 0);
  assert.equal((await fetch(`${base}/protected`, { headers: { authorization: `Bearer ${delegateToken}` } })).status, 401);
  assert.equal((await request(delegate, 'GET', '/users')).status, 403);
  initDb();
  assert.equal(row(delegate).is_admin, 0);
  assert.equal(row(owner).role_id, adminRole, 'the recovery account keeps the Administrator role');
});
