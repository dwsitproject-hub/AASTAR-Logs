'use strict';

// One-time migration command. It preserves the control database containing
// users and permissions, while clearing legacy sheet data/configuration and
// removing old data databases before DB1-DB9 are rebuilt.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DATABASE_DIR || path.join(__dirname, '../data/databases');
const controlDb = process.env.DB_PATH || path.join(__dirname, '../data/erp.db');
const legacyFiles = [
  path.join(__dirname, '../data/sheets_mirror.db'),
  path.join(__dirname, '../data/master_matching.db'),
  path.join(__dirname, '../data/shpt_file.db'),
];

function copyIfPresent(source, destination) {
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, path.basename(source)));
}

function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  const archive = path.join(path.dirname(controlDb), `rollback-before-bulk-data-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(archive, { recursive: true });

  for (const source of [controlDb, `${controlDb}-wal`, `${controlDb}-shm`, ...legacyFiles]) copyIfPresent(source, archive);
  if (fs.existsSync(dataDir)) {
    for (const file of fs.readdirSync(dataDir)) {
      if (/^DB[1-9]\.db(?:-.+)?$/.test(file)) copyIfPresent(path.join(dataDir, file), archive);
    }
  }

  const db = new Database(controlDb);
  db.pragma('busy_timeout = 5000');
  db.exec('DELETE FROM sheet_cache');
  db.exec('DELETE FROM sheets_config');
  db.close();

  for (const file of [...legacyFiles, ...fs.readdirSync(dataDir).filter(name => /^DB[1-9]\.db(?:-.+)?$/.test(name)).map(name => path.join(dataDir, name))]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }

  console.log(JSON.stringify({ archive, controlDb, dataDir, cleared: true }));
}

main();
