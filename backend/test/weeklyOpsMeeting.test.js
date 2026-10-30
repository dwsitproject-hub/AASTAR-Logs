'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLocalDeliveries,
  buildEvac,
  buildExports,
  checkbox,
  displayDate,
} = require('../services/weeklyOpsMeeting');
const { DATA_DATABASES } = require('../config/dataSources');

test('sheet booleans and serial dates are normalized', () => {
  assert.equal(checkbox('TRUE'), true);
  assert.equal(checkbox('false'), false);
  assert.equal(displayDate('46263'), '29 Aug');
});

test('local deliveries include only open purchase and sales rows', () => {
  const purchase = [{ no: 'P1', status: 'Open', payment: 'true', seller_buyer: 'Seller', quantity: '2000', performed: '1551.21', balance: '448.79' }];
  const sales = [{ no: 'S1', status: 'Closed', seller_buyer: 'Buyer' }];
  const rows = buildLocalDeliveries(purchase, sales);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'P1');
  assert.equal(rows[0].side, 'Purchase');
  assert.equal(rows[0].paymentStatus, true);
});

test('evac includes only open shipment rows', () => {
  const rows = buildEvac([
    { no: 'I1', status: 'Open', eta_ata: '46263', vessel: 'MT DAEHO SUNNY' },
    { no: 'I2', status: 'Closed', vessel: 'MT OLD' },
  ]);
  assert.deepEqual(rows.map(row => row.id), ['I1']);
  assert.equal(rows[0].etaAta, '29 Aug');
  assert.equal(rows[0].bookedQty, null);
});

test('exports split TPG from EUP and PMC, then stage GR contracts', () => {
  const rows = [
    { main_ref: 'GSP_1', main_cargo: 'RPOME', main_status: 'CLOSED', main_bl_date: '46248', main_vsl_id_2: 'VSL_1' },
    { main_ref: 'GSP_2', main_cargo: 'FAME', main_status: 'OPEN', main_shpt_period_start: '2026-08-25', main_shpt_period_end: '2026-09-15', main_vsl_id_2: 'VSL_2' },
    { main_ref: 'GSP_3', main_cargo: 'PFAD', main_sd_type: 'ISCC', main_quantity: '5000', main_partial: 'PARTIAL', main_partial_qty: '1500', main_status: 'OPEN', main_shpt_period_start: '2026-09-01', main_shpt_period_end: '2026-09-20', main_vsl_id_2: 'VSL_3' },
    { main_ref: 'GSP_4', main_cargo: 'RPOME', main_status: 'OPEN', main_shpt_period_start: '2026-08-20', main_shpt_period_end: '2026-09-20', main_vsl_id_2: 'VSL_4', main_payment_status: 'true', main_ctr: 'true', main_vsl_nom: 'true', main_si_2: 'true', main_sd_status: 'true' },
    { main_ref: 'GSP_5', main_cargo: 'CPO', main_status: 'OPEN', main_shpt_period_start: '2026-08-26', main_shpt_period_end: '2026-09-20', main_vsl_id_2: 'VSL_5' },
  ];
  const vessel = { vessel: 'MT TEST', ports: [] };
  const lookup = {
    byVslId: new Map([
      ['VSL1', { vessel, port: { shipper: 'EUP', port_name: 'Tanjung Pura, ID' } }],
      ['VSL2', { vessel, port: { shipper: 'TPG', port_name: 'Pasir Gudang, MY' } }],
      ['VSL3', { vessel, port: { shipper: 'PMC', port_name: 'Lubuk Gaung, ID', qty: '3000', l_cargo: 'POMEFAD' } }],
      ['VSL4', { vessel, port: { shipper: 'EUP', port_name: 'Tanjung Pura, ID' } }],
      ['VSL5', { vessel, port: { shipper: 'GLM', port_name: 'Lahad Datu, MY', l_cargo: 'CPO' } }],
    ]),
    byVessel: new Map(),
  };
  const result = buildExports(rows, lookup, new Date('2026-08-25T00:00:00Z'));
  assert.deepEqual(result.gr.executed.map(row => row.id), ['GSP_1']);
  assert.deepEqual(result.tpgGlm.map(row => [row.id, row.stage]), [['GSP_2', 'open'], ['GSP_5', 'upcoming']]);
  assert.strictEqual(result.tpg, result.tpgGlm);
  assert.deepEqual(result.gr.upcoming.map(row => row.id), ['GSP_3']);
  assert.equal(result.gr.upcoming[0].cargoSummary, '1,500mts ISCC POMEFAD');
  assert.equal(result.gr.upcoming[0].contractQuantity, 5000);
  assert.equal(result.gr.upcoming[0].isPartialShipment, true);
  assert.equal(result.gr.upcoming[0].partialQuantity, 1500);
  assert.equal(result.gr.upcoming[0].shipmentQuantity, 1500);
  assert.equal(JSON.stringify(result).includes('GSP_4'), false);
});

test('exports do not substitute contract cargo when Vessel DB cargo is blank', () => {
  const rows = [{
    main_ref: 'GSP_5', main_cargo: 'RPOME', main_quantity: '2000', main_partial_qty: '2000',
    main_status: 'OPEN', main_shpt_period_start: '2026-08-20', main_shpt_period_end: '2026-09-20', main_vsl_id_2: 'VSL_5',
  }];
  const vessel = { vessel: 'MT TEST', ports: [] };
  const lookup = {
    byVslId: new Map([['VSL5', { vessel, port: { shipper: 'TPG', port_name: 'Pasir Gudang, MY', l_cargo: '' } }]]),
    byVessel: new Map(),
  };
  const result = buildExports(rows, lookup, new Date('2026-08-25T00:00:00Z'));
  assert.equal(result.tpgGlm[0].cargo, '');
  assert.equal(result.tpg[0].cargoSummary, '2,000mts');
  assert.equal(result.tpg[0].contractQuantity, 2000);
  assert.equal(result.tpg[0].isPartialShipment, false);
  assert.equal(result.tpg[0].partialQuantity, null);
  assert.equal(result.tpg[0].shipmentQuantity, 2000);
});

test('GLM operations tabs are configured as independent databases', () => {
  const databases = new Map(DATA_DATABASES.map(database => [database.name, database]));
  assert.deepEqual(
    ['DB15', 'DB16', 'DB17'].map(name => ({
      name,
      tab: databases.get(name)?.sources?.[0]?.tab,
      range: databases.get(name)?.sources?.[0]?.range,
    })),
    [
      { name: 'DB15', tab: 'GLM IMPORTS', range: 'A:L' },
      { name: 'DB16', tab: 'GLM LOCAL PURCHASE', range: 'A:AM' },
      { name: 'DB17', tab: 'GLM LOCAL SALES', range: 'A:AD' },
    ],
  );
});
