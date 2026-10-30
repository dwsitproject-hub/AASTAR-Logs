'use strict';

const {
  loadVesselDatabase,
  PORT_COL_BASE,
  PORT_COL_STRIDE,
  PORT_OFF,
  VESSEL_COL,
} = require('./vesselUpdate');

const PORT_COUNT = 10;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function digits(value) {
  return text(value).replace(/\D/g, '');
}

function parseCoordinate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = text(value);
  if (!raw) return null;

  const upper = raw.toUpperCase().replace(/(\d),(\d)/g, '$1.$2');
  const sign = upper.includes('S') || upper.includes('W') ? -1 : 1;
  const cleaned = upper.replace(/[NSEW]/g, '').replace(/[^\d.+-]/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
  if (!parts.length) return null;

  let coordinate = Math.abs(parts[0]);
  if (parts.length > 1) coordinate += parts[1] / 60;
  if (parts.length > 2) coordinate += parts[2] / 3600;
  if (/^-/.test(cleaned)) coordinate *= -1;
  else coordinate *= sign;
  return Number.isFinite(coordinate) ? coordinate : null;
}

function validLatLng(latitude, longitude) {
  return latitude != null
    && longitude != null
    && Math.abs(latitude) <= 90
    && Math.abs(longitude) <= 180;
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter(value => {
    const key = text(value).toUpperCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withTime(date, time) {
  const day = text(date);
  const clock = text(time);
  if (!day) return '';
  return clock && clock !== '00:00' ? `${day} ${clock}` : day;
}

function portSchedule(row, base) {
  const choices = [
    ['ETA', withTime(row[base + PORT_OFF.eta], row[base + PORT_OFF.eta_time])],
    ['ETB', withTime(row[base + PORT_OFF.etb], row[base + PORT_OFF.etb_time])],
    ['ETC', withTime(row[base + PORT_OFF.etc], row[base + PORT_OFF.etc_time])],
    ['LAYCAN', text(row[base + PORT_OFF.laycan])],
  ];
  const selected = choices.find(([, value]) => value);
  return selected ? { type: selected[0], value: selected[1] } : { type: '', value: '' };
}

function buildPortRotation(row) {
  const ports = [];
  const byName = new Map();

  for (let index = 0; index < PORT_COUNT; index += 1) {
    const base = PORT_COL_BASE + index * PORT_COL_STRIDE;
    const name = text(row[base + PORT_OFF.port_name]);
    if (!name) continue;

    const key = name.toUpperCase();
    const schedule = portSchedule(row, base);
    const candidate = {
      sequence: ports.length + 1,
      sourceSlot: index + 1,
      name,
      movement: text(row[base + PORT_OFF.status_ld]),
      shipper: text(row[base + PORT_OFF.shipper]),
      entity: text(row[base + PORT_OFF.port_entity]),
      quantity: text(row[base + PORT_OFF.qty]),
      cargo: text(row[base + PORT_OFF.l_cargo]),
      status: text(row[base + PORT_OFF.status_oc]),
      laycan: text(row[base + PORT_OFF.laycan]),
      scheduleType: schedule.type,
      schedule: schedule.value,
    };

    if (!byName.has(key)) {
      byName.set(key, candidate);
      ports.push(candidate);
      continue;
    }

    const existing = byName.get(key);
    if (!existing.schedule && candidate.schedule) {
      existing.schedule = candidate.schedule;
      existing.scheduleType = candidate.scheduleType;
    }
    if (!existing.movement && candidate.movement) existing.movement = candidate.movement;
  }

  return ports;
}

function buildLiveVesselsFromRows(rows) {
  const vessels = [];
  const entities = new Set();
  let openCount = 0;

  for (let rowIndex = 1; rowIndex < (rows || []).length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const status = text(row[VESSEL_COL.status]).toUpperCase();
    if (status !== 'OPEN') continue;
    openCount += 1;

    const imo = digits(row[VESSEL_COL.imo]);
    const mmsi = digits(row[VESSEL_COL.mmsi]);
    const hasImo = /^\d{7}$/.test(imo) && imo !== '0000000';
    const hasMmsi = /^\d{9}$/.test(mmsi) && mmsi !== '000000000';
    const latitude = parseCoordinate(row[VESSEL_COL.latitude]);
    const longitude = parseCoordinate(row[VESSEL_COL.longitude]);
    const hasDbPosition = validLatLng(latitude, longitude);
    if (!hasImo && !hasMmsi && !hasDbPosition) continue;

    const vessel = text(row[VESSEL_COL.vessel]);
    const vslId = text(row[VESSEL_COL.vsl_id]);
    if (!vessel && !vslId) continue;

    const ports = buildPortRotation(row);
    const dischargePorts = ports.filter(port => port.movement.toUpperCase().includes('DISCHARGE'));
    const loadPorts = ports.filter(port => port.movement.toUpperCase().includes('LOAD'));
    const entity = text(row[VESSEL_COL.entity]);
    if (entity) entities.add(entity);

    vessels.push({
      vslId,
      row: rowIndex + 1,
      vessel: vessel || vslId,
      entity,
      voyage: text(row[VESSEL_COL.voyage]),
      imo: hasImo ? imo : '',
      mmsi: hasMmsi ? mmsi : '',
      latitude: hasDbPosition ? latitude : null,
      longitude: hasDbPosition ? longitude : null,
      hasDbPosition,
      status,
      operations: text(row[VESSEL_COL.ops]) || 'Schedule pending',
      direction: (dischargePorts.at(-1) || ports.at(-1))?.name || 'TBA',
      laycan: uniqueStrings(loadPorts.map(port => port.laycan)).join(' / ') || 'TBA',
      cargo: uniqueStrings(loadPorts.map(port => [port.quantity, port.cargo].filter(Boolean).join(' '))).join(' / ') || 'TBA',
      ports,
    });
  }

  vessels.sort((a, b) => a.vessel.localeCompare(b.vessel, undefined, { sensitivity: 'base' }));
  const positionedCount = vessels.filter(vessel => vessel.hasDbPosition).length;
  return {
    vessels,
    maxPorts: vessels.reduce((max, vessel) => Math.max(max, vessel.ports.length), 0),
    counts: {
      open: openCount,
      trackable: vessels.length,
      positioned: positionedCount,
      missingCoordinates: Math.max(0, openCount - positionedCount),
    },
    options: { entities: Array.from(entities).sort() },
  };
}

function buildLiveVessels() {
  const { rows, updatedAt } = loadVesselDatabase();
  const projection = buildLiveVesselsFromRows(rows);
  return {
    ...projection,
    updatedAt,
  };
}

module.exports = {
  buildLiveVessels,
  buildLiveVesselsFromRows,
  buildPortRotation,
  parseCoordinate,
  validLatLng,
};
