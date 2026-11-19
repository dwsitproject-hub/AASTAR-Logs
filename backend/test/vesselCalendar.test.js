'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVesselCalendar, parseDisplayDate } = require('../services/vesselCalendar');

test('parseDisplayDate follows the vessel month across year boundaries', () => {
  assert.equal(parseDisplayDate('4 Dec', 'Nov 2026'), '2026-12-04');
  assert.equal(parseDisplayDate('30 Dec', 'Jan 2027'), '2026-12-30');
  assert.equal(parseDisplayDate('2 Jan', 'Dec 2026'), '2027-01-02');
});

test('calendar uses ETA first, Cargo Readiness as fallback, and retains closed vessels', () => {
  const vesselStatus = {
    updatedAt: '2026-10-27T01:00:00.000Z',
    details: [
      { id: '1', status: 'OPEN' },
      { id: '2', status: 'OPEN' },
      {
        id: '3',
        rowId: 3,
        vslId: 'vsl_3',
        vessel: 'MT CLOSED',
        entity: 'GR',
        month: 'Oct 2026',
        status: 'CLOSED',
        loadports: [{ slot: 1, port: 'Bontang, ID', shipper: 'EUP', cargo: 'CG', quantity: 3000, status: 'CLOSED', eta: '30 Oct', cargoReadiness: '' }],
      },
      {
        id: '4',
        rowId: 4,
        vslId: 'vsl_4',
        vessel: 'MT HISTORIC CLOSED',
        entity: 'GR',
        month: 'Jun 2026',
        status: 'CLOSED',
        loadports: [{ slot: 1, port: 'Bontang, ID', shipper: 'EUP', cargo: 'ROL', quantity: 500, status: 'CLOSED', eta: '1 Jun', cargoReadiness: '' }],
      },
    ],
    vessels: [
      { detailId: '1', vslId: 'vsl_1', vessel: 'MT ETA', shipper: 'EUP', port: 'Bontang, ID', cargo: 'ROL', quantity: 1000, month: 'Oct 2026', eta: '29 Oct', cargoReadiness: '27 Oct' },
      { detailId: '2', vslId: 'vsl_2', vessel: 'TBN', shipper: 'EUP', port: 'Bontang, ID', cargo: 'PFAD', quantity: 2000, month: 'Nov 2026', eta: '', cargoReadiness: '4 Dec' },
    ],
  };
  const stock = {
    updatedAt: '2026-10-27T02:00:00.000Z',
    ports: [{
      name: 'EUP Bontang, ID',
      cargoes: ['ROL', 'PFAD'],
      dates: ['2026-10-27', '2026-10-28'],
      series: { ROL: [500, 600], PFAD: [100, 90] },
    }],
  };

  const result = buildVesselCalendar(vesselStatus, stock);
  const factory = result.factories.find(item => item.id === 'eup-bontang');

  assert.equal(factory.vessels.length, 4);
  assert.deepEqual(factory.vessels.map(vessel => [vessel.vessel, vessel.scheduleDate, vessel.scheduleSource, vessel.isClosed]), [
    ['MT HISTORIC CLOSED', '2026-06-01', 'ETA', true],
    ['MT ETA', '2026-10-29', 'ETA', false],
    ['MT CLOSED', '2026-10-30', 'ETA', true],
    ['TBN', '2026-12-04', 'CR', false],
  ]);
  assert.deepEqual(result.dateRange, { start: '2026-10-27', end: '2026-12-04' });
  assert.equal(factory.cargoes[0].values[1].value, 600);
  assert.equal(result.updatedAt, stock.updatedAt);
});

test('calendar sums a vessel cargoes at one factory and calculates its loading span', () => {
  const result = buildVesselCalendar({
    details: [{ id: '10', status: 'OPEN' }],
    vessels: [
      { detailId: '10', vslId: 'vsl_10_1', vessel: 'MT TWO CARGOES', shipper: 'EUP', port: 'Bontang, ID', cargo: 'ROL', quantity: '3,000', month: 'Nov 2026', eta: '2 Nov' },
      { detailId: '10', vslId: 'vsl_10_2', vessel: 'MT TWO CARGOES', shipper: 'EUP', port: 'Bontang, ID', cargo: 'PFAD', quantity: 6000, month: 'Nov 2026', eta: '2 Nov' },
    ],
  }, {
    ports: [{ name: 'EUP Bontang, ID', cargoes: ['ROL', 'PFAD'], dates: [], series: {} }],
  });

  const events = result.factories.find(item => item.id === 'eup-bontang').vessels;
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.totalLoadingQuantity, 9000);
    assert.equal(event.loadingHours, 36);
    assert.equal(event.loadingDays, 1.5);
    assert.equal(event.loadingPlotDays, 1.5);
    assert.equal(event.loadingCalendarDays, 2);
  }
  assert.deepEqual(result.dateRange, { start: '2026-11-02', end: '2026-11-03' });
});

test('calendar rounds short loading periods up to quarter-day blocks', () => {
  const result = buildVesselCalendar({
    details: [{ id: '20', status: 'OPEN' }],
    vessels: [
      { detailId: '20', vslId: 'vsl_20_1', vessel: 'MT SHORT LOAD', shipper: 'EUP', port: 'Bontang, ID', cargo: 'ROL', quantity: 1000, month: 'Nov 2026', eta: '5 Nov' },
    ],
  }, { ports: [] });

  const event = result.factories.find(item => item.id === 'eup-bontang').vessels[0];
  assert.equal(event.loadingHours, 4);
  assert.equal(event.loadingPlotDays, 0.25);
  assert.equal(event.loadingCalendarDays, 1);
});
