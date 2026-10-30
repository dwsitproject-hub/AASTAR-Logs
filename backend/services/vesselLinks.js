'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { VESSEL_LINK_CONFIG } = require('../config/dataSources');

const DATA_DIR = process.env.DATA_DATABASE_DIR || path.join(__dirname, '../data/databases');
const LINK_DB_PATH = path.join(DATA_DIR, 'vessel_links.db');

function dbPath(name) {
  return path.join(DATA_DIR, `${name}.db`);
}

function canonical(value) {
  if (value == null || String(value).trim() === '') return null;
  const result = String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, '').toUpperCase();
  return result || null;
}

function isRealVesselId(value) {
  return value && value !== 'VSL_00_0000';
}

function isActive(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  return ['true', 'yes', 'y', '1', 'active'].includes(normalized);
}

function readRows(database, table, columns) {
  const file = dbPath(database);
  if (!fs.existsSync(file)) throw new Error(`Cannot build vessel links: ${database} is not available`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const select = columns.map(column => `"${column.replace(/"/g, '""')}"`).join(', ');
    return db.prepare(`SELECT ${select} FROM "${table.replace(/"/g, '""')}"`).all();
  } finally {
    db.close();
  }
}

function rebuildVesselLinks() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${LINK_DB_PATH}.tmp-${process.pid}`;
  try { fs.rmSync(temp, { force: true }); } catch {}

  const parentRows = readRows(
    VESSEL_LINK_CONFIG.parent.database,
    VESSEL_LINK_CONFIG.parent.table,
    [VESSEL_LINK_CONFIG.parent.rowColumn, ...VESSEL_LINK_CONFIG.parent.columns],
  );
  const parentNodes = [];
  const parentsByVslId = new Map();
  for (let rowIndex = 0; rowIndex < parentRows.length; rowIndex++) {
    const row = parentRows[rowIndex];
    const sourceRow = row[VESSEL_LINK_CONFIG.parent.rowColumn] || String(rowIndex + 2);
    for (const column of VESSEL_LINK_CONFIG.parent.columns) {
      const vslId = canonical(row[column]);
      if (!isRealVesselId(vslId)) continue;
      const nodeId = `${VESSEL_LINK_CONFIG.parent.database}:${sourceRow}:${column}`;
      const node = { nodeId, databaseName: VESSEL_LINK_CONFIG.parent.database, tableName: VESSEL_LINK_CONFIG.parent.table, sourceRow: String(sourceRow), sourceColumn: column, vslId };
      parentNodes.push(node);
      if (!parentsByVslId.has(vslId)) parentsByVslId.set(vslId, []);
      parentsByVslId.get(vslId).push(node);
    }
  }

  const childNodes = [];
  const links = [];
  const sourceLinks = readRows('DB10', 'vessel_links_source', ['_sheet_row', 'match_id', 'vsl_id', 'active'])
    .sort((a, b) => Number(a._sheet_row) - Number(b._sheet_row));
  const assignmentsByMatchId = new Map();
  for (const sourceLink of sourceLinks) {
    const matchId = canonical(sourceLink.match_id);
    const vslId = canonical(sourceLink.vsl_id);
    if (!matchId) continue;
    // Source rows are append-only in normal use. The latest row also owns the
    // inactive state, so an older active row cannot revive an unmatched link.
    if (!isRealVesselId(vslId) || !isActive(sourceLink.active)) assignmentsByMatchId.delete(matchId);
    else assignmentsByMatchId.set(matchId, vslId);
  }
  for (const childConfig of VESSEL_LINK_CONFIG.children) {
    const rows = readRows(childConfig.database, childConfig.table, [childConfig.rowColumn, childConfig.matchIdColumn]);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const sourceRow = row[childConfig.rowColumn] || String(rowIndex + 2);
      const matchId = canonical(row[childConfig.matchIdColumn]);
      const vslId = matchId ? assignmentsByMatchId.get(matchId) : null;
      if (!isRealVesselId(vslId)) continue;
      const nodeId = `${childConfig.database}:${sourceRow}:${childConfig.matchIdColumn}`;
      const matches = parentsByVslId.get(vslId) || [];
      childNodes.push({
        nodeId,
        databaseName: childConfig.database,
        tableName: childConfig.table,
        sourceRow: String(sourceRow),
        sourceColumn: childConfig.matchIdColumn,
        vslId,
        matchedParentCount: matches.length,
      });
      for (const parent of matches) {
        links.push({
          vslId,
          parentNodeId: parent.nodeId,
          childNodeId: nodeId,
          parentDatabase: parent.databaseName,
          parentTable: parent.tableName,
          parentRow: parent.sourceRow,
          parentColumn: parent.sourceColumn,
          childDatabase: childConfig.database,
          childTable: childConfig.table,
          childRow: String(sourceRow),
          childColumn: childConfig.matchIdColumn,
        });
      }
    }
  }

  const db = new Database(temp);
  db.pragma('journal_mode = DELETE');
  db.exec(`CREATE TABLE _database_meta (
    database_name TEXT, parent_database TEXT, child_database_count INTEGER,
    parent_node_count INTEGER, child_node_count INTEGER, link_count INTEGER, built_at TEXT
  )`);
  db.exec(`CREATE TABLE parent_nodes (
    node_id TEXT PRIMARY KEY, database_name TEXT, table_name TEXT,
    source_row TEXT, source_column TEXT, vsl_id TEXT
  )`);
  db.exec(`CREATE TABLE child_nodes (
    node_id TEXT PRIMARY KEY, database_name TEXT, table_name TEXT,
    source_row TEXT, source_column TEXT, vsl_id TEXT, matched_parent_count INTEGER
  )`);
  db.exec(`CREATE TABLE links (
    link_id INTEGER PRIMARY KEY AUTOINCREMENT, vsl_id TEXT,
    parent_node_id TEXT, child_node_id TEXT,
    parent_database TEXT, parent_table TEXT, parent_row TEXT, parent_column TEXT,
    child_database TEXT, child_table TEXT, child_row TEXT, child_column TEXT
  )`);
  db.exec('CREATE INDEX idx_parent_nodes_vsl_id ON parent_nodes(vsl_id)');
  db.exec('CREATE INDEX idx_child_nodes_vsl_id ON child_nodes(vsl_id)');
  db.exec('CREATE INDEX idx_links_vsl_id ON links(vsl_id)');
  db.exec('CREATE INDEX idx_links_child_node ON links(child_node_id)');

  const insertParent = db.prepare('INSERT INTO parent_nodes VALUES (?, ?, ?, ?, ?, ?)');
  const insertChild = db.prepare('INSERT INTO child_nodes VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertLink = db.prepare('INSERT INTO links (vsl_id, parent_node_id, child_node_id, parent_database, parent_table, parent_row, parent_column, child_database, child_table, child_row, child_column) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertMeta = db.prepare('INSERT INTO _database_meta VALUES (?, ?, ?, ?, ?, ?, ?)');
  const write = db.transaction(() => {
    parentNodes.forEach(node => insertParent.run(node.nodeId, node.databaseName, node.tableName, node.sourceRow, node.sourceColumn, node.vslId));
    childNodes.forEach(node => insertChild.run(node.nodeId, node.databaseName, node.tableName, node.sourceRow, node.sourceColumn, node.vslId, node.matchedParentCount));
    links.forEach(link => insertLink.run(link.vslId, link.parentNodeId, link.childNodeId, link.parentDatabase, link.parentTable, link.parentRow, link.parentColumn, link.childDatabase, link.childTable, link.childRow, link.childColumn));
    insertMeta.run('VESSEL_LINKS', VESSEL_LINK_CONFIG.parent.database, VESSEL_LINK_CONFIG.children.length, parentNodes.length, childNodes.length, links.length, new Date().toISOString());
  });
  write();
  db.close();

  if (process.platform === 'win32' && fs.existsSync(LINK_DB_PATH)) fs.rmSync(LINK_DB_PATH, { force: true });
  fs.renameSync(temp, LINK_DB_PATH);
  return { path: LINK_DB_PATH, parentNodes: parentNodes.length, childNodes: childNodes.length, links: links.length };
}

module.exports = { LINK_DB_PATH, rebuildVesselLinks };
