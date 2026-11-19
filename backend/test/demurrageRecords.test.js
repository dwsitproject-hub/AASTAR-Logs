'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDemurrageRecords,
  findRecordAtSheetRow,
  spreadsheetSafeText,
} = require('../services/demurrageRecords');

function snapshot() {
  const columns = Array.from({ length: 183 }, (_, index) => `column_${index}`);
  columns[179] = 'demurrage_records';
  columns[180] = 'demurrage_status';
  columns[181] = 'show';
  columns[182] = 'nil_demurrage';
  const row = new Array(183).fill('');
  row[0] = 'VSL_26_0042';
  row[1] = 'Alphastar';
  row[2] = 'A*';
  row[4] = 'MT TEST VESSEL';
  row[5] = 'V-07';
  row[9] = 'OPEN';
  row[10] = 'Matthew';
  row[14] = 'USD 12,000';
  row[15] = '250';
  row[16] = 'NOR +6';
  row[17] = 'Operational remark';
  row[20] = 'Lubuk Gaung, ID';
  row[21] = 'Load';
  row[22] = 'SPC';
  row[23] = 'A*';
  row[24] = '3,500';
  row[25] = 'PFAD';
  row[26] = 'OPEN';
  row[27] = '10 Aug - 20 Aug';
  row[29] = '12 Aug';
  row[179] = 'Awaiting signed SOF.';
  row[180] = 'TRUE';
  row[181] = 'TRUE';
  row[182] = 'TRUE';
  return {
    rows: [[], row],
    sheetRows: [42],
    columns,
    updatedAt: '2026-10-19T01:00:00.000Z',
  };
}

test('builds vessel cards using the real source row and final DB6 column', () => {
  const result = buildDemurrageRecords(snapshot());
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].row, 42);
  assert.equal(result.records[0].vslId, 'VSL_26_0042');
  assert.equal(result.records[0].demurrageRecords, 'Awaiting signed SOF.');
  assert.equal(result.records[0].demurrageStatus, true);
  assert.equal(result.records[0].showDemurrage, true);
  assert.equal(result.records[0].nilDemurrage, true);
  assert.deepEqual(result.records[0].cargos, ['PFAD']);
  assert.deepEqual(result.records[0].loadports, ['Lubuk Gaung, ID']);
  assert.equal(result.records[0].ports[0].rotation, 1);
  assert.equal(result.demurrageRecordsColumn, 179);
  assert.equal(result.demurrageStatusColumn, 180);
  assert.equal(result.showColumn, 181);
  assert.equal(result.nilDemurrageColumn, 182);
});

test('looks up a vessel by source sheet row rather than array position', () => {
  const data = snapshot();
  assert.equal(findRecordAtSheetRow(data, 42)[0], 'VSL_26_0042');
  assert.equal(findRecordAtSheetRow(data, 2), null);
});

test('fails clearly when the Demurrage Records header is absent', () => {
  const data = snapshot();
  data.columns[179] = 'different_column';
  assert.throws(() => buildDemurrageRecords(data), /missing the Demurrage Records column/);
});

test('fails clearly when the Demurrage Status header is absent', () => {
  const data = snapshot();
  data.columns[180] = 'different_column';
  assert.throws(() => buildDemurrageRecords(data), /missing the Demurrage Status column/);
});

test('fails clearly when the Show header is absent', () => {
  const data = snapshot();
  data.columns[181] = 'different_column';
  assert.throws(() => buildDemurrageRecords(data), /missing the Show column/);
});

test('fails clearly when the Nil Demurrage header is absent', () => {
  const data = snapshot();
  data.columns[182] = 'different_column';
  assert.throws(() => buildDemurrageRecords(data), /missing the Nil Demurrage column/);
});

test('neutralizes formula-like records before USER_ENTERED sheet writes', () => {
  assert.equal(spreadsheetSafeText('=IMPORTXML("https://example.com")'), '\'=IMPORTXML("https://example.com")');
  assert.equal(spreadsheetSafeText('  +1+1'), "'  +1+1");
  assert.equal(spreadsheetSafeText('NOR tendered at 08:00'), 'NOR tendered at 08:00');
});
