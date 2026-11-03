'use strict';

// PostgreSQL schema migrations for the target platform (ApsaraDB RDS for PostgreSQL 18).
//
// Files live in backend/db/migrations and are named NNNN_snake_case.sql. Each pending
// file runs in its own transaction and is recorded in migrations.schema_migrations with a
// SHA-256 checksum; an applied file that changes afterwards stops the run, so history
// can only move forward through new files. A file whose first line is
// `-- migrate:no-transaction` runs outside a transaction (e.g. CREATE INDEX CONCURRENTLY).
// A session advisory lock keeps two deploys from migrating at the same time.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parse: parseConnectionString } = require('pg-connection-string');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const NO_TRANSACTION = /^\s*--\s*migrate:no-transaction\b/i;
// Arbitrary but fixed: pg_advisory_lock key reserved for this application's migrations.
const LOCK_KEY = 74266031;

function migrationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function checksumOf(sql) {
  // Line endings must not change the checksum (Windows checkouts use CRLF).
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function listMigrations(dir = MIGRATIONS_DIR) {
  const migrations = [];
  const versions = new Map();
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.toLowerCase().endsWith('.sql')) continue;
    const match = file.match(FILE_PATTERN);
    if (!match) {
      throw migrationError(`Migration file name must look like 0002_add_column.sql: ${file}`, 'MIGRATION_BAD_NAME');
    }
    const version = Number(match[1]);
    if (version === 0) throw migrationError(`Migration version 0000 is reserved: ${file}`, 'MIGRATION_BAD_NAME');
    if (versions.has(version)) {
      throw migrationError(`Duplicate migration version ${match[1]}: ${versions.get(version)} and ${file}`, 'MIGRATION_DUPLICATE');
    }
    versions.set(version, file);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    migrations.push({
      version,
      name: match[2],
      file,
      sql,
      checksum: checksumOf(sql),
      transactional: !NO_TRANSACTION.test(sql.split(/\r?\n/, 1)[0] || ''),
    });
  }
  return migrations;
}

// The history lives in its own schema: on PostgreSQL 15+ and on managed services
// (ApsaraDB) the owner account often may not create tables in schema public, while
// creating a schema only needs the CREATE right on the database the migrations need anyway.
async function ensureHistoryTable(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS migrations');
  // Earlier versions of this runner kept the history in public.
  const { rows } = await client.query(
    "SELECT to_regclass('public.schema_migrations') AS legacy, to_regclass('migrations.schema_migrations') AS current",
  );
  if (rows[0].legacy && !rows[0].current) {
    await client.query('ALTER TABLE public.schema_migrations SET SCHEMA migrations');
  }
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations.schema_migrations (
      version      integer     PRIMARY KEY,
      name         text        NOT NULL,
      checksum     text        NOT NULL,
      applied_at   timestamptz NOT NULL DEFAULT now(),
      applied_by   text        NOT NULL DEFAULT current_user,
      duration_ms  integer     NOT NULL
    )
  `);
}

// Compares the files on disk with the history table.
async function migrationStatus(client, migrations) {
  await ensureHistoryTable(client);
  const { rows } = await client.query('SELECT version, name, checksum, applied_at FROM migrations.schema_migrations ORDER BY version');
  const applied = new Map(rows.map(row => [Number(row.version), row]));
  const onDisk = new Map(migrations.map(migration => [migration.version, migration]));
  return {
    applied: rows.map(row => ({ version: Number(row.version), name: row.name, appliedAt: row.applied_at })),
    pending: migrations.filter(migration => !applied.has(migration.version)),
    changed: migrations.filter(migration => applied.has(migration.version) && applied.get(migration.version).checksum !== migration.checksum),
    missing: rows.filter(row => !onDisk.has(Number(row.version))).map(row => ({ version: Number(row.version), name: row.name })),
  };
}

async function applyMigration(client, migration) {
  const started = Date.now();
  if (migration.transactional) await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO migrations.schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
      [migration.version, migration.name, migration.checksum, Date.now() - started],
    );
    if (migration.transactional) await client.query('COMMIT');
  } catch (error) {
    if (migration.transactional) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    const wrapped = migrationError(`Migration ${migration.file} failed: ${error.message}`, 'MIGRATION_FAILED');
    wrapped.cause = error;
    throw wrapped;
  }
  return Date.now() - started;
}

// Applies every pending migration in version order. `client` is a connected pg.Client.
async function migrate(client, { dir = MIGRATIONS_DIR, dryRun = false, log = () => {} } = {}) {
  const migrations = listMigrations(dir);
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    const status = await migrationStatus(client, migrations);
    if (status.changed.length) {
      throw migrationError(
        `Applied migrations were modified after they ran: ${status.changed.map(m => m.file).join(', ')}. Add a new migration instead.`,
        'MIGRATION_CHECKSUM_MISMATCH',
      );
    }
    if (status.missing.length) {
      log(`warning: applied migrations not found on disk: ${status.missing.map(m => `${String(m.version).padStart(4, '0')}_${m.name}`).join(', ')}`);
    }
    const appliedNow = [];
    for (const migration of status.pending) {
      if (dryRun) {
        log(`would apply ${migration.file}`);
        continue;
      }
      log(`applying ${migration.file} ...`);
      const ms = await applyMigration(client, migration);
      log(`applied  ${migration.file} (${ms} ms)`);
      appliedNow.push(migration.file);
    }
    return { applied: appliedNow, pending: dryRun ? status.pending.map(m => m.file) : [], alreadyApplied: status.applied.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  }
}

// Connection settings from the environment. TLS for ApsaraDB RDS goes in the URL:
//   DATABASE_URL=postgres://erp_owner@<host>:5432/erp?sslmode=verify-full&sslrootcert=/path/rds-ca.pem
function connectionConfig(env = process.env, applicationName = 'astar-erp-migrate') {
  const connectionString = String(env.MIGRATION_DATABASE_URL || env.DATABASE_URL || '').trim();
  if (!connectionString) {
    throw migrationError('Set MIGRATION_DATABASE_URL (owner account) or DATABASE_URL', 'MIGRATION_NO_DATABASE');
  }
  let parsed;
  try {
    parsed = parseConnectionString(connectionString);
  } catch {
    // Never echo the URL: it usually contains the password.
    throw migrationError(
      'The database URL is not a valid URL. In the password, / ? # must be URL-encoded (%2F %3F %23); '
        + 'or leave the password out of the URL and set MIGRATION_DATABASE_PASSWORD.',
      'MIGRATION_BAD_URL',
    );
  }
  const base = { application_name: applicationName, connectionTimeoutMillis: 15000 };
  // A separate password needs no URL encoding. pg lets a connectionString win over
  // explicit fields, so the parsed settings are passed instead of the string.
  const password = String(env.MIGRATION_DATABASE_PASSWORD || '');
  if (password) return { ...parsed, password, ...base };
  return { connectionString, ...base };
}

module.exports = {
  LOCK_KEY,
  MIGRATIONS_DIR,
  checksumOf,
  connectionConfig,
  listMigrations,
  migrate,
  migrationStatus,
};
