'use strict';

const VDB = {
  VSLID: 0,
  ENTITY: 2,
  MONTH: 3,
  VESSEL: 4,
  VOYAGE: 5,
  EST_DEMM: 6,
  IMO: 7,
  MMSI: 8,
  STATUS: 9,
  OPS: 10,
  LATITUDE: 12,
  LONGITUDE: 13,
  REMARKS: 17,
};

const PORT_STARTS = [20, 36, 52, 68, 84, 100, 116, 132, 148, 164];
const PORT_OFF = { PORT: 0, PORT_STATUS: 1, SHIPPER: 2, PRICE: 3, QTY: 4, CARGO: 5, LOAD_DISCHARGE: 6, ETA: 9, ETA_TIME: 10 };

function str(v) {
  return v == null ? '' : v.toString().trim();
}

function parseCoordinate(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  const raw = str(value);
  if (!raw) return null;

  const upper = raw.toUpperCase();
  const sign = upper.includes('S') || upper.includes('W') ? -1 : 1;
  const cleaned = upper
    .replace(/[NSEW]/g, '')
    .replace(/[^\d.+-]/g, ' ')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean).map(Number).filter(n => isFinite(n));
  if (!parts.length) return null;

  let coord = Math.abs(parts[0]);
  if (parts.length > 1) coord += parts[1] / 60;
  if (parts.length > 2) coord += parts[2] / 3600;
  if (/^-/.test(cleaned)) coord *= -1;
  else coord *= sign;
  return isFinite(coord) ? coord : null;
}

function validLatLng(lat, lng) {
  return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function pickPrimaryPort(row) {
  for (const start of PORT_STARTS) {
    const port = str(row[start + PORT_OFF.PORT]);
    if (!port) continue;
    const status = str(row[start + PORT_OFF.PORT_STATUS]);
    const shipper = str(row[start + PORT_OFF.SHIPPER]);
    const cargo = str(row[start + PORT_OFF.CARGO]);
    const qty = str(row[start + PORT_OFF.QTY]);
    const eta = str(row[start + PORT_OFF.ETA]);
    return { port, status, shipper, cargo, quantity: qty, eta };
  }
  return { port: '', status: '', shipper: '', cargo: '', quantity: '', eta: '' };
}

function statusBucket(status) {
  const s = str(status).toUpperCase();
  if (s.includes('DELAY')) return 'Delayed';
  if (s.includes('ANCHOR') || s.includes('ARRIV') || s.includes('APPROACH')) return 'Approaching';
  if (s.includes('LOAD')) return 'Loading';
  return 'Open';
}

function buildVesselMap(vdbFormatted) {
  if (!Array.isArray(vdbFormatted) || vdbFormatted.length === 0) {
    return {
      vessels: [],
      statuses: [],
      entities: [],
      options: { entities: [] },
      counts: { open: 0, trackable: 0, imo: 0, mmsi: 0 },
    };
  }

  const vessels = [];
  let openCount = 0;
  const statuses = new Set();
  const entities = new Set();

  for (let r = 1; r < vdbFormatted.length; r++) {
    const row = vdbFormatted[r] || [];
    const status = str(row[VDB.STATUS]);
    if (!status || status.toUpperCase() === 'CLOSED') continue;
    openCount += 1;

    const imo = str(row[VDB.IMO]).replace(/\D/g, '');
    const mmsi = str(row[VDB.MMSI]).replace(/\D/g, '');
    const hasImo = /^\d{7}$/.test(imo) && imo !== '0000000';
    const hasMmsi = /^\d{9}$/.test(mmsi) && mmsi !== '000000000';
    if (!hasImo && !hasMmsi) continue;

    const lat = parseCoordinate(row[VDB.LATITUDE]);
    const lng = parseCoordinate(row[VDB.LONGITUDE]);
    const hasPosition = validLatLng(lat, lng);

    const vessel = str(row[VDB.VESSEL]);
    const vslId = str(row[VDB.VSLID]);
    if (!vessel && !vslId) continue;

    const entity = str(row[VDB.ENTITY]);
    const primary = pickPrimaryPort(row);
    const bucket = statusBucket(status);

    vessels.push({
      id: vslId || `${vessel}-${r}`,
      vslId,
      row: r + 1,
      vessel,
      entity,
      month: str(row[VDB.MONTH]),
      voyage: str(row[VDB.VOYAGE]),
      imo: hasImo ? imo : '',
      mmsi: hasMmsi ? mmsi : '',
      status,
      statusBucket: bucket,
      ops: str(row[VDB.OPS]),
      latitude: hasPosition ? lat : null,
      longitude: hasPosition ? lng : null,
      hasPosition,
      remarks: str(row[VDB.REMARKS]),
      ...primary,
    });
    statuses.add(bucket);
    if (entity) entities.add(entity);
  }

  vessels.sort((a, b) => a.vessel.localeCompare(b.vessel));

  return {
    vessels,
    statuses: Array.from(statuses).sort(),
    entities: Array.from(entities).sort(),
    options: { entities: Array.from(entities).sort() },
    counts: {
      open: openCount,
      trackable: vessels.length,
      imo: vessels.filter(vessel => vessel.imo).length,
      mmsi: vessels.filter(vessel => vessel.mmsi).length,
    },
  };
}

module.exports = { buildVesselMap };
