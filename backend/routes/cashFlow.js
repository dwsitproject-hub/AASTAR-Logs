// Cash-flow analytics API over data/shpt_file.db. Admin-only. Computes on demand
// (fast for a few thousand rows) so it's always in sync with the latest pull.
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { computeCashFlow } = require('../services/cashFlow');

const router = express.Router();
const DB_PATH = process.env.SHPT_DB || path.join(__dirname, '../data/shpt_file.db');

router.get('/', requireAuth, requireAdmin, (req, res) => {
  if (!fs.existsSync(DB_PATH)) return res.json({ available: false });
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    let builtAt = null;
    try { builtAt = (db.prepare('SELECT built_at FROM _meta').get() || {}).built_at; } catch {}
    const rows = db.prepare('SELECT * FROM rows').all();
    const analysis = computeCashFlow(rows);
    res.json({ available: true, builtAt, ...analysis });
  } finally { db.close(); }
});

module.exports = router;
