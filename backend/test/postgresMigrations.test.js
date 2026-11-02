'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checksumOf, listMigrations, migrate, migrationStatus, MIGRATIONS_DIR } = require('../db/postgres/migrate');

function tempDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('migration files are discovered in version order with stable checksums', t => {
  const dir = tempDir(t, {
    '0002_second.sql': 'SELECT 2;',
    '0001_first.sql': 'SELECT 1;\r\n',
    '0003_concurrent_index.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY x ON y (z);',
    'README.md': 'not a migration',
  });
  const migrations = listMigrations(dir);
  assert.deepEqual(migrations.map(m => m.file), ['0001_first.sql', '0002_second.sql', '0003_concurrent_index.sql']);
  assert.deepEqual(migrations.map(m => m.transactional), [true, true, false]);
  assert.equal(checksumOf('SELECT 1;\r\n'), checksumOf('SELECT 1;\n'), 'CRLF and LF checkouts give the same checksum');
});

test('badly named and duplicate migration files are rejected', t => {
  assert.throws(() => listMigrations(tempDir(t, { '1_short.sql': '' })), error => error.code === 'MIGRATION_BAD_NAME');
  assert.throws(() => listMigrations(tempDir(t, { '0001_Upper-Case.sql': '' })), error => error.code === 'MIGRATION_BAD_NAME');
  assert.throws(() => listMigrations(tempDir(t, { '0000_reserved.sql': '' })), error => error.code === 'MIGRATION_BAD_NAME');
  assert.throws(() => listMigrations(tempDir(t, { '0001_a.sql': '', '0001_b.sql': '' })), error => error.code === 'MIGRATION_DUPLICATE');
});

test('the shipped migrations parse and contain no explicit transaction control', () => {
  const migrations = listMigrations(MIGRATIONS_DIR);
  assert.ok(migrations.length >= 1);
  assert.equal(migrations[0].file, '0001_target_schema.sql');
  for (const migration of migrations) {
    assert.doesNotMatch(migration.sql, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im, `${migration.file} must not manage its own transaction`);
  }
});

// Integration tests need a PostgreSQL server where the user may CREATE DATABASE, e.g.
//   docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:18
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

test('migrations against PostgreSQL', { skip: TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set' }, async t => {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  const databases = [];
  const clients = [];
  // Close every test connection before dropping its database.
  t.after(async () => {
    await Promise.all(clients.map(client => client.end().catch(() => {})));
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  async function connect(database) {
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${database}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function freshDatabase() {
    const name = `erp_migrate_test_${crypto.randomBytes(5).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    databases.push(name);
    return connect(name);
  }

  await t.test('a fresh database gets the full target schema, and a second run is a no-op', async () => {
    const client = await freshDatabase();
    const first = await migrate(client);
    const shipped = listMigrations();
    assert.deepEqual(first.applied, shipped.map(m => m.file));
    assert.equal(first.applied[0], '0001_target_schema.sql');
    const { rows: schemas } = await client.query(
      "SELECT nspname FROM pg_namespace WHERE nspname IN ('app','security','audit','mirror','links') ORDER BY 1",
    );
    assert.deepEqual(schemas.map(r => r.nspname), ['app', 'audit', 'links', 'mirror', 'security']);
    const { rows: users } = await client.query("SELECT to_regclass('app.users') AS t, to_regclass('audit.authentication_events_default') AS d");
    assert.equal(users[0].t, 'app.users');
    assert.equal(users[0].d, 'audit.authentication_events_default');
    const second = await migrate(client);
    assert.deepEqual(second.applied, []);
    assert.equal(second.alreadyApplied, shipped.length);
    const { rows: history } = await client.query('SELECT version, name, checksum FROM public.schema_migrations ORDER BY version');
    assert.deepEqual(history.map(row => row.checksum), shipped.map(m => m.checksum));
    const { rows: sources } = await client.query("SELECT to_regclass('app.spreadsheet_sources') AS t");
    assert.equal(sources[0].t, 'app.spreadsheet_sources');
  });

  await t.test('new migrations apply in order; dry-run changes nothing', async () => {
    const client = await freshDatabase();
    const dir = tempDir(t, {
      '0001_base.sql': 'CREATE TABLE public.t1 (id int PRIMARY KEY);',
      '0002_more.sql': 'ALTER TABLE public.t1 ADD COLUMN note text;',
    });
    const dry = await migrate(client, { dir, dryRun: true });
    assert.deepEqual(dry.pending, ['0001_base.sql', '0002_more.sql']);
    assert.equal((await client.query("SELECT to_regclass('public.t1') AS t")).rows[0].t, null);
    const result = await migrate(client, { dir });
    assert.deepEqual(result.applied, ['0001_base.sql', '0002_more.sql']);
    const { rows } = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 't1' ORDER BY ordinal_position");
    assert.deepEqual(rows.map(r => r.column_name), ['id', 'note']);
  });

  await t.test('a failing migration rolls back completely and is not recorded', async () => {
    const client = await freshDatabase();
    const dir = tempDir(t, {
      '0001_ok.sql': 'CREATE TABLE public.ok (id int);',
      '0002_broken.sql': 'CREATE TABLE public.half (id int); INSERT INTO public.no_such_table VALUES (1);',
    });
    await assert.rejects(migrate(client, { dir }), error => error.code === 'MIGRATION_FAILED' && /0002_broken\.sql/.test(error.message));
    assert.equal((await client.query("SELECT to_regclass('public.ok') AS t")).rows[0].t, 'ok');
    assert.equal((await client.query("SELECT to_regclass('public.half') AS t")).rows[0].t, null, 'partial DDL rolled back');
    const { rows } = await client.query('SELECT version FROM public.schema_migrations ORDER BY version');
    assert.deepEqual(rows.map(r => Number(r.version)), [1]);
  });

  await t.test('editing an applied migration stops the run', async () => {
    const client = await freshDatabase();
    const dir = tempDir(t, { '0001_base.sql': 'CREATE TABLE public.t2 (id int);' });
    await migrate(client, { dir });
    fs.writeFileSync(path.join(dir, '0001_base.sql'), 'CREATE TABLE public.t2 (id bigint);');
    fs.writeFileSync(path.join(dir, '0002_next.sql'), 'CREATE TABLE public.t3 (id int);');
    await assert.rejects(migrate(client, { dir }), error => error.code === 'MIGRATION_CHECKSUM_MISMATCH');
    assert.equal((await client.query("SELECT to_regclass('public.t3') AS t")).rows[0].t, null, 'nothing after the mismatch ran');
    const status = await migrationStatus(client, listMigrations(dir));
    assert.deepEqual(status.changed.map(m => m.file), ['0001_base.sql']);
  });

  await t.test('two concurrent runs apply each migration exactly once', async () => {
    const first = await freshDatabase();
    const dir = tempDir(t, { '0001_slow.sql': 'SELECT pg_sleep(0.5); CREATE TABLE public.once (id int);' });
    const second = await connect(databases[databases.length - 1]);
    const [a, b] = await Promise.all([migrate(first, { dir }), migrate(second, { dir })]);
    assert.equal(a.applied.length + b.applied.length, 1);
    const { rows } = await first.query('SELECT count(*)::int AS n FROM public.schema_migrations');
    assert.equal(rows[0].n, 1);
  });
});
