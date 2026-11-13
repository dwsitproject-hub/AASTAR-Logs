'use strict';

// PostgreSQL schema migrations.
//   npm run db:migrate            apply pending migrations
//   npm run db:migrate -- --dry-run
//   npm run db:status             list applied / pending / changed migrations
// Uses MIGRATION_DATABASE_URL (database owner account), else DATABASE_URL.

require('dotenv').config();
const { Client } = require('pg');
const { connectionConfig, listMigrations, migrate, migrationStatus } = require('../db/postgres/migrate');

async function main() {
  const args = new Set(process.argv.slice(2));
  const command = args.has('status') ? 'status' : 'up';
  const client = new Client(connectionConfig());
  await client.connect();
  try {
    if (command === 'status') {
      const status = await migrationStatus(client, listMigrations());
      for (const row of status.applied) console.log(`applied  ${String(row.version).padStart(4, '0')}_${row.name}  ${new Date(row.appliedAt).toISOString()}`);
      for (const m of status.pending) console.log(`pending  ${m.file}`);
      for (const m of status.changed) console.log(`CHANGED  ${m.file}  (checksum differs from the applied version)`);
      for (const m of status.missing) console.log(`MISSING  ${String(m.version).padStart(4, '0')}_${m.name}  (applied, file not found)`);
      if (status.changed.length) process.exitCode = 1;
      return;
    }
    const result = await migrate(client, { dryRun: args.has('--dry-run'), log: line => console.log(line) });
    if (!result.applied.length && !result.pending.length) console.log(`Database is up to date (${result.alreadyApplied} migrations applied).`);
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
