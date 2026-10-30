'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVesselSlots } = require('../routes/vesselSlots');
const { buildVesselList, getValidLoadSlotIds } = require('../services/vesselUpdate');

function portBlock(row, index, values) {
  const base = 19 + index * 16;
  row[base] = values.vslid;
  row[base + 1] = values.port;
  row[base + 2] = values.statusLd;
  row[base + 3] = values.shipper || '';
  row[base + 5] = values.qty || '';
  row[base + 6] = values.cargo || '';
}

test('vessel matching exposes only named load ports', () => {
  const row = [];
  row[2] = 'A*';
  row[4] = 'MT TEST';
  portBlock(row, 0, { vslid: 'VSL_26_0001_1', port: 'Bontang, ID', statusLd: 'Load', shipper: 'EUP', qty: '5000', cargo: 'ROL' });
  portBlock(row, 1, { vslid: 'VSL_26_0001_2', port: 'Manila, PH', statusLd: 'Discharge' });
  portBlock(row, 2, { vslid: 'VSL_26_0001_3', port: '', statusLd: 'Load' });

  const vessels = buildVesselSlots([[], row]);
  assert.equal(vessels.length, 1);
  assert.deepEqual(vessels[0].slots.map(slot => slot.vslid), ['VSL_26_0001_1']);
  assert.equal(vessels[0].slots[0].loadport, 'Bontang, ID');
  assert.deepEqual([...getValidLoadSlotIds([[], row])], ['vsl_26_0001_1']);
});

test('vessel update exposes charterer and individual port entity', () => {
  const row = [];
  row[0] = 'VSL_26_0002';
  row[1] = 'KPN';
  row[2] = 'A*';
  row[4] = 'MT ENTITY TEST';
  row[9] = 'OPEN';
  portBlock(row, 0, { vslid: 'VSL_26_0002_1', port: 'Bontang, ID', statusLd: 'Load', shipper: 'EUP', qty: '3500', cargo: 'ROL' });
  row[23] = 'GR';

  const result = buildVesselList([[], row]);
  assert.equal(result.vessels[0].charterer, 'KPN');
  assert.equal(result.vessels[0].ports[0].port_entity, 'GR');
  assert.deepEqual(result.options.charterers, ['KPN']);
  assert.deepEqual(result.options.entities, ['A*', 'GR']);
});
