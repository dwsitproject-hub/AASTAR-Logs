'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVesselMap } = require('../vesselMap');

test('keeps an open vessel with IMO or MMSI even when coordinates are blank', () => {
  const row = [];
  row[0] = 'vsl_26_0122';
  row[2] = 'GR';
  row[4] = 'MT MTM ROTTERDAM';
  row[7] = '9477567';
  row[8] = '563233600';
  row[9] = 'OPEN';

  const result = buildVesselMap([[], row]);

  assert.equal(result.vessels.length, 1);
  assert.equal(result.vessels[0].vslId, 'vsl_26_0122');
  assert.equal(result.vessels[0].imo, '9477567');
  assert.equal(result.vessels[0].mmsi, '563233600');
  assert.equal(result.vessels[0].hasPosition, false);
  assert.deepEqual(result.counts, { open: 1, trackable: 1, imo: 1, mmsi: 1 });
});

test('excludes open vessels without a valid IMO or MMSI from the sidebar', () => {
  const row = [];
  row[0] = 'vsl_26_0150';
  row[4] = 'tbn';
  row[9] = 'OPEN';

  const result = buildVesselMap([[], row]);

  assert.equal(result.vessels.length, 0);
  assert.deepEqual(result.counts, { open: 1, trackable: 0, imo: 0, mmsi: 0 });
});

test('accepts a valid MMSI when IMO is unavailable and excludes closed vessels', () => {
  const open = [];
  open[0] = 'vsl_26_0200';
  open[4] = 'MT MMSI ONLY';
  open[8] = '563123456';
  open[9] = 'OPEN';

  const closed = [];
  closed[0] = 'vsl_26_0201';
  closed[4] = 'MT CLOSED';
  closed[7] = '9340582';
  closed[9] = 'CLOSED';

  const result = buildVesselMap([[], open, closed]);

  assert.equal(result.vessels.length, 1);
  assert.equal(result.vessels[0].imo, '');
  assert.equal(result.vessels[0].mmsi, '563123456');
  assert.deepEqual(result.counts, { open: 1, trackable: 1, imo: 0, mmsi: 1 });
});