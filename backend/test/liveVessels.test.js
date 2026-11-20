'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLiveVesselsFromRows, parseCoordinate, validLatLng } = require('../services/liveVessels');
const { PORT_COL_BASE, PORT_COL_STRIDE, PORT_OFF, VESSEL_COL } = require('../services/vesselUpdate');

function vesselRow(values = {}) {
  const row = [];
  row[VESSEL_COL.vsl_id] = values.vslId || 'vsl_26_0200';
  row[VESSEL_COL.entity] = values.entity || 'GR';
  row[VESSEL_COL.vessel] = values.vessel || 'MT TEST VOYAGE';
  row[VESSEL_COL.imo] = values.imo || '';
  row[VESSEL_COL.mmsi] = values.mmsi || '';
  row[VESSEL_COL.status] = values.status || 'OPEN';
  row[VESSEL_COL.ops] = values.operations || '';
  row[VESSEL_COL.latitude] = values.latitude ?? '';
  row[VESSEL_COL.longitude] = values.longitude ?? '';
  return row;
}

function setPort(row, slot, values) {
  const base = PORT_COL_BASE + slot * PORT_COL_STRIDE;
  row[base + PORT_OFF.vslid] = values.vslId || '';
  row[base + PORT_OFF.port_name] = values.name || '';
  row[base + PORT_OFF.status_ld] = values.movement || '';
  row[base + PORT_OFF.shipper] = values.shipper || '';
  row[base + PORT_OFF.qty] = values.quantity || '';
  row[base + PORT_OFF.l_cargo] = values.cargo || '';
  row[base + PORT_OFF.laycan] = values.laycan || '';
  row[base + PORT_OFF.cr] = values.cr || '';
  row[base + PORT_OFF.eta] = values.eta || '';
  row[base + PORT_OFF.eta_time] = values.etaTime || '';
  row[base + PORT_OFF.etb] = values.etb || '';
  row[base + PORT_OFF.etb_time] = values.etbTime || '';
  row[base + PORT_OFF.etc] = values.etc || '';
  row[base + PORT_OFF.etc_time] = values.etcTime || '';
}

test('includes every open shipment even when tracking data is unavailable', () => {
  const imo = vesselRow({ vessel: 'MT IMO', imo: '9412725' });
  const mmsi = vesselRow({ vessel: 'MT MMSI', mmsi: '563123456' });
  const coordinates = vesselRow({ vessel: 'MT POSITION', latitude: '1.2345 N', longitude: '103.4567 E' });
  const tbn = vesselRow({ vessel: 'TBN (FOB)' });
  const namedNoIdentifier = vesselRow({ vessel: 'MT NO ID' });
  const closed = vesselRow({ vessel: 'MT CLOSED', imo: '9340582', status: 'CLOSED' });

  const result = buildLiveVesselsFromRows([[], imo, mmsi, coordinates, tbn, namedNoIdentifier, closed]);

  assert.deepEqual(result.vessels.map(vessel => vessel.vessel), ['MT IMO', 'MT MMSI', 'MT NO ID', 'MT POSITION', 'TBN (FOB)']);
  assert.equal(result.vessels[3].latitude, 1.2345);
  assert.equal(result.vessels[3].longitude, 103.4567);
  assert.equal(result.vessels[4].isTbn, true);
  assert.equal(result.vessels[4].hasTrackingId, false);
  assert.deepEqual(result.counts, {
    open: 5,
    listed: 5,
    trackable: 3,
    positioned: 1,
    missingCoordinates: 4,
  });
});

test('parses decimal and DMS coordinates while rejecting invalid positions', () => {
  assert.equal(parseCoordinate('1 14 4 N'), 1 + (14 / 60) + (4 / 3600));
  assert.equal(parseCoordinate('103 deg 51 22 E'), 103 + (51 / 60) + (22 / 3600));
  assert.equal(parseCoordinate('6.125 S'), -6.125);
  assert.equal(parseCoordinate('1,2345 N'), 1.2345);
  assert.equal(parseCoordinate('106.845 W'), -106.845);
  assert.equal(validLatLng(1.25, 103.5), true);
  assert.equal(validLatLng(91, 103.5), false);
  assert.equal(validLatLng(1.25, 181), false);
});

test('deduplicates ports while preserving first sequential occurrence', () => {
  const row = vesselRow({ imo: '9412725' });
  setPort(row, 0, {
    vslId: 'vsl_26_0200_1', name: 'Bontang, ID', movement: 'Load', quantity: '3000', cargo: 'POMEFAD',
    laycan: '10 Oct - 15 Oct', cr: '10 Oct', eta: '11 Oct', etaTime: '08:30',
    etb: '12 Oct', etbTime: '00:00', etc: '13 Oct', etcTime: '12:00 AM',
  });
  setPort(row, 1, { name: ' bontang, id ', movement: 'Load', etb: '12 Oct' });
  setPort(row, 2, { name: 'Kandla, IN', movement: 'Discharge', etb: '24 Oct' });

  const result = buildLiveVesselsFromRows([[], row]);
  const vessel = result.vessels[0];

  assert.deepEqual(vessel.ports.map(port => port.name), ['Bontang, ID', 'Kandla, IN']);
  assert.equal(vessel.ports[0].vslId, 'vsl_26_0200_1');
  assert.equal(vessel.ports[0].scheduleType, 'ETA');
  assert.equal(vessel.ports[0].schedule, '11 Oct 08:30');
  assert.equal(vessel.direction, 'Kandla, IN');
  assert.equal(vessel.laycan, '10 Oct - 15 Oct');
  assert.equal(vessel.cargo, '3000 POMEFAD');
  assert.equal(vessel.cargoReadiness, '10 Oct');
  assert.equal(vessel.eta, '11 Oct 08:30');
  assert.equal(vessel.etb, '12 Oct');
  assert.equal(vessel.etc, '13 Oct');
});

test('uses ETB, ETC and laycan as sequential date fallbacks', () => {
  const row = vesselRow({ mmsi: '563123456' });
  setPort(row, 0, { name: 'Port A', movement: 'Load', etb: '12 Oct' });
  setPort(row, 1, { name: 'Port B', movement: 'Discharge', etc: '18 Oct' });
  setPort(row, 2, { name: 'Port C', movement: 'Discharge', laycan: '20 Oct - 22 Oct' });

  const vessel = buildLiveVesselsFromRows([[], row]).vessels[0];

  assert.deepEqual(vessel.ports.map(port => [port.scheduleType, port.schedule]), [
    ['ETB', '12 Oct'],
    ['ETC', '18 Oct'],
    ['LAYCAN', '20 Oct - 22 Oct'],
  ]);
});
