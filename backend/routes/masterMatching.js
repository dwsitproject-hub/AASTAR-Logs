// Read-only API over the consolidated master-matching table
// (data/master_matching.db) produced by services/masterMatching.js. Admin-only.
// Used by the test > Master Matching page.
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const MASTER_PATH = process.env.MASTER_DB || path.join(__dirname, '../data/master_matching.db');

function openDb() {
  if (!fs.existsSync(MASTER_PATH)) return null;
  return new Database(MASTER_PATH, { readonly: true, fileMustExist: true });
}

// Preferred display order; any columns not listed are appended.
const COL_ORDER = [
  'tab', 'ref', 'is_partial', 'contract_no', 'parent_contract_no', 'shpt_year',
  'cargo', 'counterparty', 'final_quantity', 'qty_original', 'intention_vessel',
  'vsl_id', 'matched', 'vessel', 'entity', 'port', 'laycan', 'eta', 'etb', 'etc',
  'contract_start', 'contract_end', 'discharge_port', 'remarks_outstanding', 'source_row',
];

// GET /api/master-matching?limit=&offset=&tab=&partial=1&matched=1&q=
router.get('/', requireAuth, requireAdmin, (req, res) => {
  const db = openDb();
  if (!db) return res.json({ available: false, rows: [], columns: [], total: 0 });
  try {
    let meta = {};
    try { meta = db.prepare('SELECT * FROM _meta').get() || {}; } catch {}

    const allCols = db.prepare(`PRAGMA table_info("matches")`).all().map(c => c.name).filter(c => c !== 'id');
    const columns = [...COL_ORDER.filter(c => allCols.includes(c)), ...allCols.filter(c => !COL_ORDER.includes(c))];

    const where = [];
    const params = [];
    if (req.query.tab)              { where.push('tab = ?'); params.push(String(req.query.tab)); }
    if (req.query.partial === '1')  { where.push('is_partial = 1'); }
    if (req.query.matched === '1')  { where.push('matched = 1'); }
    if (req.query.matched === '0')  { where.push('matched = 0'); }
    if (req.query.q) {
      const q = `%${String(req.query.q)}%`;
      where.push('(ref LIKE ? OR contract_no LIKE ? OR vessel LIKE ? OR vsl_id LIKE ? OR intention_vessel LIKE ? OR counterparty LIKE ?)');
      params.push(q, q, q, q, q, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const total = db.prepare(`SELECT COUNT(*) AS n FROM matches ${whereSql}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM matches ${whereSql} ORDER BY tab, source_row LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const tabs = db.prepare('SELECT DISTINCT tab FROM matches ORDER BY tab').all().map(r => r.tab);

    res.json({ available: true, builtAt: meta.built_at || null, meta, columns, rows, total, tabs, limit, offset });
  } finally { db.close(); }
});

module.exports = router;
