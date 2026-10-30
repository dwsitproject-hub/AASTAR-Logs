'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExportSummary,
  calculateDemmDays,
  calculateEstDemmurage,
  resolveEntryMonth,
} = require('../services/exportSummary');

const PORT_BASE = 20;

function vesselRow({ vessel, vesselMonth, laycan, charterer = 'AlphaStar', vesselSize = '', demmRate = '' }) {
  const row = [];
  row[1] = charterer;
  row[2] = 'A*';
  row[3] = vesselMonth;
  row[4] = vessel;
  row[10] = vesselSize;
  row[14] = demmRate;
  row[PORT_BASE] = 'Tanjung Pura, ID';
  row[PORT_BASE + 1] = 'Load';
  row[PORT_BASE + 2] = 'EUP';
  row[PORT_BASE + 4] = 1000;
  row[PORT_BASE + 5] = 'RPOME';
  row[PORT_BASE + 7] = laycan;
  return row;
}

test('includes charterer and vessel size while keeping PDPR out of each rate value', () => {
  const data = [
    [],
    vesselRow({ vessel: 'MT RATE TEST', vesselMonth: 'September 2026', laycan: '10 Sep - 20 Sep', charterer: 'AlphaStar', vesselSize: '10500', demmRate: '5000' }),
  ];

  const summary = buildExportSummary(data, [], { now: new Date(2026, 8, 2) });
  const row = summary.monthlyData.find(month => month.label === 'September 2026').primarySections[0].rows[0];

  assert.equal(row.charterer, 'AlphaStar');
  assert.equal(row.vesselSize, 10500);
  assert.equal(row.demmurage, 'USD 5,000');
});

function vesselsForMonth(summary, label) {
  const month = summary.monthlyData.find(item => item.label === label);
  return (month?.primarySections || []).flatMap(section => section.rows).map(row => row.vessel);
}

test('Laycan month takes precedence over the vessel month', () => {
  const data = [
    [],
    vesselRow({ vessel: 'VT QUEEN', vesselMonth: 'August 2026', laycan: '10 Sep - 20 Sep' }),
    vesselRow({ vessel: 'MT FALLBACK', vesselMonth: 'August 2026', laycan: '' }),
  ];
  const summary = buildExportSummary(data, [], { now: new Date(2026, 8, 2) });

  assert.deepEqual(vesselsForMonth(summary, 'August 2026'), ['MT FALLBACK']);
  assert.deepEqual(vesselsForMonth(summary, 'September 2026'), ['VT QUEEN']);
});

test('month-only Laycan inherits the vessel year and handles year rollover', () => {
  assert.deepEqual(resolveEntryMonth('Sep', { month: 7, year: 2026 }, new Date(2026, 8, 2)), { month: 8, year: 2026 });
  assert.deepEqual(resolveEntryMonth('Jan', { month: 11, year: 2026 }, new Date(2026, 11, 2)), { month: 0, year: 2027 });
  assert.deepEqual(resolveEntryMonth('07 AUG 11 AUG', { month: 7, year: 2026 }, new Date(2026, 8, 2)), { month: 7, year: 2026 });
});

test('history mode returns every populated month with stable period metadata', () => {
  const data = [
    [],
    vesselRow({ vessel: 'MT JANUARY', vesselMonth: 'January 2025', laycan: '10 Jan - 20 Jan' }),
    vesselRow({ vessel: 'MT AUGUST', vesselMonth: 'August 2026', laycan: '10 Aug - 20 Aug' }),
    vesselRow({ vessel: 'MT SEPTEMBER', vesselMonth: 'September 2026', laycan: '10 Sep - 20 Sep' }),
  ];

  const history = buildExportSummary(data, [], { now: new Date(2026, 8, 2), allMonths: true });
  assert.deepEqual(history.monthlyData.map(month => month.key), ['2025-01', '2026-08', '2026-09']);
  assert.deepEqual(history.monthlyData.map(month => month.month), [1, 8, 9]);
  assert.deepEqual(history.availableYears, [2026, 2025]);
  assert.deepEqual(vesselsForMonth(history, 'January 2025'), ['MT JANUARY']);

  const standard = buildExportSummary(data, [], { now: new Date(2026, 8, 2) });
  assert.deepEqual(standard.monthlyData.map(month => month.key), ['2026-08', '2026-09', '2026-10']);
  assert.equal(vesselsForMonth(standard, 'January 2025').length, 0);
});

test('NOR+6 starts from ETA plus six hours when ETA is later than laycan', () => {
  const item = {
    laytimeStarts: 'NOR+6',
    laytimeRateRaw: 100,
    demmRateRaw: 12000,
    laycanRaw: '10 Sep - 20 Sep',
    laycanYear: 2026,
    etaRaw: '12 Sep 2026',
    etaTimeRaw: '06:00',
    etcRaw: '14 Sep 2026',
    etcTimeRaw: '18:00',
  };

  assert.equal(calculateDemmDays(2400, item), 1.25);
  assert.equal(calculateEstDemmurage(2400, item), 'USD 15,000');
});

test('NOR+6 starts from laycan when ETA is earlier than laycan', () => {
  const item = {
    laytimeStarts: 'NOR+6',
    laytimeRateRaw: 100,
    demmRateRaw: 12000,
    laycanRaw: '10 Sep - 20 Sep',
    laycanYear: 2026,
    etaRaw: '08 Sep 2026',
    etaTimeRaw: '06:00',
    etcRaw: '12 Sep 2026',
    etcTimeRaw: '12:00',
  };

  assert.equal(calculateDemmDays(2400, item), 1.5);
  assert.equal(calculateEstDemmurage(2400, item), 'USD 18,000');
});

test('NOR+6 does not produce demurrage when used time is within allowed laytime', () => {
  const item = {
    laytimeStarts: 'NOR+6',
    laytimeRateRaw: 100,
    demmRateRaw: 12000,
    laycanRaw: '10 Sep - 20 Sep',
    laycanYear: 2026,
    etaRaw: '08 Sep 2026',
    etaTimeRaw: '06:00',
    etcRaw: '10 Sep 2026',
    etcTimeRaw: '12:00',
  };

  assert.equal(calculateDemmDays(2400, item), 0);
  assert.equal(calculateEstDemmurage(2400, item), '');
});
