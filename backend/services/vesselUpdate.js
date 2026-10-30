// Port of VesselDashboard Flask backend - parses VESSEL DB and produces vessel list

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT_COL_BASE = 20; // 0-based: col 20 is "Port 1"; fixed columns A-S stay before port blocks.
const PORT_COL_STRIDE = 16;
// Per-port column offsets (0-based within the 16-col block).
const PORT_OFF = {
  vslid: -1,
  port_name: 0,
  status_ld: 1,
  shipper: 2,
  port_entity: 3,
  qty: 4,
  l_cargo: 5,
  status_oc: 6,
  laycan: 7,
  cr: 8,
  eta: 9,
  eta_time: 10,
  etb: 11,
  etb_time: 12,
  etc: 13,
  etc_time: 14
};

const VESSEL_COL = {
  vsl_id: 0,
  charterer: 1,
  entity: 2,
  vessel: 4,
  voyage: 5,
  est_demmurage: 6,
  imo: 7,
  mmsi: 8,
  status: 9,
  ops: 10,
  latitude: 12,
  longitude: 13,
  demm_rate: 14,
  laytime_rate: 15,
  laytime_starts: 16,
  remarks: 17,
  nominated: 18
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_INDEX = MONTHS.reduce((m, mo, i) => (m[mo.toLowerCase()] = i, m), {});
const VESSEL_DB_PATH = process.env.DATA_DATABASE_DIR
  ? path.join(process.env.DATA_DATABASE_DIR, 'DB6.db')
  : path.join(__dirname, '../data/databases/DB6.db');
const vesselDatabaseCache = new Map();

function databaseFileSignature(databasePath) {
  try {
    const stat = fs.statSync(databasePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

// "30 Jun" -> "YYYY-06-30"; "30 Jun 2026" -> "2026-06-30"; "" -> ""
function displayToIso(s) {
  if (!s) return '';
  s = s.toString().trim();
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (m) {
    const mo = MONTH_INDEX[m[2].toLowerCase()];
    if (mo == null) return '';
    return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${String(parseInt(m[1])).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})$/);
  if (m) {
    const mo = MONTH_INDEX[m[2].toLowerCase()];
    if (mo == null) return '';
    return `${new Date().getFullYear()}-${String(mo + 1).padStart(2, '0')}-${String(parseInt(m[1])).padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
}

function str(v) { return v == null ? '' : v.toString(); }

function numericValue(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return isFinite(number) ? number : null;
}

function serialToDate(value) {
  const serial = numericValue(value);
  if (serial == null) return null;
  const date = new Date((serial - 25569) * 86400 * 1000);
  return isNaN(date.getTime()) ? null : date;
}

function formatSerialDate(value, monthOnly = false) {
  const serial = numericValue(value);
  if (serial == null || serial < 20000 || serial > 80000) return str(value).trim();
  const date = serialToDate(serial);
  if (!date) return str(value).trim();
  if (monthOnly) return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function formatSerialTime(value) {
  const fraction = numericValue(value);
  if (fraction == null || fraction < 0 || fraction >= 1) return str(value).trim();
  const totalMinutes = Math.round(fraction * 24 * 60) % (24 * 60);
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

function vesselDateColumns() {
  const dates = new Set([VESSEL_COL.MONTH]);
  const times = new Set();
  for (let i = 0; i < 10; i++) {
    const base = PORT_COL_BASE + i * PORT_COL_STRIDE;
    for (const offset of [PORT_OFF.laycan, PORT_OFF.cr, PORT_OFF.eta, PORT_OFF.etb, PORT_OFF.etc]) dates.add(base + offset);
    for (const offset of [PORT_OFF.eta_time, PORT_OFF.etb_time, PORT_OFF.etc_time]) times.add(base + offset);
  }
  return { dates, times };
}

function loadVesselDatabase(databasePath = VESSEL_DB_PATH) {
  const signature = databaseFileSignature(databasePath);
  const cached = vesselDatabaseCache.get(databasePath);
  if (cached && cached.signature === signature) return cached.value;

  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const schema = db.prepare('PRAGMA table_info("vessel_db")').all();
    const sourceColumns = schema.filter(column => column.name !== '_sheet_row');
    const { dates, times } = vesselDateColumns();
    const records = db.prepare('SELECT * FROM vessel_db ORDER BY CAST(_sheet_row AS INTEGER)').all();
    const rows = [[]];
    for (const record of records) {
      const row = [];
      sourceColumns.forEach((column, index) => {
        const value = record[column.name];
        if (dates.has(index)) row[index] = formatSerialDate(value, index === VESSEL_COL.MONTH);
        else if (times.has(index)) row[index] = formatSerialTime(value);
        else row[index] = value == null ? '' : value;
      });
      rows.push(row);
    }
    const metadata = db.prepare('SELECT pulled_at FROM _database_meta LIMIT 1').get();
    const value = { rows, updatedAt: metadata?.pulled_at || null };
    vesselDatabaseCache.set(databasePath, { signature: databaseFileSignature(databasePath), value });
    return value;
  } finally {
    db.close();
  }
}

function updateVesselDatabase(updates, databasePath = VESSEL_DB_PATH) {
  if (!updates.length) return 0;
  const db = new Database(databasePath);
  try {
    const schema = db.prepare('PRAGMA table_info("vessel_db")').all();
    const sourceColumns = schema.filter(column => column.name !== '_sheet_row');
    const update = db.transaction(() => {
      let count = 0;
      for (const item of updates) {
        const column = sourceColumns[item.col];
        if (!column) continue;
        const sqlName = column.name.replace(/"/g, '""');
        const result = db.prepare(`UPDATE vessel_db SET "${sqlName}" = ? WHERE _sheet_row = ?`).run(
          item.value == null ? '' : String(item.value),
          String(item.row),
        );
        count += result.changes;
      }
      return count;
    });
    const changed = update();
    vesselDatabaseCache.delete(databasePath);
    return changed;
  } finally {
    db.close();
  }
}

function parseCheckbox(v) {
  if (v === true) return true;
  const s = str(v).trim().toLowerCase();
  return ['true', 'yes', 'y', '1', 'checked'].includes(s);
}

// "USD 5,000.00" / "USD 5000" / "5000" -> "5000"
function parseDemmRate(s) {
  if (!s) return '';
  const m = s.toString().match(/(-?\d[\d,]*(?:\.\d+)?)/);
  if (!m) return '';
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return '';
  return Math.round(n).toString();
}

// "USD 5,000.00" / "5000" -> "5000" for sheet writes.
function normalizeDemmRate(s) {
  if (!s && s !== 0) return '';
  const n = Number(s.toString().replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return s.toString();
  return n.toString();
}

function buildVesselList(data, { statusFilter = 'open', query = '' } = {}) {
  if (!data || data.length < 2) return { vessels: [], options: { charterers: [], entities: [], cargos: [], shippers: [], ports: [], ops: [] } };

  const vessels = [];
  const chartererSet = new Set();
  const entitySet = new Set();
  const cargoSet = new Set();
  const shipperSet = new Set();
  const portSet = new Set();
  const opsSet = new Set();
  const q = query.trim().toLowerCase();

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;
    const vsl_id = str(row[VESSEL_COL.vsl_id]).trim();
    const vessel = str(row[VESSEL_COL.vessel]).trim();
    if (!vsl_id && !vessel) continue;

    const status = str(row[VESSEL_COL.status]).trim();
    const charterer = str(row[VESSEL_COL.charterer]).trim();
    const entity = str(row[VESSEL_COL.entity]).trim();
    const ops = str(row[VESSEL_COL.ops]).trim();

    if (charterer) chartererSet.add(charterer);
    if (entity) entitySet.add(entity);
    if (ops) opsSet.add(ops);

    if (statusFilter === 'open' && status.toUpperCase() !== 'OPEN') continue;

    const ports = [];
    for (let i = 0; i < 10; i++) {
      const base = PORT_COL_BASE + i * PORT_COL_STRIDE;
      const p = {
        vslid: str(row[base + PORT_OFF.vslid]).trim(),
        port_name: str(row[base + PORT_OFF.port_name]).trim(),
        status_ld: str(row[base + PORT_OFF.status_ld]).trim(),
        shipper: str(row[base + PORT_OFF.shipper]).trim(),
        port_entity: str(row[base + PORT_OFF.port_entity]).trim(),
        qty: str(row[base + PORT_OFF.qty]).trim(),
        l_cargo: str(row[base + PORT_OFF.l_cargo]).trim(),
        status_oc: str(row[base + PORT_OFF.status_oc]).trim(),
        laycan: str(row[base + PORT_OFF.laycan]).trim(),
        cr: str(row[base + PORT_OFF.cr]).trim(),
        eta: str(row[base + PORT_OFF.eta]).trim(),
        eta_time: str(row[base + PORT_OFF.eta_time]).trim(),
        etb: str(row[base + PORT_OFF.etb]).trim(),
        etb_time: str(row[base + PORT_OFF.etb_time]).trim(),
        etc: str(row[base + PORT_OFF.etc]).trim(),
        etc_time: str(row[base + PORT_OFF.etc_time]).trim()
      };
      p.cr_iso = displayToIso(p.cr);
      p.eta_iso = displayToIso(p.eta);
      p.etb_iso = displayToIso(p.etb);
      p.etc_iso = displayToIso(p.etc);
      p.cr_display = p.cr;
      p.eta_display = p.eta;
      p.etb_display = p.etb;
      p.etc_display = p.etc;
      ports.push(p);
      if (p.port_name) portSet.add(p.port_name);
      if (p.port_entity) entitySet.add(p.port_entity);
      if (p.l_cargo) cargoSet.add(p.l_cargo);
      if (p.shipper) shipperSet.add(p.shipper);
    }

    const rawDemm = str(row[VESSEL_COL.demm_rate]).trim();
    const v = {
      row: r + 1,
      vsl_id,
      charterer,
      entity,
      vessel,
      voyage: str(row[VESSEL_COL.voyage]).trim(),
      imo: str(row[VESSEL_COL.imo]).trim(),
      mmsi: str(row[VESSEL_COL.mmsi]).trim(),
      status,
      ops,
      demm_rate: parseDemmRate(rawDemm),
      demm_rate_display: rawDemm,
      laytime_rate: str(row[VESSEL_COL.laytime_rate]).trim(),
      laytime_starts: str(row[VESSEL_COL.laytime_starts]).trim(),
      est_demmurage: str(row[VESSEL_COL.est_demmurage]).trim(),
      remarks: str(row[VESSEL_COL.remarks]).trim(),
      nominated: parseCheckbox(row[VESSEL_COL.nominated]),
      ports
    };

    if (q) {
      const haystack = [
        v.vsl_id, v.vessel, v.voyage, v.charterer, v.entity, v.imo, v.mmsi, v.ops,
        ...v.ports.flatMap(p => [p.port_name, p.shipper, p.port_entity, p.l_cargo])
      ].join('|').toLowerCase();
      if (haystack.indexOf(q) === -1) continue;
    }

    vessels.push(v);
  }

  return {
    vessels,
    options: {
      charterers: [...chartererSet].sort(),
      entities: [...entitySet].sort(),
      cargos: [...cargoSet].sort(),
      shippers: [...shipperSet].sort(),
      ports: [...portSet].sort(),
      ops: [...opsSet].sort()
    }
  };
}

function getValidLoadSlotIds(data) {
  const ids = new Set();
  for (let rowIndex = 1; rowIndex < (data || []).length; rowIndex++) {
    const row = data[rowIndex] || [];
    for (let portIndex = 0; portIndex < 10; portIndex++) {
      const base = PORT_COL_BASE + portIndex * PORT_COL_STRIDE;
      const vslId = str(row[base + PORT_OFF.vslid]).trim();
      const portName = str(row[base + PORT_OFF.port_name]).trim();
      const statusLd = str(row[base + PORT_OFF.status_ld]).trim().toLowerCase();
      if (vslId && portName && statusLd === 'load') ids.add(vslId.toLowerCase());
    }
  }
  return ids;
}

// Convert 0-based column index to A1 column letter
function colToA1(c) {
  let s = '';
  c = parseInt(c);
  while (true) {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
    if (c < 0) break;
  }
  return s;
}

// Extract dropdown options from cached ABV tab.
// ABV!A = port names, ABV!C = L.Cargo names
function buildAbvOptions(abvData) {
  const ports = [], cargoes = [];
  if (!abvData) return { ports, cargoes };
  for (let r = 1; r < abvData.length; r++) {
    const row = abvData[r] || [];
    const p = str(row[0]).trim();
    const c = str(row[2]).trim();
    if (p && !ports.includes(p)) ports.push(p);
    if (c && !cargoes.includes(c)) cargoes.push(c);
  }
  return { ports: ports.sort(), cargoes: cargoes.sort() };
}

// Scan existing rows for the largest vsl_YY_NNNN base ID and return the next one.
// Format: vsl_<YY>_<NNNN> where YY = current 2-digit year, NNNN = 4-digit zero-padded sequence.
function nextVslId(data) {
  const year2 = String(new Date().getFullYear()).slice(-2);
  let maxNum = 0;
  if (data) {
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (!row) continue;
      const id = str(row[0]).trim();
      // Match vsl_YY_NNNN (3 underscore-separated parts), use year-matching if available
      const m = id.match(/^vsl_(\d{2})_(\d{4,})/i);
      if (!m) continue;
      if (m[1] !== year2) continue;
      const n = parseInt(m[2], 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  }
  return `vsl_${year2}_${String(maxNum + 1).padStart(4, '0')}`;
}

module.exports = {
  buildVesselList,
  buildAbvOptions,
  loadVesselDatabase,
  updateVesselDatabase,
  nextVslId,
  displayToIso,
  colToA1,
  parseDemmRate,
  normalizeDemmRate,
  VESSEL_COL,
  PORT_COL_BASE,
  PORT_COL_STRIDE,
  PORT_OFF,
  getValidLoadSlotIds,
};
