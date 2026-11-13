'use strict';

// One-click sign-in for a local Docker or development stack, where neither the
// corporate Google client nor a DWS Hub registration is available. It signs in
// exactly one seeded, approved account (LOCAL_DEV_LOGIN_EMAIL) and can never be
// enabled in production: the server refuses to start instead.

function localDevLoginEmail(env = process.env) {
  const email = String(env.LOCAL_DEV_LOGIN_EMAIL || '').trim().toLowerCase();
  if (!email) return '';
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    throw new Error('LOCAL_DEV_LOGIN_EMAIL must not be set when NODE_ENV=production');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('LOCAL_DEV_LOGIN_EMAIL must be an email address');
  }
  return email;
}

function findLocalDevUser(db, email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM users WHERE LOWER(TRIM(email)) = ?').get(email) || null;
}

module.exports = { findLocalDevUser, localDevLoginEmail };
