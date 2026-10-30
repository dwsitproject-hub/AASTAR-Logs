const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { cacheRefreshInterval } = require('../config/config');
const { configureQueue, enqueueWrite, startQueueWorker } = require('./writeQueue');

// SA files that are NOT loaded into the alphabetical index — they're handled by
// dedicated services with their own polling/auth. Keep indices 0-7 stable.
const EXCLUDED_FROM_INDEX = new Set(['kpnstock.json']);

const cache = {};
let serviceAccounts = [];
let dbRef = null;

function loadServiceAccounts() {
  const keysDir = process.env.SERVICE_ACCOUNTS_DIR || path.join(__dirname, '../service-accounts');
  if (!fs.existsSync(keysDir)) {
    console.warn('No service-accounts directory found.');
    return [];
  }
  const files = fs.readdirSync(keysDir).filter(f => f.endsWith('.json') && !EXCLUDED_FROM_INDEX.has(f));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(keysDir, f), 'utf8')); }
    catch { console.error(`Failed to load service account: ${f}`); return null; }
  }).filter(Boolean);
}

function getAuthClient(accountIndex) {
  if (!serviceAccounts.length) return null;
  const key = serviceAccounts[accountIndex % serviceAccounts.length];
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

async function fetchSheet(sheetId, tabName, accountIndex = 0) {
  const auth = getAuthClient(accountIndex);
  if (!auth) return null;
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: tabName,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  return response.data.values || [];
}

// Public write APIs: queue + apply locally so readers see the change immediately.
function writeSheet(sheetId, tabName, range, values, accountIndex = 0) {
  // Apply to in-memory cache optimistically
  applyWriteToCache(sheetId, tabName, range, values);
  enqueueWrite({ sheetId, tabName, range, values, accountIndex });
}

async function appendSheet(sheetId, tabName, values, accountIndex = 0) {
  // Append goes direct - batch append is awkward. Still rate-limited but rare.
  const auth = getAuthClient(accountIndex);
  if (!auth) throw new Error('No service accounts configured');
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: tabName,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
  return res.data;
}

// Delete a single row from a sheet tab. row1Based is 1-based (matches sheet UI).
// Needs the numeric tab id (gid) — look it up via spreadsheets.get.
async function deleteRow(spreadsheetId, tabName, row1Based, accountIndex = 0) {
  const auth = getAuthClient(accountIndex);
  if (!auth) throw new Error('No service accounts configured');
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
  const tab = (meta.data.sheets || []).find(s => s.properties.title === tabName);
  if (!tab) throw new Error(`Tab not found: ${tabName}`);
  const sheetId = tab.properties.sheetId;
  const startIndex = row1Based - 1;
  const endIndex = row1Based;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex, endIndex }
        }
      }]
    }
  });
  return res.data;
}

// Parse A1 range like "B5:D7" into 0-based row/col offsets
function parseA1Range(range) {
  const m = range.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  if (!m) return null;
  const colToNum = (s) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const startCol = colToNum(m[1]);
  const startRow = parseInt(m[2]) - 1;
  return { startRow, startCol };
}

function applyWriteToCache(sheetId, tabName, range, values) {
  // Apply optimistically to both formatted and raw cache entries if they exist
  for (const suffix of ['raw', 'fmt']) {
    const key = `${sheetId}::${tabName}::${suffix}`;
    const entry = cache[key];
    if (!entry) continue;
    const parsed = parseA1Range(range);
    if (!parsed) continue;
    const { startRow, startCol } = parsed;
    const data = entry.data;
    for (let r = 0; r < values.length; r++) {
      const targetRow = startRow + r;
      while (data.length <= targetRow) data.push([]);
      const row = data[targetRow];
      for (let c = 0; c < values[r].length; c++) {
        const targetCol = startCol + c;
        while (row.length <= targetCol) row.push('');
        row[targetCol] = values[r][c];
      }
    }
    entry.updatedAt = new Date().toISOString();
  }
}

async function batchFetchSheet(sheetId, ranges, accountIndex = 0, formatted = false) {
  const auth = getAuthClient(accountIndex);
  if (!auth) return null;
  const sheets = google.sheets({ version: 'v4', auth });
  const opts = {
    spreadsheetId: sheetId,
    ranges,
    valueRenderOption: formatted ? 'FORMATTED_VALUE' : 'UNFORMATTED_VALUE'
  };
  if (!formatted) opts.dateTimeRenderOption = 'SERIAL_NUMBER';
  const response = await sheets.spreadsheets.values.batchGet(opts);
  return response.data.valueRanges || [];
}

async function refreshAllCaches() {
  const { getDb } = require('../db/database');
  const db = getDb();
  const configs = db.prepare('SELECT * FROM sheets_config').all();

  // Group by (sheet_id, service_account_index, render_format) so each group is one batchGet
  const groups = {};
  for (const c of configs) {
    const fmt = c.render_format === 'formatted' ? 'formatted' : 'unformatted';
    const key = `${c.sheet_id}::${c.service_account_index}::${fmt}`;
    if (!groups[key]) groups[key] = { sheet_id: c.sheet_id, accountIndex: c.service_account_index, formatted: fmt === 'formatted', configs: [] };
    groups[key].configs.push(c);
  }

  for (const groupKey of Object.keys(groups)) {
    const { sheet_id, accountIndex, formatted, configs: groupConfigs } = groups[groupKey];
    const ranges = groupConfigs.map(c => c.range ? `${c.tab_name}!${c.range}` : c.tab_name);
    try {
      const valueRanges = await batchFetchSheet(sheet_id, ranges, accountIndex, formatted);
      groupConfigs.forEach((c, i) => {
        const cacheKey = `${c.sheet_id}::${c.tab_name}::${formatted ? 'fmt' : 'raw'}`;
        const data = valueRanges[i]?.values || [];
        // Only bump updatedAt when the data actually changed. Keeping updatedAt
        // stable during idle periods lets clients short-circuit unchanged polls
        // (304 / ?since) and skip re-rendering. `_json` caches the serialized
        // form so we compare without re-stringifying the previous value.
        const dataStr = JSON.stringify(data);
        const prev = cache[cacheKey];
        if (prev && prev._json === dataStr) return; // unchanged — keep entry + updatedAt
        cache[cacheKey] = { data, updatedAt: new Date().toISOString(), _json: dataStr };
      });
    } catch (err) {
      console.error(`Batch refresh failed for sheet ${sheet_id} (account ${accountIndex}, formatted=${formatted}):`, err.message);
    }
  }

  // Land this poll's data on disk (erp.db).
  persistCache();
}

function getCached(sheetId, tabName, formatted = false) {
  const suffix = formatted ? 'fmt' : 'raw';
  return cache[`${sheetId}::${tabName}::${suffix}`] || null;
}

// Persist cache to SQLite so restarts don't lose data
function initCacheTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sheet_cache (
    cache_key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
}

function persistCache() {
  if (!dbRef) return;
  const stmt = dbRef.prepare('INSERT OR REPLACE INTO sheet_cache (cache_key, data, updated_at) VALUES (?, ?, ?)');
  const tx = dbRef.transaction(() => {
    for (const key of Object.keys(cache)) {
      stmt.run(key, JSON.stringify(cache[key].data), cache[key].updatedAt);
    }
  });
  try {
    tx();
  } catch (err) { console.error('Cache persist failed:', err.message); }
}

function restoreCache() {
  if (!dbRef) return 0;
  const rows = dbRef.prepare('SELECT cache_key, data, updated_at FROM sheet_cache').all();
  for (const row of rows) {
    try { cache[row.cache_key] = { data: JSON.parse(row.data), updatedAt: row.updated_at }; }
    catch { /* skip corrupted */ }
  }
  return rows.length;
}

function startCacheRefresh() {
  serviceAccounts = loadServiceAccounts();
  console.log(`Loaded ${serviceAccounts.length} service account(s)`);

  const { getDb } = require('../db/database');
  dbRef = getDb();
  initCacheTable(dbRef);
  const restored = restoreCache();
  if (restored) console.log(`Restored ${restored} cached sheet(s) from SQLite`);

  configureQueue({ accounts: serviceAccounts, intervalMs: 1500, authClient: getAuthClient });
  startQueueWorker();

  refreshAllCaches();
  setInterval(refreshAllCaches, cacheRefreshInterval);
  setInterval(persistCache, 30 * 1000);
}

// Synchronous (non-queued) write — for one-shot operations like "create entry"
// where we need confirmation before responding to the user.
async function writeSheetSync(sheetId, range, values, accountIndex = 0) {
  const auth = getAuthClient(accountIndex);
  if (!auth) throw new Error('No service accounts configured');
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });
  return res.data;
}

module.exports = { startCacheRefresh, getCached, fetchSheet, writeSheet, writeSheetSync, appendSheet, deleteRow, refreshAllCaches };
