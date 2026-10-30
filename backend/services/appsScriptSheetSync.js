'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const { getDb } = require('../db/database');
const { broadcastDataUpdated } = require('./realtime');

const SPREADSHEET_ID = String(
  process.env.APPS_SCRIPT_TEST_SPREADSHEET_ID
  || '13jC69FfyHuhbcM5Vcu_Dgcj1a5kKWxXuLC98IRLTnEo'
).trim();
const TAB_NAME = String(process.env.APPS_SCRIPT_TEST_TAB || 'Sheet1').trim();
const SERVICE_ACCOUNT_EMAIL = String(
  process.env.APPS_SCRIPT_TEST_SERVICE_ACCOUNT_EMAIL
  || 'vessel-vs-contract-2-0@robust-chess-498206-r3.iam.gserviceaccount.com'
).trim().toLowerCase();
const DATA_COLUMNS = 5;
const RECORD_ID_COLUMN = DATA_COLUMNS + 1;
const RECORD_ID_HEADER = '_ERP_ROW_ID';
const FALLBACK_HEADERS = ['No.', 'buyer', 'contract', 'incoterm', 'price'];
const MAX_CELL_LENGTH = 10000;
const REQUEST_TIMEOUT_MS = 20000;
const WRITE_FLUSH_INTERVAL_MS = clamp(
  Number(process.env.APPS_SCRIPT_TEST_WRITE_FLUSH_MS) || 2000,
  1000,
  30000
);
const RECONCILE_INTERVAL_MS = clamp(
  Number(process.env.APPS_SCRIPT_TEST_RECONCILE_MS) || 300000,
  30000,
  3600000
);

let started = false;
let flushing = false;
let reconcilePromise = null;
let reconcileTimer = null;
let flushTimer = null;
let scheduledReconcile = null;
let sheetsClient = null;
let tabSheetId = null;
let mutationVersion = 0;
let directState = 'unknown';
let lastDirectError = null;

const stats = {
  pushCount: 0,
  lastPushAt: null,
  directReadCalls: 0,
  directWriteCalls: 0,
  legacyCalls: 0,
  lastReconciledAt: null,
  lastFlushAt: null,
  lastError: null,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nowIso() {
  return new Date().toISOString();
}

function quoteTab(tabName = TAB_NAME) {
  return `'${String(tabName).replace(/'/g, "''")}'`;
}

function columnToA1(columnNumber) {
  let value = Number(columnNumber);
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new Error('Cell values must be text, numbers, or booleans');
  }
  const normalized = String(value);
  if (normalized.length > MAX_CELL_LENGTH) throw new Error('Cell value is too long');
  return normalized;
}

function normalizeValues(values) {
  return Array.from({ length: DATA_COLUMNS }, (_, index) => normalizeCell(values?.[index]));
}

function toUserEnteredValue(value) {
  const normalized = normalizeCell(value);
  if (!normalized) return {};
  if (normalized.startsWith('=')) return { formulaValue: normalized };
  if (/^(true|false)$/i.test(normalized)) {
    return { boolValue: normalized.toLowerCase() === 'true' };
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) return { numberValue: numeric };
  }
  return { stringValue: normalized };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function getMeta(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM apps_script_sheet_meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(key, value, timestamp = nowIso()) {
  getDb().prepare(`
    INSERT INTO apps_script_sheet_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), timestamp);
}

function notifyClients() {
  broadcastDataUpdated({ resource: 'apps-script-sheet', department: 'admin' });
}

function loadSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const keysDir = process.env.SERVICE_ACCOUNTS_DIR || path.join(__dirname, '../service-accounts');
  if (!fs.existsSync(keysDir)) throw new Error(`Service-account directory not found: ${keysDir}`);

  let credentials = null;
  for (const filename of fs.readdirSync(keysDir).filter(file => file.endsWith('.json'))) {
    try {
      const candidate = JSON.parse(fs.readFileSync(path.join(keysDir, filename), 'utf8'));
      if (String(candidate.client_email || '').toLowerCase() === SERVICE_ACCOUNT_EMAIL) {
        credentials = candidate;
        break;
      }
    } catch (error) {
      console.error(`Failed to load service account ${filename}: ${error.message}`);
    }
  }
  if (!credentials) throw new Error(`Service account not found: ${SERVICE_ACCOUNT_EMAIL}`);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function loadTabSheetId() {
  if (Number.isInteger(tabSheetId)) return tabSheetId;
  const metadata = await loadSheetsClient().spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties(sheetId,title))',
  });
  stats.directReadCalls += 1;
  const tab = (metadata.data.sheets || []).find(item => item.properties.title === TAB_NAME);
  if (!tab) throw new Error(`Tab not found: ${TAB_NAME}`);
  tabSheetId = Number(tab.properties.sheetId);
  return tabSheetId;
}

function legacyBridgeConfig() {
  const endpoint = String(process.env.APPS_SCRIPT_TEST_URL || '').trim();
  const secret = String(process.env.APPS_SCRIPT_TEST_SECRET || '').trim();
  if (!endpoint || !secret) return null;

  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') return null;
    return { endpoint: url.toString(), secret };
  } catch {
    return null;
  }
}

async function callLegacyBridge(action) {
  const config = legacyBridgeConfig();
  if (!config) throw new Error('Apps Script fallback bridge is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let url = config.endpoint;
    const options = { redirect: 'follow', signal: controller.signal };
    if (action) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ secret: config.secret, ...action });
    } else {
      const readUrl = new URL(url);
      readUrl.searchParams.set('secret', config.secret);
      url = readUrl.toString();
    }

    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Apps Script returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || payload.ok !== true) {
      throw new Error(payload?.error || 'Apps Script returned an invalid response');
    }
    stats.legacyCalls += 1;
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Apps Script request timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function localRowsByNumber() {
  const rows = getDb().prepare(
    'SELECT record_id, row_number FROM apps_script_sheet_rows ORDER BY row_number'
  ).all();
  return new Map(rows.map(row => [Number(row.row_number), row.record_id]));
}

function snapshotFromDirect(rawValues) {
  const rows = Array.isArray(rawValues) ? rawValues : [];
  const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
  const idHeader = String(headerRow[RECORD_ID_COLUMN - 1] || '').trim();
  if (idHeader && idHeader !== RECORD_ID_HEADER) {
    const error = new Error(`${TAB_NAME}!${columnToA1(RECORD_ID_COLUMN)}1 must be blank or ${RECORD_ID_HEADER}`);
    error.code = 'ID_COLUMN_OCCUPIED';
    throw error;
  }

  const existingByRow = localRowsByNumber();
  const seenIds = new Set();
  const idWrites = [];
  const records = [];
  for (let index = 1; index < rows.length; index += 1) {
    const rowNumber = index + 1;
    const source = Array.isArray(rows[index]) ? rows[index] : [];
    const values = normalizeValues(source);
    let recordId = String(source[RECORD_ID_COLUMN - 1] || '').trim();
    if (!recordId || seenIds.has(recordId)) {
      recordId = existingByRow.get(rowNumber) || crypto.randomUUID();
      if (seenIds.has(recordId)) recordId = crypto.randomUUID();
      idWrites.push({ rowNumber, recordId });
    }
    seenIds.add(recordId);
    records.push({ recordId, rowNumber, values });
  }

  return {
    headers: normalizeValues(headerRow).map((value, index) => value || FALLBACK_HEADERS[index]),
    records,
    idHeader,
    idWrites,
  };
}

function snapshotFromLegacy(payload) {
  const existingByRow = localRowsByNumber();
  const records = (Array.isArray(payload?.rows) ? payload.rows : [])
    .map(row => {
      const rowNumber = Number(row?.rowNumber);
      if (!Number.isInteger(rowNumber) || rowNumber < 2) return null;
      return {
        recordId: existingByRow.get(rowNumber) || crypto.randomUUID(),
        rowNumber,
        values: normalizeValues(row.values),
      };
    })
    .filter(Boolean);
  const suppliedHeaders = Array.isArray(payload?.headers) ? payload.headers : [];
  return {
    headers: normalizeValues(suppliedHeaders).map((value, index) => value || FALLBACK_HEADERS[index]),
    records,
    idWrites: [],
  };
}

async function fetchDirectSnapshot() {
  const sheets = loadSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteTab()}!A:${columnToA1(RECORD_ID_COLUMN)}`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  stats.directReadCalls += 1;
  directState = 'available';
  lastDirectError = null;
  return snapshotFromDirect(response.data.values || []);
}

async function ensureRemoteRecordIds(snapshot) {
  const data = [];
  if (!snapshot.idHeader) {
    data.push({
      range: `${quoteTab()}!${columnToA1(RECORD_ID_COLUMN)}1`,
      values: [[RECORD_ID_HEADER]],
    });
  }
  snapshot.idWrites.forEach(item => {
    data.push({
      range: `${quoteTab()}!${columnToA1(RECORD_ID_COLUMN)}${item.rowNumber}`,
      values: [[item.recordId]],
    });
  });
  if (data.length) {
    await loadSheetsClient().spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    });
    stats.directWriteCalls += 1;
  }

  if (getMeta('record_id_column_hidden') !== 'true') {
    try {
      const sheetId = await loadTabSheetId();
      await loadSheetsClient().spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{
            updateDimensionProperties: {
              range: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: RECORD_ID_COLUMN - 1,
                endIndex: RECORD_ID_COLUMN,
              },
              properties: { hiddenByUser: true },
              fields: 'hiddenByUser',
            },
          }],
        },
      });
      stats.directWriteCalls += 1;
      setMeta('record_id_column_hidden', 'true');
    } catch (error) {
      console.error(`Apps Script test ID column could not be hidden: ${error.message}`);
    }
  }
}

function pendingColumnsByRecord() {
  const rows = getDb().prepare(`
    SELECT record_id, column_number
    FROM apps_script_sheet_outbox
    WHERE operation = 'cell'
  `).all();
  const result = new Map();
  rows.forEach(row => {
    if (!result.has(row.record_id)) result.set(row.record_id, new Set());
    result.get(row.record_id).add(Number(row.column_number));
  });
  return result;
}

function hasPendingMove(db = getDb()) {
  return Boolean(db.prepare(
    "SELECT 1 FROM apps_script_sheet_outbox WHERE operation = 'move' LIMIT 1"
  ).get());
}

function applySnapshot(snapshot, source, versionAtStart) {
  if (versionAtStart !== mutationVersion) return false;
  const db = getDb();
  const timestamp = nowIso();
  const pending = pendingColumnsByRecord();
  const pendingCreates = db.prepare(`
    SELECT outbox.record_id, outbox.operation, rows.row_number
    FROM apps_script_sheet_outbox AS outbox
    JOIN apps_script_sheet_rows AS rows ON rows.record_id = outbox.record_id
    WHERE outbox.operation IN ('append', 'insert')
    ORDER BY rows.row_number
  `).all();
  const pendingCreateIds = new Set(pendingCreates.map(row => row.record_id));
  const sourceIds = new Set(snapshot.records.map(row => row.recordId));
  const outstandingInserts = pendingCreates.filter(row => (
    row.operation === 'insert' && !sourceIds.has(row.record_id)
  ));
  const records = snapshot.records.map(record => {
    let rowNumber = record.rowNumber;
    outstandingInserts.forEach(pendingInsert => {
      if (rowNumber >= Number(pendingInsert.row_number)) rowNumber += 1;
    });
    return rowNumber === record.rowNumber ? record : { ...record, rowNumber };
  });
  const existingRows = db.prepare(
    'SELECT record_id, row_number, values_json FROM apps_script_sheet_rows'
  ).all();
  const existingById = new Map(existingRows.map(row => [row.record_id, row]));
  const incomingIds = new Set(records.map(row => row.recordId));

  const upsert = db.prepare(`
    INSERT INTO apps_script_sheet_rows
      (record_id, row_number, values_json, pending_append, source_updated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      row_number = excluded.row_number,
      values_json = excluded.values_json,
      pending_append = excluded.pending_append,
      source_updated_at = excluded.source_updated_at,
      updated_at = excluded.updated_at
  `);
  const remove = db.prepare(`
    DELETE FROM apps_script_sheet_rows
    WHERE record_id = ?
      AND pending_append = 0
      AND NOT EXISTS (
        SELECT 1 FROM apps_script_sheet_outbox WHERE record_id = ?
      )
  `);

  const transaction = db.transaction(() => {
    records.forEach(record => {
      const existing = existingById.get(record.recordId);
      const values = [...record.values];
      const protectedColumns = pending.get(record.recordId);
      const pendingCreate = pendingCreateIds.has(record.recordId);
      if (existing && (protectedColumns?.size || pendingCreate)) {
        const localValues = normalizeValues(parseJson(existing.values_json, []));
        if (pendingCreate) {
          values.splice(0, values.length, ...localValues);
        } else {
          protectedColumns.forEach(column => {
            if (column >= 1 && column <= DATA_COLUMNS) values[column - 1] = localValues[column - 1];
          });
        }
      }
      upsert.run(
        record.recordId,
        record.rowNumber,
        JSON.stringify(values),
        pendingCreate ? 1 : 0,
        timestamp,
        timestamp
      );
    });
    existingRows.forEach(row => {
      if (!incomingIds.has(row.record_id)) remove.run(row.record_id, row.record_id);
    });
    setMeta('headers', JSON.stringify(snapshot.headers), timestamp);
    setMeta('last_source', source, timestamp);
    setMeta('last_reconciled_at', timestamp, timestamp);
  });
  transaction();
  stats.lastReconciledAt = timestamp;
  return true;
}

async function reconcile() {
  if (reconcilePromise) return reconcilePromise;
  if (hasPendingMove()) {
    return { applied: false, source: 'local', reason: 'pending-move' };
  }
  const versionAtStart = mutationVersion;
  reconcilePromise = (async () => {
    let snapshot;
    let source;
    try {
      snapshot = await fetchDirectSnapshot();
      await ensureRemoteRecordIds(snapshot);
      source = 'sheets-api';
    } catch (directError) {
      directState = Number(directError.response?.status) === 403 ? 'permission-required' : 'unavailable';
      lastDirectError = directError.message;
      try {
        snapshot = snapshotFromLegacy(await callLegacyBridge());
        source = 'apps-script-fallback';
      } catch (legacyError) {
        stats.lastError = legacyError.message;
        throw legacyError;
      }
    }

    if (!applySnapshot(snapshot, source, versionAtStart)) {
      scheduleReconcile(250);
      return { applied: false, source, reason: 'newer-mutation' };
    }
    stats.lastError = null;
    notifyClients();
    return { applied: true, source };
  })().finally(() => {
    reconcilePromise = null;
  });
  return reconcilePromise;
}

function scheduleReconcile(delayMs = 250) {
  if (scheduledReconcile) return;
  scheduledReconcile = setTimeout(() => {
    scheduledReconcile = null;
    reconcile().catch(error => {
      stats.lastError = error.message;
      console.error(`Apps Script sheet reconciliation failed: ${error.message}`);
    });
  }, delayMs);
  scheduledReconcile.unref();
}

function findLocalRow(recordId, rowNumber) {
  const db = getDb();
  if (recordId) {
    const byId = db.prepare('SELECT * FROM apps_script_sheet_rows WHERE record_id = ?').get(recordId);
    if (byId) return byId;
  }
  if (Number.isInteger(rowNumber)) {
    return db.prepare('SELECT * FROM apps_script_sheet_rows WHERE row_number = ?').get(rowNumber);
  }
  return null;
}

function enqueueOutbox(db, item, timestamp) {
  db.prepare(`
    INSERT INTO apps_script_sheet_outbox
      (dedupe_key, operation, record_id, column_number, values_json,
       attempts, next_attempt_at, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      operation = excluded.operation,
      record_id = excluded.record_id,
      column_number = excluded.column_number,
      values_json = excluded.values_json,
      attempts = 0,
      next_attempt_at = 0,
      last_error = NULL,
      updated_at = excluded.updated_at
  `).run(
    item.dedupeKey,
    item.operation,
    item.recordId,
    item.columnNumber ?? null,
    JSON.stringify(item.values),
    timestamp,
    timestamp
  );
}

function queueCellUpdates({ recordId, rowNumber, changes }) {
  const normalizedChanges = (Array.isArray(changes) ? changes : []).map(change => {
    const column = Number(change?.column);
    if (!Number.isInteger(column) || column < 1 || column > DATA_COLUMNS) {
      throw new Error('Invalid sheet column');
    }
    return { column, value: normalizeCell(change?.value) };
  });
  if (!normalizedChanges.length) throw new Error('No cell changes supplied');

  const db = getDb();
  const row = findLocalRow(recordId, Number(rowNumber));
  if (!row) throw new Error('Sheet row was not found');
  const timestamp = nowIso();
  const values = normalizeValues(parseJson(row.values_json, []));
  normalizedChanges.forEach(change => { values[change.column - 1] = change.value; });

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE apps_script_sheet_rows
      SET values_json = ?, updated_at = ?
      WHERE record_id = ?
    `).run(JSON.stringify(values), timestamp, row.record_id);

    if (row.pending_append) {
      const pendingCreate = db.prepare(`
        SELECT operation, values_json
        FROM apps_script_sheet_outbox
        WHERE record_id = ? AND operation IN ('append', 'insert')
        ORDER BY id
        LIMIT 1
      `).get(row.record_id);
      if (pendingCreate?.operation === 'insert') {
        const payload = parseJson(pendingCreate.values_json, {});
        enqueueOutbox(db, {
          dedupeKey: `insert:${row.record_id}`,
          operation: 'insert',
          recordId: row.record_id,
          values: {
            afterRecordId: String(payload.afterRecordId || ''),
            rowValues: [...values, row.record_id],
          },
        }, timestamp);
      } else {
        enqueueOutbox(db, {
          dedupeKey: `append:${row.record_id}`,
          operation: 'append',
          recordId: row.record_id,
          values: [...values, row.record_id],
        }, timestamp);
      }
    } else {
      normalizedChanges.forEach(change => {
        enqueueOutbox(db, {
          dedupeKey: `cell:${row.record_id}:${change.column}`,
          operation: 'cell',
          recordId: row.record_id,
          columnNumber: change.column,
          values: change.value,
        }, timestamp);
      });
    }
  });
  transaction();
  mutationVersion += 1;
  notifyClients();
  return { recordId: row.record_id, rowNumber: row.row_number, values, queued: true };
}

function queueAppend(values) {
  const db = getDb();
  if (hasPendingMove(db)) {
    throw new Error('Wait for the row movement to finish syncing before adding another row');
  }
  const recordId = crypto.randomUUID();
  const normalized = normalizeValues(values);
  const timestamp = nowIso();
  const largest = db.prepare(
    'SELECT COALESCE(MAX(row_number), 1) AS row_number FROM apps_script_sheet_rows'
  ).get();
  const rowNumber = Number(largest.row_number) + 1;

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO apps_script_sheet_rows
        (record_id, row_number, values_json, pending_append, source_updated_at, updated_at)
      VALUES (?, ?, ?, 1, NULL, ?)
    `).run(recordId, rowNumber, JSON.stringify(normalized), timestamp);
    enqueueOutbox(db, {
      dedupeKey: `append:${recordId}`,
      operation: 'append',
      recordId,
      values: [...normalized, recordId],
    }, timestamp);
  });
  transaction();
  mutationVersion += 1;
  notifyClients();
  return { recordId, rowNumber, values: normalized, queued: true };
}

function queueInsert(values, { afterRecordId, afterRowNumber } = {}) {
  const db = getDb();
  if (hasPendingMove(db)) {
    throw new Error('Wait for the row movement to finish syncing before inserting another row');
  }
  const anchor = findLocalRow(String(afterRecordId || ''), Number(afterRowNumber));
  if (!anchor) throw new Error('Insert anchor row was not found');
  if (anchor.pending_append) throw new Error('Wait for the anchor row to finish syncing before inserting below it');

  const recordId = crypto.randomUUID();
  const normalized = normalizeValues(values);
  const timestamp = nowIso();
  const rowNumber = Number(anchor.row_number) + 1;

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE apps_script_sheet_rows
      SET row_number = row_number + 1
      WHERE row_number >= ?
    `).run(rowNumber);
    db.prepare(`
      INSERT INTO apps_script_sheet_rows
        (record_id, row_number, values_json, pending_append, source_updated_at, updated_at)
      VALUES (?, ?, ?, 1, NULL, ?)
    `).run(recordId, rowNumber, JSON.stringify(normalized), timestamp);
    enqueueOutbox(db, {
      dedupeKey: `insert:${recordId}`,
      operation: 'insert',
      recordId,
      values: {
        afterRecordId: anchor.record_id,
        rowValues: [...normalized, recordId],
      },
    }, timestamp);
  });
  transaction();
  mutationVersion += 1;
  notifyClients();
  return {
    recordId,
    rowNumber,
    values: normalized,
    afterRecordId: anchor.record_id,
    queued: true,
  };
}

function queueMove({ recordId, targetRecordId, position }) {
  const sourceId = String(recordId || '').trim();
  const targetId = String(targetRecordId || '').trim();
  const placement = String(position || '').toLowerCase();
  if (!sourceId || !targetId) throw new Error('Row move requires a source and target row');
  if (sourceId === targetId) throw new Error('A row cannot be moved onto itself');
  if (!['before', 'after'].includes(placement)) {
    throw new Error('Row move position must be before or after');
  }

  const db = getDb();
  const pendingWrite = db.prepare(
    'SELECT operation FROM apps_script_sheet_outbox ORDER BY id LIMIT 1'
  ).get();
  if (pendingWrite) {
    throw new Error('Wait for pending Sheet changes to finish syncing before moving a row');
  }

  const rows = db.prepare(`
    SELECT record_id, row_number, pending_append
    FROM apps_script_sheet_rows
    ORDER BY row_number, record_id
  `).all();
  const sourceIndex = rows.findIndex(row => row.record_id === sourceId);
  const originalTargetIndex = rows.findIndex(row => row.record_id === targetId);
  if (sourceIndex < 0) throw new Error('Row move source was not found');
  if (originalTargetIndex < 0) throw new Error('Row move target was not found');
  if (rows[sourceIndex].pending_append || rows[originalTargetIndex].pending_append) {
    throw new Error('Wait for both rows to finish syncing before moving them');
  }

  const positions = rows.map(row => Number(row.row_number));
  const reordered = [...rows];
  const [source] = reordered.splice(sourceIndex, 1);
  const targetIndex = reordered.findIndex(row => row.record_id === targetId);
  const insertIndex = targetIndex + (placement === 'after' ? 1 : 0);
  reordered.splice(insertIndex, 0, source);
  const changed = reordered.some((row, index) => row.record_id !== rows[index].record_id);
  if (!changed) {
    return {
      recordId: sourceId,
      targetRecordId: targetId,
      position: placement,
      rowNumber: Number(rows[sourceIndex].row_number),
      queued: false,
    };
  }

  const timestamp = nowIso();
  const updatePosition = db.prepare(`
    UPDATE apps_script_sheet_rows
    SET row_number = ?, updated_at = ?
    WHERE record_id = ?
  `);
  const transaction = db.transaction(() => {
    reordered.forEach((row, index) => {
      updatePosition.run(positions[index], timestamp, row.record_id);
    });
    enqueueOutbox(db, {
      dedupeKey: `move:${sourceId}`,
      operation: 'move',
      recordId: sourceId,
      values: { targetRecordId: targetId, position: placement },
    }, timestamp);
  });
  transaction();
  mutationVersion += 1;
  notifyClients();

  return {
    recordId: sourceId,
    targetRecordId: targetId,
    position: placement,
    fromRow: positions[sourceIndex],
    rowNumber: positions[insertIndex],
    queued: true,
  };
}

function ingestEvent(payload) {
  payload = { ...(payload || {}) };
  delete payload.secret;
  const db = getDb();
  const suppliedEventId = String(payload?.eventId || payload?.event_id || '').trim();
  const eventId = suppliedEventId || crypto.randomUUID();
  const eventType = String(payload?.eventType || payload?.type || 'edit').toLowerCase();
  if (payload?.spreadsheetId && String(payload.spreadsheetId) !== SPREADSHEET_ID) {
    throw new Error('Unexpected spreadsheet ID');
  }
  if (payload?.sheetName && String(payload.sheetName) !== TAB_NAME) {
    return { ignored: true, reason: 'different-tab' };
  }

  if (suppliedEventId && db.prepare(
    'SELECT 1 FROM apps_script_sheet_events WHERE event_id = ?'
  ).get(eventId)) {
    return { duplicate: true };
  }

  const row = Number(payload?.row);
  const column = Number(payload?.column);
  const numRows = Number(payload?.numRows) || 1;
  const numColumns = Number(payload?.numColumns) || 1;
  const structural = eventType !== 'edit'
    || !Number.isInteger(row) || row < 2
    || !Number.isInteger(column) || column < 1;
  const matrix = Array.isArray(payload?.values)
    ? payload.values
    : payload?.value !== undefined && payload?.value !== null
      ? [[payload.value]]
      : null;
  const rowValues = Array.isArray(payload?.rowValues) ? payload.rowValues : null;
  const recordIds = Array.isArray(payload?.recordIds) ? payload.recordIds : [];
  const timestamp = nowIso();
  const pendingMove = hasPendingMove(db);
  let changed = false;
  let needsReconcile = structural;

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO apps_script_sheet_events
        (event_id, event_type, payload_json, received_at)
      VALUES (?, ?, ?, ?)
    `).run(eventId, eventType, JSON.stringify(payload), timestamp);

    if (!structural && rowValues) {
      for (let rowOffset = 0; rowOffset < Math.min(numRows, rowValues.length); rowOffset += 1) {
        const targetRow = row + rowOffset;
        const existing = findLocalRow(String(recordIds[rowOffset] || ''), targetRow);
        const recordId = String(recordIds[rowOffset] || existing?.record_id || crypto.randomUUID());
        const storedRow = pendingMove && existing ? Number(existing.row_number) : targetRow;
        const values = normalizeValues(rowValues[rowOffset]);
        const localValues = normalizeValues(parseJson(existing?.values_json, []));
        for (let targetColumn = 1; targetColumn <= DATA_COLUMNS; targetColumn += 1) {
          const directlyEdited = targetColumn >= column && targetColumn < column + numColumns;
          const pendingKey = `cell:${recordId}:${targetColumn}`;
          const pending = db.prepare(
            'SELECT 1 FROM apps_script_sheet_outbox WHERE dedupe_key = ?'
          ).get(pendingKey);
          if (directlyEdited) {
            db.prepare('DELETE FROM apps_script_sheet_outbox WHERE dedupe_key = ?').run(pendingKey);
          } else if (pending) {
            values[targetColumn - 1] = localValues[targetColumn - 1];
          }
        }
        db.prepare(`
          INSERT INTO apps_script_sheet_rows
            (record_id, row_number, values_json, pending_append, source_updated_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)
          ON CONFLICT(record_id) DO UPDATE SET
            row_number = excluded.row_number,
            values_json = excluded.values_json,
            pending_append = 0,
            source_updated_at = excluded.source_updated_at,
            updated_at = excluded.updated_at
        `).run(recordId, storedRow, JSON.stringify(values), timestamp, timestamp);
        changed = true;
      }
    } else if (!structural && matrix) {
      for (let rowOffset = 0; rowOffset < Math.min(numRows, matrix.length); rowOffset += 1) {
        const targetRow = row + rowOffset;
        const local = findLocalRow(String(recordIds[rowOffset] || ''), targetRow);
        if (!local) {
          needsReconcile = true;
          continue;
        }
        const values = normalizeValues(parseJson(local.values_json, []));
        const sourceRow = Array.isArray(matrix[rowOffset]) ? matrix[rowOffset] : [];
        for (let columnOffset = 0; columnOffset < Math.min(numColumns, sourceRow.length); columnOffset += 1) {
          const targetColumn = column + columnOffset;
          if (targetColumn < 1 || targetColumn > DATA_COLUMNS) continue;
          values[targetColumn - 1] = normalizeCell(sourceRow[columnOffset]);
          db.prepare('DELETE FROM apps_script_sheet_outbox WHERE dedupe_key = ?')
            .run(`cell:${local.record_id}:${targetColumn}`);
          changed = true;
        }
        db.prepare(`
          UPDATE apps_script_sheet_rows
          SET values_json = ?, pending_append = 0, source_updated_at = ?, updated_at = ?
          WHERE record_id = ?
        `).run(JSON.stringify(values), timestamp, timestamp, local.record_id);
      }
    } else if (!structural) {
      needsReconcile = true;
    }

    stats.pushCount = Number(getMeta('push_count', '0')) + 1;
    stats.lastPushAt = timestamp;
    setMeta('push_count', stats.pushCount, timestamp);
    setMeta('last_push_at', timestamp, timestamp);
  });
  transaction();

  mutationVersion += 1;
  if (changed) notifyClients();
  if (needsReconcile) scheduleReconcile(250);
  return { duplicate: false, changed, reconciliationQueued: needsReconcile };
}

function parseUpdatedRangeStart(updatedRange) {
  const match = String(updatedRange || '').match(/![A-Z]+(\d+):[A-Z]+\d+$/i);
  return match ? Number(match[1]) : null;
}

function finalizeCreatedRows(items, sentRows, firstRow) {
  const db = getDb();
  const timestamp = nowIso();
  const transaction = db.transaction(() => {
    items.forEach((item, index) => {
      const rowNumber = Number.isInteger(firstRow) ? firstRow + index : null;
      const current = db.prepare(
        'SELECT values_json FROM apps_script_sheet_rows WHERE record_id = ?'
      ).get(item.record_id);
      const currentValues = normalizeValues(parseJson(current?.values_json, []));
      const sentValues = normalizeValues(sentRows[index]);
      if (rowNumber) {
        db.prepare(`
          UPDATE apps_script_sheet_rows
          SET row_number = ?, pending_append = 0, source_updated_at = ?, updated_at = ?
          WHERE record_id = ?
        `).run(rowNumber, timestamp, timestamp, item.record_id);
      } else {
        db.prepare(`
          UPDATE apps_script_sheet_rows
          SET pending_append = 0, source_updated_at = ?, updated_at = ?
          WHERE record_id = ?
        `).run(timestamp, timestamp, item.record_id);
      }
      db.prepare('DELETE FROM apps_script_sheet_outbox WHERE id = ?').run(item.id);
      currentValues.forEach((value, columnIndex) => {
        if (value === sentValues[columnIndex]) return;
        enqueueOutbox(db, {
          dedupeKey: `cell:${item.record_id}:${columnIndex + 1}`,
          operation: 'cell',
          recordId: item.record_id,
          columnNumber: columnIndex + 1,
          values: value,
        }, timestamp);
      });
    });
  });
  transaction();
}

async function recoverPreviouslyCreated(items) {
  if (!items.length) return { remaining: [], remoteRowsById: new Map() };
  const response = await loadSheetsClient().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteTab()}!A2:${columnToA1(RECORD_ID_COLUMN)}`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  stats.directReadCalls += 1;
  const byId = new Map();
  (response.data.values || []).forEach((row, index) => {
    const recordId = String(row?.[RECORD_ID_COLUMN - 1] || '').trim();
    if (recordId) byId.set(recordId, { rowNumber: index + 2, values: normalizeValues(row) });
  });

  const remaining = [];
  items.forEach(item => {
    const remote = byId.get(item.record_id);
    if (!remote) {
      remaining.push(item);
      return;
    }
    finalizeCreatedRows([item], [remote.values], remote.rowNumber);
  });
  return { remaining, remoteRowsById: byId };
}

async function loadRemoteRowsById() {
  const response = await loadSheetsClient().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteTab()}!${columnToA1(RECORD_ID_COLUMN)}2:${columnToA1(RECORD_ID_COLUMN)}`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  stats.directReadCalls += 1;
  const rows = Array.isArray(response.data.values) ? response.data.values : [];
  const byId = new Map();
  rows.forEach((values, index) => {
    const recordId = String(values?.[0] || '').trim();
    if (recordId) byId.set(recordId, { recordId, rowNumber: index + 2 });
  });
  return byId;
}

function finalizeMove(entry) {
  getDb().prepare(
    'DELETE FROM apps_script_sheet_outbox WHERE id = ? AND updated_at = ?'
  ).run(entry.id, entry.updated_at);
}

async function flushDirect(entries) {
  const sheets = loadSheetsClient();
  directState = 'available';
  const creates = await recoverPreviouslyCreated(
    entries.filter(entry => entry.operation === 'append' || entry.operation === 'insert')
  );
  const appendEntries = creates.remaining.filter(entry => entry.operation === 'append');
  const insertEntries = creates.remaining.filter(entry => entry.operation === 'insert');

  if (appendEntries.length) {
    const db = getDb();
    const sentRows = appendEntries.map(item => {
      const row = db.prepare(
        'SELECT values_json FROM apps_script_sheet_rows WHERE record_id = ?'
      ).get(item.record_id);
      return [...normalizeValues(parseJson(row?.values_json, [])), item.record_id];
    });
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${quoteTab()}!A:${columnToA1(RECORD_ID_COLUMN)}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: sentRows },
    });
    stats.directWriteCalls += 1;
    const firstRow = parseUpdatedRangeStart(response.data?.updates?.updatedRange);
    finalizeCreatedRows(
      appendEntries,
      sentRows,
      firstRow
    );
    if (Number.isInteger(firstRow)) {
      appendEntries.forEach((item, index) => {
        creates.remoteRowsById.set(item.record_id, {
          rowNumber: firstRow + index,
          values: normalizeValues(sentRows[index]),
        });
      });
    }
  }

  if (insertEntries.length) {
    const db = getDb();
    const sheetId = await loadTabSheetId();
    const ordered = insertEntries.map(entry => ({
      entry,
      rowNumber: Number(db.prepare(
        'SELECT row_number FROM apps_script_sheet_rows WHERE record_id = ?'
      ).get(entry.record_id)?.row_number),
    })).filter(item => Number.isInteger(item.rowNumber))
      .sort((left, right) => right.rowNumber - left.rowNumber);

    for (const item of ordered) {
      const payload = parseJson(item.entry.values_json, {});
      const afterRecordId = String(payload.afterRecordId || '').trim();
      const anchor = creates.remoteRowsById.get(afterRecordId);
      if (!anchor) throw new Error(`Insert anchor is not available in ${TAB_NAME}`);

      const row = db.prepare(
        'SELECT values_json FROM apps_script_sheet_rows WHERE record_id = ?'
      ).get(item.entry.record_id);
      if (!row) continue;
      const sentValues = [
        ...normalizeValues(parseJson(row.values_json, [])),
        item.entry.record_id,
      ];
      const targetRow = Number(anchor.rowNumber) + 1;

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId,
                  dimension: 'ROWS',
                  startIndex: targetRow - 1,
                  endIndex: targetRow,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                start: { sheetId, rowIndex: targetRow - 1, columnIndex: 0 },
                rows: [{
                  values: sentValues.map(value => ({ userEnteredValue: toUserEnteredValue(value) })),
                }],
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
      stats.directWriteCalls += 1;
      finalizeCreatedRows([item.entry], [sentValues], targetRow);

      creates.remoteRowsById.forEach(remote => {
        if (remote.rowNumber >= targetRow) remote.rowNumber += 1;
      });
      creates.remoteRowsById.set(item.entry.record_id, {
        rowNumber: targetRow,
        values: normalizeValues(sentValues),
      });
    }
    scheduleReconcile(250);
  }

  const moveEntries = entries.filter(entry => entry.operation === 'move');
  if (moveEntries.length) {
    const sheetId = await loadTabSheetId();
    for (const entry of moveEntries) {
      const payload = parseJson(entry.values_json, {});
      const targetRecordId = String(payload.targetRecordId || '').trim();
      const position = String(payload.position || '').toLowerCase();
      if (!targetRecordId || !['before', 'after'].includes(position)) {
        throw new Error('Stored row move is invalid');
      }

      const remoteRows = await loadRemoteRowsById();
      const source = remoteRows.get(entry.record_id);
      const target = remoteRows.get(targetRecordId);
      if (!source) throw new Error(`Row move source is not available in ${TAB_NAME}`);
      if (!target) throw new Error(`Row move target is not available in ${TAB_NAME}`);

      const alreadyPlaced = position === 'before'
        ? source.rowNumber === target.rowNumber - 1
        : source.rowNumber === target.rowNumber + 1;
      if (!alreadyPlaced) {
        const sourceIndex = source.rowNumber - 1;
        const targetIndex = target.rowNumber - 1;
        // Sheets interprets destinationIndex in the grid coordinates before removing the source row.
        const destinationIndex = position === 'before' ? targetIndex : targetIndex + 1;
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            requests: [{
              moveDimension: {
                source: {
                  sheetId,
                  dimension: 'ROWS',
                  startIndex: sourceIndex,
                  endIndex: sourceIndex + 1,
                },
                destinationIndex,
              },
            }],
          },
        });
        stats.directWriteCalls += 1;
      }
      finalizeMove(entry);
    }
    scheduleReconcile(250);
  }

  const cellEntries = entries.filter(entry => entry.operation === 'cell');
  if (cellEntries.length) {
    const db = getDb();
    const selected = cellEntries.map(entry => {
      const row = db.prepare(
        'SELECT row_number FROM apps_script_sheet_rows WHERE record_id = ?'
      ).get(entry.record_id);
      if (!row) return null;
      const column = Number(entry.column_number);
      return {
        entry,
        range: `${quoteTab()}!${columnToA1(column)}${row.row_number}`,
        values: [[normalizeCell(parseJson(entry.values_json, ''))]],
      };
    }).filter(Boolean);
    if (selected.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: selected.map(item => ({ range: item.range, values: item.values })),
        },
      });
      stats.directWriteCalls += 1;
      const remove = db.prepare(
        'DELETE FROM apps_script_sheet_outbox WHERE id = ? AND updated_at = ?'
      );
      const transaction = db.transaction(() => {
        selected.forEach(item => remove.run(item.entry.id, item.entry.updated_at));
      });
      transaction();
    }
  }
}

async function flushLegacy(entries) {
  for (const entry of entries) {
    if (entry.operation === 'append') {
      const row = getDb().prepare(
        'SELECT values_json FROM apps_script_sheet_rows WHERE record_id = ?'
      ).get(entry.record_id);
      const values = normalizeValues(parseJson(row?.values_json, []));
      await callLegacyBridge({ action: 'appendRow', values });
      finalizeCreatedRows([entry], [values], null);
      scheduleReconcile(250);
      continue;
    }

    if (entry.operation === 'insert' || entry.operation === 'move') {
      throw new Error('Row structure changes are waiting for direct Sheets API access');
    }

    const row = getDb().prepare(
      'SELECT row_number FROM apps_script_sheet_rows WHERE record_id = ?'
    ).get(entry.record_id);
    if (!row) continue;
    await callLegacyBridge({
      action: 'updateCell',
      row: row.row_number,
      column: Number(entry.column_number),
      value: normalizeCell(parseJson(entry.values_json, '')),
    });
    getDb().prepare(
      'DELETE FROM apps_script_sheet_outbox WHERE id = ? AND updated_at = ?'
    ).run(entry.id, entry.updated_at);
  }
}

function markFlushFailure(entries, error) {
  const db = getDb();
  const timestamp = nowIso();
  const update = db.prepare(`
    UPDATE apps_script_sheet_outbox
    SET attempts = attempts + 1,
        next_attempt_at = ?,
        last_error = ?,
        updated_at = ?
    WHERE id = ? AND updated_at = ?
  `);
  const transaction = db.transaction(() => {
    entries.forEach(entry => {
      const attempts = Number(entry.attempts) + 1;
      const backoff = Math.min(60000, (2 ** Math.min(attempts, 6)) * 1000)
        + Math.floor(Math.random() * 1000);
      update.run(Date.now() + backoff, error.message, timestamp, entry.id, entry.updated_at);
    });
  });
  transaction();
  stats.lastError = error.message;
}

async function flushOutbox() {
  if (flushing) return;
  const entries = getDb().prepare(`
    SELECT * FROM apps_script_sheet_outbox
    WHERE next_attempt_at <= ?
    ORDER BY id
    LIMIT 500
  `).all(Date.now());
  if (!entries.length) return;

  flushing = true;
  try {
    try {
      await flushDirect(entries);
      lastDirectError = null;
    } catch (directError) {
      directState = Number(directError.response?.status) === 403 ? 'permission-required' : 'unavailable';
      lastDirectError = directError.message;
      const placeholders = entries.map(() => '?').join(',');
      const remaining = getDb().prepare(`
        SELECT * FROM apps_script_sheet_outbox
        WHERE id IN (${placeholders})
        ORDER BY id
      `).all(...entries.map(entry => entry.id));
      if (remaining.length) await flushLegacy(remaining);
    }
    stats.lastFlushAt = nowIso();
    stats.lastError = null;
  } catch (error) {
    markFlushFailure(entries, error);
    console.error(`Apps Script sheet outbox flush failed: ${error.message}`);
  } finally {
    flushing = false;
  }
}

function getRowsResponse() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT record_id, row_number, values_json, pending_append
    FROM apps_script_sheet_rows
    ORDER BY row_number, record_id
  `).all().map(row => ({
    recordId: row.record_id,
    rowNumber: Number(row.row_number),
    values: normalizeValues(parseJson(row.values_json, [])),
    pending: Boolean(row.pending_append),
  }));
  const outbox = db.prepare('SELECT COUNT(*) AS count FROM apps_script_sheet_outbox').get();
  const moves = db.prepare(
    "SELECT COUNT(*) AS count FROM apps_script_sheet_outbox WHERE operation = 'move'"
  ).get();
  const headers = normalizeValues(parseJson(getMeta('headers', '[]'), []))
    .map((value, index) => value || FALLBACK_HEADERS[index]);
  const pushCount = Number(getMeta('push_count', String(stats.pushCount))) || 0;
  const lastPushAt = getMeta('last_push_at', stats.lastPushAt);
  const lastReconciledAt = getMeta('last_reconciled_at', stats.lastReconciledAt);

  return {
    ok: true,
    headers,
    rows,
    updatedAt: lastPushAt || lastReconciledAt || null,
    cache: {
      hit: true,
      persisted: true,
      mode: directState === 'available' ? 'hybrid' : 'apps-script-fallback',
      spreadsheetId: SPREADSHEET_ID,
      tabName: TAB_NAME,
      serviceAccount: SERVICE_ACCOUNT_EMAIL,
      refreshIntervalMs: RECONCILE_INTERVAL_MS,
      writeFlushIntervalMs: WRITE_FLUSH_INTERVAL_MS,
      pendingWrites: Number(outbox.count) || 0,
      reorderPending: Number(moves.count) > 0,
      push: { count: pushCount, lastPushAt },
      lastReconciledAt,
      lastFlushAt: stats.lastFlushAt,
      directState,
      directError: lastDirectError,
    },
  };
}

async function ensureReady() {
  const count = getDb().prepare('SELECT COUNT(*) AS count FROM apps_script_sheet_rows').get();
  if (!Number(count.count)) await reconcile();
  return getRowsResponse();
}

function start() {
  if (started) return;
  started = true;
  stats.pushCount = Number(getMeta('push_count', '0')) || 0;
  stats.lastPushAt = getMeta('last_push_at');
  stats.lastReconciledAt = getMeta('last_reconciled_at');

  setImmediate(() => reconcile().catch(error => {
    stats.lastError = error.message;
    console.error(`Apps Script sheet startup reconciliation failed: ${error.message}`);
  }));
  flushTimer = setInterval(flushOutbox, WRITE_FLUSH_INTERVAL_MS);
  reconcileTimer = setInterval(() => scheduleReconcile(0), RECONCILE_INTERVAL_MS);
  flushTimer.unref();
  reconcileTimer.unref();
  console.log(
    `Apps Script sheet sync started (write flush ${WRITE_FLUSH_INTERVAL_MS}ms, reconcile ${RECONCILE_INTERVAL_MS}ms)`
  );
}

module.exports = {
  DATA_COLUMNS,
  SPREADSHEET_ID,
  TAB_NAME,
  SERVICE_ACCOUNT_EMAIL,
  ensureReady,
  flushOutbox,
  getRowsResponse,
  ingestEvent,
  queueAppend,
  queueCellUpdates,
  queueInsert,
  queueMove,
  reconcile,
  start,
};
