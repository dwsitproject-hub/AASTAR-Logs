'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const Database = require('better-sqlite3');
const { DATA_DATABASES, BULK_SYNC_INTERVAL_MS } = require('../config/dataSources');
const { LINK_DB_PATH, rebuildVesselLinks } = require('./vesselLinks');
const { broadcastDataUpdated } = require('./realtime');

const DATA_DIR = process.env.DATA_DATABASE_DIR || path.join(__dirname, '../data/databases');
const GOOGLE_REQUEST_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.GOOGLE_SHEETS_REQUEST_TIMEOUT_MS) || 60000,
);
const credentialsByEmail = new Map();
const lastHashes = new Map();
const VESSEL_LINK_DATABASES = new Set(['DB1', 'DB2', 'DB3', 'DB4', 'DB5', 'DB6', 'DB10']);
// Outcome of the latest refresh per database, for Admin -> Sheets Config.
const databaseSyncState = new Map();
let timer = null;
let running = false;

function normalize(value) {
  return value == null ? '' : String(value).trim();
}

function colToA1(column) {
  let value = Number(column);
  let result = '';
  do {
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}

function identifier(value, fallback) {
  let name = normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) name = fallback;
  if (/^\d/.test(name)) name = `c_${name}`;
  return name;
}

function uniqueIdentifiers(labels, prefix = '') {
  const used = new Set();
  return labels.map((label, index) => {
    const base = identifier(`${prefix}${label || ''}`, `col_${index + 1}`);
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}_${suffix++}`;
    used.add(name);
    return { name, label: normalize(label) || `Column ${index + 1}` };
  });
}

function tableRows(rows, prefix = '') {
  const allRows = Array.isArray(rows) ? rows : [];
  const header = Array.isArray(allRows[0]) ? allRows[0] : [];
  const width = allRows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), header.length);
  const columns = uniqueIdentifiers(Array.from({ length: width }, (_, i) => header[i]), prefix);
  return { rows: allRows.slice(1), columns };
}

function cellValue(value) {
  if (value == null || value === '') return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function dbPath(name) {
  return path.join(DATA_DIR, `${name}.db`);
}

function loadCredentials() {
  const keysDir = process.env.SERVICE_ACCOUNTS_DIR || path.join(__dirname, '../service-accounts');
  if (!fs.existsSync(keysDir)) throw new Error(`Service-account directory not found: ${keysDir}`);

  credentialsByEmail.clear();
  for (const filename of fs.readdirSync(keysDir).filter(file => file.endsWith('.json'))) {
    try {
      const credential = JSON.parse(fs.readFileSync(path.join(keysDir, filename), 'utf8'));
      if (credential.client_email) credentialsByEmail.set(credential.client_email.toLowerCase(), credential);
    } catch (err) {
      console.error(`Failed to load service account ${filename}:`, err.message);
    }
  }
}

function authFor(email) {
  const credential = credentialsByEmail.get(email.toLowerCase());
  if (!credential) throw new Error(`Service account not found: ${email}`);
  return new google.auth.GoogleAuth({
    credentials: credential,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function sourceKey(source) {
  return `${source.tab}!${source.range}`;
}

function a1Range(source) {
  const tab = source.tab.replace(/'/g, "''");
  return `${/[\s!]/.test(source.tab) ? `'${tab}'` : tab}!${source.range}`;
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function sourcePrefix(source, index) {
  const fallback = `${identifier(source.table, index === 0 ? 'left' : 'right')}_`;
  if (!source.prefix) return fallback;
  return source.prefix.endsWith('_') ? source.prefix : `${source.prefix}_`;
}

function parentChildMarker(value) {
  const match = normalize(value).match(/^(.*)_([PC])$/i);
  return match ? { key: match[1], type: match[2].toUpperCase() } : null;
}

function isBlank(value) {
  return value == null || String(value).trim() === '';
}

function canonicalIdentifier(value) {
  if (isBlank(value)) return null;
  const canonical = String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, '').toUpperCase();
  return canonical || null;
}

function isMeaningfulContractRow(row, matchIdIndex, vslIndex) {
  if (!Array.isArray(row)) return false;
  return row.some((value, index) => index !== matchIdIndex && index !== vslIndex && !isBlank(value));
}

// A copied Google Sheets row also copies its VSL ID. ERP Match ID is the
// durable row identity, so repair duplicate IDs before the snapshot reaches
// SQLite. The first physical row keeps its identity; later copies get a fresh
// ID and their visible legacy VSL cell is cleared.
async function repairContractMatchIds(fetched) {
  const results = [];
  for (const definition of DATA_DATABASES) {
    const sourceIndex = definition.sources.findIndex(source => source.matchIdColumn);
    if (sourceIndex < 0) continue;
    const source = definition.sources[sourceIndex];
    const key = sourceKey(source);
    const rows = fetched.get(key);
    if (!Array.isArray(rows) || !rows.length) continue;

    const prefix = definition.layout === 'side-by-side' ? sourcePrefix(source, sourceIndex) : '';
    const columns = tableRows(rows, prefix).columns;
    const matchIdIndex = columns.findIndex(column => column.name === source.matchIdColumn);
    const vslIndex = columns.findIndex(column => column.name === source.legacyVslColumn);
    if (matchIdIndex < 0) {
      results.push({ name: definition.name, skipped: true, reason: 'ERP Match ID column is not available yet' });
      continue;
    }

    const staged = rows.map(row => Array.isArray(row) ? [...row] : []);
    const quarantined = rows.map(row => Array.isArray(row) ? [...row] : []);
    const seen = new Set();
    const updates = [];
    let created = 0;
    let repaired = 0;
    let clearedLegacyVsl = 0;
    for (let rowIndex = 1; rowIndex < staged.length; rowIndex++) {
      const row = staged[rowIndex];
      if (!isMeaningfulContractRow(row, matchIdIndex, vslIndex)) continue;
      const original = normalize(row[matchIdIndex]);
      const keyId = original.toLowerCase();
      const duplicate = !!keyId && seen.has(keyId);
      const nextId = original && !duplicate ? original : crypto.randomUUID();
      if (original && !duplicate) {
        seen.add(keyId);
        continue;
      }

      while (row.length <= matchIdIndex) row.push('');
      row[matchIdIndex] = nextId;
      while (quarantined[rowIndex].length <= matchIdIndex) quarantined[rowIndex].push('');
      quarantined[rowIndex][matchIdIndex] = '';
      updates.push({ range: `${colToA1(matchIdIndex)}${rowIndex + 1}`, value: nextId });
      seen.add(nextId.toLowerCase());
      if (duplicate) repaired++;
      else created++;

      if (duplicate && vslIndex >= 0 && !isBlank(row[vslIndex])) {
        row[vslIndex] = '';
        while (quarantined[rowIndex].length <= vslIndex) quarantined[rowIndex].push('');
        quarantined[rowIndex][vslIndex] = '';
        updates.push({ range: `${colToA1(vslIndex)}${rowIndex + 1}`, value: '' });
        clearedLegacyVsl++;
      }
    }

    if (!updates.length) continue;
    try {
      await writeSourceCells(definition, updates);
      fetched.set(key, staged);
      results.push({ name: definition.name, created, repaired, clearedLegacyVsl });
    } catch (err) {
      console.error(`ERP Match ID repair failed for ${definition.name}:`, err.message);
      // Never materialize a copied Match ID locally when its durable repair
      // could not be written. A blank local ID quarantines the row so it
      // cannot inherit the original contract's active DB10 vessel link.
      fetched.set(key, quarantined);
      results.push({ name: definition.name, error: err.message, quarantined: created + repaired });
    }
  }
  return results;
}

function normalizeIdentifierFields(definition, fetched) {
  const targets = new Set(definition.identifierColumns || []);
  if (!targets.size) return { fetched, changed: 0 };

  const result = { ...fetched };
  let changed = 0;
  definition.sources.forEach((source, sourceIndex) => {
    const rows = fetched[sourceKey(source)];
    if (!Array.isArray(rows) || !rows.length) return;
    const prefix = definition.layout === 'side-by-side' ? sourcePrefix(source, sourceIndex) : '';
    const columns = tableRows(rows, prefix).columns;
    const indexes = columns
      .map((column, index) => targets.has(column.name) ? index : -1)
      .filter(index => index >= 0);
    if (!indexes.length) return;

    const normalizedRows = rows.map(row => Array.isArray(row) ? [...row] : row);
    for (let rowIndex = 1; rowIndex < normalizedRows.length; rowIndex++) {
      const row = normalizedRows[rowIndex];
      if (!Array.isArray(row)) continue;
      for (const columnIndex of indexes) {
        const original = row[columnIndex];
        const normalized = canonicalIdentifier(original);
        if (original !== normalized) {
          row[columnIndex] = normalized;
          changed++;
        }
      }
    }
    result[sourceKey(source)] = normalizedRows;
  });

  return { fetched: result, changed };
}

function fillMergedChildRows(definition, fetched) {
  if (!definition.fillDown || definition.sources.length < 2) return { fetched, changed: 0 };

  const mainSource = definition.sources[0];
  const shadowSource = definition.sources[1];
  const sourceRows = fetched[sourceKey(mainSource)] || [];
  const shadowRows = fetched[sourceKey(shadowSource)] || [];
  if (!Array.isArray(sourceRows) || !Array.isArray(shadowRows) || !sourceRows.length || !shadowRows.length) {
    return { fetched, changed: 0 };
  }

  const mainPrefix = sourcePrefix(mainSource, 0);
  const shadowPrefix = sourcePrefix(shadowSource, 1);
  const mainColumns = tableRows(sourceRows, mainPrefix).columns;
  const shadowColumns = tableRows(shadowRows, shadowPrefix).columns;
  const start = mainColumns.findIndex(column => column.name === definition.fillDown.from);
  const end = mainColumns.findIndex(column => column.name === definition.fillDown.to);
  const markerColumns = shadowColumns
    .map((column, index) => ({ ...column, index }))
    .filter(column => /parent_child/i.test(column.name));
  const excludedColumns = new Set(definition.fillDown.exclude || []);
  if (start < 0 || end < start || !markerColumns.length) return { fetched, changed: 0 };

  const formattedRows = sourceRows.map(row => Array.isArray(row) ? [...row] : row);
  let changed = 0;
  for (const markerColumn of markerColumns) {
    const groups = new Map();
    for (let rowIndex = 1; rowIndex < shadowRows.length; rowIndex++) {
      const parsed = parentChildMarker(shadowRows[rowIndex]?.[markerColumn.index]);
      if (!parsed) continue;
      if (!groups.has(parsed.key)) groups.set(parsed.key, { parents: [], children: [] });
      groups.get(parsed.key)[parsed.type === 'P' ? 'parents' : 'children'].push(rowIndex);
    }

    for (const group of groups.values()) {
      if (!group.parents.length || !group.children.length) continue;
      const parentIndex = group.parents[0];
      const parentRow = formattedRows[parentIndex];
      if (!Array.isArray(parentRow)) continue;
      for (const childIndex of group.children) {
        const childRow = formattedRows[childIndex];
        if (!Array.isArray(childRow)) continue;
        for (let columnIndex = start; columnIndex <= end; columnIndex++) {
          if (excludedColumns.has(mainColumns[columnIndex].name)) continue;
          if (isBlank(childRow[columnIndex]) && !isBlank(parentRow[columnIndex])) {
            childRow[columnIndex] = parentRow[columnIndex];
            changed++;
          }
        }
      }
    }
  }

  return {
    fetched: { ...fetched, [sourceKey(mainSource)]: formattedRows },
    changed,
  };
}

function createTable(db, tableName, rows, prefix = '') {
  const parsed = tableRows(rows, prefix);
  const table = identifier(tableName, 'data');
  const columns = [{ name: '_sheet_row', label: '_sheet_row' }, ...parsed.columns];
  const defs = columns.map(column => `"${column.name}" TEXT`).join(', ');
  db.exec(`CREATE TABLE "${table}" (${defs})`);
  db.exec('CREATE TABLE IF NOT EXISTS _columns (table_name TEXT, ordinal INTEGER, sqlite_name TEXT, source_label TEXT)');
  const columnInsert = db.prepare('INSERT INTO _columns (table_name, ordinal, sqlite_name, source_label) VALUES (?, ?, ?, ?)');
  columns.forEach((column, index) => columnInsert.run(table, index, column.name, column.label));

  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(`INSERT INTO "${table}" VALUES (${placeholders})`);
  const insertRows = db.transaction(() => {
    parsed.rows.forEach((row, rowIndex) => {
      const values = [String(rowIndex + 2)];
      for (let i = 0; i < parsed.columns.length; i++) values.push(cellValue(Array.isArray(row) ? row[i] : null));
      insert.run(values);
    });
  });
  insertRows();
  return { table, rows: parsed.rows.length, columns: parsed.columns.length };
}

// Some source tabs are report grids rather than header-based tables. Preserve
// every row, including the first row, so the consumer can interpret the grid's
// own section headers and data rows without losing positional information.
function createRawGridTable(db, tableName, rows) {
  const allRows = Array.isArray(rows) ? rows : [];
  const width = allRows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  const table = identifier(tableName, 'raw_data');
  const columns = [
    { name: '_sheet_row', label: '_sheet_row' },
    ...Array.from({ length: width }, (_, index) => ({ name: `col_${index + 1}`, label: `Column ${index + 1}` })),
  ];
  db.exec(`CREATE TABLE "${table}" (${columns.map(column => `"${column.name}" TEXT`).join(', ')})`);
  db.exec('CREATE TABLE IF NOT EXISTS _columns (table_name TEXT, ordinal INTEGER, sqlite_name TEXT, source_label TEXT)');
  const columnInsert = db.prepare('INSERT INTO _columns (table_name, ordinal, sqlite_name, source_label) VALUES (?, ?, ?, ?)');
  columns.forEach((column, index) => columnInsert.run(table, index, column.name, column.label));

  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(`INSERT INTO "${table}" VALUES (${placeholders})`);
  const insertRows = db.transaction(() => {
    allRows.forEach((row, rowIndex) => {
      const values = [String(rowIndex + 1)];
      for (let columnIndex = 0; columnIndex < width; columnIndex++) {
        values.push(cellValue(Array.isArray(row) ? row[columnIndex] : null));
      }
      insert.run(values);
    });
  });
  insertRows();
  return { table, rows: allRows.length, columns: width };
}

function createSideBySideTable(db, definition, fetched) {
  const leftPrefix = sourcePrefix(definition.sources[0], 0);
  const rightPrefix = sourcePrefix(definition.sources[1], 1);
  const left = tableRows(fetched[sourceKey(definition.sources[0])] || [], leftPrefix);
  const right = tableRows(fetched[sourceKey(definition.sources[1])] || [], rightPrefix);
  const table = identifier(definition.combinedTable, 'combined_data');
  const leftRowName = `_${identifier(leftPrefix, 'left')}_row`;
  const rightRowName = `_${identifier(rightPrefix, 'right')}_row`;
  const columns = [
    { name: leftRowName, label: leftRowName },
    ...left.columns,
    { name: rightRowName, label: rightRowName },
    ...right.columns,
  ];
  db.exec(`CREATE TABLE "${table}" (${columns.map(column => `"${column.name}" TEXT`).join(', ')})`);
  db.exec('CREATE TABLE IF NOT EXISTS _columns (table_name TEXT, ordinal INTEGER, sqlite_name TEXT, source_label TEXT)');
  const columnInsert = db.prepare('INSERT INTO _columns (table_name, ordinal, sqlite_name, source_label) VALUES (?, ?, ?, ?)');
  columns.forEach((column, index) => columnInsert.run(table, index, column.name, column.label));

  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(`INSERT INTO "${table}" VALUES (${placeholders})`);
  const rowCount = Math.max(left.rows.length, right.rows.length);
  const insertRows = db.transaction(() => {
    for (let i = 0; i < rowCount; i++) {
      const leftRow = left.rows[i] || [];
      const rightRow = right.rows[i] || [];
      const values = [left.rows[i] ? String(i + 2) : null];
      for (let c = 0; c < left.columns.length; c++) values.push(cellValue(leftRow[c]));
      values.push(right.rows[i] ? String(i + 2) : null);
      for (let c = 0; c < right.columns.length; c++) values.push(cellValue(rightRow[c]));
      insert.run(values);
    }
  });
  insertRows();
  return { table, rows: rowCount, columns: left.columns.length + right.columns.length + 2 };
}

function writeDatabase(definition, fetched, hash) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const output = dbPath(definition.name);
  const temp = `${output}.tmp-${process.pid}`;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(`${temp}${suffix}`, { force: true }); } catch {}
  }

  const db = new Database(temp);
  db.pragma('journal_mode = DELETE');
  db.exec(`CREATE TABLE _database_meta (
    database_name TEXT, layout TEXT, source_sheet_id TEXT, service_account_email TEXT,
    source_tab TEXT, source_range TEXT, row_count INTEGER, column_count INTEGER,
    source_hash TEXT, pulled_at TEXT
  )`);
  const metaInsert = db.prepare('INSERT INTO _database_meta VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const built = [];

  if (definition.layout === 'side-by-side') {
    const result = createSideBySideTable(db, definition, fetched);
    built.push(result);
    const sourceRows = definition.sources.map(source => tableRows(fetched[sourceKey(source)] || []).rows.length);
    metaInsert.run(definition.name, definition.layout, definition.sheetId, definition.serviceAccountEmail, 'COMBINED', definition.sources.map(source => `${source.tab}!${source.range}`).join(' + '), Math.max(...sourceRows, 0), result.columns, hash, new Date().toISOString());
  } else if (definition.layout === 'raw-grid') {
    for (const source of definition.sources) {
      const result = createRawGridTable(db, source.table, fetched[sourceKey(source)] || []);
      built.push(result);
      const rows = fetched[sourceKey(source)] || [];
      const columnCount = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
      metaInsert.run(definition.name, definition.layout, definition.sheetId, definition.serviceAccountEmail, source.tab, source.range, rows.length, columnCount, hash, new Date().toISOString());
    }
  } else {
    for (const source of definition.sources) {
      const result = createTable(db, source.table, fetched[sourceKey(source)] || []);
      built.push(result);
      const parsed = tableRows(fetched[sourceKey(source)] || []);
      metaInsert.run(definition.name, 'separate', definition.sheetId, definition.serviceAccountEmail, source.tab, source.range, parsed.rows.length, result.columns, hash, new Date().toISOString());
    }
  }
  db.close();

  if (process.platform === 'win32' && fs.existsSync(output)) fs.rmSync(output, { force: true });
  fs.renameSync(temp, output);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(`${output}${suffix}`, { force: true }); } catch {}
  }
  lastHashes.set(definition.name, hash);
  return { name: definition.name, path: output, tables: built };
}

function readExistingHash(name) {
  if (lastHashes.has(name)) return lastHashes.get(name);
  const file = dbPath(name);
  if (!fs.existsSync(file)) return null;
  try {
    const db = new Database(file, { readonly: true });
    const row = db.prepare('SELECT source_hash FROM _database_meta LIMIT 1').get();
    db.close();
    const hash = row?.source_hash || null;
    lastHashes.set(name, hash);
    return hash;
  } catch { return null; }
}

async function refreshBulkDatabases() {
  if (running) return { skipped: true, reason: 'sync already running' };
  running = true;
  try {
    loadCredentials();
    const groups = new Map();
    for (const definition of DATA_DATABASES) {
      // Switched off for this stack (SHEET_ID_*=none): reported unavailable below.
      if (!definition.sheetId) continue;
      const key = `${definition.sheetId}::${definition.serviceAccountEmail}`;
      if (!groups.has(key)) groups.set(key, { sheetId: definition.sheetId, email: definition.serviceAccountEmail, sources: new Map() });
      for (const source of definition.sources) groups.get(key).sources.set(sourceKey(source), source);
    }

    const fetched = new Map();
    const failures = [];
    for (const group of groups.values()) {
      const auth = authFor(group.email);
      const sheets = google.sheets({ version: 'v4', auth });
      const sources = [...group.sources.values()];
      const ranges = sources.map(a1Range);
      let response;
      try {
        response = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: group.sheetId,
          ranges,
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER',
        }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
      } catch (err) {
        const message = err.response?.data?.error?.message || err.message;
        failures.push({ email: group.email, sheetId: group.sheetId, ranges, error: message });
        continue;
      }
      (response.data.valueRanges || []).forEach((valueRange, index) => {
        const source = sources[index];
        if (source) fetched.set(sourceKey(source), valueRange.values || []);
      });
    }

    const matchIdRepairs = await repairContractMatchIds(fetched);
    const results = [];
    for (const definition of DATA_DATABASES) {
      const missing = definition.sources.filter(source => !fetched.has(sourceKey(source)));
      if (missing.length) {
        results.push({
          name: definition.name,
          unavailable: true,
          reason: 'One or more source ranges could not be pulled',
          sources: missing.map(source => sourceKey(source)),
        });
        continue;
      }
      const payload = Object.fromEntries(definition.sources.map(source => [sourceKey(source), fetched.get(sourceKey(source)) || []]));
      const hash = hashPayload({
        schema: {
          formatVersion: 2,
          layout: definition.layout || 'separate',
          sourceSheetId: definition.sheetId,
          serviceAccountEmail: definition.serviceAccountEmail,
          combinedTable: definition.combinedTable || null,
          fillDown: definition.fillDown || null,
          identifierColumns: definition.identifierColumns || [],
          sources: definition.sources.map(({ table, tab, range, prefix, matchIdColumn, legacyVslColumn }) => ({
            table,
            tab,
            range,
            prefix: prefix || null,
            matchIdColumn: matchIdColumn || null,
            legacyVslColumn: legacyVslColumn || null,
          })),
        },
        payload,
      });
      if (hash === readExistingHash(definition.name) && fs.existsSync(dbPath(definition.name))) {
        results.push({ name: definition.name, unchanged: true, path: dbPath(definition.name) });
      } else {
        const formatted = fillMergedChildRows(definition, payload);
        const normalized = normalizeIdentifierFields(definition, formatted.fetched);
        results.push({
          ...writeDatabase(definition, normalized.fetched, hash),
          formattedCells: formatted.changed,
          normalizedIdentifiers: normalized.changed,
        });
      }
    }

    const unavailableLinkSources = results.filter(result => VESSEL_LINK_DATABASES.has(result.name) && result.unavailable);
    const linkSourceChanged = results.some(result => VESSEL_LINK_DATABASES.has(result.name) && !result.unavailable && !result.unchanged);
    let vesselLinks = { unchanged: true, path: LINK_DB_PATH };
    if (unavailableLinkSources.length) {
      vesselLinks = { skipped: true, reason: 'One or more link source databases are unavailable', sources: unavailableLinkSources.map(result => result.name) };
    } else if (linkSourceChanged || !fs.existsSync(LINK_DB_PATH)) {
      try {
        vesselLinks = rebuildVesselLinks();
      } catch (err) {
        vesselLinks = { error: err.message };
        console.error('Vessel link rebuild failed:', err.message);
      }
    }
    const changedDatabases = results
      .filter(result => !result.unchanged && !result.unavailable && result.name)
      .map(result => result.name);
    if (changedDatabases.length) {
      broadcastDataUpdated({
        resource: 'bulk-databases',
        databases: changedDatabases,
        source: 'google-sheets',
      });
    }
    const syncedAt = new Date().toISOString();
    for (const result of results) {
      const definition = DATA_DATABASES.find(item => item.name === result.name);
      const failure = failures.find(item => item.sheetId === definition?.sheetId && item.email === definition?.serviceAccountEmail);
      databaseSyncState.set(result.name, {
        at: syncedAt,
        ok: !result.unavailable,
        changed: !result.unavailable && !result.unchanged,
        error: result.unavailable ? (definition?.sheetId ? (failure?.error || result.reason) : 'Switched off') : '',
      });
    }
    return {
      syncedAt,
      groups: groups.size,
      failures,
      matchIdRepairs,
      databases: results,
      vesselLinks,
    };
  } finally {
    running = false;
  }
}

// Write a batch of source cells with the same service account used by the
// configured bulk source. This keeps interactive edits on the sheet and the
// local database on the same source of truth.
async function writeSourceCells(definition, updates) {
  if (!definition || !updates.length) return { updated: 0 };
  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tab = definition.sources[0]?.tab || '';
  const escapedTab = tab.replace(/'/g, "''");
  // Google Sheets accepts a large batchUpdate, but chunking protects the
  // one-time ID backfill when thousands of existing contracts need IDs.
  const chunkSize = 500;
  for (let start = 0; start < updates.length; start += chunkSize) {
    const chunk = updates.slice(start, start + chunkSize);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: definition.sheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: chunk.map(update => ({
          range: `'${escapedTab}'!${update.range}`,
          values: [[update.value == null ? '' : update.value]],
        })),
      },
    }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  }
  return { updated: updates.length };
}

async function writeSourceRange(definition, range, values) {
  if (!definition || !range) return { updated: 0 };
  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tab = definition.sources[0]?.tab || '';
  const escapedTab = tab.replace(/'/g, "''");
  await sheets.spreadsheets.values.update({
    spreadsheetId: definition.sheetId,
    range: `'${escapedTab}'!${range}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  return { updated: values.length };
}

// Live read of a range on the source tab (formatted values). Interactive writes
// use it to re-check row identity at the moment of writing, because the local
// DB snapshot can be up to one sync interval old.
async function readSourceRange(definition, range) {
  if (!definition || !range) return [];
  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tab = definition.sources[0]?.tab || '';
  const escapedTab = tab.replace(/'/g, "''");
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: definition.sheetId,
    range: `'${escapedTab}'!${range}`,
    valueRenderOption: 'FORMATTED_VALUE',
  }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  return response.data?.values || [];
}

async function appendSourceRows(definition, rows) {
  if (!definition || !Array.isArray(rows) || !rows.length) return { updated: 0, updatedRange: '' };
  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tab = definition.sources[0]?.tab || '';
  const escapedTab = tab.replace(/'/g, "''");
  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: definition.sheetId,
    range: `'${escapedTab}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  return {
    updated: Number(response.data?.updates?.updatedRows) || rows.length,
    updatedRange: response.data?.updates?.updatedRange || '',
  };
}

async function ensureSourceTab(definition, headers) {
  if (!definition || !Array.isArray(headers) || !headers.length) throw new Error('Invalid source tab definition');
  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tabName = definition.sources[0]?.tab || '';
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: definition.sheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const existing = (metadata.data.sheets || []).find(sheet => sheet.properties.title === tabName);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: definition.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }

  const escapedTab = tabName.replace(/'/g, "''");
  const lastColumn = colToA1(headers.length - 1);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: definition.sheetId,
    range: `'${escapedTab}'!A1:${lastColumn}1`,
  });
  const current = response.data.values?.[0] || [];
  const normalizedExpected = headers.map(value => normalize(value).toLowerCase());
  const normalizedCurrent = headers.map((_, index) => normalize(current[index]).toLowerCase());
  const blank = normalizedCurrent.every(value => !value);
  if (!blank && normalizedCurrent.some((value, index) => value !== normalizedExpected[index])) {
    throw new Error(`Existing ${tabName} headers do not match the required Vessel Links schema`);
  }
  if (blank) await writeSourceRange(definition, `A1:${lastColumn}1`, [headers]);
  return { tab: tabName, created: !existing, headersWritten: blank };
}

async function ensureSourceColumnHeader(definition, columnIndex, header) {
  if (!definition || !Number.isInteger(columnIndex) || columnIndex < 0 || !header) {
    throw new Error('Invalid source column header definition');
  }
  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tab = definition.sources[0]?.tab || '';
  const escapedTab = tab.replace(/'/g, "''");
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: definition.sheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))',
  });
  const sheet = (metadata.data.sheets || []).find(item => item.properties.title === tab);
  if (!sheet) throw new Error(`Tab not found: ${tab}`);
  const currentColumnCount = Number(sheet.properties.gridProperties?.columnCount) || 0;
  if (currentColumnCount <= columnIndex) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: definition.sheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: {
              sheetId: sheet.properties.sheetId,
              gridProperties: { columnCount: columnIndex + 1 },
            },
            fields: 'gridProperties.columnCount',
          },
        }],
      },
    });
  }
  const cell = `${colToA1(columnIndex)}1`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: definition.sheetId, range: `'${escapedTab}'!${cell}` });
  const current = normalize(response.data.values?.[0]?.[0]);
  if (current && current.toLowerCase() !== normalize(header).toLowerCase()) {
    throw new Error(`${tab}!${cell} already contains "${current}"; expected "${header}"`);
  }
  if (!current) await writeSourceCells(definition, [{ range: cell, value: header }]);
  return { tab, cell, written: !current };
}

async function hideSourceColumn(definition, columnIndex) {
  if (!definition || !Number.isInteger(columnIndex) || columnIndex < 0) {
    throw new Error('Invalid source column to hide');
  }
  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tabName = definition.sources[0]?.tab || '';
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: definition.sheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const tab = (metadata.data.sheets || []).find(sheet => sheet.properties.title === tabName);
  if (!tab) throw new Error(`Tab not found: ${tabName}`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: definition.sheetId,
    requestBody: {
      requests: [{
        updateDimensionProperties: {
          range: {
            sheetId: tab.properties.sheetId,
            dimension: 'COLUMNS',
            startIndex: columnIndex,
            endIndex: columnIndex + 1,
          },
          properties: { hiddenByUser: true },
          fields: 'hiddenByUser',
        },
      }],
    },
  });
  return { tab: tabName, column: colToA1(columnIndex), hidden: true };
}

async function getSourceMergeGroup(definition, options) {
  const { row, anchorColumns = [] } = options || {};
  if (!definition || !Number.isInteger(row) || row < 2 || !anchorColumns.length) {
    throw new Error('Invalid source merge lookup');
  }
  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tabName = definition.sources[0]?.tab || '';
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: definition.sheetId,
    fields: 'sheets(properties(sheetId,title),merges)',
  });
  const tab = (metadata.data.sheets || []).find(sheet => sheet.properties.title === tabName);
  if (!tab) throw new Error(`Tab not found: ${tabName}`);

  const rowIndex = row - 1;
  const anchors = new Set(anchorColumns);
  const merge = (tab.merges || [])
    .filter(range =>
      range.startRowIndex <= rowIndex && range.endRowIndex > rowIndex &&
      [...anchors].some(column => range.startColumnIndex <= column && range.endColumnIndex > column)
    )
    .sort((left, right) =>
      (left.endRowIndex - left.startRowIndex) - (right.endRowIndex - right.startRowIndex)
    )[0];
  return merge
    ? { startRow: merge.startRowIndex + 1, endRow: merge.endRowIndex, merged: true }
    : { startRow: row, endRow: row, merged: false };
}

async function insertSourcePartialRow(definition, options) {
  const {
    groupStartRow,
    groupEndRow,
    columnCount,
    newRow,
    parentUpdates = [],
    noMergeColumns = [],
    mergeStartRows = {},
    preserveMergeTopology = false,
    mergeBeforeColumn = columnCount,
    newMergeColumns = [],
  } = options || {};
  if (!definition || !Number.isInteger(groupStartRow) || !Number.isInteger(groupEndRow) || groupStartRow < 2 || groupEndRow < groupStartRow) {
    throw new Error('Invalid partial-shipment row group');
  }
  if (!Number.isInteger(columnCount) || columnCount < 2 || !Array.isArray(newRow)) {
    throw new Error('Invalid partial-shipment row data');
  }

  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tabName = definition.sources[0]?.tab || '';
  const escapedTab = tabName.replace(/'/g, "''");
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: definition.sheetId,
    fields: 'sheets(properties(sheetId,title),merges)',
  });
  const tab = (metadata.data.sheets || []).find(sheet => sheet.properties.title === tabName);
  if (!tab) throw new Error(`Tab not found: ${tabName}`);

  const groupStartIndex = groupStartRow - 1;
  const groupEndIndex = groupEndRow;
  const existingMerges = (tab.merges || []).filter(merge =>
    merge.startColumnIndex > 0 && merge.endColumnIndex <= mergeBeforeColumn &&
    merge.startRowIndex < groupEndIndex && merge.endRowIndex > groupStartIndex
  );
  const topologyMerges = preserveMergeTopology
    // Include blocks ending at the insertion point and larger independent
    // blocks that cross it. Google Sheets cannot insert through a live merge.
    ? existingMerges.filter(merge =>
        merge.startRowIndex < groupEndIndex && merge.endRowIndex >= groupEndIndex
      )
    : existingMerges;
  const unmergeRequests = topologyMerges
    .map(merge => ({ unmergeCells: { range: merge } }));
  const structuralRequests = [
    ...unmergeRequests,
    {
      insertDimension: {
        range: {
          sheetId: tab.properties.sheetId,
          dimension: 'ROWS',
          startIndex: groupEndRow,
          endIndex: groupEndRow + 1,
        },
        inheritFromBefore: true,
      },
    },
  ];
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: definition.sheetId,
    requestBody: { requests: structuralRequests },
  });

  const childRow = groupEndRow + 1;
  const lastColumn = colToA1(columnCount - 1);
  const writeData = [{
    range: `'${escapedTab}'!B${childRow}:${lastColumn}${childRow}`,
    values: [Array.from({ length: columnCount - 1 }, (_, index) => newRow[index + 1] == null ? '' : newRow[index + 1])],
  }];
  parentUpdates.forEach(update => {
    writeData.push({
      range: `'${escapedTab}'!${colToA1(update.column)}${groupStartRow}`,
      values: [[update.value == null ? '' : update.value]],
    });
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: definition.sheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: writeData },
  });

  const excluded = new Set(noMergeColumns);
  const mergeRequests = [];
  if (preserveMergeTopology) {
    topologyMerges.forEach(merge => {
      const columnsExcluded = Array.from(
        { length: merge.endColumnIndex - merge.startColumnIndex },
        (_, offset) => merge.startColumnIndex + offset
      ).some(column => excluded.has(column));
      if (columnsExcluded) return;
      mergeRequests.push({
        mergeCells: {
          range: { ...merge, endRowIndex: merge.endRowIndex + 1 },
          mergeType: 'MERGE_COLUMNS',
        },
      });
    });
    newMergeColumns.forEach(column => {
      if (column <= 0 || column >= mergeBeforeColumn || excluded.has(column)) return;
      const alreadyExtended = topologyMerges.some(merge =>
        merge.startColumnIndex <= column && merge.endColumnIndex > column
      );
      if (alreadyExtended) return;
      mergeRequests.push({
        mergeCells: {
          range: {
            sheetId: tab.properties.sheetId,
            startRowIndex: groupStartIndex,
            endRowIndex: childRow,
            startColumnIndex: column,
            endColumnIndex: column + 1,
          },
          mergeType: 'MERGE_COLUMNS',
        },
      });
    });
  }
  for (let column = 1; !preserveMergeTopology && column < columnCount; column++) {
    if (excluded.has(column)) continue;
    const existingMerge = existingMerges.find(merge => merge.startColumnIndex <= column && merge.endColumnIndex > column);
    const requestedStartRow = Number(mergeStartRows[column]) || groupStartRow;
    const startRowIndex = existingMerge ? existingMerge.startRowIndex : requestedStartRow - 1;
    if (childRow - startRowIndex < 2) continue;
    mergeRequests.push({
      mergeCells: {
        range: {
          sheetId: tab.properties.sheetId,
          startRowIndex,
          endRowIndex: childRow,
          startColumnIndex: column,
          endColumnIndex: column + 1,
        },
        mergeType: 'MERGE_COLUMNS',
      },
    });
  }
  if (mergeRequests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: definition.sheetId,
      requestBody: { requests: mergeRequests },
    });
  }
  return { inserted: childRow };
}

async function deleteSourcePartialRow(definition, options) {
  const {
    groupStartRow,
    groupEndRow,
    row,
    parentUpdates = [],
    mergeBeforeColumn = Number.MAX_SAFE_INTEGER,
    deleteRowOnly = false,
  } = options || {};
  if (
    !definition || !Number.isInteger(groupStartRow) || !Number.isInteger(groupEndRow) ||
    !Number.isInteger(row) || groupStartRow < 2 || groupEndRow <= groupStartRow ||
    row <= groupStartRow || row > groupEndRow
  ) {
    throw new Error('Invalid partial-shipment child row');
  }

  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tabName = definition.sources[0]?.tab || '';
  const escapedTab = tabName.replace(/'/g, "''");
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: definition.sheetId,
    fields: deleteRowOnly
      ? 'sheets(properties(sheetId,title))'
      : 'sheets(properties(sheetId,title),merges)',
  });
  const tab = (metadata.data.sheets || []).find(sheet => sheet.properties.title === tabName);
  if (!tab) throw new Error(`Tab not found: ${tabName}`);

  const groupStartIndex = groupStartRow - 1;
  const groupEndIndex = groupEndRow;
  const deleteIndex = row - 1;
  const existingMerges = (tab.merges || []).filter(merge =>
    !deleteRowOnly &&
    merge.startColumnIndex > 0 && merge.endColumnIndex <= mergeBeforeColumn &&
    merge.startRowIndex <= deleteIndex && merge.endRowIndex > deleteIndex &&
    merge.startRowIndex < groupEndIndex && merge.endRowIndex > groupStartIndex
  );

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: definition.sheetId,
    requestBody: {
      requests: [
        ...existingMerges.map(merge => ({ unmergeCells: { range: merge } })),
        {
          deleteDimension: {
            range: {
              sheetId: tab.properties.sheetId,
              dimension: 'ROWS',
              startIndex: deleteIndex,
              endIndex: deleteIndex + 1,
            },
          },
        },
      ],
    },
  });

  if (parentUpdates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: definition.sheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: parentUpdates.map(update => ({
          range: `'${escapedTab}'!${colToA1(update.column)}${groupStartRow}`,
          values: [[update.value == null ? '' : update.value]],
        })),
      },
    });
  }

  const mergeRequests = existingMerges.flatMap(merge => {
    let startRowIndex = merge.startRowIndex;
    let endRowIndex = merge.endRowIndex;
    if (startRowIndex > deleteIndex) startRowIndex--;
    if (endRowIndex > deleteIndex) endRowIndex--;
    if (endRowIndex - startRowIndex < 2) return [];
    return [{
      mergeCells: {
        range: { ...merge, startRowIndex, endRowIndex },
        mergeType: 'MERGE_COLUMNS',
      },
    }];
  });
  if (!deleteRowOnly && mergeRequests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: definition.sheetId,
      requestBody: { requests: mergeRequests },
    });
  }

  return { deleted: row };
}

async function deleteSourceRow(definition, row1Based) {
  if (!definition || !Number.isInteger(row1Based) || row1Based < 2) {
    throw new Error('Invalid source row');
  }
  loadCredentials();
  const auth = authFor(definition.serviceAccountEmail);
  const sheets = google.sheets({ version: 'v4', auth });
  const tabName = definition.sources[0]?.tab || '';
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: definition.sheetId,
    fields: 'sheets(properties(sheetId,title))',
  }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  const tab = (metadata.data.sheets || []).find(sheet => sheet.properties.title === tabName);
  if (!tab) throw new Error(`Tab not found: ${tabName}`);
  const rowIndex = row1Based - 1;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: definition.sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: tab.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }],
    },
  }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  return { deleted: row1Based };
}

const syncStatus = { lastSuccessAt: 0, lastFailureAt: 0, lastFailureCount: 0, lastError: '' };

function startBulkDataSync() {
  if (timer) return;
  const run = () => refreshBulkDatabases()
    .then(result => {
      if (result.skipped) return;
      if (result.failures?.length) {
        result.failures.forEach(failure => console.error(`Bulk fetch failed for ${failure.email} on ${failure.sheetId}: ${failure.error}`));
        syncStatus.lastFailureAt = Date.now();
      }
      syncStatus.lastFailureCount = result.failures?.length || 0;
      if (result.groups && syncStatus.lastFailureCount < result.groups) syncStatus.lastSuccessAt = Date.now();
    })
    .catch(err => {
      syncStatus.lastFailureAt = Date.now();
      syncStatus.lastError = err.message;
      console.error('Bulk data sync failed:', err.message);
    });
  run();
  timer = setInterval(run, BULK_SYNC_INTERVAL_MS);
  console.log(`Bulk data sync started (every ${BULK_SYNC_INTERVAL_MS / 1000}s, ${DATA_DATABASES.length} databases)`);
}

function stopBulkDataSync() {
  if (timer) clearInterval(timer);
  timer = null;
}

// For the readiness probe: is a sync running, and how fresh is the mirror?
function bulkSyncStatus() {
  return { ...syncStatus, running, intervalMs: BULK_SYNC_INTERVAL_MS };
}

function databaseSyncStates() {
  return Object.fromEntries(databaseSyncState);
}

// After a source's settings change, its last outcome no longer describes it.
function forgetDatabaseSyncState(names) {
  for (const name of names) databaseSyncState.delete(name);
}

// Emails of the service-account keys on this server (never the keys themselves).
function availableServiceAccounts() {
  try {
    loadCredentials();
  } catch {
    return [];
  }
  return [...credentialsByEmail.keys()].sort();
}

// Connection check for Admin -> Sheets Config: can this account open the
// spreadsheet, and which tabs does it have?
async function inspectSpreadsheet(sheetId, serviceAccountEmail) {
  loadCredentials();
  const sheets = google.sheets({ version: 'v4', auth: authFor(serviceAccountEmail) });
  const response = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'properties.title,sheets.properties.title',
  }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS });
  return {
    title: response.data.properties?.title || '',
    tabs: (response.data.sheets || []).map(sheet => sheet.properties?.title).filter(Boolean),
  };
}

module.exports = {
  DATA_DIR,
  DATA_DATABASES,
  refreshBulkDatabases,
  writeSourceCells,
  writeSourceRange,
  readSourceRange,
  appendSourceRows,
  ensureSourceTab,
  ensureSourceColumnHeader,
  hideSourceColumn,
  getSourceMergeGroup,
  insertSourcePartialRow,
  deleteSourcePartialRow,
  deleteSourceRow,
  startBulkDataSync,
  stopBulkDataSync,
  bulkSyncStatus,
  databaseSyncStates,
  forgetDatabaseSyncState,
  availableServiceAccounts,
  inspectSpreadsheet,
  dbPath,
};
