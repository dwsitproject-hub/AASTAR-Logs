'use strict';

// Roles (Admin -> Roles): every user has one role, and the role decides which
// pages they can open. A role's pages are written onto its members' accounts
// (users.is_admin / permissions / tab_permissions), which is what sign-in, page
// checks and realtime events read, so access changes apply on the next request.
// The built-in Administrator role grants every page plus the Admin Panel and
// cannot be edited or deleted.
const { DEPARTMENTS, TAB_PATHS, WHOLE_DEPARTMENTS } = require('../config/pages');

const ADMINISTRATOR = 'Administrator';
const ROLES_MIGRATION = '2026-11-roles';
const NAME_MAX = 60;
const DESCRIPTION_MAX = 200;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function parseList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function sorted(list) {
  return [...new Set(list)].sort();
}

// A department name stored for a department that has tabs means all its tabs.
function normalizeAccess(permissions, tabPermissions) {
  const tabs = new Set(tabPermissions.filter(path => TAB_PATHS.includes(path)));
  for (const name of permissions) {
    const department = DEPARTMENTS.find(item => item.dept === name);
    if (department?.tabs.length) department.tabs.forEach(path => tabs.add(path));
  }
  return {
    permissions: sorted(permissions.filter(name => WHOLE_DEPARTMENTS.includes(name))),
    tab_permissions: TAB_PATHS.filter(path => tabs.has(path)),
  };
}

// A readable name for generated roles that fits NAME_MAX: with page counts, then
// department names only, then a generic name (never cut mid-word).
function describeAccess(access) {
  const detailed = [];
  const plain = [];
  for (const department of DEPARTMENTS) {
    if (department.tabs.length) {
      const granted = department.tabs.filter(path => access.tab_permissions.includes(path)).length;
      if (!granted) continue;
      plain.push(department.label);
      detailed.push(granted === department.tabs.length ? department.label : `${department.label} (${granted} page${granted === 1 ? '' : 's'})`);
    } else if (access.permissions.includes(department.dept)) {
      plain.push(department.label);
      detailed.push(department.label);
    }
  }
  for (const name of [detailed.join(' + '), plain.join(' + ')]) {
    if (name.length <= NAME_MAX - 4) return name;
  }
  return 'Custom access';
}

function uniqueName(db, base) {
  const name = base.slice(0, NAME_MAX);
  if (!db.prepare('SELECT 1 FROM roles WHERE name = ? COLLATE NOCASE').get(name)) return name;
  for (let index = 2; ; index += 1) {
    const candidate = `${name.slice(0, NAME_MAX - 4)} #${index}`;
    if (!db.prepare('SELECT 1 FROM roles WHERE name = ? COLLATE NOCASE').get(candidate)) return candidate;
  }
}

function administratorRoleId(db) {
  return db.prepare('SELECT id FROM roles WHERE is_system = 1 AND is_admin = 1').get().id;
}

// Converts the access each user had before roles existed: admins get the
// Administrator role, and users with the same pages share one generated role.
function migrateExistingAccess(db) {
  const now = new Date().toISOString();
  const adminRoleId = administratorRoleId(db);
  const insertRole = db.prepare(`
    INSERT INTO roles (name, description, is_admin, is_system, permissions, tab_permissions, created_at, updated_at, updated_by)
    VALUES (?, ?, 0, 0, ?, ?, ?, ?, 'initial setup')
  `);
  const assign = db.prepare('UPDATE users SET role_id = ?, permissions = ?, tab_permissions = ? WHERE id = ?');
  const rolesByAccess = new Map();
  for (const user of db.prepare('SELECT id, is_admin, permissions, tab_permissions FROM users ORDER BY id').all()) {
    if (user.is_admin === 1) {
      db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(adminRoleId, user.id);
      continue;
    }
    const access = normalizeAccess(parseList(user.permissions), parseList(user.tab_permissions));
    if (!access.permissions.length && !access.tab_permissions.length) continue;
    const key = JSON.stringify(access);
    if (!rolesByAccess.has(key)) {
      const result = insertRole.run(
        uniqueName(db, describeAccess(access)),
        'Created from the access users had before roles; rename it as you like.',
        JSON.stringify(access.permissions),
        JSON.stringify(access.tab_permissions),
        now,
        now,
      );
      rolesByAccess.set(key, result.lastInsertRowid);
    }
    assign.run(rolesByAccess.get(key), JSON.stringify(access.permissions), JSON.stringify(access.tab_permissions), user.id);
  }
}

function initRoles(db, { recoveryEmail = '' } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      permissions TEXT NOT NULL DEFAULT '[]',
      tab_permissions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name_nocase ON roles (name COLLATE NOCASE);
  `);
  try { db.exec('ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id)'); } catch {}
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_role_id ON users (role_id)');

  if (!db.prepare('SELECT 1 FROM roles WHERE is_system = 1 AND is_admin = 1').get()) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO roles (name, description, is_admin, is_system, permissions, tab_permissions, created_at, updated_at, updated_by)
      VALUES (?, 'Every page, plus the Admin Panel: users, roles, spreadsheets.', 1, 1, '[]', '[]', ?, ?, 'initial setup')
    `).run(ADMINISTRATOR, now, now);
  }
  if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(ROLES_MIGRATION)) {
    db.transaction(() => {
      migrateExistingAccess(db);
      db.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)').run(ROLES_MIGRATION, new Date().toISOString());
    })();
  }
  // The recovery account always keeps the Administrator role.
  if (recoveryEmail) {
    db.prepare(`
      UPDATE users SET role_id = ?, is_admin = 1, is_approved = 1
      WHERE LOWER(TRIM(COALESCE(email, ''))) = ? AND (role_id IS NOT ? OR is_admin != 1 OR is_approved != 1)
    `).run(administratorRoleId(db), recoveryEmail, administratorRoleId(db));
  }
}

function roleRow(db, id) {
  return db.prepare('SELECT * FROM roles WHERE id = ?').get(id) || null;
}

function publicRole(role, userCount = 0) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    is_admin: role.is_admin === 1,
    is_system: role.is_system === 1,
    permissions: parseList(role.permissions),
    tab_permissions: parseList(role.tab_permissions),
    user_count: userCount,
    updated_at: role.updated_at,
    updated_by: role.updated_by,
  };
}

function listRoles(db) {
  const counts = new Map(db.prepare('SELECT role_id, COUNT(*) AS n FROM users WHERE role_id IS NOT NULL GROUP BY role_id').all()
    .map(row => [row.role_id, row.n]));
  return db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name COLLATE NOCASE').all()
    .map(role => publicRole(role, counts.get(role.id) || 0));
}

function validateRoleInput(db, input, currentId = null) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) throw httpError(400, 'A role name is required');
  if (name.length > NAME_MAX) throw httpError(400, `A role name has at most ${NAME_MAX} characters`);
  const clash = db.prepare('SELECT id FROM roles WHERE name = ? COLLATE NOCASE').get(name);
  if (clash && clash.id !== currentId) throw httpError(409, `A role named "${name}" already exists`);
  const description = typeof input?.description === 'string' ? input.description.trim().slice(0, DESCRIPTION_MAX) : '';
  const permissions = Array.isArray(input?.permissions) ? input.permissions : [];
  const tabPermissions = Array.isArray(input?.tab_permissions) ? input.tab_permissions : [];
  if ([...permissions, ...tabPermissions].some(value => typeof value !== 'string')) {
    throw httpError(400, 'Page access must be lists of department names and page paths');
  }
  if (permissions.includes('admin') || tabPermissions.some(path => path === '/admin' || path.startsWith('/admin/'))) {
    throw httpError(400, 'The Admin Panel comes only with the Administrator role');
  }
  const unknown = [
    ...permissions.filter(name => !WHOLE_DEPARTMENTS.includes(name)),
    ...tabPermissions.filter(path => !TAB_PATHS.includes(path)),
  ];
  if (unknown.length) throw httpError(400, `Unknown pages: ${unknown.join(', ')}`);
  const access = normalizeAccess(permissions, tabPermissions);
  if (!access.permissions.length && !access.tab_permissions.length) throw httpError(400, 'Give the role at least one page');
  return { name, description, ...access };
}

function createRole(db, input, actor) {
  const role = validateRoleInput(db, input);
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO roles (name, description, is_admin, is_system, permissions, tab_permissions, created_at, updated_at, updated_by)
    VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?)
  `).run(role.name, role.description, JSON.stringify(role.permissions), JSON.stringify(role.tab_permissions), now, now, actor);
  return publicRole(roleRow(db, result.lastInsertRowid));
}

function updateRole(db, id, input, actor) {
  const current = roleRow(db, id);
  if (!current) throw httpError(404, 'Role not found');
  if (current.is_system === 1) throw httpError(403, 'The Administrator role is built in and cannot be changed');
  const role = validateRoleInput(db, input, current.id);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE roles SET name = ?, description = ?, permissions = ?, tab_permissions = ?, updated_at = ?, updated_by = ?
      WHERE id = ?
    `).run(role.name, role.description, JSON.stringify(role.permissions), JSON.stringify(role.tab_permissions), now, actor, id);
    db.prepare(`
      UPDATE users SET permissions = ?, tab_permissions = ?, updated_at = CURRENT_TIMESTAMP WHERE role_id = ?
    `).run(JSON.stringify(role.permissions), JSON.stringify(role.tab_permissions), id);
  })();
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(id).n;
  return publicRole(roleRow(db, id), userCount);
}

function deleteRole(db, id) {
  const current = roleRow(db, id);
  if (!current) throw httpError(404, 'Role not found');
  if (current.is_system === 1) throw httpError(403, 'The Administrator role is built in and cannot be deleted');
  const members = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(id).n;
  if (members) throw httpError(409, `${members} user${members === 1 ? ' has' : 's have'} this role. Give them another role first.`);
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
}

// Columns written onto a user who gets this role (or no role).
function accessForRole(role) {
  if (!role) return { role_id: null, is_admin: 0, permissions: '[]', tab_permissions: '[]' };
  return {
    role_id: role.id,
    is_admin: role.is_admin === 1 ? 1 : 0,
    permissions: role.is_admin === 1 ? '[]' : role.permissions,
    tab_permissions: role.is_admin === 1 ? '[]' : role.tab_permissions,
  };
}

module.exports = {
  ADMINISTRATOR,
  accessForRole,
  administratorRoleId,
  createRole,
  deleteRole,
  describeAccess,
  initRoles,
  listRoles,
  normalizeAccess,
  roleRow,
  updateRole,
};
