'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

test('Google-only migration preserves existing approval and invalidates legacy sessions once', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-google-migration-'));
  const databasePath = path.join(directory, 'erp.db');
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      permissions TEXT DEFAULT '[]',
      email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (username, password, is_admin) VALUES ('Matthew', 'legacy-hash', 1);
    INSERT INTO users (username, email, password, is_admin, permissions)
    VALUES ('Other Admin', 'other.admin@kpn-corp.com', 'legacy-hash-2', 1, '["commercial","admin"]');
  `);
  db.close();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const databaseModule = path.join(__dirname, '../db/database.js');
  const script = `
    const database = require(${JSON.stringify(databaseModule)});
    database.initDb();
    database.initDb();
    const db = database.getDb();
    const user = db.prepare('SELECT username, email, password, is_admin, is_approved, auth_version FROM users WHERE username = ?').get('Matthew');
    const otherAdmin = db.prepare("SELECT password, is_admin, permissions, tab_permissions FROM users WHERE username = 'Other Admin'").get();
    db.prepare("INSERT INTO users (username) VALUES ('future-user')").run();
    const futureUser = db.prepare("SELECT password, is_admin, is_approved FROM users WHERE username = 'future-user'").get();
    const markerCount = db.prepare('SELECT COUNT(*) AS count FROM app_migrations WHERE name = ?').get('2026-08-google-only-auth').count;
    console.log(JSON.stringify({ user, otherAdmin, futureUser, markerCount }));
    db.close();
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH: databasePath },
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.user.email, 'matthew.chiu@kpn-corp.com');
  assert.equal(result.user.is_approved, 1);
  assert.equal(result.user.is_admin, 1);
  assert.equal(result.user.password, null);
  assert.equal(result.user.auth_version, 2);
  assert.equal(result.otherAdmin.password, null);
  assert.equal(result.otherAdmin.is_admin, 0);
  assert.equal(JSON.parse(result.otherAdmin.permissions).includes('admin'), false);
  assert.deepEqual(JSON.parse(result.otherAdmin.tab_permissions), ['/commercial/open-shipments', '/commercial/kpn-export']);
  assert.equal(result.futureUser.password, null);
  assert.equal(result.futureUser.is_admin, 0);
  assert.equal(result.futureUser.is_approved, 0);
  assert.equal(result.markerCount, 1);
});
