'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSubscription,
  extractDigitrafficPosition,
  extractPositionEvent,
  getOpenImoFromRows,
  getOpenMmsiFromRows,
  mergePositionCollections,
} = require('../services/aisStream');
const { VESSEL_COL } = require('../services/vesselUpdate');

function row({ status = 'OPEN', mmsi = '', imo = '' } = {}) {
  const result = [];
  result[VESSEL_COL.status] = status;
  result[VESSEL_COL.mmsi] = mmsi;
  result[VESSEL_COL.imo] = imo;
  return result;
}

test('subscribes only to unique valid identifiers from open DB6 vessels', () => {
  const rows = [
    [],
    row({ mmsi: '563123456', imo: '9412725' }),
    row({ mmsi: '563 123 456', imo: '9412725' }),
    row({ mmsi: '123', imo: '123' }),
    row({ status: 'CLOSED', mmsi: '441222529', imo: '9340582' }),
  ];
  assert.deepEqual(getOpenMmsiFromRows(rows), ['563123456']);
  assert.deepEqual(getOpenImoFromRows(rows), ['9412725']);
});

test('builds the required world subscription without exposing unrelated message types', () => {
  const subscription = buildSubscription('secret', ['563123456', 'bad']);
  assert.deepEqual(subscription.BoundingBoxes, [[[-90, -180], [90, 180]]]);
  assert.deepEqual(subscription.FiltersShipMMSI, ['563123456']);
  assert.deepEqual(subscription.FilterMessageTypes, ['PositionReport']);
  assert.equal(subscription.APIKey, 'secret');
});

test('normalizes AISStream position reports and unavailable navigation values', () => {
  const position = extractPositionEvent({
    MessageType: 'PositionReport',
    MetaData: { MMSI: 563123456, ShipName: 'MT TEST', time_utc: '2026-10-07 10:15:00 +0000 UTC' },
    Message: { PositionReport: { Latitude: 1.234, Longitude: 103.456, Sog: 102.3, Cog: 360, TrueHeading: 511 } },
  }, '2026-10-07T10:15:01.000Z');

  assert.deepEqual(position, {
    mmsi: '563123456',
    imo: '',
    latitude: 1.234,
    longitude: 103.456,
    speedKnots: null,
    courseDegrees: null,
    headingDegrees: null,
    navigationalStatus: null,
    shipName: 'MT TEST',
    callSign: '',
    destination: '',
    source: 'aisstream',
    sourceTimestamp: '2026-10-07 10:15:00 +0000 UTC',
    receivedAt: '2026-10-07T10:15:01.000Z',
  });
});

test('normalizes Digitraffic GeoJSON and enriches it with static vessel metadata', () => {
  const position = extractDigitrafficPosition({
    mmsi: 230123456,
    geometry: { type: 'Point', coordinates: [24.941, 60.173] },
    properties: {
      mmsi: 230123456,
      sog: 12.4,
      cog: 181.2,
      heading: 183,
      navStat: 0,
      timestampExternal: Date.parse('2026-10-08T01:02:03.000Z'),
    },
  }, {
    mmsi: 230123456,
    imo: 9412725,
    name: 'MT FINLAND TEST',
    callSign: 'OJTEST',
    destination: 'HELSINKI',
  }, '2026-10-08T01:02:08.000Z');

  assert.deepEqual(position, {
    mmsi: '230123456',
    imo: '9412725',
    latitude: 60.173,
    longitude: 24.941,
    speedKnots: 12.4,
    courseDegrees: 181.2,
    headingDegrees: 183,
    navigationalStatus: 0,
    shipName: 'MT FINLAND TEST',
    callSign: 'OJTEST',
    destination: 'HELSINKI',
    source: 'digitraffic',
    sourceTimestamp: '2026-10-08T01:02:03.000Z',
    receivedAt: '2026-10-08T01:02:03.000Z',
    fetchedAt: '2026-10-08T01:02:08.000Z',
  });
});

test('keeps the freshest report per MMSI and prefers AISStream on an exact tie', () => {
  const base = { mmsi: '230123456', latitude: 60, longitude: 24 };
  const merged = mergePositionCollections(
    [{ ...base, source: 'digitraffic', receivedAt: '2026-10-08T01:02:03.000Z' }],
    [{ ...base, source: 'aisstream', receivedAt: '2026-10-08T01:02:04.000Z' }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'aisstream');
  assert.equal(merged[0].receivedAt, '2026-10-08T01:02:04.000Z');

  const tied = mergePositionCollections(
    [{ ...base, source: 'digitraffic', receivedAt: '2026-10-08T01:02:04.000Z' }],
    [{ ...base, source: 'aisstream', receivedAt: '2026-10-08T01:02:04.000Z' }],
  );
  assert.equal(tied[0].source, 'aisstream');
});

test('rejects non-position messages and invalid coordinates', () => {
  assert.equal(extractPositionEvent({ MessageType: 'ShipStaticData' }), null);
  assert.equal(extractPositionEvent({
    MessageType: 'PositionReport',
    MetaData: { MMSI: 563123456 },
    Message: { PositionReport: { Latitude: 91, Longitude: 103 } },
  }), null);
  assert.equal(extractDigitrafficPosition({
    mmsi: 230123456,
    geometry: { coordinates: [24, 91] },
    properties: {},
  }), null);
});