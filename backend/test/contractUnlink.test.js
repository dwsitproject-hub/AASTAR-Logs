'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildActiveContractLinks } = require('../services/contractUnlink');

function vesselRow() {
  const row = [];
  row[2] = 'A*';
  row[4] = 'MT CURRENT NAME';
  row[19] = 'VSL_26_0137_1';
  row[20] = 'Tanjung Pura, ID';
  row[22] = 'EUP';
  row[25] = 'ROL';
  return row;
}

test('active contract links are searchable, auditable and resolved through DB6', () => {
  const matching = {
    updatedAt: '2026-09-14T01:00:00.000Z',
    tabs: {
      'AASTAR SALES': { rows: [
        { _row: 12, match_id: 'match-active', ref: 'AS_11', contract_no: 'APS26-297', buyer: 'Buyer A', cargo: 'ROL', qty: '6000', partial: 'PARTIAL', partial_qty: '2300', vsl_id: 'vsl_26_0137_1', intention_vessel: 'OLD NAME' },
        { _row: 13, match_id: 'match-pending', ref: 'AS_12', contract_no: 'APS26-298', vsl_id: '' },
        { _row: 14, match_id: 'match-stale', ref: 'AS_13', contract_no: 'APS26-299', vsl_id: 'VSL_26_0137_1' },
      ] },
      'KIMARA PURCHASE': { rows: [
        { _row: 20, match_id: 'match-inactive', ref: 'KP_19', vsl_id: 'VSL_26_0137_1' },
      ] },
    },
  };
  const ledger = [
    { _sheet_row: '2', match_id: 'match-active', vsl_id: 'VSL_26_0100_1', active: 'TRUE', updated_at: '2026-09-01', updated_by: 'Old' },
    { _sheet_row: '8', match_id: 'match-active', vsl_id: 'VSL_26_0137_1', active: 'TRUE', updated_at: '2026-09-14', updated_by: 'ERP Vessel Matching' },
    { _sheet_row: '9', match_id: 'match-stale', vsl_id: 'VSL_26_0100_1', active: 'TRUE' },
    { _sheet_row: '10', match_id: 'match-inactive', vsl_id: 'VSL_26_0137_1', active: 'FALSE' },
  ];

  const all = buildActiveContractLinks(matching, [[], vesselRow()], ledger);
  assert.equal(all.pagination.total, 1);
  assert.equal(all.rows[0].contractNo, 'APS26-297');
  assert.equal(all.rows[0].vessel, 'MT CURRENT NAME');
  assert.equal(all.rows[0].loadport, 'Tanjung Pura, ID');
  assert.equal(all.rows[0].shipper, 'EUP');
  assert.equal(all.rows[0].qty, '2300');
  assert.equal(all.rows[0].isPartial, true);
  assert.equal(all.rows[0].linkedBy, 'ERP Vessel Matching');
  assert.deepEqual(all.sourceCounts, { 'AASTAR SALES': 1 });
  assert.equal(buildActiveContractLinks(matching, [[], vesselRow()], ledger, { q: 'tanjung pura' }).pagination.total, 1);
  assert.equal(buildActiveContractLinks(matching, [[], vesselRow()], ledger, { q: 'does not exist' }).pagination.total, 0);
});

test('VSL_00_0000 and inactive ledger rows are never offered for unlinking', () => {
  const matching = { tabs: { 'AASTAR SALES': { rows: [
    { _row: 2, match_id: 'dummy', ref: 'AS_1', vsl_id: 'VSL_00_0000' },
    { _row: 3, match_id: 'inactive', ref: 'AS_2', vsl_id: 'VSL_26_0137_1' },
  ] } } };
  const ledger = [
    { _sheet_row: '2', match_id: 'dummy', vsl_id: 'VSL_00_0000', active: 'TRUE' },
    { _sheet_row: '3', match_id: 'inactive', vsl_id: 'VSL_26_0137_1', active: 'FALSE' },
  ];
  assert.equal(buildActiveContractLinks(matching, [[], vesselRow()], ledger).pagination.total, 0);
});

test('preserves the source Match ID casing required by matching row safety checks', () => {
  const matchId = '617b2260-f252-4bb2-9ff4-b8cf6da59baf';
  const matching = { tabs: { 'AASTAR SALES': { rows: [
    { _row: 2789, match_id: matchId, ref: 'AS_2788', contract_no: 'APS26-297', vsl_id: 'VSL_26_0137_1' },
  ] } } };
  const ledger = [
    { _sheet_row: '131', match_id: matchId.toUpperCase(), vsl_id: 'VSL_26_0137_1', active: 'TRUE' },
  ];

  const result = buildActiveContractLinks(matching, [[], vesselRow()], ledger, { q: 'APS26-297' });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.rows[0].matchId, matchId);
});
