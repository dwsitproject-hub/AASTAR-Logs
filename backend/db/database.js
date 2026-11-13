const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/erp.db');
const MATTHEW_EMAIL = String(process.env.MATTHEW_EMAIL || 'matthew.chiu@kpn-corp.com').trim().toLowerCase();

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    // Wait briefly instead of failing with SQLITE_BUSY when a maintenance script holds the lock.
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
  }
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT,
      is_admin INTEGER DEFAULT 0,
      permissions TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sheets_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      tab_name TEXT NOT NULL,
      department TEXT NOT NULL,
      service_account_index INTEGER DEFAULT 0,
      range TEXT
    );

    CREATE TABLE IF NOT EXISTS apps_script_sheet_rows (
      record_id TEXT PRIMARY KEY,
      row_number INTEGER NOT NULL,
      values_json TEXT NOT NULL,
      pending_append INTEGER NOT NULL DEFAULT 0,
      source_updated_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_apps_script_sheet_rows_number
      ON apps_script_sheet_rows (row_number);

    CREATE TABLE IF NOT EXISTS apps_script_sheet_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS apps_script_sheet_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS apps_script_sheet_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT UNIQUE NOT NULL,
      operation TEXT NOT NULL,
      record_id TEXT NOT NULL,
      column_number INTEGER,
      values_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_apps_script_sheet_outbox_due
      ON apps_script_sheet_outbox (next_attempt_at, id);

    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  // Migrate: add range column if missing
  try { db.exec('ALTER TABLE sheets_config ADD COLUMN range TEXT'); } catch {}
  // Migrate: add render_format column. 'unformatted' (default) = SERIAL_NUMBER, 'formatted' = FORMATTED_VALUE.
  try { db.exec("ALTER TABLE sheets_config ADD COLUMN render_format TEXT DEFAULT 'unformatted'"); } catch {}

  // Migrate: per-sub-tab access. `tab_permissions` holds an explicit list of
  // sub-tab paths a user can open (Operations / Logistics are granted per-tab).
  try { db.exec("ALTER TABLE users ADD COLUMN tab_permissions TEXT DEFAULT '[]'"); } catch {}
  try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch {}
  try { db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT'); } catch {}
  try { db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1'); } catch {}
  try { db.exec('ALTER TABLE users ADD COLUMN is_approved INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users (email COLLATE NOCASE) WHERE email IS NOT NULL'); } catch {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL'); } catch {}

  // Rebuild the legacy users table once so stored passwords can be removed
  // completely and future Google-created users do not need a placeholder.
  const removePasswordsMigration = '2026-08-remove-account-passwords';
  if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(removePasswordsMigration)) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_google_only (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password TEXT,
          is_admin INTEGER NOT NULL DEFAULT 0,
          permissions TEXT NOT NULL DEFAULT '[]',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          tab_permissions TEXT NOT NULL DEFAULT '[]',
          email TEXT,
          google_sub TEXT,
          auth_version INTEGER NOT NULL DEFAULT 1,
          is_approved INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO users_google_only (
          id, username, password, is_admin, permissions, created_at, updated_at,
          tab_permissions, email, google_sub, auth_version, is_approved
        )
        SELECT
          id, username, NULL, is_admin, permissions, created_at, updated_at,
          tab_permissions, email, google_sub, auth_version, is_approved
        FROM users;
        DROP TABLE users;
        ALTER TABLE users_google_only RENAME TO users;
        CREATE UNIQUE INDEX idx_users_email_nocase
          ON users (email COLLATE NOCASE) WHERE email IS NOT NULL;
        CREATE UNIQUE INDEX idx_users_google_sub
          ON users (google_sub) WHERE google_sub IS NOT NULL;
      `);
      db.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)')
        .run(removePasswordsMigration, new Date().toISOString());
    })();
  }

  // DWS Hub SSO identity (OIDC `sub`). Added after the users-table rebuild above so
  // the one-time rebuild on a legacy database cannot drop it.
  try { db.exec('ALTER TABLE users ADD COLUMN hub_sub TEXT'); } catch {}
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hub_sub ON users (hub_sub) WHERE hub_sub IS NOT NULL');

  // The legacy default Admin account is intentionally retired. Matthew remains
  // the recovery administrator and can manage users through the normal UI.
  const removedAdmin = db.prepare("DELETE FROM users WHERE LOWER(TRIM(username)) = 'admin'").run();
  if (removedAdmin.changes) console.log('Legacy Admin account removed.');

  // Link the known recovery administrator to the corporate Google identity.
  db.prepare(`
    UPDATE users
    SET email = COALESCE(NULLIF(email, ''), ?),
        is_approved = 1
    WHERE LOWER(TRIM(username)) = 'matthew'
  `).run(MATTHEW_EMAIL);

  // Retire legacy admin flags once; subsequent roles are explicitly granted by Matthew.
  const delegatedAdminsMigration = '2026-09-delegated-administrators';
  if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(delegatedAdminsMigration)) {
    db.transaction(() => {
      db.prepare(`
        UPDATE users SET is_admin = 0, auth_version = auth_version + 1
        WHERE LOWER(TRIM(COALESCE(email, ''))) != ? AND is_admin = 1
      `).run(MATTHEW_EMAIL);
      db.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)')
        .run(delegatedAdminsMigration, new Date().toISOString());
    })();
  }

  // The recovery account remains an administrator without resetting delegated roles.
  db.prepare(`
    UPDATE users
    SET is_admin = 1
    WHERE LOWER(TRIM(COALESCE(email, ''))) = ?
  `).run(MATTHEW_EMAIL);

  // Invalidate every session issued before Google-only authentication became
  // mandatory. The marker makes this a one-time migration, not a restart-wide
  // logout policy.
  const googleOnlyMigration = '2026-08-google-only-auth';
  if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(googleOnlyMigration)) {
    db.transaction(() => {
      db.prepare('UPDATE users SET is_approved = 1, auth_version = auth_version + 1').run();
      db.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)')
        .run(googleOnlyMigration, new Date().toISOString());
    })();
  }

  // Page access is authoritative user data. Historical tab backfills used to
  // run here on every restart and could re-add access Matthew had removed.
  // Future navigation migrations must be explicit, one-time app migrations.
  const navigationMigration = '2026-08-navigation-tab-permissions';
  if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(navigationMigration)) {
    db.transaction(() => {
      const subtabMigration = {
        commercial: ['/commercial/open-shipments'],
        operations: ['/operations/contract-dashboard', '/operations/vessel-contract'],
        logistics: [
          '/logistics/stock-summary', '/logistics/vessel-status',
          '/logistics/export-summary', '/logistics/vessel-update',
          '/logistics/vessel-contract', '/logistics/vessel-matching',
          '/logistics/demurrage', '/logistics/export-planning',
        ],
        chartering: ['/chartering/export-planning'],
      };
      const removedTabs = new Set([
        '/logistics/vessel-map', '/logistics/matching',
        '/logistics/vessels-updates', '/logistics/eta-updates',
      ]);
      const rows = db.prepare('SELECT id, is_admin, permissions, tab_permissions FROM users').all();
      const update = db.prepare('UPDATE users SET permissions = ?, tab_permissions = ? WHERE id = ?');
      for (const row of rows) {
        if (row.is_admin === 1) continue;
        let permissions; try { permissions = JSON.parse(row.permissions || '[]'); } catch { permissions = []; }
        let tabs; try { tabs = JSON.parse(row.tab_permissions || '[]'); } catch { tabs = []; }
        for (const [department, paths] of Object.entries(subtabMigration)) {
          if (!permissions.includes(department)) continue;
          permissions = permissions.filter(value => value !== department);
          for (const tab of paths) if (!tabs.includes(tab)) tabs.push(tab);
        }
        if (tabs.some(path => path.startsWith('/logistics/'))) {
          for (const tab of ['/logistics/vessel-contract', '/logistics/vessel-matching', '/logistics/export-planning']) {
            if (!tabs.includes(tab)) tabs.push(tab);
          }
        }
        if (tabs.includes('/operations/contract-dashboard') && !tabs.includes('/operations/vessel-contract')) {
          tabs.push('/operations/vessel-contract');
        }
        if (tabs.includes('/test/vessel-matching') && !tabs.includes('/logistics/vessel-matching')) {
          tabs.push('/logistics/vessel-matching');
        }
        tabs = tabs.filter(path => !removedTabs.has(path));
        update.run(JSON.stringify(permissions), JSON.stringify(tabs), row.id);
      }
      db.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)')
        .run(navigationMigration, new Date().toISOString());
    })();
  }

  const kpnExportMigration = '2026-09-commercial-kpn-export';
  if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(kpnExportMigration)) {
    db.transaction(() => {
      const rows = db.prepare('SELECT id, is_admin, tab_permissions FROM users').all();
      const update = db.prepare('UPDATE users SET tab_permissions = ? WHERE id = ?');
      for (const row of rows) {
        if (row.is_admin === 1) continue;
        let tabs; try { tabs = JSON.parse(row.tab_permissions || '[]'); } catch { tabs = []; }
        if (tabs.includes('/commercial/open-shipments') && !tabs.includes('/commercial/kpn-export')) {
          tabs.push('/commercial/kpn-export');
          update.run(JSON.stringify(tabs), row.id);
        }
      }
      db.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)')
        .run(kpnExportMigration, new Date().toISOString());
    })();
  }

  const contractUnlinkMigration = '2026-09-logistics-contract-unlink';
  if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(contractUnlinkMigration)) {
    db.transaction(() => {
      const rows = db.prepare('SELECT id, is_admin, tab_permissions FROM users').all();
      const update = db.prepare('UPDATE users SET tab_permissions = ? WHERE id = ?');
      for (const row of rows) {
        if (row.is_admin === 1) continue;
        let tabs; try { tabs = JSON.parse(row.tab_permissions || '[]'); } catch { tabs = []; }
        if (tabs.includes('/logistics/vessel-matching') && !tabs.includes('/logistics/contract-unlink')) {
          tabs.push('/logistics/contract-unlink');
          update.run(JSON.stringify(tabs), row.id);
        }
      }
      db.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)')
        .run(contractUnlinkMigration, new Date().toISOString());
    })();
  }

  const exportSummaryTotalMigration = '2026-09-logistics-export-summary-total';
  if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(exportSummaryTotalMigration)) {
    db.transaction(() => {
      const rows = db.prepare('SELECT id, is_admin, tab_permissions FROM users').all();
      const update = db.prepare('UPDATE users SET tab_permissions = ? WHERE id = ?');
      for (const row of rows) {
        if (row.is_admin === 1) continue;
        let tabs; try { tabs = JSON.parse(row.tab_permissions || '[]'); } catch { tabs = []; }
        if (tabs.includes('/logistics/export-summary') && !tabs.includes('/logistics/export-summary-total')) {
          tabs.push('/logistics/export-summary-total');
          update.run(JSON.stringify(tabs), row.id);
        }
      }
      db.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)')
        .run(exportSummaryTotalMigration, new Date().toISOString());
    })();
  }

  // Ordinary users cannot acquire administrator access through a department grant.
  try {
    const rows = db.prepare('SELECT id, email, permissions FROM users WHERE is_admin = 0').all();
    const updatePermissions = db.prepare('UPDATE users SET permissions = ? WHERE id = ?');
    for (const row of rows) {
      if (String(row.email || '').trim().toLowerCase() === MATTHEW_EMAIL) continue;
      let permissions; try { permissions = JSON.parse(row.permissions || '[]'); } catch { permissions = []; }
      const cleaned = permissions.filter(permission => permission !== 'admin');
      if (cleaned.length !== permissions.length) updatePermissions.run(JSON.stringify(cleaned), row.id);
    }
  } catch (e) { console.error('ordinary-user admin permission cleanup skipped:', e.message); }

  // Roles (Admin -> Roles): converts existing access once, keeps the recovery account an administrator.
  require('../services/roles').initRoles(db, { recoveryEmail: MATTHEW_EMAIL });
}

module.exports = { getDb, initDb };
