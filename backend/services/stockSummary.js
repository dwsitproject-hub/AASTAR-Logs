'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Stock Summary is now read from DB9, which is populated by the shared bulk
// sync from the Monthly tab. The report is a positional grid, so DB9 keeps
// every source row instead of treating the first row as table headers.
const DATA_DIR = process.env.DATA_DATABASE_DIR || path.join(__dirname, '../data/databases');
const DB_PATH = path.join(DATA_DIR, 'DB9.db');
const TABLE_NAME = 'stock_monthly';

let cached = { ports: [], updatedAt: null, raw: null };
let cachedSignature = null;
let lastError = null;

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

// Lotus 1-2-3 epoch — Google Sheets serial number → ISO date string.
function serialToIso(serial) {
  const number = numeric(serial);
  if (number == null) return null;
  const ms = (number - 25569) * 86400 * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function isPortHeader(rowA) {
  if (rowA == null || String(rowA).trim() === '') return false;
  if (numeric(rowA) != null) return false;
  const value = String(rowA).trim();
  // Month banner like "June 2026" — skip.
  if (/^[A-Z][a-z]+ \d{4}$/i.test(value)) return false;
  return true;
}

function parseMonthly(rows) {
  // A port header contains the cargo names in columns B onward. Following
  // numeric date rows belong to that port until the next text header.
  const ports = [];
  let current = null;

  for (const row of Array.isArray(rows) ? rows : []) {
    const values = Array.isArray(row) ? row : [];
    const first = values[0];

    if (isPortHeader(first)) {
      if (current) ports.push(current);
      const cargoes = [];
      for (let index = 1; index < values.length; index++) {
        const value = values[index];
        if (value == null || String(value).trim() === '') break;
        cargoes.push(String(value).trim());
      }
      current = {
        name: String(first).trim(),
        cargoes,
        dates: [],
        series: {},
      };
      cargoes.forEach(cargo => { current.series[cargo] = []; });
      continue;
    }

    if (current && numeric(first) != null) {
      const iso = serialToIso(first);
      if (!iso) continue;
      current.dates.push(iso);
      current.cargoes.forEach((cargo, index) => {
        const value = values[index + 1];
        const parsed = numeric(value);
        current.series[cargo].push(parsed == null ? null : parsed);
      });
    }
  }
  if (current) ports.push(current);
  return ports;
}

function sourceColumns(db) {
  return db.prepare(`PRAGMA table_info("${TABLE_NAME}")`).all()
    .map(column => column.name)
    .filter(name => /^col_\d+$/.test(name))
    .sort((left, right) => Number(left.slice(4)) - Number(right.slice(4)));
}

function readDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error('Stock Summary database DB9 is not available yet');
  }

  const db = new Database(DB_PATH, { readonly: true });
  try {
    const meta = db.prepare('SELECT source_hash, pulled_at FROM _database_meta LIMIT 1').get() || {};
    const signature = `${meta.source_hash || ''}:${meta.pulled_at || ''}`;
    if (signature === cachedSignature) return;

    const columns = sourceColumns(db);
    if (!columns.length) throw new Error('DB9 stock table has no source columns');
    const select = columns.map(column => `"${column}"`).join(', ');
    const rows = db.prepare(`SELECT ${select} FROM "${TABLE_NAME}" ORDER BY CAST(_sheet_row AS INTEGER)`).all()
      .map(row => columns.map(column => row[column]));

    cached = {
      ports: parseMonthly(rows),
      updatedAt: meta.pulled_at || null,
      raw: null,
    };
    cachedSignature = signature;
    lastError = null;
  } finally {
    db.close();
  }
}

function getCached() {
  try {
    readDatabase();
  } catch (err) {
    lastError = err.message;
    console.error('Stock Summary database read failed:', err.message);
  }
  return { ...cached, error: lastError };
}

module.exports = { getCached, parseMonthly, serialToIso };
