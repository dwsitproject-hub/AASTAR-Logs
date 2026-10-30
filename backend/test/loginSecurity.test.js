'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { LoginSecurityStore } = require('../services/loginSecurity');

function temporaryStore(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-login-security-'));
  const store = new LoginSecurityStore({
    databasePath: path.join(directory, 'security.db'),
    activityDatabasePath: path.join(directory, 'missing-activity.db'),
    failureLimit: 4,
    ...options,
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store };
}

test('an IP is persistently blocked on its fourth failed login', t => {
  const { store } = temporaryStore(t);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const status = store.recordFailure('203.0.113.18', 'Admin');
    assert.equal(status.failedAttempts, attempt);
    assert.equal(status.isBlocked, false);
  }
  const blocked = store.recordFailure('203.0.113.18', 'Admin');
  assert.equal(blocked.failedAttempts, 4);
  assert.equal(blocked.isBlocked, true);

  store.recordSuccess('203.0.113.18');
  assert.equal(store.status('203.0.113.18').isBlocked, true);
  assert.equal(store.listBlocked().length, 1);
});

test('unlocking clears the block and starts a fresh failure count', t => {
  const { store } = temporaryStore(t);
  for (let attempt = 0; attempt < 4; attempt += 1) store.recordFailure('198.51.100.9', 'test');
  assert.equal(store.unlock('198.51.100.9', 'Matthew'), true);
  assert.equal(store.status('198.51.100.9').isBlocked, false);
  assert.equal(store.status('198.51.100.9').failedAttempts, 0);
  assert.equal(store.recordFailure('198.51.100.9', 'test').failedAttempts, 1);
});

test('whitelisted IPs remain unblocked and persist across store reopen', t => {
  const { store } = temporaryStore(t);
  const ip = '203.0.113.77';
  const entry = store.allowlist(ip, 'Singapore office', 'Matthew');
  assert.equal(entry.ip_address, ip);
  assert.equal(entry.label, 'Singapore office');

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const status = store.recordFailure(ip, 'dummy');
    assert.equal(status.isAllowlisted, true);
    assert.equal(status.isBlocked, false);
    assert.equal(status.failedAttempts, 0);
  }

  store.close();
  assert.equal(store.status(ip).isAllowlisted, true);
  assert.equal(store.listAllowlisted().length, 1);
});

test('whitelisting clears an existing block and removal restores lockout counting', t => {
  const { store } = temporaryStore(t);
  const ip = '198.51.100.28';
  for (let attempt = 0; attempt < 4; attempt += 1) store.recordFailure(ip, 'dummy');
  assert.equal(store.status(ip).isBlocked, true);

  store.allowlist(ip, '', 'Matthew');
  assert.equal(store.status(ip).isBlocked, false);
  assert.equal(store.listBlocked().length, 0);
  assert.equal(store.removeAllowlist(ip), true);
  assert.equal(store.recordFailure(ip, 'dummy').failedAttempts, 1);
});

test('historical IPs with at least four failures are imported once', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-login-history-'));
  const activityPath = path.join(directory, 'activity.db');
  const activityDb = new Database(activityPath);
  activityDb.exec(`
    CREATE TABLE failed_login_attempts (
      occurred_at TEXT NOT NULL,
      username TEXT,
      ip_address TEXT NOT NULL
    );
  `);
  const insert = activityDb.prepare('INSERT INTO failed_login_attempts VALUES (?, ?, ?)');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    insert.run(`2026-08-28T00:0${attempt}:00.000Z`, 'Admin', '192.0.2.44');
  }
  activityDb.close();

  const store = new LoginSecurityStore({
    databasePath: path.join(directory, 'security.db'),
    activityDatabasePath: activityPath,
    failureLimit: 4,
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(store.status('192.0.2.44').isBlocked, true);
  assert.equal(store.status('192.0.2.44').failedAttempts, 5);
  store.unlock('192.0.2.44', 'Matthew');
  store.close();
  assert.equal(store.status('192.0.2.44').isBlocked, false);
});
