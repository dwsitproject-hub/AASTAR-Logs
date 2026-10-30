// Read-only API over data/shpt_file.db (materialized 'Shpt File' tab). Admin-only.
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const DB_PATH = process.env.SHPT_DB || path.join(__dirname, '../data/shpt_file.db');

function openDb() {
  if (!fs.existsSync(DB_PATH)) return null;
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

// GET /api/shpt-file?limit=&offset=&q=
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const db = openDb();
  if (!db) return res.json({ available: false, rows: [], columns: [], total: 0 });
  try {
    let meta = {};
    try { meta = db.prepare('SELECT * FROM _meta').get() || {}; } catch {}
    const columns = db.prepare(`PRAGMA table_info("rows")`).all().map(c => c.name).filter(c => c !== 'id');

    const where = [];
    const params = [];
    if (req.query.q) {
      const q = `%${String(req.query.q)}%`;
      where.push('(contract_no LIKE ? OR seller LIKE ? OR buyer LIKE ? OR vessel_name LIKE ? OR cargo LIKE ?)');
      params.push(q, q, q, q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const total = db.prepare(`SELECT COUNT(*) n FROM rows ${whereSql}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM rows ${whereSql} ORDER BY source_row LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ available: true, builtAt: meta.built_at || null, columns, rows, total, limit, offset });
  } finally { db.close(); }
});

module.exports = router;
