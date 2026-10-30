'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../services/vesselMatching');

const { materializePartialChild } = __test;

test('materializes a merged GR partial child when the Shadow helper has no final row', () => {
  const definition = {
    rowColumn: '_main_row',
    partialField: 'main_partial',
    matchIdField: 'main_erp_match_id',
    refField: 'main_ref',
    mergeAnchorField: 'main_contract_no',
  };
  const previousRecord = {
    _main_row: '191', main_partial: 'PARTIAL', main_erp_match_id: 'parent-id',
    main_ref: 'AKP_118', main_contract_no: 'GPS26-118',
  };
  const record = {
    _main_row: '192', main_partial: 'PARTIAL', main_erp_match_id: 'child-id',
    main_ref: '', main_contract_no: '',
  };
  const previousRow = {
    _row: 191, ref: 'AKP_118', contract_no: 'GPS26-118', buyer: 'Buyer', qty: '6000',
    cargo: 'RPOME', intention_vessel: 'MT PARENT', vsl_id: 'VSL_26_0100_1',
    source_vsl_id: 'VSL_26_0100_1', match_id: 'parent-id', partial: 'PARTIAL', partial_qty: '3500',
  };
  const row = {
    _row: 192, ref: '', contract_no: '', buyer: '', qty: '', cargo: '', intention_vessel: '',
    vsl_id: '', source_vsl_id: '', match_id: 'child-id', partial: 'PARTIAL', partial_qty: '0',
  };

  assert.equal(materializePartialChild(row, record, previousRow, previousRecord, definition), true);
  assert.equal(row._partialChild, true);
  assert.equal(row.contract_no, 'GPS26-118');
  assert.equal(row.buyer, 'Buyer');
  assert.equal(row.qty, '6000');
  assert.equal(row.cargo, 'RPOME');
  assert.equal(row.ref, '');
  assert.equal(row.intention_vessel, '');
  assert.equal(row.vsl_id, '');
  assert.equal(row.match_id, 'child-id');
  assert.equal(row.partial_qty, '0');
});

test('does not attach an unrelated GR partial row to the previous contract', () => {
  const definition = {
    rowColumn: '_main_row', partialField: 'main_partial', matchIdField: 'main_erp_match_id',
    refField: 'main_ref', mergeAnchorField: 'main_contract_no',
  };
  const previousRecord = { _main_row: '191', main_partial: 'PARTIAL', main_contract_no: 'GPS26-118' };
  const record = {
    _main_row: '192', main_partial: 'PARTIAL', main_erp_match_id: 'other-id',
    main_ref: 'AKP_119', main_contract_no: 'GPS26-119',
  };
  const row = { _row: 192, ref: 'AKP_119', contract_no: 'GPS26-119', partial: 'PARTIAL', match_id: 'other-id' };

  assert.equal(materializePartialChild(row, record, { contract_no: 'GPS26-118' }, previousRecord, definition), false);
  assert.equal(row._partialChild, undefined);
  assert.equal(row.contract_no, 'GPS26-119');
});

test('materializes a standard Aastar or Kimara final-row partial child', () => {
  const definition = {
    rowColumn: '_sales_row', partialField: 'sales_partial', matchIdField: 'sales_erp_match_id',
    refField: 'sales_ref',
  };
  const previousRecord = { _sales_row: '500', sales_partial: 'PARTIAL', sales_erp_match_id: 'parent-id' };
  const record = { _sales_row: '501', sales_partial: 'PARTIAL', sales_erp_match_id: 'child-id' };
  const previousRow = { _row: 500, contract_no: 'APS26-500', buyer: 'Buyer', qty: '2000', partial: 'PARTIAL' };
  const row = { _row: 501, contract_no: '', buyer: '', qty: '', match_id: 'child-id', partial: 'PARTIAL', partial_qty: '0' };

  assert.equal(materializePartialChild(row, record, previousRow, previousRecord, definition), true);
  assert.equal(row.contract_no, 'APS26-500');
  assert.equal(row.buyer, 'Buyer');
  assert.equal(row.qty, '2000');
  assert.equal(row.match_id, 'child-id');
});
