'use strict';

const { buildVesselStatusFromDatabase } = require('./vesselStatus');
const stockSummary = require('./stockSummary');

const FACTORIES = [
  { id: 'eup-bontang', label: 'EUP Bontang', shipper: 'EUP', port: 'Bontang, ID', stockPort: 'EUP Bontang, ID' },
  { id: 'eup-pura', label: 'EUP Pura', shipper: 'EUP', port: 'Tanjung Pura, ID', stockPort: 'EUP Tanjung Pura, ID' },
  { id: 'spc-lubuk-gaung', label: 'SPC Lubuk Gaung', shipper: 'SPC', port: 'Lubuk Gaung, ID', stockPort: 'SPC Lubuk Gaung, ID' },
  { id: 'eup-batam', label: 'EUP Batam', shipper: 'EUP', port: 'Batam, ID', stockPort: 'EUP Batam, ID' },
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function text(value) {
  return value == null ? '' : String(value).trim();
}

function normalized(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function numeric(value) {
  const parsed = Number(String(value == null ? '' : value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateIso(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return '';
  return date.toISOString().slice(0, 10);
}

function addIsoDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseDisplayDate(value, monthLabel) {
  const raw = text(value);
  const isoMatch = raw.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) return dateIso(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));

  const match = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(20\d{2}))?/);
  if (!match) return '';
  const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase());
  if (month < 0) return '';

  const anchor = text(monthLabel).match(/^([A-Za-z]{3,9})\s+(20\d{2})$/);
  const anchorMonth = anchor ? MONTHS.indexOf(anchor[1].slice(0, 3).toLowerCase()) : month;
  let year = match[3] ? Number(match[3]) : (anchor ? Number(anchor[2]) : new Date().getUTCFullYear());
  if (!match[3] && anchorMonth >= 0) {
    if (month - anchorMonth > 6) year -= 1;
    else if (anchorMonth - month > 6) year += 1;
  }
  return dateIso(year, month, Number(match[1]));
}

function latestTimestamp(...values) {
  return values.filter(Boolean).sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

function buildFactory(factory, vesselStatus, stockPayload) {
  const stockPort = (stockPayload.ports || []).find(port => normalized(port.name) === normalized(factory.stockPort));
  const detailById = new Map((vesselStatus.details || []).map(detail => [text(detail.id), detail]));
  const scheduled = [];
  const unscheduled = [];
  const seenRows = new Set();
  let eventIndex = 0;

  const addRow = (row, identity = '') => {
    if (normalized(row.shipper) !== normalized(factory.shipper) || normalized(row.port) !== normalized(factory.port)) return;
    const detail = detailById.get(text(row.detailId));
    const rowStatus = text(row.status).toUpperCase();
    const detailStatus = text(detail?.status).toUpperCase();
    const isClosed = rowStatus === 'CLOSED' || detailStatus === 'CLOSED';
    const status = isClosed ? 'CLOSED' : (detailStatus || rowStatus || 'OPEN');
    const rowKey = [row.detailId, row.vslId, row.port, row.shipper, row.cargo, row.quantity]
      .map(normalized).join('|');
    if (seenRows.has(rowKey)) return;
    seenRows.add(rowKey);

    const etaIso = parseDisplayDate(row.eta, row.month);
    const cargoReadinessIso = parseDisplayDate(row.cargoReadiness, row.month);
    const scheduleDate = etaIso || cargoReadinessIso;
    const event = {
      id: `${row.vslId || row.rowId}-${row.port}-${row.cargo}-${identity || eventIndex++}`,
      vesselKey: text(row.detailId) || text(row.vslId) || normalized(row.vessel),
      vslId: row.vslId,
      vessel: row.vessel || 'TBN',
      entity: row.entity,
      cargo: row.cargo,
      quantity: row.quantity,
      scheduleDate,
      scheduleSource: etaIso ? 'ETA' : (cargoReadinessIso ? 'CR' : ''),
      eta: row.eta,
      cargoReadiness: row.cargoReadiness,
      laycan: row.laycan,
      etb: row.etb,
      etc: row.etc,
      remarks: row.remarks,
      status,
      isClosed,
    };
    if (scheduleDate) scheduled.push(event);
    else unscheduled.push(event);
  };

  for (const row of vesselStatus.vessels || []) {
    addRow(row);
  }

  // Vessel Status intentionally omits closed loadports. Rehydrate them from the
  // detail records for this calendar only so other ERP pages keep their behavior.
  for (const detail of vesselStatus.details || []) {
    for (const port of detail.loadports || []) {
      if (text(port.status).toUpperCase() !== 'CLOSED') continue;
      addRow({
        detailId: detail.id,
        rowId: detail.rowId,
        vslId: detail.vslId,
        vessel: detail.vessel,
        entity: detail.entity,
        month: detail.month,
        port: port.port,
        shipper: port.shipper,
        cargo: port.cargo,
        quantity: port.quantity,
        status: port.status,
        laycan: port.laycan,
        cargoReadiness: port.cargoReadiness,
        eta: port.eta,
        etb: port.etb,
        etc: port.etc,
        remarks: detail.remarks,
      }, `closed-${detail.id}-${port.slot}`);
    }
  }

  const loadingQuantityByVessel = new Map();
  for (const event of [...scheduled, ...unscheduled]) {
    loadingQuantityByVessel.set(
      event.vesselKey,
      (loadingQuantityByVessel.get(event.vesselKey) || 0) + numeric(event.quantity),
    );
  }
  for (const event of [...scheduled, ...unscheduled]) {
    const totalLoadingQuantity = loadingQuantityByVessel.get(event.vesselKey) || 0;
    const loadingHours = totalLoadingQuantity / 250;
    const loadingDays = loadingHours / 24;
    const loadingPlotDays = loadingHours > 0 ? Math.max(0.25, Math.ceil(loadingDays * 4) / 4) : 1;
    event.totalLoadingQuantity = totalLoadingQuantity;
    event.loadingHours = loadingHours;
    event.loadingDays = loadingDays;
    event.loadingPlotDays = loadingPlotDays;
    event.loadingCalendarDays = Math.max(1, Math.ceil(loadingPlotDays));
  }

  scheduled.sort((left, right) => left.scheduleDate.localeCompare(right.scheduleDate)
    || left.vessel.localeCompare(right.vessel)
    || left.cargo.localeCompare(right.cargo));

  const cargoes = [];
  const cargoKeys = new Set();
  for (const cargo of stockPort?.cargoes || []) {
    const key = normalized(cargo);
    cargoKeys.add(key);
    cargoes.push({
      name: cargo,
      key,
      values: (stockPort.dates || []).map((date, index) => ({
        date,
        value: stockPort.series?.[cargo]?.[index] ?? null,
      })),
    });
  }
  for (const event of [...scheduled, ...unscheduled]) {
    const key = normalized(event.cargo);
    if (!key || cargoKeys.has(key)) continue;
    cargoKeys.add(key);
    cargoes.push({ name: event.cargo, key, values: [] });
  }

  return {
    ...factory,
    stockPort: stockPort?.name || factory.stockPort,
    cargoes,
    vessels: scheduled,
    unscheduled,
  };
}

function buildVesselCalendar(vesselStatus, stockPayload) {
  const factories = FACTORIES.map(factory => buildFactory(factory, vesselStatus || {}, stockPayload || {}));
  const dates = [];
  for (const factory of factories) {
    for (const cargo of factory.cargoes) cargo.values.forEach(point => { if (point.date) dates.push(point.date); });
    // Historical closed rows should not expand the working calendar range, but
    // closed vessels inside the stock/open-vessel window remain visible.
    factory.vessels.forEach(vessel => {
      if (vessel.isClosed) return;
      dates.push(vessel.scheduleDate);
      dates.push(addIsoDays(vessel.scheduleDate, Math.max(0, vessel.loadingCalendarDays - 1)));
    });
  }
  dates.sort();

  return {
    factories,
    dateRange: { start: dates[0] || null, end: dates[dates.length - 1] || null },
    updatedAt: latestTimestamp(vesselStatus?.updatedAt, stockPayload?.updatedAt),
    sources: {
      vesselUpdatedAt: vesselStatus?.updatedAt || null,
      stockUpdatedAt: stockPayload?.updatedAt || null,
    },
  };
}

function buildVesselCalendarFromDatabases() {
  return buildVesselCalendar(buildVesselStatusFromDatabase(), stockSummary.getCached());
}

module.exports = {
  FACTORIES,
  buildVesselCalendar,
  buildVesselCalendarFromDatabases,
  parseDisplayDate,
};
