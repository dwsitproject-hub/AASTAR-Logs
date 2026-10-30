'use strict';

// Consolidated "master matching" table builder.
//
// Reads the service-account-pulled sheet data (persisted in erp.db `sheet_cache`)
// for the 4 Matching tabs + the VESSEL DB, and materializes ONE consolidated row
// per contract assignment into a separate, read-only SQLite file
// (data/master_matching.db). Additive: erp.db is opened read-only, output is a
// brand-new file swapped in atomically. Rebuilt on every SA poll (see
// services/sheetsCache.js) so it tracks live data.
//
// Per contract row it records: which contract → which vessel → which port →
// ETA/ETB/ETC (matched by vsl_id against the VESSEL DB port blocks), plus a
// `final_quantity` (parsed from `intention_vessel` for partial shipments, else
// the contract qty). Partial rows inherit their parent contract's fields via the
// contract number the user entered in the new column beside `partial_identifier`.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_SRC = process.env.SRC_DB || path.join(__dirname, '../data/erp.db');
const DEFAULT_OUT = process.env.MASTER_DB || path.join(__dirname, '../data/master_matching.db');

const MATCH_SHEET = '1AlO_PUh0vakXXYGu3r-vIZW4O1NV4bePieNkaYhPPdE';
const VESSELDB_KEY = '1mF8twQ64KUYnGHhf_6Y9qFjGIdPRfBliBfs_JKDnOWQ::VESSEL DB::fmt';

// Per-tab 0-based column indices (verified against the live sheet headers).
// copyStart is always col 1 (shpt_year/year); copyEnd = remarks_outstanding.
// newCol = the column the user inserted right after partial_identifier.
const TABS = [
  { key: 'AASTAR SALES',    cacheKey: `${MATCH_SHEET}::AASTAR SALES::fmt`,
    contractNo: 14, cargo: 12, counterparty: 13, contractStart: 26, contractEnd: 27,
    dischargePort: 32, remarks: 35, qty: 18, intentionVessel: 36, vslId: 43, partial: 44, newCol: 45 },
  { key: 'AASTAR PURCHASE', cacheKey: `${MATCH_SHEET}::AASTAR PURCHASE::fmt`,
    contractNo: 14, cargo: 11, counterparty: 12, contractStart: 24, contractEnd: 25,
    dischargePort: 28, remarks: 31, qty: 17, intentionVessel: 32, vslId: 33, partial: 34, newCol: 35 },
  { key: 'KIMARA SALES',    cacheKey: `${MATCH_SHEET}::KIMARA SALES::fmt`,
    contractNo: 14, cargo: 12, counterparty: 13, contractStart: 26, contractEnd: 27,
    dischargePort: 32, remarks: 35, qty: 18, intentionVessel: 36, vslId: 39, partial: 40, newCol: 41 },
  { key: 'KIMARA PURCHASE', cacheKey: `${MATCH_SHEET}::KIMARA PURCHASE::fmt`,
    contractNo: 14, cargo: 11, counterparty: 12, contractStart: 25, contractEnd: 26,
    dischargePort: 28, remarks: 31, qty: 17, intentionVessel: 32, vslId: 33, partial: 34, newCol: 35 },
];

// VESSEL DB layout: 10 port blocks, stride 16, first vslid at col 19.
const VDB = { vessel: 4, entity: 2, blockStart: 19, stride: 16, blocks: 10,
  off: { vslid: 0, port: 1, laycan: 8, eta: 10, etb: 12, etc: 14 } };

const s = (v) => (v == null ? '' : String(v).trim());
const isPartial = (v) => s(v).toUpperCase() === 'PARTIAL';

// "1,234.5" -> "1234.5" ; blanks stay blank.
function normQty(v) {
  const t = s(v).replace(/,/g, '');
  const m = t.match(/-?\d+(\.\d+)?/);
  return m ? m[0] : '';
}
// "MT TORM ALICE - 500MT" -> "500" ; "...- 3,000 MT" -> "3000".
function qtyFromIntention(v) {
  const t = s(v);
  const m = t.match(/-\s*([\d,]+(?:\.\d+)?)\s*MT\s*$/i);
  return m ? m[1].replace(/,/g, '') : '';
}

let rebuilding = false;

function rebuildMasterMatching({ srcDb = DEFAULT_SRC, outDb = DEFAULT_OUT, quiet = false } = {}) {
  if (rebuilding) return null;
  rebuilding = true;
  const OUT = outDb;
  const TMP = `${OUT}.tmp`;
  const log = (...a) => { if (!quiet) console.log(...a); };

  try {
    if (!fs.existsSync(srcDb)) { if (!quiet) console.error('master: source DB missing', srcDb); return null; }
    const src = new Database(srcDb, { readonly: true, fileMustExist: true });
    src.pragma('busy_timeout = 5000');
    const getKey = src.prepare('SELECT data FROM sheet_cache WHERE cache_key = ?');
    const load = (key) => { const r = getKey.get(key); if (!r) return null; try { return JSON.parse(r.data); } catch { return null; } };

    // Build vsl_id -> vessel/port/eta/etb/etc lookup from the VESSEL DB.
    const vdbData = load(VESSELDB_KEY) || [];
    const vLookup = {};
    for (let i = 1; i < vdbData.length; i++) {
      const row = vdbData[i]; if (!Array.isArray(row)) continue;
      const vessel = s(row[VDB.vessel]); const entity = s(row[VDB.entity]);
      for (let b = 0; b < VDB.blocks; b++) {
        const base = VDB.blockStart + b * VDB.stride;
        const vslid = s(row[base + VDB.off.vslid]);
        if (!vslid) continue;
        vLookup[vslid] = {
          vessel, entity,
          port: s(row[base + VDB.off.port]),
          laycan: s(row[base + VDB.off.laycan]),
          eta: s(row[base + VDB.off.eta]),
          etb: s(row[base + VDB.off.etb]),
          etc: s(row[base + VDB.off.etc]),
        };
      }
    }

    // Assemble consolidated records tab-by-tab.
    const records = [];
    let matchedCount = 0, partialCount = 0;
    for (const t of TABS) {
      const data = load(t.cacheKey);
      if (!data || data.length < 2) continue;

      // Index non-partial rows by contract_no for partial-parent lookups.
      const parentByContract = {};
      for (let r = 1; r < data.length; r++) {
        const row = data[r]; if (!Array.isArray(row)) continue;
        if (isPartial(row[t.partial])) continue;
        const cno = s(row[t.contractNo]);
        if (cno && !parentByContract[cno]) parentByContract[cno] = row;
      }

      for (let r = 1; r < data.length; r++) {
        const row = data[r]; if (!Array.isArray(row)) continue;
        const partial = isPartial(row[t.partial]);
        const vslId = s(row[t.vslId]);
        // Only consolidate rows that represent a vessel assignment or a partial.
        if (!vslId && !partial) continue;

        // Base contract fields come from this row; partials pull them from the
        // parent contract identified by the number in the new column.
        let srcRow = row;
        let contractNo = s(row[t.contractNo]);
        let parentNo = '';
        if (partial) {
          parentNo = s(row[t.newCol]);
          const parent = parentNo ? parentByContract[parentNo] : null;
          if (parent) srcRow = parent;
          if (parentNo) contractNo = parentNo;
        }

        const finalQty = partial ? qtyFromIntention(row[t.intentionVessel]) : normQty(row[t.qty]);
        const match = vslId ? vLookup[vslId] : null;
        if (match) matchedCount++;
        if (partial) partialCount++;

        records.push({
          tab: t.key,
          source_row: r + 1,
          ref: s(row[0]),
          is_partial: partial ? 1 : 0,
          contract_no: contractNo,
          parent_contract_no: parentNo,
          shpt_year: s(srcRow[1]),
          cargo: s(srcRow[t.cargo]),
          counterparty: s(srcRow[t.counterparty]),
          contract_start: s(srcRow[t.contractStart]),
          contract_end: s(srcRow[t.contractEnd]),
          discharge_port: s(srcRow[t.dischargePort]),
          remarks_outstanding: s(srcRow[t.remarks]),
          qty_original: s(row[t.qty]),
          final_quantity: finalQty,
          intention_vessel: s(row[t.intentionVessel]),
          vsl_id: vslId,
          matched: match ? 1 : 0,
          vessel: match ? match.vessel : '',
          entity: match ? match.entity : '',
          port: match ? match.port : '',
          laycan: match ? match.laycan : '',
          eta: match ? match.eta : '',
          etb: match ? match.etb : '',
          etc: match ? match.etc : '',
        });
      }
    }
    src.close();

    // Write a fresh temp DB, then atomically swap it over the live file.
    for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`, `${TMP}-journal`]) {
      try { fs.existsSync(f) && fs.unlinkSync(f); } catch {}
    }
    const out = new Database(TMP);
    const now = new Date().toISOString();
    out.exec(`CREATE TABLE _meta (built_at TEXT, rows INTEGER, matched INTEGER, partials INTEGER)`);
    out.exec(`CREATE TABLE matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tab TEXT, source_row INTEGER, ref TEXT, is_partial INTEGER,
      contract_no TEXT, parent_contract_no TEXT, shpt_year TEXT, cargo TEXT,
      counterparty TEXT, contract_start TEXT, contract_end TEXT, discharge_port TEXT,
      remarks_outstanding TEXT, qty_original TEXT, final_quantity TEXT,
      intention_vessel TEXT, vsl_id TEXT, matched INTEGER,
      vessel TEXT, entity TEXT, port TEXT, laycan TEXT, eta TEXT, etb TEXT, etc TEXT
    )`);
    const cols = ['tab','source_row','ref','is_partial','contract_no','parent_contract_no','shpt_year','cargo','counterparty','contract_start','contract_end','discharge_port','remarks_outstanding','qty_original','final_quantity','intention_vessel','vsl_id','matched','vessel','entity','port','laycan','eta','etb','etc'];
    const ins = out.prepare(`INSERT INTO matches (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    const insMany = out.transaction((rows) => { for (const rec of rows) ins.run(cols.map(c => rec[c])); });
    insMany(records);
    out.prepare(`INSERT INTO _meta VALUES (?,?,?,?)`).run(now, records.length, matchedCount, partialCount);
    out.close();

    fs.renameSync(TMP, OUT);
    for (const f of [`${OUT}-wal`, `${OUT}-shm`]) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }

    log(`master_matching: ${records.length} rows (${matchedCount} matched, ${partialCount} partial) -> ${OUT}`);
    return { rows: records.length, matched: matchedCount, partials: partialCount, builtAt: now };
  } finally {
    rebuilding = false;
  }
}

module.exports = { rebuildMasterMatching };

if (require.main === module) {
  const r = rebuildMasterMatching();
  if (!r) process.exit(1);
}
