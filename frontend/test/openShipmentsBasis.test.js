import test from 'node:test';
import assert from 'node:assert/strict';
import { getShipmentBasis } from '../src/pages/commercial/openShipmentsBasis.js';

test('classifies a vessel with an FOB discharge as FOB', () => {
  assert.equal(getShipmentBasis({ dischargePorts: [{ port: 'FOB' }] }), 'FOB');
  assert.equal(getShipmentBasis({ dischargePorts: [{ port: 'Fujairah, UAE' }, { port: ' fob ' }] }), 'FOB');
});

test('classifies all other vessels as CIF', () => {
  assert.equal(getShipmentBasis({ dischargePorts: [{ port: 'Kandla, IN' }] }), 'CIF');
  assert.equal(getShipmentBasis({ dischargePorts: [] }), 'CIF');
  assert.equal(getShipmentBasis({}), 'CIF');
});
