'use strict';

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isAllowedGoogleIdentity(payload, allowedDomain) {
  const domain = String(allowedDomain || '').trim().toLowerCase();
  const email = String(payload?.email || '').trim().toLowerCase();
  const hostedDomain = String(payload?.hd || '').trim().toLowerCase();
  const subject = String(payload?.sub || '').trim();
  return Boolean(
    domain
    && payload?.email_verified
    && subject
    && hostedDomain === domain
    && email.endsWith(`@${domain}`)
  );
}

function hasAssignedAccess(user) {
  if (user?.is_admin === true || Number(user?.is_admin) === 1) return true;
  return parseJsonList(user?.permissions).length > 0 || parseJsonList(user?.tab_permissions).length > 0;
}

function provisionGoogleUser(db, { email, subject }) {
  let user = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(subject);
  if (!user) user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);

  if (!user) {
    let result;
    try {
      result = db.prepare(`
        INSERT INTO users (
          username, email, google_sub, password, is_admin, is_approved,
          permissions, tab_permissions, auth_version
        ) VALUES (?, ?, ?, NULL, 0, 0, '[]', '[]', 1)
      `).run(email, email, subject);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return { created: false, conflict: true, user: null };
      }
      throw error;
    }
    return {
      created: true,
      conflict: false,
      user: db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid),
    };
  }

  if (user.google_sub && user.google_sub !== subject) {
    return { created: false, conflict: true, user: null };
  }

  try {
    db.prepare(`
      UPDATE users
      SET email = ?, google_sub = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(email, subject, user.id);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { created: false, conflict: true, user: null };
    }
    throw error;
  }

  return {
    created: false,
    conflict: false,
    user: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id),
  };
}

module.exports = {
  hasAssignedAccess,
  isAllowedGoogleIdentity,
  parseJsonList,
  provisionGoogleUser,
};
