'use strict';

// Admin-managed connection settings for the six synced spreadsheets
// (Admin -> Sheets Config). The tab layout stays in config/dataSources.js because
// the pages depend on exact columns; this table decides which spreadsheet, which
// service account, and whether it is synced at all. It is seeded once from the
// code defaults (plus SHEET_ID_* / SHEETS_SERVICE_ACCOUNT_EMAIL), then the table
// is the source of truth. Every change is kept in spreadsheet_source_changes.
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { DATA_DATABASES, SPREADSHEETS, sheetsCopiesOnly, sourceWrites } = require('../config/dataSources');
const bulkDataSync = require('./bulkDataSync');

// Captured before the table is applied to the definitions.
const SEED_VALUES = new Map(SPREADSHEETS.map(sheet => {
  const definition = DATA_DATABASES.find(item => item.spreadsheet === sheet.key);
  return [sheet.key, { sheetId: definition.sheetId, serviceAccountEmail: definition.serviceAccountEmail }];
}));
const SHEET_ID_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

function httpError(statusCode, code, message, details = {}) {
  return Object.assign(new Error(message), { statusCode, code, ...details });
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS spreadsheet_sources (
      key TEXT PRIMARY KEY,
      sheet_id TEXT NOT NULL DEFAULT '',
      service_account_email TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS spreadsheet_source_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spreadsheet_source_changes_key
      ON spreadsheet_source_changes (key, changed_at);
  `);
}

function seed(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO spreadsheet_sources (key, sheet_id, service_account_email, enabled, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, 'initial setup')
  `);
  const now = new Date().toISOString();
  for (const sheet of SPREADSHEETS) {
    const values = SEED_VALUES.get(sheet.key);
    insert.run(sheet.key, values.sheetId, values.serviceAccountEmail, values.sheetId ? 1 : 0, now);
  }
}

function rowFor(db, key) {
  return db.prepare('SELECT * FROM spreadsheet_sources WHERE key = ?').get(key);
}

function spreadsheetFor(key) {
  return SPREADSHEETS.find(sheet => sheet.key === key) || null;
}

// The spreadsheet the sync really uses: '' when switched off, missing, or when a
// copies-only stack would otherwise touch the production spreadsheet.
function effectiveSheetId(sheet, row) {
  if (!row || row.enabled !== 1 || !row.sheet_id) return '';
  if (sheetsCopiesOnly() && row.sheet_id === sheet.productionSheetId) return '';
  return row.sheet_id;
}

// Points every data source at its spreadsheet's stored settings. The definition
// objects are shared, so the sync and the writers pick the change up at once.
function applySpreadsheetSources(db) {
  for (const sheet of SPREADSHEETS) {
    const row = rowFor(db, sheet.key);
    for (const definition of DATA_DATABASES.filter(item => item.spreadsheet === sheet.key)) {
      definition.sheetId = effectiveSheetId(sheet, row);
      definition.serviceAccountEmail = row?.service_account_email || definition.serviceAccountEmail;
    }
  }
}

function initSpreadsheetSources(db) {
  ensureTables(db);
  seed(db);
  applySpreadsheetSources(db);
}

function parseSheetId(input) {
  const value = String(input || '').trim();
  const fromUrl = value.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  const id = fromUrl ? fromUrl[1] : value;
  return SHEET_ID_PATTERN.test(id) ? id : '';
}

function requiredTabs(key) {
  const tabs = new Set();
  for (const definition of DATA_DATABASES.filter(item => item.spreadsheet === key)) {
    for (const source of definition.sources) tabs.add(source.tab);
  }
  return [...tabs];
}

function storedDataInfo(definition) {
  const file = bulkDataSync.dbPath(definition.name);
  if (!fs.existsSync(file)) return { rows: null, pulledAt: null, fromSheetId: null };
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const meta = db.prepare('SELECT source_tab, source_sheet_id, row_count, pulled_at FROM _database_meta').all();
    const combined = meta.find(row => row.source_tab === 'COMBINED');
    return {
      rows: combined ? combined.row_count : meta.reduce((sum, row) => sum + (row.row_count || 0), 0),
      pulledAt: meta.map(row => row.pulled_at).sort().pop() || null,
      fromSheetId: meta[0]?.source_sheet_id || null,
    };
  } catch {
    return { rows: null, pulledAt: null, fromSheetId: null };
  } finally {
    db?.close();
  }
}

function describe(db, sheet) {
  const row = rowFor(db, sheet.key);
  const syncStates = bulkDataSync.databaseSyncStates();
  const databases = DATA_DATABASES.filter(item => item.spreadsheet === sheet.key).map(definition => {
    const tabs = definition.sources.map(source => ({ tab: source.tab, range: source.range, writes: sourceWrites(definition, source) }));
    return {
      name: definition.name,
      tabs,
      access: tabs.some(tab => tab.writes.length) ? 'read-write' : 'read',
      stored: storedDataInfo(definition),
      sync: syncStates[definition.name] || null,
    };
  });
  const changes = db.prepare(`
    SELECT field, old_value, new_value, changed_by, changed_at
    FROM spreadsheet_source_changes WHERE key = ? ORDER BY id DESC LIMIT 10
  `).all(sheet.key);
  return {
    key: sheet.key,
    label: sheet.label,
    description: sheet.description,
    sheetId: row?.sheet_id || '',
    serviceAccountEmail: row?.service_account_email || '',
    enabled: row?.enabled === 1,
    syncing: Boolean(effectiveSheetId(sheet, row)),
    isProductionSheet: Boolean(row?.sheet_id) && row.sheet_id === sheet.productionSheetId,
    blockedByCopiesOnly: Boolean(row?.enabled === 1 && row.sheet_id) && !effectiveSheetId(sheet, row),
    access: databases.some(database => database.access === 'read-write') ? 'read-write' : 'read',
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || '',
    databases,
    changes,
  };
}

function listSpreadsheetSources(db) {
  return {
    copiesOnly: sheetsCopiesOnly(),
    serviceAccounts: bulkDataSync.availableServiceAccounts(),
    spreadsheets: SPREADSHEETS.map(sheet => describe(db, sheet)),
  };
}

// Validates a proposed setting and, unless it switches the spreadsheet off,
// opens it with the chosen account and checks every tab the ERP reads is there.
async function checkSpreadsheetSource(key, input, deps = bulkDataSync) {
  const sheet = spreadsheetFor(key);
  if (!sheet) throw httpError(404, 'SPREADSHEET_NOT_FOUND', 'Unknown spreadsheet');
  const enabled = input?.enabled !== false;
  const rawSheetId = String(input?.sheetId || '').trim();
  const sheetId = rawSheetId ? parseSheetId(rawSheetId) : '';
  if (rawSheetId && !sheetId) throw httpError(400, 'INVALID_SHEET_ID', 'Enter a Google Sheets link or spreadsheet ID');
  const serviceAccountEmail = String(input?.serviceAccountEmail || '').trim().toLowerCase();
  const result = { key, sheetId, serviceAccountEmail, enabled, title: '', tabs: [], missingTabs: [] };
  if (!enabled) return result;

  if (!sheetId) throw httpError(400, 'SHEET_ID_REQUIRED', 'A spreadsheet is required unless the spreadsheet is switched off');
  if (sheetsCopiesOnly() && sheetId === sheet.productionSheetId) {
    throw httpError(400, 'PRODUCTION_SHEET_BLOCKED', 'This stack only syncs copies (SHEETS_COPIES_ONLY); the production spreadsheet is not allowed here');
  }
  if (!deps.availableServiceAccounts().includes(serviceAccountEmail)) {
    throw httpError(400, 'SERVICE_ACCOUNT_UNKNOWN', 'Choose a service account whose key is installed on the server');
  }
  let inspected;
  try {
    inspected = await deps.inspectSpreadsheet(sheetId, serviceAccountEmail);
  } catch (error) {
    const reason = error.response?.data?.error?.message || error.message;
    throw httpError(400, 'SPREADSHEET_UNREACHABLE', `The service account could not open this spreadsheet: ${reason}. Share it with ${serviceAccountEmail} as Editor.`);
  }
  result.title = inspected.title;
  result.tabs = inspected.tabs;
  result.missingTabs = requiredTabs(key).filter(tab => !inspected.tabs.includes(tab));
  if (result.missingTabs.length) {
    throw httpError(400, 'TABS_MISSING', `This spreadsheet is missing tabs the ERP reads: ${result.missingTabs.join(', ')}`, { result });
  }
  return result;
}

async function updateSpreadsheetSource(db, key, input, actor, deps = bulkDataSync) {
  const checked = await checkSpreadsheetSource(key, input, deps);
  const current = rowFor(db, key);
  const next = {
    sheet_id: checked.sheetId || (checked.enabled ? '' : current?.sheet_id || ''),
    service_account_email: checked.serviceAccountEmail || current?.service_account_email || '',
    enabled: checked.enabled ? 1 : 0,
  };
  const now = new Date().toISOString();
  const changedBy = String(actor || 'unknown').slice(0, 254);
  db.transaction(() => {
    const record = db.prepare(`
      INSERT INTO spreadsheet_source_changes (key, field, old_value, new_value, changed_by, changed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const field of ['sheet_id', 'service_account_email', 'enabled']) {
      const before = current ? String(current[field]) : '';
      const after = String(next[field]);
      if (before !== after) record.run(key, field, before, after, changedBy, now);
    }
    db.prepare(`
      INSERT INTO spreadsheet_sources (key, sheet_id, service_account_email, enabled, updated_at, updated_by)
      VALUES (@key, @sheet_id, @service_account_email, @enabled, @updated_at, @updated_by)
      ON CONFLICT(key) DO UPDATE SET
        sheet_id = excluded.sheet_id,
        service_account_email = excluded.service_account_email,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run({ key, ...next, updated_at: now, updated_by: changedBy });
  })();
  applySpreadsheetSources(db);
  bulkDataSync.forgetDatabaseSyncState(DATA_DATABASES.filter(item => item.spreadsheet === key).map(item => item.name));
  return { spreadsheet: describe(db, spreadsheetFor(key)), check: checked };
}

module.exports = {
  applySpreadsheetSources,
  checkSpreadsheetSource,
  initSpreadsheetSources,
  listSpreadsheetSources,
  parseSheetId,
  updateSpreadsheetSource,
};
