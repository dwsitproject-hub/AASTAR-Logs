'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DEPARTMENTS, TAB_PATHS } = require('../config/pages');

test('the server page list matches the sidebar (frontend/src/navConfig.js)', () => {
  const navConfig = fs.readFileSync(path.join(__dirname, '../../frontend/src/navConfig.js'), 'utf8');
  const sidebarTabs = [...navConfig.matchAll(/\{ label: '[^']+', path: '(\/[a-z-]+\/[a-z-]+)' \}/g)].map(match => match[1]);
  assert.deepEqual(sidebarTabs, TAB_PATHS);
  const sidebarDepartments = [...navConfig.matchAll(/dept: '([a-z]+)'/g)].map(match => match[1]);
  assert.deepEqual(sidebarDepartments, DEPARTMENTS.map(department => department.dept));
});

test('existing access becomes roles once: admins get Administrator, equal access shares a role', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-roles-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'erp.db');
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT,
      is_admin INTEGER DEFAULT 0, permissions TEXT DEFAULT '[]', tab_permissions TEXT DEFAULT '[]',
      email TEXT, google_sub TEXT, auth_version INTEGER NOT NULL DEFAULT 1, is_approved INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO users (username, email, is_admin, permissions, tab_permissions) VALUES
      ('Boss', 'boss@kpn-corp.com', 1, '[]', '[]'),
      ('Ann', 'ann@kpn-corp.com', 0, '[]', '["/logistics/vessel-status","/logistics/stock-summary"]'),
      ('Bob', 'bob@kpn-corp.com', 0, '[]', '["/logistics/stock-summary","/logistics/vessel-status"]'),
      ('Cat', 'cat@kpn-corp.com', 0, '["finance","commercial"]', '[]'),
      ('Dan', 'dan@kpn-corp.com', 0, '["commercial","finance"]', '["/operations/contract-dashboard","/operations/vessel-contract","/logistics/stock-summary","/chartering/export-planning"]'),
      ('New', 'new@kpn-corp.com', 0, '[]', '[]');
    UPDATE users SET is_approved = 0 WHERE username = 'New';
  `);
  const { initRoles, listRoles } = require('../services/roles');
  initRoles(db, { recoveryEmail: 'boss@kpn-corp.com' });
  initRoles(db, { recoveryEmail: 'boss@kpn-corp.com' });

  const user = name => db.prepare('SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE username = ?').get(name);
  assert.equal(user('Boss').role_name, 'Administrator');
  assert.equal(user('Ann').role_id, user('Bob').role_id, 'same pages, same role');
  assert.equal(user('Ann').role_name, 'Logistics (2 pages)');
  assert.equal(user('Cat').role_name, 'Commercial + Finance & Accounting', 'a department with tabs means all its tabs');
  assert.deepEqual(JSON.parse(user('Cat').tab_permissions), ['/commercial/open-shipments', '/commercial/kpn-export']);
  assert.deepEqual(JSON.parse(user('Cat').permissions), ['finance']);
  // Five departments do not fit 60 characters even without page counts.
  assert.equal(user('Dan').role_name, 'Custom access', 'too long a description becomes a generic name, never cut mid-word');
  assert.equal(user('New').role_id, null, 'users without access stay without a role');
  assert.equal(listRoles(db).length, 4, 'the migration runs once');
  db.close();
});

test('roles are validated, the Administrator role is locked, and edits reach every member', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-roles-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = new Database(path.join(directory, 'erp.db'));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, email TEXT, is_admin INTEGER DEFAULT 0,
      is_approved INTEGER DEFAULT 1, permissions TEXT DEFAULT '[]', tab_permissions TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  const { administratorRoleId, createRole, deleteRole, listRoles, updateRole } = require('../services/roles');
  require('../services/roles').initRoles(db);

  const status = fn => { try { fn(); return 'ok'; } catch (error) { return error.statusCode; } };
  assert.equal(status(() => createRole(db, { name: '', tab_permissions: ['/logistics/vessel-status'] }, 'a')), 400);
  assert.equal(status(() => createRole(db, { name: 'Empty', tab_permissions: [] }, 'a')), 400);
  assert.equal(status(() => createRole(db, { name: 'Sneaky', permissions: ['admin'] }, 'a')), 400);
  assert.equal(status(() => createRole(db, { name: 'Unknown', tab_permissions: ['/nowhere/page'] }, 'a')), 400);
  assert.equal(status(() => createRole(db, { name: 'administrator', permissions: ['finance'] }, 'a')), 409);

  const role = createRole(db, { name: 'Logistics desk', description: 'Daily ops', tab_permissions: ['/logistics/vessel-status'] }, 'admin@x');
  assert.equal(role.updated_by, 'admin@x');
  db.prepare("INSERT INTO users (username, role_id, tab_permissions) VALUES ('Member', ?, '[\"/logistics/vessel-status\"]')").run(role.id);

  const edited = updateRole(db, role.id, { name: 'Logistics desk', tab_permissions: ['/logistics/vessel-update', '/logistics/vessel-status'] }, 'admin@x');
  assert.deepEqual(edited.tab_permissions, ['/logistics/vessel-status', '/logistics/vessel-update'], 'kept in sidebar order');
  assert.equal(edited.user_count, 1);
  assert.deepEqual(JSON.parse(db.prepare("SELECT tab_permissions FROM users WHERE username = 'Member'").get().tab_permissions), edited.tab_permissions);

  assert.equal(status(() => updateRole(db, administratorRoleId(db), { name: 'Admins', permissions: ['finance'] }, 'a')), 403);
  assert.equal(status(() => deleteRole(db, administratorRoleId(db))), 403);
  assert.equal(status(() => deleteRole(db, role.id)), 409, 'a role with members cannot be deleted');
  db.prepare("DELETE FROM users WHERE username = 'Member'").run();
  assert.equal(status(() => deleteRole(db, role.id)), 'ok');
  assert.deepEqual(listRoles(db).map(item => item.name), ['Administrator']);
  db.close();
});
