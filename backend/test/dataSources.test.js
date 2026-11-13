'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DATA_DATABASES, serviceAccount, sheetId } = require('../config/dataSources');

test('spreadsheet IDs and service accounts default to production and can be overridden per stack', () => {
  assert.equal(sheetId('GR', 'prod-sheet', {}), 'prod-sheet');
  assert.equal(sheetId('GR', 'prod-sheet', { SHEET_ID_GR: ' copy-sheet ' }), 'copy-sheet');
  assert.equal(sheetId('GR', 'prod-sheet', { SHEET_ID_GR: 'None' }), '', 'none switches the sheet off');
  assert.equal(sheetId('GR', 'prod-sheet', { SHEETS_COPIES_ONLY: '1' }), '', 'copies-only never falls back to production');
  assert.equal(sheetId('GR', 'prod-sheet', { SHEETS_COPIES_ONLY: '1', SHEET_ID_GR: 'prod-sheet' }), '', 'not even when named explicitly');
  assert.equal(sheetId('GR', 'prod-sheet', { SHEETS_COPIES_ONLY: '1', SHEET_ID_GR: 'copy-sheet' }), 'copy-sheet');
  assert.equal(serviceAccount('prod@sa.example', {}), 'prod@sa.example');
  assert.equal(serviceAccount('prod@sa.example', { SHEETS_SERVICE_ACCOUNT_EMAIL: ' Dev@SA.example ' }), 'dev@sa.example');
});

test('every data source names a spreadsheet and a service account', () => {
  for (const definition of DATA_DATABASES) {
    assert.match(definition.sheetId, /^[A-Za-z0-9_-]{30,}$/, definition.name);
    assert.match(definition.serviceAccountEmail, /^[^@\s]+@[^@\s]+$/, definition.name);
  }
});
