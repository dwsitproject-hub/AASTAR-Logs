// Port of Exportsummary.gs - processes vessel data + EOM stock from Google Sheets cache

const PORT_COLUMNS = [20, 36, 52, 68, 84, 100, 116, 132, 148, 164];
const OFFSET = { PORT:0, STATUS:1, SHIPPER:2, PRICE:3, QUANTITY:4, CARGO:5, PORT_STATUS:6, LAYCAN:7, CR:8, ETA:9, ETA_TIME:10, ETB:11, ETB_TIME:12, ETC:13, ETC_TIME:14 };
const COL = { ENTITY:2, MONTH:3, VESSEL:4, EST_DEMM:6, DEMM:14, LAYTIME_RATE:15, LAYTIME_STARTS:16, EXPORT_REMARKS:18 };

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Google Sheets serial number → JS Date. Serial 1 = 1899-12-31 (Lotus 1-2-3 quirk → 1900-01-01 in Google).
function serialToDate(serial) {
  if (typeof serial !== 'number' || !isFinite(serial)) return null;
  // Google Sheets epoch: 1899-12-30 (accounts for the 1900 leap year bug).
  const ms = (serial - 25569) * 86400 * 1000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return `${String(value.getDate()).padStart(2,'0')} ${MONTHS_SHORT[value.getMonth()]}`;
  if (typeof value === 'number') {
    const d = serialToDate(value);
    if (d) return `${String(d.getDate()).padStart(2,'0')} ${MONTHS_SHORT[d.getMonth()]}`;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) return `${String(parsed.getDate()).padStart(2,'0')} ${MONTHS_SHORT[parsed.getMonth()]}`;
  }
  return value.toString();
}

function parseSortDate(dateStr) {
  if (!dateStr) return 99999999;
  const m = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const parts = dateStr.toString().trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) return 99999999;
  const d = parseInt(parts[0]) || 0;
  const mon = m[parts[1].substring(0,3)] || 0;
  if (!d || !mon) return 99999999;
  return new Date().getFullYear() * 10000 + mon * 100 + d;
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const m = value.toString().match(/-?[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function formatRate(value) {
  const n = parseNumber(value);
  if (n == null) return '';
  return `USD ${Math.round(n).toLocaleString('en-US')} PDPR`;
}

function parseDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  if (typeof value === 'number') {
    const d = serialToDate(value);
    return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
  }
  const s = value.toString().trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime()) && s.match(/\d/)) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }
  return null;
}

function parseTimeParts(value) {
  if (value === null || value === undefined || value === '') return { hours: 0, minutes: 0 };
  if (value instanceof Date && !isNaN(value.getTime())) return { hours: value.getHours(), minutes: value.getMinutes() };
  if (typeof value === 'number' && isFinite(value)) {
    const fraction = ((value % 1) + 1) % 1;
    const totalMinutes = Math.round(fraction * 24 * 60) % (24 * 60);
    return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
  }
  const m = value.toString().trim().match(/(\d{1,2}):(\d{2})/);
  if (!m) return { hours: 0, minutes: 0 };
  return {
    hours: Math.min(23, Math.max(0, parseInt(m[1], 10))),
    minutes: Math.min(59, Math.max(0, parseInt(m[2], 10)))
  };
}

function combineDateTime(dateValue, timeValue) {
  const d = parseDateOnly(dateValue);
  if (!d) return null;
  const t = parseTimeParts(timeValue);
  d.setHours(t.hours, t.minutes, 0, 0);
  return d;
}

function formatMoney(value) {
  if (!isFinite(value) || value <= 0) return '';
  return `USD ${Math.round(value).toLocaleString('en-US')}`;
}

function calculateEstDemmurage(rowTotal, item) {
  const demmRate = parseNumber(item.demmRateRaw);
  const laytimeRate = parseNumber(item.laytimeRateRaw);
  if (!rowTotal || !demmRate || !laytimeRate) return '';

  const starts = (item.laytimeStarts || '').toString().trim().toLowerCase();
  const eta = combineDateTime(item.etaRaw, item.etaTimeRaw);
  const etb = combineDateTime(item.etbRaw, item.etbTimeRaw);
  const etc = combineDateTime(item.etcRaw, item.etcTimeRaw);
  if (!etc) return '';

  let laytimeStart = null;
  if (starts.indexOf('nor') !== -1) {
    if (!eta) return '';
    laytimeStart = new Date(eta.getTime() + 6 * 60 * 60 * 1000);
  } else if (starts.indexOf('all fast') !== -1 || starts.indexOf('allfast') !== -1) {
    if (!etb) return '';
    laytimeStart = etb;
  } else {
    return '';
  }

  const actualDays = (etc.getTime() - laytimeStart.getTime()) / (24 * 60 * 60 * 1000);
  const allowedDays = (rowTotal / laytimeRate) / 24;
  return formatMoney((actualDays - allowedDays) * demmRate);
}

function parseMonthYear(value) {
  if (!value && value !== 0) return { month: -1, year: -1 };
  if (value instanceof Date) return { month: value.getMonth(), year: value.getFullYear() };
  if (typeof value === 'number') {
    const d = serialToDate(value);
    if (d) return { month: d.getMonth(), year: d.getFullYear() };
    return { month: -1, year: -1 };
  }
  const parsed = new Date(value);
  if (!isNaN(parsed.getTime()) && value.toString().match(/\d/)) return { month: parsed.getMonth(), year: parsed.getFullYear() };
  const valStr = value.toString().trim().toLowerCase();
  for (let m = 0; m < MONTHS.length; m++) {
    if (valStr.indexOf(MONTHS[m].toLowerCase()) !== -1 || valStr.indexOf(MONTHS_SHORT[m].toLowerCase()) !== -1) {
      return { month: m, year: new Date().getFullYear() };
    }
  }
  return { month: -1, year: -1 };
}

function buildEomLookup(eomData) {
  if (!eomData || eomData.length === 0) return {};
  const lookup = {};
  for (let headerRow = 1; headerRow < eomData.length; headerRow += 16) {
    const row = eomData[headerRow];
    if (!row) break;
    const portName = row[0] ? row[0].toString().trim() : '';
    if (!portName) continue;
    const portKey = portName.toUpperCase();
    const cargoCols = {};
    for (let c = 1; c < row.length; c++) {
      const cargoName = row[c] ? row[c].toString().trim() : '';
      if (cargoName) cargoCols[c] = cargoName.toUpperCase();
    }
    if (!lookup[portKey]) lookup[portKey] = {};
    for (let dr = headerRow + 1; dr <= headerRow + 15 && dr < eomData.length; dr++) {
      const drow = eomData[dr];
      if (!drow) continue;
      const { month: dMonth, year: dYear } = parseMonthYear(drow[0]);
      if (dMonth === -1) continue;
      const mKey = `${dYear}-${dMonth < 10 ? '0' : ''}${dMonth}`;
      if (!lookup[portKey][mKey]) lookup[portKey][mKey] = {};
      for (const col in cargoCols) {
        const qty = parseFloat(drow[col]);
        if (!isNaN(qty)) lookup[portKey][mKey][cargoCols[col]] = qty;
      }
    }
  }
  return lookup;
}

function getEomStockForSection(sectionKey, eomLookup, monthKey) {
  if (!eomLookup) return null;
  const match = (pk) => {
    pk = pk.toUpperCase();
    switch (sectionKey) {
      case 'EUP_BONTANG': return pk.indexOf('EUP') === 0 && pk.indexOf('BONTANG') !== -1;
      case 'EUP_TJ_PURA': return pk.indexOf('EUP') === 0 && (pk.indexOf('TANJUNG PURA') !== -1 || pk.indexOf('TJ PURA') !== -1);
      case 'PMC': return pk.indexOf('PMC') === 0;
      case 'SPC': return pk.indexOf('SPC') === 0;
      case 'EUP_OTHER': return pk.indexOf('EUP') === 0 && pk.indexOf('BONTANG') === -1 && pk.indexOf('TANJUNG PURA') === -1 && pk.indexOf('TJ PURA') === -1;
      case 'TPG': return pk.indexOf('TPG') === 0;
      default: return false;
    }
  };
  const stock = {};
  let found = false;
  for (const portKey in eomLookup) {
    if (!match(portKey)) continue;
    const monthData = eomLookup[portKey][monthKey];
    if (!monthData) continue;
    for (const cargo in monthData) {
      const qty = monthData[cargo];
      if (qty && Math.round(qty) !== 0) { stock[cargo] = (stock[cargo] || 0) + qty; found = true; }
    }
  }
  if (!found) return null;
  const cleaned = {};
  let hasAny = false;
  for (const c in stock) if (Math.round(stock[c]) !== 0) { cleaned[c] = stock[c]; hasAny = true; }
  return hasAny ? cleaned : null;
}

function buildSections(entries, eomLookup, monthKey) {
  const combined = {};
  entries.forEach(e => {
    const key = `${e.rowId}|${e.port}|${e.cargo}|${e.shipper}`;
    if (!combined[key]) {
      combined[key] = { ...e, quantity: 0 };
    }
    combined[key].quantity += e.quantity;
    ['laycan','cr','eta','etb','etc'].forEach(f => { if (e[f] && !combined[key][f]) combined[key][f] = e[f]; });
  });

  const vesselRows = {};
  for (const k in combined) {
    const e = combined[k];
    const rowKey = `${e.rowId}|${e.port}|${e.shipper}`;
    if (!vesselRows[rowKey]) {
      vesselRows[rowKey] = {
        vessel: e.vessel, entity: e.entity, isClosed: e.isClosed, port: e.port, shipper: e.shipper,
        demmurage: e.demmurage, estDemmurage: '', remarks: e.remarks,
        laycan: e.laycan, cr: e.cr, eta: e.eta, etb: e.etb, etc: e.etc, cargoes: {}
      };
      vesselRows[rowKey]._calc = e;
    }
    vesselRows[rowKey].cargoes[e.cargo] = (vesselRows[rowKey].cargoes[e.cargo] || 0) + e.quantity;
  }

  const rows = Object.values(vesselRows);
  rows.forEach(r => {
    const rowTotal = Object.values(r.cargoes).reduce((sum, qty) => sum + (parseFloat(qty) || 0), 0);
    r.estDemmurage = calculateEstDemmurage(rowTotal, r._calc);
    delete r._calc;
  });

  rows.sort((a, b) => {
    const d = parseSortDate(a.eta) - parseSortDate(b.eta);
    if (d !== 0) return d;
    return parseSortDate(a.cr) - parseSortDate(b.cr);
  });

  const sections = {
    EUP_BONTANG: { key: 'EUP_BONTANG', label: 'EUP - Bontang', rows: [] },
    EUP_TJ_PURA: { key: 'EUP_TJ_PURA', label: 'EUP - Tanjung Pura', rows: [] },
    PMC: { key: 'PMC', label: 'PMC', rows: [] },
    SPC: { key: 'SPC', label: 'SPC', rows: [] },
    EUP_OTHER: { key: 'EUP_OTHER', label: 'EUP - Other Ports', rows: [] },
    TPG: { key: 'TPG', label: 'TPG - Pasir Gudang / Tanjung Langsat', rows: [] }
  };
  const otherSections = {};

  rows.forEach(r => {
    const portUpper = r.port.toUpperCase();
    if (r.shipper === 'EUP') {
      if (portUpper.indexOf('BONTANG') !== -1) sections.EUP_BONTANG.rows.push(r);
      else if (portUpper.indexOf('TANJUNG PURA') !== -1 || portUpper.indexOf('TJ PURA') !== -1 || portUpper.indexOf('T.PURA') !== -1) sections.EUP_TJ_PURA.rows.push(r);
      else sections.EUP_OTHER.rows.push(r);
    } else if (sections[r.shipper]) sections[r.shipper].rows.push(r);
    else {
      if (!otherSections[r.shipper]) otherSections[r.shipper] = { label: r.shipper, rows: [], isJPN: r.shipper === 'JPN' };
      otherSections[r.shipper].rows.push(r);
    }
  });

  const primary = [];
  ['EUP_BONTANG','EUP_TJ_PURA','PMC','SPC','EUP_OTHER','TPG'].forEach(key => {
    if (sections[key].rows.length > 0) {
      sections[key].eomStock = getEomStockForSection(key, eomLookup, monthKey);
      primary.push(sections[key]);
    }
  });

  const secondary = [];
  Object.keys(otherSections).sort().forEach(key => {
    if (otherSections[key].rows.length > 0) secondary.push(otherSections[key]);
  });

  return { primary, secondary };
}

function buildExportSummary(mainData, eomData) {
  if (!mainData || mainData.length === 0) return { monthlyData: [], allCargoes: [], today: '' };

  const now = new Date();
  const cm = now.getMonth(), cy = now.getFullYear();
  const pd = new Date(cy, cm - 1, 1), nd = new Date(cy, cm + 1, 1);
  const targetMonths = [
    { month: pd.getMonth(), year: pd.getFullYear(), label: `${MONTHS[pd.getMonth()]} ${pd.getFullYear()}` },
    { month: cm, year: cy, label: `${MONTHS[cm]} ${cy}` },
    { month: nd.getMonth(), year: nd.getFullYear(), label: `${MONTHS[nd.getMonth()]} ${nd.getFullYear()}` }
  ];

  const entriesByMonth = {};
  const allCargoes = {};

  for (let i = 1; i < mainData.length; i++) {
    const row = mainData[i];
    if (!row) continue;
    const vessel = row[COL.VESSEL] ? row[COL.VESSEL].toString().trim() : '';
    if (!vessel) continue;
    const entity = row[COL.ENTITY] ? row[COL.ENTITY].toString().trim() : '';
    const demmRateRaw = row[COL.DEMM];
    const laytimeRateRaw = row[COL.LAYTIME_RATE];
    const laytimeStarts = row[COL.LAYTIME_STARTS] ? row[COL.LAYTIME_STARTS].toString().trim() : '';
    const exportRemarks = row[COL.EXPORT_REMARKS] ? row[COL.EXPORT_REMARKS].toString().trim() : '';
    const { month: rm, year: ry } = parseMonthYear(row[COL.MONTH]);
    if (rm === -1) continue;
    const monthKey = `${ry}-${rm < 10 ? '0' : ''}${rm}`;
    if (!targetMonths.some(t => t.month === rm && t.year === ry)) continue;

    for (const base of PORT_COLUMNS) {
      const portName = row[base + OFFSET.PORT] ? row[base + OFFSET.PORT].toString().trim() : '';
      const status = row[base + OFFSET.STATUS] ? row[base + OFFSET.STATUS].toString().trim() : '';
      const shipper = row[base + OFFSET.SHIPPER] ? row[base + OFFSET.SHIPPER].toString().trim() : '';
      const quantity = row[base + OFFSET.QUANTITY];
      const cargo = row[base + OFFSET.CARGO] ? row[base + OFFSET.CARGO].toString().trim() : '';
      const portClosed = row[base + OFFSET.PORT_STATUS] ? row[base + OFFSET.PORT_STATUS].toString().trim().toLowerCase() : '';

      if (!portName || status.toLowerCase() !== 'load') continue;
      if (!shipper) continue;
      const numQty = parseFloat(quantity) || 0;
      if (numQty <= 0) continue;

      if (cargo) allCargoes[cargo] = true;
      if (!entriesByMonth[monthKey]) entriesByMonth[monthKey] = [];
      entriesByMonth[monthKey].push({
        vessel, rowId: i, entity, isClosed: portClosed === 'closed',
        port: portName, shipper: shipper.toUpperCase(), quantity: numQty, cargo,
        demmurage: formatRate(row[COL.DEMM]),
        estDemmurage: '',
        remarks: exportRemarks,
        demmRateRaw,
        laytimeRateRaw,
        laytimeStarts,
        laycan: formatDate(row[base + OFFSET.LAYCAN]),
        cr: formatDate(row[base + OFFSET.CR]),
        eta: formatDate(row[base + OFFSET.ETA]),
        etb: formatDate(row[base + OFFSET.ETB]),
        etc: formatDate(row[base + OFFSET.ETC]),
        etaRaw: row[base + OFFSET.ETA],
        etaTimeRaw: row[base + OFFSET.ETA_TIME],
        etbRaw: row[base + OFFSET.ETB],
        etbTimeRaw: row[base + OFFSET.ETB_TIME],
        etcRaw: row[base + OFFSET.ETC],
        etcTimeRaw: row[base + OFFSET.ETC_TIME]
      });
    }
  }

  const eomLookup = buildEomLookup(eomData);
  const monthlyData = targetMonths.map(tm => {
    const monthKey = `${tm.year}-${tm.month < 10 ? '0' : ''}${tm.month}`;
    const result = buildSections(entriesByMonth[monthKey] || [], eomLookup, monthKey);
    return { label: tm.label, primarySections: result.primary, secondarySections: result.secondary };
  });

  const today = `${String(now.getDate()).padStart(2,'0')}/${MONTHS_SHORT[cm]}/${String(cy).slice(-2)}`;
  return { monthlyData, allCargoes: Object.keys(allCargoes), today };
}

function etaToIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const d = serialToDate(value);
    return d ? d.toISOString().slice(0, 10) : null;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime()) && value.match(/\d/)) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

// Flat list of vessel ETAs by (port, cargo) for overlay on stock summary chart.
// Only includes ETAs inside the [start, end] window (ISO dates inclusive).
function buildVesselSchedule(mainData, startIso, endIso) {
  if (!mainData || mainData.length === 0) return [];
  const start = startIso ? new Date(startIso + 'T00:00:00') : null;
  const end = endIso ? new Date(endIso + 'T23:59:59') : null;
  const out = [];

  for (let i = 1; i < mainData.length; i++) {
    const row = mainData[i];
    if (!row) continue;
    const vessel = row[COL.VESSEL] ? row[COL.VESSEL].toString().trim() : '';
    if (!vessel) continue;

    for (const base of PORT_COLUMNS) {
      const portName = row[base + OFFSET.PORT] ? row[base + OFFSET.PORT].toString().trim() : '';
      const status = row[base + OFFSET.STATUS] ? row[base + OFFSET.STATUS].toString().trim() : '';
      const cargo = row[base + OFFSET.CARGO] ? row[base + OFFSET.CARGO].toString().trim() : '';
      const quantity = parseFloat(row[base + OFFSET.QUANTITY]) || 0;
      const etaIso = etaToIso(row[base + OFFSET.ETA]);
      const portClosed = row[base + OFFSET.PORT_STATUS] ? row[base + OFFSET.PORT_STATUS].toString().trim().toLowerCase() : '';

      if (!portName || !etaIso || quantity <= 0) continue;
      if (status.toLowerCase() !== 'load') continue;
      if (start && end) {
        const d = new Date(etaIso + 'T00:00:00');
        if (d < start || d > end) continue;
      }
      out.push({ vessel, port: portName, cargo, quantity, eta: etaIso, isClosed: portClosed === 'closed' });
    }
  }
  return out;
}

module.exports = { buildExportSummary, buildVesselSchedule };
