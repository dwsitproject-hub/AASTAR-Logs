'use strict';

// One-time production migration for durable contract-to-vessel assignments.
// It is intentionally idempotent: rerunning it preserves existing Vessel
// Links rows and only seeds legacy assignments that have not been recorded.

const Database = require('better-sqlite3');
const { DATA_DATABASES, VESSEL_LINK_CONFIG } = require('../config/dataSources');
const {
  appendSourceRows,
  ensureSourceColumnHeader,
  hideSourceColumn,
  ensureSourceTab,
  refreshBulkDatabases,
  dbPath,
} = require('../services/bulkDataSync');
const { HEADERS } = require('../services/vesselLinkStore');

const MATCH_ID_HEADER = 'ERP Match ID';
const REF_FIELDS = {
  DB1: 'sales_ref',
  DB2: 'purchase_ref',
  DB3: 'kimara_sales_ref',
  DB4: 'kimara_purchase_ref',
  DB5: 'main_ref',
};

function str(value) {
  return value == null ? '' : String(value).trim();
}

function realVslId(value) {
  const vslId = str(value);
  return vslId && vslId.toUpperCase() !== 'VSL_00_0000' ? vslId : '';
}

function definition(name) {
  const result = DATA_DATABASES.find(item => item.name === name);
  if (!result) throw new Error(`Missing ${name} data-source definition`);
  return result;
}

function assertSync(result, stage) {
  const unavailable = (result.databases || []).filter(item => item.unavailable);
  if (unavailable.length) {
    throw new Error(`${stage} could not pull: ${unavailable.map(item => item.name).join(', ')}`);
  }
  if (result.failures?.length) {
    throw new Error(`${stage} had Google Sheets errors: ${result.failures.map(item => item.error).join('; ')}`);
  }
}

function existingMatchIds() {
  const db = new Database(dbPath('DB10'), { readonly: true, fileMustExist: true });
  try {
    return new Set(db.prepare(`
      SELECT lower(trim(match_id)) AS match_id
      FROM vessel_links_source
      WHERE trim(COALESCE(match_id, '')) <> ''
    `).all().map(row => row.match_id));
  } finally {
    db.close();
  }
}

function legacyAssignments(existing) {
  const rows = [];
  for (const child of VESSEL_LINK_CONFIG.children) {
    const db = new Database(dbPath(child.database), { readonly: true, fileMustExist: true });
    try {
      const refField = REF_FIELDS[child.database];
      const records = db.prepare(`
        SELECT "${child.rowColumn}", "${child.matchIdColumn}", "${child.column}", "${refField}"
        FROM "${child.table}"
        ORDER BY CAST("${child.rowColumn}" AS INTEGER)
      `).all();
      for (const record of records) {
        const matchId = str(record[child.matchIdColumn]);
        const vslId = realVslId(record[child.column]);
        if (!matchId || !vslId || existing.has(matchId.toLowerCase())) continue;
        existing.add(matchId.toLowerCase());
        rows.push({
          matchId,
          sourceTab: child.sourceTab,
          contractRef: str(record[refField]),
          sourceRow: str(record[child.rowColumn]),
          vslId,
        });
      }
    } finally {
      db.close();
    }
  }
  return rows;
}

async function main() {
  const db10 = definition('DB10');
  const helpers = VESSEL_LINK_CONFIG.children.map(child => ({
    child,
    source: definition(child.database),
  }));

  const source = await ensureSourceTab(db10, HEADERS);
  console.log(`Vessel Links tab: ${source.created ? 'created' : 'already present'}${source.headersWritten ? ', headers written' : ''}`);
  for (const { child, source: contractSource } of helpers) {
    const sourceRange = contractSource.sources[0];
    const headerIndex = sourceRange.range.split(':')[1];
    const headerColumn = headerIndex ? headerIndex : sourceRange.range;
    // The configured range ends exactly at the helper column, so derive its
    // zero-based index from the column name without changing any live fields.
    const letters = String(headerColumn).replace(/\d/g, '').toUpperCase();
    let index = 0;
    for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
    await ensureSourceColumnHeader(contractSource, index - 1, MATCH_ID_HEADER);
    await hideSourceColumn(contractSource, index - 1);
    console.log(`Ensured ${child.sourceTab} ${letters}1 header`);
  }

  const firstSync = await refreshBulkDatabases();
  assertSync(firstSync, 'Initial Match ID sync');
  const repairs = firstSync.matchIdRepairs || [];
  repairs.forEach(item => {
    if (item.created || item.repaired) {
      console.log(`${item.name}: created ${item.created || 0}, repaired duplicates ${item.repaired || 0}, cleared copied VSL IDs ${item.clearedLegacyVsl || 0}`);
    }
  });

  const existing = existingMatchIds();
  const legacy = legacyAssignments(existing);
  if (legacy.length) {
    const now = new Date().toISOString();
    const values = legacy.map(link => [
      link.matchId,
      link.sourceTab,
      link.contractRef,
      '',
      link.sourceRow,
      link.vslId,
      'TRUE',
      now,
      now,
      'migration',
    ]);
    await appendSourceRows(db10, values);
  }
  console.log(`Seeded ${legacy.length} active legacy vessel links`);

  const finalSync = await refreshBulkDatabases();
  assertSync(finalSync, 'Final Vessel Links sync');
  console.log(`Migration complete. ${JSON.stringify(finalSync.vesselLinks)}`);
}

main().catch(err => {
  console.error(`Vessel Links migration failed: ${err.message}`);
  process.exitCode = 1;
});
