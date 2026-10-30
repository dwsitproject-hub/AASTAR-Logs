'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { DATA_DATABASES, DERIVED_DATABASES } = require('../config/dataSources');
const { DATA_DIR, dbPath } = require('../services/bulkDataSync');

const router = express.Router();
const ALL_DATABASES = [...DATA_DATABASES, ...DERIVED_DATABASES];
const knownDatabases = new Map(ALL_DATABASES.map(definition => [definition.name, definition]));

function definitionFor(name) {
  return knownDatabases.get(String(name || '').toUpperCase()) || null;
}

function databaseFile(definition) {
  return definition.fileName ? path.join(DATA_DIR, definition.fileName) : dbPath(definition.name);
}

function openDatabase(name) {
  const definition = definitionFor(name);
  if (!definition) return null;
  const file = databaseFile(definition);
  if (!fs.existsSync(file)) return null;
  return new Database(file, { readonly: true, fileMustExist: true });
}

function safeTable(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ? AND substr(name, 1, 1) <> '_' AND substr(name, 1, 7) <> 'sqlite_'").get(name);
  return row?.name || null;
}

router.get('/databases', requireAuth, requireAdmin, (req, res) => {
  res.json({
    databases: ALL_DATABASES.map(definition => {
      const file = databaseFile(definition);
      let tables = [];
      let bytes = 0;
      if (fs.existsSync(file)) {
        bytes = fs.statSync(file).size;
        const db = openDatabase(definition.name);
        if (db) {
          tables = db.prepare("SELECT name AS table_name FROM sqlite_master WHERE type='table' AND substr(name, 1, 1) <> '_' AND substr(name, 1, 7) <> 'sqlite_'").all();
          db.close();
        }
      }
      return { name: definition.name, available: fs.existsSync(file), bytes, layout: definition.layout || 'separate', kind: definition.kind || 'source', sources: definition.sources || [], tables };
    }),
  });
});

router.get('/:dbName/tables', requireAuth, requireAdmin, (req, res) => {
  const definition = definitionFor(req.params.dbName);
  if (!definition) return res.status(404).json({ error: 'Unknown database' });
  const db = openDatabase(definition.name);
  if (!db) return res.json({ available: false, database: definition.name, tables: [] });
  try {
    const tables = db.prepare("SELECT name AS table_name FROM sqlite_master WHERE type='table' AND substr(name, 1, 1) <> '_' AND substr(name, 1, 7) <> 'sqlite_'").all().map(({ table_name }) => {
      const columns = db.prepare(`PRAGMA table_info("${table_name}")`).all();
      const total = db.prepare(`SELECT COUNT(*) AS count FROM "${table_name}"`).get().count;
      return { table_name, columns: columns.map(column => column.name), total };
    });
    const metadata = db.prepare('SELECT * FROM _database_meta').all();
    res.json({ available: true, database: definition.name, tables, metadata });
  } finally { db.close(); }
});

router.get('/:dbName/table/:tableName', requireAuth, requireAdmin, (req, res) => {
  const definition = definitionFor(req.params.dbName);
  if (!definition) return res.status(404).json({ error: 'Unknown database' });
  const db = openDatabase(definition.name);
  if (!db) return res.status(404).json({ error: 'Database is not available yet' });
  try {
    const tableName = safeTable(db, req.params.tableName);
    if (!tableName) return res.status(404).json({ error: 'Unknown table' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all().map(column => column.name);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get().count;
    const orderColumn = definition.displayOrderColumn;
    const order = definition.displayOrder === 'desc' ? 'DESC' : 'ASC';
    const orderSql = orderColumn ? ` ORDER BY CAST("${orderColumn}" AS INTEGER) ${order}` : '';
    const rows = db.prepare(`SELECT * FROM "${tableName}"${orderSql} LIMIT ? OFFSET ?`).all(limit, offset);
    res.json({ database: definition.name, name: tableName, columns, rows, total, limit, offset });
  } finally { db.close(); }
});

module.exports = router;
