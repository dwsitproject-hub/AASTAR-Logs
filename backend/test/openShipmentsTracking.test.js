const assert = require('node:assert/strict');
const test = require('node:test');

const { buildVesselContract } = require('../services/vesselContract');

function makeMatchingRow() {
  const row = Array(36).fill('');
  row[2] = 'VSL_26_0999_1';
  row[3] = 'OPEN';
  row[4] = 'MT TRACKING TEST';
  row[5] = 'Batam, ID';
  row[14] = 'CPO';
  row[16] = '1000';
  row[27] = 'SALES';
  return row;
}

function makeVesselRow() {
  const row = Array(180).fill('');
  row[0] = 'vsl_26_0999';
  row[2] = 'GR';
  row[4] = 'MT TRACKING TEST';
  row[7] = '9412725';
  row[8] = '563095700';
  row[9] = 'OPEN';
  row[19] = 'VSL_26_0999_1';
  row[20] = 'Batam, ID';
  row[21] = 'Load';
  row[22] = 'EUP';
  row[24] = 1000;
  row[25] = 'CPO';
  return row;
}

test('Open Shipments rows retain DB6 IMO and MMSI identifiers', () => {
  const result = buildVesselContract([[], makeMatchingRow()], [[], makeVesselRow()]);
  assert.ok(result.rows.length > 0);
  assert.equal(result.rows[0].imo, '9412725');
  assert.equal(result.rows[0].mmsi, '563095700');
});
