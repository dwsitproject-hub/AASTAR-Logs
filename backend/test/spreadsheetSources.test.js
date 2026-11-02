'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-spreadsheet-sources-'));
process.env.DB_PATH = path.join(directory, 'erp.db');
process.env.DATA_DATABASE_DIR = path.join(directory, 'databases');

const { getDb, initDb } = require('../db/database');
const { DATA_DATABASES, SPREADSHEETS } = require('../config/dataSources');
const {
  applySpreadsheetSources,
  checkSpreadsheetSource,
  initSpreadsheetSources,
  listSpreadsheetSources,
  parseSheetId,
  updateSpreadsheetSource,
} = require('../services/spreadsheetSources');

const COPY_ID = '1CopyOfTheConsolidatedPalmFile_abcdefgh';
const ACCOUNT = 'erp-local@example-project.iam.gserviceaccount.com';
const PALM_TABS = ['AASTAR SALES', 'AASTAR PURCHASE', 'KIMARA SALES', 'KIMARA PURCHASE', 'Shadow', 'Vessel Links'];

function fakeGoogle({ tabs = PALM_TABS, fail = null } = {}) {
  return {
    availableServiceAccounts: () => [ACCOUNT],
    inspectSpreadsheet: async () => {
      if (fail) throw new Error(fail);
      return { title: 'Copy of Consolidated Palm File', tabs };
    },
  };
}

test.after(() => {
  getDb().close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('the spreadsheet list is seeded once from the code defaults and drives the data sources', async () => {
  initDb();
  const db = getDb();
  initSpreadsheetSources(db);
  initSpreadsheetSources(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spreadsheet_sources').get().n, SPREADSHEETS.length);

  const listed = listSpreadsheetSources(db);
  const palm = listed.spreadsheets.find(sheet => sheet.key === 'AASTAR_SALES');
  assert.equal(palm.sheetId, SPREADSHEETS[0].productionSheetId);
  assert.equal(palm.access, 'read-write');
  assert.equal(listed.spreadsheets.find(sheet => sheet.key === 'STOCK').access, 'read');
  const vessel = listed.spreadsheets.find(sheet => sheet.key === 'VESSEL');
  assert.equal(vessel.databases.find(database => database.name === 'DB6').access, 'read-write');
  assert.equal(vessel.databases.find(database => database.name === 'DB7').access, 'read');
  const db1 = palm.databases.find(database => database.name === 'DB1');
  assert.ok(db1.tabs.find(tab => tab.tab === 'AASTAR SALES').writes.length > 0);
  assert.deepEqual(db1.tabs.find(tab => tab.tab === 'Shadow').writes, []);
});

test('a change is validated against the real spreadsheet, recorded, and applied at once', async () => {
  const db = getDb();
  assert.equal(parseSheetId(`https://docs.google.com/spreadsheets/d/${COPY_ID}/edit?gid=0`), COPY_ID);
  assert.equal(parseSheetId('not a sheet'), '');

  await assert.rejects(checkSpreadsheetSource('NOPE', {}, fakeGoogle()), error => error.statusCode === 404);
  await assert.rejects(checkSpreadsheetSource('AASTAR_SALES', { sheetId: 'x', serviceAccountEmail: ACCOUNT }, fakeGoogle()), error => error.code === 'INVALID_SHEET_ID');
  await assert.rejects(checkSpreadsheetSource('AASTAR_SALES', { sheetId: COPY_ID, serviceAccountEmail: 'other@x.iam.gserviceaccount.com' }, fakeGoogle()), error => error.code === 'SERVICE_ACCOUNT_UNKNOWN');
  await assert.rejects(checkSpreadsheetSource('AASTAR_SALES', { sheetId: COPY_ID, serviceAccountEmail: ACCOUNT }, fakeGoogle({ fail: 'The caller does not have permission' })), error => error.code === 'SPREADSHEET_UNREACHABLE' && error.message.includes(ACCOUNT));
  await assert.rejects(checkSpreadsheetSource('AASTAR_SALES', { sheetId: COPY_ID, serviceAccountEmail: ACCOUNT }, fakeGoogle({ tabs: ['AASTAR SALES'] })), error => error.code === 'TABS_MISSING' && error.result.missingTabs.includes('Vessel Links'));

  const { spreadsheet } = await updateSpreadsheetSource(db, 'AASTAR_SALES', {
    sheetId: `https://docs.google.com/spreadsheets/d/${COPY_ID}/edit`,
    serviceAccountEmail: ACCOUNT,
    enabled: true,
  }, 'admin@example.com', fakeGoogle());
  assert.equal(spreadsheet.sheetId, COPY_ID);
  assert.equal(spreadsheet.updatedBy, 'admin@example.com');
  assert.deepEqual(spreadsheet.changes.map(change => change.field).sort(), ['service_account_email', 'sheet_id']);
  for (const definition of DATA_DATABASES.filter(item => item.spreadsheet === 'AASTAR_SALES')) {
    assert.equal(definition.sheetId, COPY_ID);
    assert.equal(definition.serviceAccountEmail, ACCOUNT);
  }

  const off = await updateSpreadsheetSource(db, 'AASTAR_SALES', { enabled: false }, 'admin@example.com', fakeGoogle());
  assert.equal(off.spreadsheet.enabled, false);
  assert.equal(off.spreadsheet.sheetId, COPY_ID, 'switching off keeps the spreadsheet for later');
  assert.equal(DATA_DATABASES.find(item => item.name === 'DB1').sheetId, '');
});

test('a copies-only stack refuses and never syncs a production spreadsheet', async () => {
  const db = getDb();
  process.env.SHEETS_COPIES_ONLY = '1';
  try {
    await assert.rejects(
      checkSpreadsheetSource('STOCK', { sheetId: SPREADSHEETS.find(sheet => sheet.key === 'STOCK').productionSheetId, serviceAccountEmail: ACCOUNT }, fakeGoogle()),
      error => error.code === 'PRODUCTION_SHEET_BLOCKED',
    );
    applySpreadsheetSources(db);
    assert.equal(DATA_DATABASES.find(item => item.name === 'DB9').sheetId, '', 'the seeded production ID is not synced');
    const stock = listSpreadsheetSources(db).spreadsheets.find(sheet => sheet.key === 'STOCK');
    assert.equal(stock.blockedByCopiesOnly, true);
    assert.equal(stock.syncing, false);
  } finally {
    delete process.env.SHEETS_COPIES_ONLY;
    applySpreadsheetSources(db);
  }
});
