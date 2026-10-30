'use strict';

const Database = require('better-sqlite3');
const { DATA_DATABASES } = require('../config/dataSources');
const { appendSourceRows, writeSourceCells, dbPath } = require('./bulkDataSync');

const TABLE = 'vessel_links_source';
const HEADERS = [
  'Match ID',
  'Source Tab',
  'Contract Ref',
  'Parent Match ID',
  'Source Row',
  'VSL ID',
  'Active',
  'Created At',
  'Updated At',
  'Updated By',
];

function str(value) {
  return value == null ? '' : String(value).trim();
}

function normalizedMatchId(value) {
  return str(value).toLowerCase();
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sourceDefinition() {
  const definition = DATA_DATABASES.find(item => item.name === 'DB10');
  if (!definition) throw new Error('DB10 Vessel Links source is not configured');
  return definition;
}

function parseAppendedRow(updatedRange) {
  const match = String(updatedRange || '').match(/![A-Z]+(\d+)(?::[A-Z]+(\d+))?$/i);
  return match ? Number(match[2] || match[1]) : 0;
}

function getRowsForMatchId(matchId) {
  const db = new Database(dbPath('DB10'), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT _sheet_row, match_id, source_tab, contract_ref, parent_match_id, source_row,
             vsl_id, active, created_at, updated_at, updated_by
      FROM ${quoteIdentifier(TABLE)}
      WHERE lower(trim(COALESCE(match_id, ''))) = ?
      ORDER BY CAST(_sheet_row AS INTEGER)
    `).all(normalizedMatchId(matchId));
  } finally {
    db.close();
  }
}

function loadActiveAssignments() {
  const db = new Database(dbPath('DB10'), { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT _sheet_row, match_id, vsl_id, active
      FROM ${quoteIdentifier(TABLE)}
      ORDER BY CAST(_sheet_row AS INTEGER)
    `).all();
    const assignments = new Map();
    for (const row of rows) {
      const matchId = normalizedMatchId(row.match_id);
      const active = ['true', 'yes', 'y', '1', 'active'].includes(str(row.active).toLowerCase());
      const vslId = str(row.vsl_id);
      if (!matchId) continue;
      if (!active || !vslId || vslId.toUpperCase() === 'VSL_00_0000') assignments.delete(matchId);
      else assignments.set(matchId, vslId);
    }
    return assignments;
  } finally {
    db.close();
  }
}

function updateLocalRow(sheetRow, fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const db = new Database(dbPath('DB10'));
  try {
    const result = db.prepare(`
      UPDATE ${quoteIdentifier(TABLE)}
      SET ${entries.map(([key]) => `${quoteIdentifier(key)} = ?`).join(', ')}
      WHERE _sheet_row = ?
    `).run(...entries.map(([, value]) => value), String(sheetRow));
    if (!result.changes) throw new Error('Vessel Links database row was not updated');
  } finally {
    db.close();
  }
}

function insertLocalRow(sheetRow, values) {
  const db = new Database(dbPath('DB10'));
  try {
    const fields = ['_sheet_row', 'match_id', 'source_tab', 'contract_ref', 'parent_match_id', 'source_row', 'vsl_id', 'active', 'created_at', 'updated_at', 'updated_by'];
    const result = db.prepare(`
      INSERT INTO ${quoteIdentifier(TABLE)} (${fields.map(quoteIdentifier).join(', ')})
      VALUES (${fields.map(() => '?').join(', ')})
    `).run(String(sheetRow), String(values.matchId), String(values.sourceTab), String(values.contractRef),
      String(values.parentMatchId || ''), String(values.sourceRow), String(values.vslId), 'TRUE',
      String(values.createdAt), String(values.updatedAt), String(values.updatedBy));
    if (!result.changes) throw new Error('Vessel Links database row was not inserted');
  } finally {
    db.close();
  }
}

async function upsertVesselLink({ matchId, sourceTab, contractRef, parentMatchId = '', sourceRow, vslId, updatedBy = 'ERP' }) {
  const id = str(matchId);
  const targetVslId = str(vslId);
  if (!id) throw new Error('ERP Match ID is required to create a vessel link');
  if (!targetVslId || targetVslId.toUpperCase() === 'VSL_00_0000') throw new Error('A real VSL ID is required to create a vessel link');

  const definition = sourceDefinition();
  const now = new Date().toISOString();
  const existing = getRowsForMatchId(id);
  const latest = existing.at(-1);
  if (latest) {
    const rowNumber = Number(latest._sheet_row);
    await writeSourceCells(definition, [
      { range: `B${rowNumber}`, value: sourceTab },
      { range: `C${rowNumber}`, value: contractRef },
      { range: `D${rowNumber}`, value: parentMatchId },
      { range: `E${rowNumber}`, value: sourceRow },
      { range: `F${rowNumber}`, value: targetVslId },
      { range: `G${rowNumber}`, value: 'TRUE' },
      { range: `I${rowNumber}`, value: now },
      { range: `J${rowNumber}`, value: updatedBy },
    ]);
    updateLocalRow(rowNumber, {
      source_tab: sourceTab,
      contract_ref: contractRef,
      parent_match_id: parentMatchId,
      source_row: String(sourceRow),
      vsl_id: targetVslId,
      active: 'TRUE',
      updated_at: now,
      updated_by: updatedBy,
    });
    return { row: rowNumber, created: false, vslId: targetVslId };
  }

  const values = {
    matchId: id,
    sourceTab,
    contractRef,
    parentMatchId,
    sourceRow: String(sourceRow),
    vslId: targetVslId,
    createdAt: now,
    updatedAt: now,
    updatedBy,
  };
  const appended = await appendSourceRows(definition, [[
    values.matchId,
    values.sourceTab,
    values.contractRef,
    values.parentMatchId,
    values.sourceRow,
    values.vslId,
    'TRUE',
    values.createdAt,
    values.updatedAt,
    values.updatedBy,
  ]]);
  const rowNumber = parseAppendedRow(appended.updatedRange);
  if (!rowNumber) throw new Error('Google Sheets did not return the appended Vessel Links row');
  insertLocalRow(rowNumber, values);
  return { row: rowNumber, created: true, vslId: targetVslId };
}

async function deactivateVesselLink(matchId, updatedBy = 'ERP') {
  const id = str(matchId);
  if (!id) return { changed: false };
  const latest = getRowsForMatchId(id).at(-1);
  if (!latest) return { changed: false };

  const definition = sourceDefinition();
  const now = new Date().toISOString();
  const rowNumber = Number(latest._sheet_row);
  await writeSourceCells(definition, [
    { range: `G${rowNumber}`, value: 'FALSE' },
    { range: `I${rowNumber}`, value: now },
    { range: `J${rowNumber}`, value: updatedBy },
  ]);
  updateLocalRow(rowNumber, { active: 'FALSE', updated_at: now, updated_by: updatedBy });
  return { changed: true, row: rowNumber };
}

async function deactivateVesselLinksByVslIds(vslIds, updatedBy = 'ERP') {
  const targets = new Set((vslIds || []).map(value => str(value).toLowerCase()).filter(Boolean));
  if (!targets.size) return { changed: 0, matchIds: [] };

  const db = new Database(dbPath('DB10'), { readonly: true, fileMustExist: true });
  let latestRows;
  try {
    const rows = db.prepare(`
      SELECT _sheet_row, match_id, vsl_id, active
      FROM ${quoteIdentifier(TABLE)}
      ORDER BY CAST(_sheet_row AS INTEGER)
    `).all();
    const latestByMatch = new Map();
    for (const row of rows) {
      const matchId = normalizedMatchId(row.match_id);
      if (matchId) latestByMatch.set(matchId, row);
    }
    latestRows = [...latestByMatch.entries()]
      .filter(([, row]) => targets.has(str(row.vsl_id).toLowerCase()) && ['true', 'yes', 'y', '1', 'active'].includes(str(row.active).toLowerCase()))
      .map(([matchId, row]) => ({ matchId, rowNumber: Number(row._sheet_row) }));
  } finally {
    db.close();
  }
  if (!latestRows.length) return { changed: 0, matchIds: [] };

  const definition = sourceDefinition();
  const now = new Date().toISOString();
  await writeSourceCells(definition, latestRows.flatMap(({ rowNumber }) => [
    { range: `G${rowNumber}`, value: 'FALSE' },
    { range: `I${rowNumber}`, value: now },
    { range: `J${rowNumber}`, value: updatedBy },
  ]));

  const writable = new Database(dbPath('DB10'));
  try {
    const update = writable.prepare(`
      UPDATE ${quoteIdentifier(TABLE)}
      SET active = 'FALSE', updated_at = ?, updated_by = ?
      WHERE _sheet_row = ?
    `);
    writable.transaction(() => {
      for (const { rowNumber } of latestRows) update.run(now, updatedBy, String(rowNumber));
    })();
  } finally {
    writable.close();
  }
  return { changed: latestRows.length, matchIds: latestRows.map(item => item.matchId) };
}

async function remapVesselLinksByVslIds(remaps, updatedBy = 'ERP') {
  const destinations = new Map((remaps || []).map(item => [str(item.from).toLowerCase(), str(item.to)]).filter(([from, to]) => from && to));
  if (!destinations.size) return { changed: 0 };

  const db = new Database(dbPath('DB10'), { readonly: true, fileMustExist: true });
  let targets;
  try {
    const rows = db.prepare(`
      SELECT _sheet_row, match_id, vsl_id, active
      FROM ${quoteIdentifier(TABLE)}
      ORDER BY CAST(_sheet_row AS INTEGER)
    `).all();
    const latestByMatch = new Map();
    for (const row of rows) {
      const matchId = normalizedMatchId(row.match_id);
      if (matchId) latestByMatch.set(matchId, row);
    }
    targets = [...latestByMatch.values()].filter(row => {
      const active = ['true', 'yes', 'y', '1', 'active'].includes(str(row.active).toLowerCase());
      return active && destinations.has(str(row.vsl_id).toLowerCase());
    }).map(row => ({
      rowNumber: Number(row._sheet_row),
      vslId: destinations.get(str(row.vsl_id).toLowerCase()),
    }));
  } finally {
    db.close();
  }
  if (!targets.length) return { changed: 0 };

  const definition = sourceDefinition();
  const now = new Date().toISOString();
  await writeSourceCells(definition, targets.flatMap(({ rowNumber, vslId }) => [
    { range: `F${rowNumber}`, value: vslId },
    { range: `I${rowNumber}`, value: now },
    { range: `J${rowNumber}`, value: updatedBy },
  ]));

  const writable = new Database(dbPath('DB10'));
  try {
    const update = writable.prepare(`
      UPDATE ${quoteIdentifier(TABLE)}
      SET vsl_id = ?, updated_at = ?, updated_by = ?
      WHERE _sheet_row = ?
    `);
    writable.transaction(() => {
      for (const target of targets) update.run(target.vslId, now, updatedBy, String(target.rowNumber));
    })();
  } finally {
    writable.close();
  }
  return { changed: targets.length };
}

module.exports = {
  HEADERS,
  loadActiveAssignments,
  upsertVesselLink,
  deactivateVesselLink,
  deactivateVesselLinksByVslIds,
  remapVesselLinksByVslIds,
};
