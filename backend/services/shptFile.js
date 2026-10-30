'use strict';

// Materializes the 'Shpt File' tab (pulled by SA1 from the Aastar Sales sheet,
// read-only) into a clean typed table in data/shpt_file.db. Additive: erp.db is
// read-only, output is a fresh file swapped in atomically. Rebuilt on every SA
// poll (see services/sheetsCache.js). The cached range starts at sheet row 2
// (the header), so data[0] is the header and data[1..] are shipment rows.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_SRC = process.env.SRC_DB || path.join(__dirname, '../data/erp.db');
const DEFAULT_OUT = process.env.SHPT_DB || path.join(__dirname, '../data/shpt_file.db');
const CACHE_KEY = '1AlO_PUh0vakXXYGu3r-vIZW4O1NV4bePieNkaYhPPdE::Shpt File::fmt';

// field -> 0-based column in the pulled range (verified against the live header).
const COLS = {
  ref: 0, trade_group: 1, shpt_yr: 2, ops_pic: 3, seller_grp: 4, seller: 5,
  buyer_grp: 6, buyer: 7, contract_no: 8, latest_shpt_date: 9, shpt_laycan: 10,
  shpt_mth: 11, vessel_name: 12, bl_date: 13, bl_mth: 14, bl_quantity: 15,
  cargo: 16, cargo_remarks: 17, load_port: 18, load_country: 19, discharge_port: 20,
  discharge_country: 21, term: 23, purchase_price_pmt: 24, purchase_value_usd: 25,
  other_costs: 26, pmt_date: 27, pmt_terms: 34, lc_no: 36, lc_issue_date: 37,
  unit_price_provn: 39, unit_price_final: 40, invoice_value_usd: 41,
  pmt_received_usd: 45, invoice_outstanding_usd: 46, pmt_rec_date: 47,
  pmt_rec_mth: 48, rec_bank: 49, due_date: 50, nod_overdue: 51, remarks: 55,
};
const FIELDS = Object.keys(COLS);

const s = (v) => (v == null ? '' : String(v).trim());

let rebuilding = false;

function rebuildShptFile({ srcDb = DEFAULT_SRC, outDb = DEFAULT_OUT, quiet = false } = {}) {
  if (rebuilding) return null;
  rebuilding = true;
  const OUT = outDb;
  const TMP = `${OUT}.tmp`;
  try {
    if (!fs.existsSync(srcDb)) { if (!quiet) console.error('shptFile: source DB missing'); return null; }
    const src = new Database(srcDb, { readonly: true, fileMustExist: true });
    src.pragma('busy_timeout = 5000');
    const row = src.prepare('SELECT data FROM sheet_cache WHERE cache_key = ?').get(CACHE_KEY);
    src.close();
    if (!row) { if (!quiet) console.error('shptFile: Shpt File not in cache yet'); return null; }
    let data;
    try { data = JSON.parse(row.data); } catch { return null; }
    if (!Array.isArray(data) || data.length < 2) return null;

    const records = [];
    for (let r = 1; r < data.length; r++) {
      const raw = data[r];
      if (!Array.isArray(raw)) continue;
      const rec = {};
      for (const f of FIELDS) rec[f] = s(raw[COLS[f]]);
      // Skip empty/spacer rows: keep only rows with a real identity.
      if (!rec.contract_no && !rec.seller && !rec.buyer && !rec.bl_date && !rec.purchase_value_usd && !rec.invoice_value_usd) continue;
      rec.source_row = r + 1; // sheet row (range began at row 2, so +1 over 0-based header)
      records.push(rec);
    }

    for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`, `${TMP}-journal`]) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
    const out = new Database(TMP);
    const now = new Date().toISOString();
    out.exec(`CREATE TABLE _meta (built_at TEXT, rows INTEGER)`);
    const cols = [...FIELDS, 'source_row'];
    const defs = cols.map(c => `"${c}" ${c === 'source_row' ? 'INTEGER' : 'TEXT'}`).join(', ');
    out.exec(`CREATE TABLE rows (id INTEGER PRIMARY KEY AUTOINCREMENT, ${defs})`);
    const ins = out.prepare(`INSERT INTO rows (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    const insMany = out.transaction((rs) => { for (const rec of rs) ins.run(cols.map(c => rec[c])); });
    insMany(records);
    out.prepare(`INSERT INTO _meta VALUES (?,?)`).run(now, records.length);
    out.close();

    fs.renameSync(TMP, OUT);
    for (const f of [`${OUT}-wal`, `${OUT}-shm`]) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }
    if (!quiet) console.log(`shpt_file: ${records.length} rows -> ${OUT}`);
    return { rows: records.length, builtAt: now };
  } finally {
    rebuilding = false;
  }
}

module.exports = { rebuildShptFile, COLS, FIELDS };

if (require.main === module) {
  const r = rebuildShptFile();
  if (!r) process.exit(1);
}
