const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth, requireAdmin, requireMatthew } = require('../middleware/auth');
const { hasAssignedAccess } = require('../services/googleAccountAccess');

const router = express.Router();
const ALLOWED_GOOGLE_DOMAIN = String(process.env.GOOGLE_ALLOWED_DOMAIN || 'kpn-corp.com').trim().toLowerCase();
const MATTHEW_EMAIL = String(process.env.MATTHEW_EMAIL || 'matthew.chiu@kpn-corp.com').trim().toLowerCase();

function safeString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeEmail(value, currentEmail = '') {
  const email = safeString(value, 254).toLowerCase();
  if (!email) return null;
  // An identity already verified by DWS Hub may use another corporate domain.
  if (email === String(currentEmail || '').trim().toLowerCase()) return email;
  if (!email.endsWith(`@${ALLOWED_GOOGLE_DOMAIN}`)) return false;
  return email;
}

router.get('/', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT id, username, email, google_sub, hub_sub, is_admin, is_approved, permissions, tab_permissions, created_at
    FROM users
    ORDER BY username COLLATE NOCASE
  `).all();
  res.json(users.map(u => ({
    ...u,
    permissions: JSON.parse(u.permissions || '[]'),
    tab_permissions: JSON.parse(u.tab_permissions || '[]'),
    is_admin: u.is_admin === 1,
    is_approved: u.is_approved === 1,
    google_linked: Boolean(u.google_sub),
    hub_linked: Boolean(u.hub_sub),
    google_sub: undefined,
    hub_sub: undefined,
  })));
});

router.post('/', requireAuth, requireAdmin, requireMatthew, (_req, res) => {
  res.status(405).json({ error: 'Users are created through corporate Google sign-in' });
});

router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  const isOwner = String(req.user.email || '').trim().toLowerCase() === MATTHEW_EMAIL;
  const isApproved = req.body?.is_approved === true;
  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const tabPermissions = Array.isArray(req.body?.tab_permissions) ? req.body.tab_permissions : [];
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const email = normalizeEmail(req.body?.email, user.email);
  const identityLinked = Boolean(user.google_sub || user.hub_sub);
  if (email === false) return res.status(400).json({ error: `Google email must use @${ALLOWED_GOOGLE_DOMAIN}` });
  const targetIsOwner = String(user.email || '').trim().toLowerCase() === MATTHEW_EMAIL;
  const isAdmin = req.body?.is_admin === true;
  if (!isOwner && (user.is_admin === 1 || targetIsOwner || user.id === req.user.id || isAdmin)) {
    return res.status(403).json({ error: 'Only Matthew can manage administrator accounts' });
  }
  if (!isOwner && email !== String(user.email || '').trim().toLowerCase()) {
    return res.status(403).json({ error: 'Only Matthew can change a corporate Google identity' });
  }
  if (!targetIsOwner && email === MATTHEW_EMAIL) {
    return res.status(403).json({ error: 'The Matthew recovery identity cannot be reassigned' });
  }
  if (isAdmin && !targetIsOwner && (!email || !identityLinked || !isApproved)) {
    return res.status(400).json({ error: 'An administrator must have a linked DWS Hub or corporate Google account and approved access' });
  }
  if (permissions.some(value => typeof value !== 'string') || tabPermissions.some(value => typeof value !== 'string')) {
    return res.status(400).json({ error: 'Permissions must be lists of names and page paths' });
  }
  if (!isAdmin && (permissions.includes('admin') || tabPermissions.some(value => value === '/admin' || value.startsWith('/admin/')))) {
    return res.status(400).json({ error: 'Use the administrator role to grant Admin Panel access' });
  }
  if (identityLinked && email !== String(user.email || '').toLowerCase()) {
    return res.status(400).json({ error: 'A linked sign-in email cannot be changed' });
  }
  if (isApproved && !hasAssignedAccess({
    is_admin: isAdmin,
    permissions: JSON.stringify(permissions),
    tab_permissions: JSON.stringify(tabPermissions),
  })) {
    return res.status(400).json({ error: 'Assign at least one page before approving this user' });
  }

  if (parseInt(req.params.id, 10) === req.user.id && (!isAdmin || !isApproved)) {
    return res.status(400).json({ error: 'Cannot disable your own administrator access' });
  }
  if (String(user.email || '').toLowerCase() === MATTHEW_EMAIL && (!isAdmin || !isApproved)) {
    return res.status(400).json({ error: 'The Matthew recovery account must remain approved as an administrator' });
  }

  try {
    db.prepare(`
      UPDATE users
      SET email = ?, is_admin = ?, is_approved = ?, permissions = ?, tab_permissions = ?,
          auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      email,
      isAdmin ? 1 : 0,
      isApproved ? 1 : 0,
      JSON.stringify(permissions),
      JSON.stringify(tabPermissions),
      req.params.id,
    );
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Google email already belongs to another user' });
    throw error;
  }

  res.json({ message: 'User updated' });
});

router.delete('/:id', requireAuth, requireAdmin, requireMatthew, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const db = getDb();
  const user = db.prepare('SELECT username, email FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (String(user.email || '').toLowerCase() === MATTHEW_EMAIL) {
    return res.status(403).json({ error: 'The Matthew recovery account cannot be deleted' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ message: 'User deleted' });
});

module.exports = router;
