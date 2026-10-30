// Port of VesselDashboard Flask backend - parses VESSEL DB (formatted) and produces vessel list

const PORT_COL_BASE = 20; // 0-based: col 20 is "Port 1"; fixed columns A-S stay before port blocks.
const PORT_COL_STRIDE = 16;
// Per-port column offsets (0-based within the 16-col block). latest_price is a display column after Current/Shipper.
const PORT_OFF = {
  vslid: -1,
  port_name: 0,
  status_ld: 1,
  shipper: 2,
  latest_price: 3,
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
  entity: 2,
  vessel: 4,
  voyage: 5,
  est_demmurage: 6,
  imo: 7,
  mmsi: 8,
  status: 9,
  ops: 10,
  demm_rate: 14,
  laytime_rate: 15,
  laytime_starts: 16,
  remarks: 17
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_INDEX = MONTHS.reduce((m, mo, i) => (m[mo.toLowerCase()] = i, m), {});

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

// "USD 5,000.00" / "USD 5000" / "5000" -> "5000"
function parseDemmRate(s) {
  if (!s) return '';
  const m = s.toString().match(/(-?\d[\d,]*(?:\.\d+)?)/);
  if (!m) return '';
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return '';
  return Math.round(n).toString();
}

// "5000" -> "USD 5,000.00" (matches the existing sheet format)
function formatDemmRate(s) {
  if (!s && s !== 0) return '';
  const n = parseFloat(s.toString().replace(/[^\d.-]/g, ''));
  if (isNaN(n)) return s.toString();
  return 'USD ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildVesselList(data, { statusFilter = 'open', query = '' } = {}) {
  if (!data || data.length < 2) return { vessels: [], options: { entities: [], cargos: [], shippers: [], ports: [], ops: [] } };

  const vessels = [];
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
    const entity = str(row[VESSEL_COL.entity]).trim();
    const ops = str(row[VESSEL_COL.ops]).trim();

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
        latest_price: str(row[base + PORT_OFF.latest_price]).trim(),
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
      if (p.l_cargo) cargoSet.add(p.l_cargo);
      if (p.shipper) shipperSet.add(p.shipper);
    }

    const rawDemm = str(row[VESSEL_COL.demm_rate]).trim();
    const v = {
      row: r + 1,
      vsl_id,
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
      ports
    };

    if (q) {
      const haystack = [
        v.vsl_id, v.vessel, v.voyage, v.entity, v.imo, v.mmsi, v.ops,
        ...v.ports.flatMap(p => [p.port_name, p.shipper, p.l_cargo])
      ].join('|').toLowerCase();
      if (haystack.indexOf(q) === -1) continue;
    }

    vessels.push(v);
  }

  return {
    vessels,
    options: {
      entities: [...entitySet].sort(),
      cargos: [...cargoSet].sort(),
      shippers: [...shipperSet].sort(),
      ports: [...portSet].sort(),
      ops: [...opsSet].sort()
    }
  };
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

module.exports = { buildVesselList, buildAbvOptions, nextVslId, displayToIso, colToA1, parseDemmRate, formatDemmRate, VESSEL_COL, PORT_COL_BASE, PORT_COL_STRIDE, PORT_OFF };
