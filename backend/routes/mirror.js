// Read-only API over the SQLite mirror (sheets_mirror.db) produced by
// scripts/mirror-sheets-to-sqlite.js. Admin-only. Used by the test > Vessel
// Match page to browse the materialized sheet tables.
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const MIRROR_PATH = process.env.MIRROR_DB || path.join(__dirname, '../data/sheets_mirror.db');

function openMirror() {
  if (!fs.existsSync(MIRROR_PATH)) return null;
  return new Database(MIRROR_PATH, { readonly: true, fileMustExist: true });
}

// Only allow querying tables that actually exist in the mirror (prevents any
// injection via the :name param).
function realTable(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  return row ? row.name : null;
}

// GET /api/mirror/tables — catalog of materialized tables.
router.get('/tables', requireAuth, requireAdmin, (req, res) => {
  const db = openMirror();
  if (!db) return res.json({ available: false, tables: [] });
  try {
    let tables;
    try {
      tables = db.prepare('SELECT * FROM _mirror_meta ORDER BY row_count DESC').all();
    } catch {
      // No meta table — fall back to listing tables directly.
      tables = db.prepare("SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    }
    res.json({ available: true, tables });
  } finally { db.close(); }
});

// GET /api/mirror/table/:name?limit=&offset= — columns + a page of rows.
router.get('/table/:name', requireAuth, requireAdmin, (req, res) => {
  const db = openMirror();
  if (!db) return res.status(404).json({ error: 'Mirror not generated yet.' });
  try {
    const name = realTable(db, req.params.name);
    if (!name) return res.status(404).json({ error: 'Unknown table' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
    const rows = db.prepare(`SELECT * FROM "${name}" LIMIT ? OFFSET ?`).all(limit, offset);

    res.json({ name, columns, rows, total, limit, offset });
  } finally { db.close(); }
});

module.exports = router;
