'use strict';

// Creates (or promotes) one approved administrator, for a fresh local or staging
// database where nobody can approve the first account through the UI.
//   npm run seed:admin -- someone@example.com [--username "Display Name"]
// Sign-in still goes through Google, the DWS Hub, or the local dev sign-in;
// an existing google_sub / hub_sub link on the account is left untouched.
require('dotenv').config();
const { getDb, initDb } = require('../db/database');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function seedAdmin(db, { email, username = '' }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalizedEmail)) throw new Error('A valid email address is required');
  const name = String(username || '').trim().slice(0, 120) || normalizedEmail;

  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(normalizedEmail);
    if (existing) {
      db.prepare(`
        UPDATE users SET is_admin = 1, is_approved = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(existing.id);
      return { created: false, user: db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id) };
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(name)) {
      throw new Error(`Username "${name}" is already taken; pass a different --username`);
    }
    const result = db.prepare(`
      INSERT INTO users (
        username, email, password, is_admin, is_approved,
        permissions, tab_permissions, auth_version
      ) VALUES (?, ?, NULL, 1, 1, '[]', '[]', 1)
    `).run(name, normalizedEmail);
    return { created: true, user: db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid) };
  })();
}

function parseArgs(argv) {
  const args = { email: '', username: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--username') args.username = argv[++i] || '';
    else if (!args.email) args.email = argv[i];
  }
  return args;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    initDb();
    const { created, user } = seedAdmin(getDb(), args);
    console.log(`${created ? 'Created' : 'Updated'} administrator #${user.id} ${user.username} <${user.email}> (approved)`);
    getDb().close();
  } catch (error) {
    console.error(`seed:admin failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, seedAdmin };
