const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { accessForRole, administratorRoleId, roleRow } = require('../services/roles');

// Admin -> User Management. Any administrator can add, edit and delete users;
// a user's pages come from their role (services/roles.js). Two accounts are
// protected: the recovery administrator (MATTHEW_EMAIL) and the admin's own.
const router = express.Router();
const MATTHEW_EMAIL = String(process.env.MATTHEW_EMAIL || 'matthew.chiu@kpn-corp.com').trim().toLowerCase();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isRecovery(email) {
  return String(email || '').trim().toLowerCase() === MATTHEW_EMAIL;
}

function fail(res, status, error) {
  return res.status(status).json({ error });
}

// Shared checks for create and edit. Returns { values } or { status, error }.
function validateUserInput(db, body, current = null) {
  const email = safeString(body?.email, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return { status: 400, error: 'Enter the email the user signs in with (DWS Hub or corporate Google)' };
  const username = safeString(body?.username, 120) || email;
  const isApproved = body?.is_approved === true;
  const roleId = body?.role_id === null || body?.role_id === undefined || body?.role_id === '' ? null : Number(body.role_id);
  const role = roleId === null ? null : roleRow(db, roleId);
  if (roleId !== null && !role) return { status: 400, error: 'Choose an existing role' };
  if (isApproved && !role) return { status: 400, error: 'Choose a role before approving this user' };

  const currentEmail = String(current?.email || '').trim().toLowerCase();
  if (current && (current.google_sub || current.hub_sub) && email !== currentEmail) {
    return { status: 400, error: 'A linked sign-in email cannot be changed' };
  }
  // The recovery account may be added (staging starts without it), but its email
  // cannot be moved onto someone else's existing account.
  if (current && isRecovery(email) && !isRecovery(currentEmail)) {
    return { status: 403, error: 'The recovery administrator email cannot be given to another user' };
  }
  if (!current && isRecovery(email) && !(role?.is_admin === 1 && isApproved)) {
    return { status: 400, error: 'Add the recovery administrator with the Administrator role and approved' };
  }
  const emailOwner = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (emailOwner && emailOwner.id !== current?.id) return { status: 409, error: 'Another user already has this email' };
  const nameOwner = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (nameOwner && nameOwner.id !== current?.id) return { status: 409, error: 'Another user already has this name' };
  return { values: { email, username, isApproved, role } };
}

router.get('/', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.google_sub, u.hub_sub, u.is_admin, u.is_approved,
           u.permissions, u.tab_permissions, u.created_at, u.role_id, r.name AS role_name
    FROM users u LEFT JOIN roles r ON r.id = u.role_id
    ORDER BY u.username COLLATE NOCASE
  `).all();
  res.json(users.map(u => ({
    ...u,
    permissions: JSON.parse(u.permissions || '[]'),
    tab_permissions: JSON.parse(u.tab_permissions || '[]'),
    is_admin: u.is_admin === 1,
    is_approved: u.is_approved === 1,
    is_recovery: isRecovery(u.email),
    google_linked: Boolean(u.google_sub),
    hub_linked: Boolean(u.hub_sub),
    google_sub: undefined,
    hub_sub: undefined,
  })));
});

// Adds a user before their first sign-in; DWS Hub or Google links the account by email.
router.post('/', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const checked = validateUserInput(db, req.body);
  if (checked.error) return fail(res, checked.status, checked.error);
  const { email, username, isApproved, role } = checked.values;
  const access = accessForRole(role);
  const result = db.prepare(`
    INSERT INTO users (username, email, password, role_id, is_admin, is_approved, permissions, tab_permissions, auth_version)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1)
  `).run(username, email, access.role_id, access.is_admin, isApproved ? 1 : 0, access.permissions, access.tab_permissions);
  res.status(201).json({ id: result.lastInsertRowid, message: 'User added' });
});

router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return fail(res, 404, 'User not found');
  const checked = validateUserInput(db, req.body, user);
  if (checked.error) return fail(res, checked.status, checked.error);
  const { email, username, isApproved, role } = checked.values;
  const keepsAdministrator = Boolean(role) && role.id === administratorRoleId(db) && isApproved;
  if (isRecovery(user.email) && !keepsAdministrator) {
    return fail(res, 400, 'The recovery account must stay approved with the Administrator role');
  }
  if (user.id === req.user.id && !keepsAdministrator) {
    return fail(res, 400, 'You cannot remove your own administrator access');
  }

  const access = accessForRole(role);
  db.prepare(`
    UPDATE users
    SET username = ?, email = ?, role_id = ?, is_admin = ?, is_approved = ?, permissions = ?, tab_permissions = ?,
        auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(username, email, access.role_id, access.is_admin, isApproved ? 1 : 0, access.permissions, access.tab_permissions, user.id);
  res.json({ message: 'User updated' });
});

router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
  if (!user) return fail(res, 404, 'User not found');
  if (user.id === req.user.id) return fail(res, 400, 'You cannot delete your own account');
  if (isRecovery(user.email)) return fail(res, 403, 'The recovery administrator account cannot be deleted');
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  res.json({ message: 'User deleted' });
});

module.exports = router;
