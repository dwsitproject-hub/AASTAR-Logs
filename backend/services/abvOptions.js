'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ABV_DB_PATH = process.env.DATA_DATABASE_DIR
  ? path.join(process.env.DATA_DATABASE_DIR, 'DB8.db')
  : path.join(__dirname, '../data/databases/DB8.db');

let cached = null;

function fileSignature(file) {
  const stat = fs.statSync(file);
  return `${stat.size}:${stat.mtimeMs}`;
}

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function loadAbvOptions(databasePath = ABV_DB_PATH) {
  const signature = fileSignature(databasePath);
  if (cached?.path === databasePath && cached.signature === signature) return cached.value;

  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const sourceColumns = db.prepare('PRAGMA table_info("abv")').all()
      .filter(column => column.name !== '_sheet_row');
    if (sourceColumns.length < 3) throw new Error('DB8 ABV table does not contain columns A:C');

    const portColumn = sourceColumns[0].name.replace(/"/g, '""');
    const cargoColumn = sourceColumns[2].name.replace(/"/g, '""');
    const rows = db.prepare(`
      SELECT "${portColumn}" AS port, "${cargoColumn}" AS cargo
      FROM "abv"
      ORDER BY CAST(_sheet_row AS INTEGER)
    `).all();

    const ports = new Set();
    const cargoes = new Set();
    for (const row of rows) {
      const port = clean(row.port);
      const cargo = clean(row.cargo);
      if (port) ports.add(port);
      if (cargo) cargoes.add(cargo);
    }

    const metadata = db.prepare('SELECT pulled_at FROM _database_meta LIMIT 1').get();
    const value = {
      ports: [...ports].sort((a, b) => a.localeCompare(b)),
      cargoes: [...cargoes].sort((a, b) => a.localeCompare(b)),
      updatedAt: metadata?.pulled_at || null,
    };
    cached = { path: databasePath, signature, value };
    return value;
  } finally {
    db.close();
  }
}

module.exports = { loadAbvOptions };
