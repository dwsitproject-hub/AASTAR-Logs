// Additive, READ-ONLY mirror tool.
//
// Takes the sheet data the service accounts already pulled (persisted in the
// existing `sheet_cache` table of erp.db) and materializes each sheet/tab into
// its own real, queryable table in a SEPARATE SQLite file (sheets_mirror.db).
//
// It changes NOTHING the running app uses: erp.db is opened read-only, and the
// output is a brand-new file.
//
// Two ways to run:
//   - CLI (one-off):  node scripts/mirror-sheets-to-sqlite.js
//   - In-process:     require('./scripts/mirror-sheets-to-sqlite').rebuildMirror()
//     (called by services/sheetsCache.js after every SA poll persists, so the
//      mirror stays in lockstep with the live cache — see rebuildMirror below.)
//
//   Env: SRC_DB (default ../data/erp.db), OUT_DB (default ../data/sheets_mirror.db)

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_SRC = process.env.SRC_DB || path.join(__dirname, '../data/erp.db');
const DEFAULT_OUT = process.env.OUT_DB || path.join(__dirname, '../data/sheets_mirror.db');

// Turn an arbitrary header cell into a valid, unique SQLite column name.
function sanitize(raw, used, fallback) {
  let name = String(raw == null ? '' : raw).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) name = fallback;
  if (/^[0-9]/.test(name)) name = 'c_' + name;
  let final = name, i = 2;
  while (used.has(final)) final = `${name}_${i++}`;
  used.add(final);
  return final;
}

// Guard so overlapping calls (e.g. a slow rebuild while the next poll fires)
// can't run concurrently and race on the temp file.
let rebuilding = false;

// Rebuild the whole mirror from erp.db. Synchronous (better-sqlite3). Safe to
// call repeatedly: it builds into a temp file and atomically renames it over the
// live mirror, so a concurrent reader of the /mirror route never sees a
// missing or half-written file. Never throws for "busy" — returns null instead.
function rebuildMirror({ srcDb = DEFAULT_SRC, outDb = DEFAULT_OUT, quiet = false } = {}) {
  if (rebuilding) return null;
  rebuilding = true;

  const SRC = srcDb;
  const OUT = outDb;
  const TMP = `${OUT}.tmp`;
  const log = (...a) => { if (!quiet) console.log(...a); };

  try {
    if (!fs.existsSync(SRC)) {
      if (!quiet) console.error('Mirror source DB not found:', SRC);
      return null;
    }

    const src = new Database(SRC, { readonly: true, fileMustExist: true });
    const cacheRows = src.prepare('SELECT cache_key, data, updated_at FROM sheet_cache').all();
    const configs = src.prepare('SELECT sheet_id, sheet_name, tab_name, render_format FROM sheets_config').all();

    // cache_key looks like `${sheet_id}::${tab_name}::fmt|raw`
    const friendly = (cacheKey) => {
      const idx1 = cacheKey.indexOf('::');
      const idx2 = cacheKey.lastIndexOf('::');
      const sheetId = cacheKey.slice(0, idx1);
      const tabName = cacheKey.slice(idx1 + 2, idx2);
      const suffix = cacheKey.slice(idx2 + 2); // fmt | raw
      const cfg = configs.find(c => c.sheet_id === sheetId && c.tab_name === tabName);
      return { sheetName: cfg ? cfg.sheet_name : sheetId.slice(0, 10), tabName, fmt: suffix };
    };

    // Build into a fresh TEMP file (no WAL, so it's a single self-contained file
    // after close). We rename it over OUT at the end for an atomic swap.
    for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`, `${TMP}-journal`]) {
      try { fs.existsSync(f) && fs.unlinkSync(f); } catch {}
    }
    const out = new Database(TMP);
    out.exec(`CREATE TABLE _mirror_meta (
      table_name TEXT, cache_key TEXT, sheet_name TEXT, tab_name TEXT,
      render_format TEXT, row_count INTEGER, col_count INTEGER,
      source_updated_at TEXT, mirrored_at TEXT
    )`);
    const insMeta = out.prepare(`INSERT INTO _mirror_meta VALUES (?,?,?,?,?,?,?,?,?)`);

    const usedTables = new Set(['_mirror_meta']);
    const now = new Date().toISOString();
    const summary = [];

    for (const row of cacheRows) {
      let data;
      try { data = JSON.parse(row.data); } catch { continue; }
      if (!Array.isArray(data)) continue;

      const f = friendly(row.cache_key);

      // Skip the operations "Matching / Matching" tab (per request). The
      // "Matching Sales" tables are a different sheet and are kept.
      if (f.sheetName === 'Matching' && f.tabName === 'Matching') continue;

      // VESSEL DB has a large grid of mostly-empty trailing rows; only keep rows
      // whose COL A (the vsl_id key) is populated.
      const filterColA = f.tabName === 'VESSEL DB';

      const tname = sanitize(`${f.sheetName}_${f.tabName}_${f.fmt}`, usedTables, 'sheet');

      const header = Array.isArray(data[0]) ? data[0] : [];
      const bodyRows = data.slice(1);
      const maxLen = data.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);

      // Build unique column names from the header, generating names for any
      // extra/ragged columns beyond the header width.
      const usedCols = new Set(['_row']);
      const cols = [];
      for (let c = 0; c < maxLen; c++) cols.push(sanitize(header[c], usedCols, `col_${c + 1}`));

      const colDefs = ['"_row" INTEGER'].concat(cols.map(c => `"${c}" TEXT`)).join(', ');
      out.exec(`CREATE TABLE "${tname}" (${colDefs})`);

      let inserted = 0;
      if (cols.length) {
        const placeholders = ['?'].concat(cols.map(() => '?')).join(', ');
        const ins = out.prepare(`INSERT INTO "${tname}" VALUES (${placeholders})`);
        const insMany = out.transaction((rows) => {
          rows.forEach((r, idx) => {
            // COL A (index 0) gate for VESSEL DB — drop rows with an empty key.
            if (filterColA) {
              const a = Array.isArray(r) ? r[0] : undefined;
              if (a == null || String(a).trim() === '') return;
            }
            const vals = [idx + 1]; // _row = original sheet body row (1-based)
            for (let c = 0; c < cols.length; c++) {
              const v = Array.isArray(r) ? r[c] : undefined;
              vals.push(v == null || v === '' ? null : String(v));
            }
            ins.run(vals);
            inserted++;
          });
        });
        insMany(bodyRows);
      }

      insMeta.run(tname, row.cache_key, f.sheetName, f.tabName, f.fmt, inserted, cols.length, row.updated_at, now);
      summary.push({ table: tname, source: `${f.sheetName} / ${f.tabName} [${f.fmt}]`, rows: inserted, cols: cols.length });
    }

    src.close();
    out.close();

    // Atomic swap: replace the live mirror with the freshly built temp file.
    // Existing open readers keep the old inode; new opens get the new file.
    fs.renameSync(TMP, OUT);
    // Drop any stale sidecars left over from the previous (WAL-era) mirror.
    for (const f of [`${OUT}-wal`, `${OUT}-shm`]) { try { fs.existsSync(f) && fs.unlinkSync(f); } catch {} }

    log(`Mirror written to: ${OUT}`);
    log(`Tables: ${summary.length}`);
    if (!quiet) {
      summary.sort((a, b) => b.rows - a.rows).forEach(s =>
        console.log(`  ${s.table.padEnd(40)} ${String(s.rows).padStart(6)} rows  ${String(s.cols).padStart(3)} cols   ← ${s.source}`)
      );
    }
    return { tables: summary.length, mirroredAt: now };
  } finally {
    rebuilding = false;
  }
}

module.exports = { rebuildMirror };

// CLI entry point — only runs when invoked directly, not when required.
if (require.main === module) {
  const res = rebuildMirror();
  if (!res) process.exit(1);
}
