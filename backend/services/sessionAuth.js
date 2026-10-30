'use strict';

const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/config');
const { getDb } = require('../db/database');

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function verifySessionToken(token) {
  const claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  const user = getDb().prepare(`
    SELECT id, username, email, hub_sub, is_admin, is_approved, permissions, tab_permissions, auth_version
    FROM users
    WHERE id = ?
  `).get(claims.id);
  if (!user || Number(claims.auth_version) !== Number(user.auth_version)) {
    const error = new Error('Session is no longer valid');
    error.code = 'SESSION_REVOKED';
    throw error;
  }
  if (user.is_approved !== 1) {
    const error = new Error('Account access is awaiting approval');
    error.code = 'ACCOUNT_PENDING';
    throw error;
  }
  return {
    claims,
    user: {
      id: user.id,
      username: user.username,
      email: user.email || null,
      hub_sub: user.hub_sub || null,
      is_admin: user.is_admin === 1,
      is_approved: true,
      permissions: parseJsonList(user.permissions),
      tab_permissions: parseJsonList(user.tab_permissions),
      auth_version: Number(user.auth_version),
      jti: claims.jti,
    },
  };
}

module.exports = { parseJsonList, verifySessionToken };
