'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  hasAssignedAccess,
  isAllowedGoogleIdentity,
  provisionGoogleUser,
} = require('../services/googleAccountAccess');

function temporaryUsers(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-google-users-'));
  const db = new Database(path.join(directory, 'users.db'));
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      google_sub TEXT,
      password TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_approved INTEGER NOT NULL DEFAULT 1,
      permissions TEXT NOT NULL DEFAULT '[]',
      tab_permissions TEXT NOT NULL DEFAULT '[]',
      auth_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_users_email_nocase ON users (email COLLATE NOCASE) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX idx_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;
  `);
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test('Google identity requires a verified exact corporate email and hosted domain', () => {
  const valid = { email_verified: true, email: 'user@kpn-corp.com', hd: 'kpn-corp.com', sub: 'google-1' };
  assert.equal(isAllowedGoogleIdentity(valid, 'kpn-corp.com'), true);
  assert.equal(isAllowedGoogleIdentity({ ...valid, email: 'user@other.com' }, 'kpn-corp.com'), false);
  assert.equal(isAllowedGoogleIdentity({ ...valid, hd: 'other.com' }, 'kpn-corp.com'), false);
  assert.equal(isAllowedGoogleIdentity({ ...valid, email_verified: false }, 'kpn-corp.com'), false);
});

test('unknown corporate Google users are created pending with zero access', t => {
  const db = temporaryUsers(t);
  db.prepare(`INSERT INTO users (username, password) VALUES ('alice', 'legacy-hash')`).run();

  const result = provisionGoogleUser(db, { email: 'alice@kpn-corp.com', subject: 'google-alice' });
  assert.equal(result.created, true);
  assert.equal(result.conflict, false);
  assert.equal(result.user.username, 'alice@kpn-corp.com');
  assert.equal(result.user.is_approved, 0);
  assert.equal(result.user.permissions, '[]');
  assert.equal(result.user.tab_permissions, '[]');
  assert.equal(result.user.password, null);
  assert.notEqual(result.user.id, db.prepare(`SELECT id FROM users WHERE username = 'alice'`).get().id);
});

test('an exact pre-linked email keeps its approval and permissions', t => {
  const db = temporaryUsers(t);
  db.prepare(`
    INSERT INTO users (username, email, password, is_approved, permissions)
    VALUES ('Operations', 'ops@kpn-corp.com', 'legacy-hash', 1, '["finance"]')
  `).run();

  const result = provisionGoogleUser(db, { email: 'ops@kpn-corp.com', subject: 'google-ops' });
  assert.equal(result.created, false);
  assert.equal(result.user.is_approved, 1);
  assert.equal(result.user.google_sub, 'google-ops');
  assert.deepEqual(JSON.parse(result.user.permissions), ['finance']);
});

test('a changed Google subject for an already linked email requires review', t => {
  const db = temporaryUsers(t);
  db.prepare(`
    INSERT INTO users (username, email, google_sub, password)
    VALUES ('User', 'user@kpn-corp.com', 'original-subject', 'legacy-hash')
  `).run();

  const result = provisionGoogleUser(db, { email: 'user@kpn-corp.com', subject: 'replacement-subject' });
  assert.equal(result.conflict, true);
  assert.equal(result.user, null);
});

test('approval requires administrator status or at least one assigned page', () => {
  assert.equal(hasAssignedAccess({ is_admin: 0, permissions: '[]', tab_permissions: '[]' }), false);
  assert.equal(hasAssignedAccess({ is_admin: 0, permissions: '["finance"]', tab_permissions: '[]' }), true);
  assert.equal(hasAssignedAccess({ is_admin: 0, permissions: '[]', tab_permissions: '["/logistics/vessel-status"]' }), true);
  assert.equal(hasAssignedAccess({ is_admin: 1, permissions: '[]', tab_permissions: '[]' }), true);
});
