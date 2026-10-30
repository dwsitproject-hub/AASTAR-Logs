'use strict';

// Builds a flat list of incoming vessel exports for the Daily ETA / Vessel Status page.
// Data sources (already cached):
//   - VESSEL DB formatted  (logistics / "Vessel Update" config, render_format='formatted')
//   - VESSEL DB unformatted (logistics / "Export Summary" config, render_format='unformatted')
//   - Matching formatted    (operations / "Matching" config) - for demmurage rate

const VDB_PORT_STARTS = [20, 36, 52, 68, 84, 100, 116, 132, 148, 164];
const VDB_OFF = {
  PORT: 0, STATUS: 1, SHIPPER: 2, PRICE: 3, QTY: 4, CARGO: 5, PORT_STATUS: 6,
  LAYCAN: 7, CR: 8, ETA: 9, ETA_TIME: 10, ETB: 11, ETB_TIME: 12, ETC: 13, ETC_TIME: 14,
};

// VESSEL DB top-level columns
const VDB = { VSLID: 0, ENTITY: 2, MONTH: 3, VESSEL: 4, EST_DEMM: 6, DEMM: 14, LAYTIME_RATE: 15, LAYTIME_STARTS: 16, REMARKS: 17 };

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SUPPLY_SHIPPERS = new Set(['EUP','SPC','PMC','TPG','GLM']);

function str(v) { return v == null ? '' : v.toString().trim(); }

function serialToDate(serial) {
  if (typeof serial !== 'number' || !isFinite(serial)) return null;
  const ms = (serial - 25569) * 86400 * 1000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

// Parse "USD 5,000.00" / "5,000" / "5000" / "$5,000 PDPR" → number, or null.
function parseDemmurageNumber(s) {
  if (s == null || s === '') return null;
  const m = s.toString().match(/-?[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function formatDemmurage(n) {
  if (n == null || isNaN(n)) return '';
  return `USD ${Math.round(n).toLocaleString('en-US')} PDPR`;
}

// VESSEL DB month col may be a serial number, a Date, or text like "Jun 2026".
function parseMonthYear(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return { month: value.getMonth(), year: value.getFullYear() };
  if (typeof value === 'number') {
    const d = serialToDate(value);
    if (d) return { month: d.getMonth(), year: d.getFullYear() };
    return null;
  }
  const txt = value.toString().trim().toLowerCase();
  // Try "Jun 2026" / "June 2026" / "Jun-2026"
  for (let i = 0; i < 12; i++) {
    if (txt.includes(MONTHS_SHORT[i].toLowerCase()) || txt.includes(MONTHS_FULL[i].toLowerCase())) {
      const yMatch = txt.match(/(20\d{2})/);
      return { month: i, year: yMatch ? parseInt(yMatch[1]) : new Date().getFullYear() };
    }
  }
  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) return { month: parsed.getMonth(), year: parsed.getFullYear() };
  return null;
}

function monthLabel(my) { return my ? `${MONTHS_SHORT[my.month]} ${my.year}` : ''; }
function monthSortKey(my) { return my ? my.year * 100 + my.month : 99999999; }

// Build a demmurage lookup straight from the VESSEL DB row (formatted view).
function buildDemmLookup(vdbFormatted) {
  const out = {};
  if (!vdbFormatted || vdbFormatted.length === 0) return out;
  for (let r = 1; r < vdbFormatted.length; r++) {
    const row = vdbFormatted[r];
    if (!row) continue;
    const vslId = str(row[VDB.VSLID]);
    const demm = str(row[VDB.DEMM]);
    if (vslId && demm) out[vslId] = demm;
  }
  return out;
}

// Build a discharge-port lookup keyed by vsl_id. A port within a vessel row is a
// "discharge" if its shipper cell == "Discharge" (case-insensitive).
function buildDischargeLookup(vdbFormatted) {
  const out = {};
  if (!vdbFormatted || vdbFormatted.length === 0) return out;
  for (let r = 1; r < vdbFormatted.length; r++) {
    const row = vdbFormatted[r];
    if (!row) continue;
    const vslId = str(row[VDB.VSLID]);
    if (!vslId) continue;
    for (const start of VDB_PORT_STARTS) {
      const port = str(row[start + VDB_OFF.PORT]);
      if (!port) continue;
      const shipper = str(row[start + VDB_OFF.SHIPPER]).toUpperCase();
      if (shipper === 'DISCHARGE' || shipper === 'DISCH') {
        if (!out[vslId]) out[vslId] = [];
        out[vslId].push(port.toUpperCase());
      }
    }
  }
  return out;
}

// Eta serial (for sort) from unformatted row aligned to the same row index.
function buildEtaSerials(vdbRaw) {
  // [rowIdx][portStart] => number|null
  const arr = [];
  if (!vdbRaw) return arr;
  for (let r = 0; r < vdbRaw.length; r++) {
    const row = vdbRaw[r] || [];
    const slot = {};
    for (const start of VDB_PORT_STARTS) {
      const v = row[start + VDB_OFF.ETA];
      slot[start] = (typeof v === 'number' && isFinite(v)) ? v : null;
    }
    arr.push(slot);
  }
  return arr;
}

function buildVesselStatus(vdbFormatted, vdbRaw) {
  if (!vdbFormatted || vdbFormatted.length === 0) {
    return { vessels: [], shippers: [], entities: [], ports: [], cargoes: [] };
  }

  const demmLookup = buildDemmLookup(vdbFormatted);
  const dischargeLookup = buildDischargeLookup(vdbFormatted);
  const etaSerials = buildEtaSerials(vdbRaw);

  const rows = [];
  const shippers = new Set(), entities = new Set(), ports = new Set(), cargoes = new Set();

  for (let r = 1; r < vdbFormatted.length; r++) {
    const row = vdbFormatted[r];
    if (!row) continue;
    const vslId = str(row[VDB.VSLID]);
    const vessel = str(row[VDB.VESSEL]);
    if (!vslId && !vessel) continue;
    const entity = str(row[VDB.ENTITY]);
    const monthRaw = row[VDB.MONTH];
    const remarks = str(row[VDB.REMARKS]);
    const laytimeRate = str(row[VDB.LAYTIME_RATE]);
    const laytimeStarts = str(row[VDB.LAYTIME_STARTS]);

    const rawDemmStr = demmLookup[vslId] || '';
    const demmBase = parseDemmurageNumber(rawDemmStr);

    // For markup logic, find discharge ports for this vsl_id
    const dischPorts = dischargeLookup[vslId] || [];
    const hasFOB = dischPorts.some(p => p === 'FOB');

    for (const start of VDB_PORT_STARTS) {
      const port = str(row[start + VDB_OFF.PORT]);
      if (!port) continue;
      const status = str(row[start + VDB_OFF.STATUS]);
      if (status.toLowerCase() !== 'load') continue;

      const shipper = str(row[start + VDB_OFF.SHIPPER]).toUpperCase();
      // Skip discharge ports — they're identified by shipper="Discharge"
      if (shipper === 'DISCHARGE' || shipper === 'DISCH') continue;

      const qty = parseFloat(str(row[start + VDB_OFF.QTY]).replace(/[, ]/g, '')) || 0;
      if (!shipper || qty <= 0) continue;

      const cargo = str(row[start + VDB_OFF.CARGO]);
      const portClosed = str(row[start + VDB_OFF.PORT_STATUS]).toLowerCase() === 'closed';
      if (portClosed) continue;

      // Demmurage markup: supply shipper + non-FOB discharge → +2000
      let demmFinal = demmBase;
      if (demmBase != null && SUPPLY_SHIPPERS.has(shipper) && !hasFOB) {
        demmFinal = demmBase + 2000;
      }
      const demmDisplay = demmFinal != null ? formatDemmurage(demmFinal) : '';

      // Month — prefer VDB Month col; fall back to ETA serial
      let my = parseMonthYear(monthRaw);
      if (!my) {
        const etaSerial = etaSerials[r] && etaSerials[r][start];
        if (etaSerial != null) {
          const d = serialToDate(etaSerial);
          if (d) my = { month: d.getMonth(), year: d.getFullYear() };
        }
      }

      const etaSort = etaSerials[r] && etaSerials[r][start] != null ? etaSerials[r][start] : 9e9;

      const out = {
        rowId: r,
        month: monthLabel(my),
        monthSort: monthSortKey(my),
        entity,
        shipper,
        vessel,
        port,
        portSort: port.toUpperCase(),
        cargo,
        quantity: qty,
        demmurage: demmDisplay,
        laytimeRate,
        laytimeStarts,
        laycan: str(row[start + VDB_OFF.LAYCAN]),
        cargoReadiness: str(row[start + VDB_OFF.CR]),
        eta: str(row[start + VDB_OFF.ETA]),
        etb: str(row[start + VDB_OFF.ETB]),
        etc: str(row[start + VDB_OFF.ETC]),
        etaSort,
        remarks,
        isClosed: false,
      };
      rows.push(out);
      if (entity) entities.add(entity);
      if (shipper) shippers.add(shipper);
      if (port) ports.add(port);
      if (cargo) cargoes.add(cargo);
    }
  }

  // Sort: Month → Port → ETA
  rows.sort((a, b) => {
    if (a.monthSort !== b.monthSort) return a.monthSort - b.monthSort;
    if (a.portSort !== b.portSort) return a.portSort.localeCompare(b.portSort);
    return a.etaSort - b.etaSort;
  });

  return {
    vessels: rows,
    shippers: Array.from(shippers).sort(),
    entities: Array.from(entities).sort(),
    ports: Array.from(ports).sort(),
    cargoes: Array.from(cargoes).sort(),
  };
}

module.exports = { buildVesselStatus };
