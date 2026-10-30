// Port of Exportsummary.gs - processes DB6 vessel data + DB7 EOM stock.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT_COLUMNS = [20, 36, 52, 68, 84, 100, 116, 132, 148, 164];
const OFFSET = { PORT:0, STATUS:1, SHIPPER:2, PRICE:3, QUANTITY:4, CARGO:5, PORT_STATUS:6, LAYCAN:7, CR:8, ETA:9, ETA_TIME:10, ETB:11, ETB_TIME:12, ETC:13, ETC_TIME:14 };
const COL = { CHARTERER:1, ENTITY:2, MONTH:3, VESSEL:4, EST_DEMM:6, VSL_SIZE:10, DEMM:14, LAYTIME_RATE:15, LAYTIME_STARTS:16 };

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function numericValue(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return isFinite(number) ? number : null;
}

// Google Sheets serial number → JS Date. Serial 1 = 1899-12-31 (Lotus 1-2-3 quirk → 1900-01-01 in Google).
function serialToDate(serial) {
  const number = numericValue(serial);
  if (number == null) return null;
  // Google Sheets epoch: 1899-12-30 (accounts for the 1900 leap year bug).
  const ms = (number - 25569) * 86400 * 1000;
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
  if (typeof value === 'string' && numericValue(value) != null) {
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
  return `USD ${Math.round(n).toLocaleString('en-US')}`;
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
  const serial = numericValue(s);
  if (serial != null && serial > 20000) {
    const d = serialToDate(serial);
    return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime()) && s.match(/\d/)) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }
  return null;
}

function parseLaycanStart(value, fallbackYear) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date || typeof value === 'number') return parseDateOnly(value);

  const text = value.toString().trim();
  if (!text) return null;
  const year = Number(fallbackYear) || new Date().getFullYear();

  // Laycan is usually stored as a range such as "10 AUG - 20 AUG". Use the
  // first date in the range and inherit the vessel month year when omitted.
  const monthMatch = text.match(/(?:^|[^\d])(\d{1,2})\s*([A-Za-z]{3,9})(?:\s*,?\s*(\d{2,4}))?\b/);
  if (monthMatch) {
    const month = MONTHS_SHORT.findIndex(m => m.toLowerCase() === monthMatch[2].slice(0, 3).toLowerCase());
    if (month >= 0) {
      let explicitYear = monthMatch[3] || '';
      if (explicitYear.length === 2) {
        const textAfterMatch = text.slice((monthMatch.index || 0) + monthMatch[0].length);
        if (/^\s*[A-Za-z]{3,9}\b/.test(textAfterMatch)) explicitYear = '';
      }
      const parsedYear = explicitYear ? Number(explicitYear) : year;
      const normalizedYear = parsedYear < 100 ? 2000 + parsedYear : parsedYear;
      const date = new Date(normalizedYear, month, Number(monthMatch[1]));
      if (date.getFullYear() === normalizedYear && date.getMonth() === month && date.getDate() === Number(monthMatch[1])) return date;
    }
  }

  const numericMatch = text.match(/(?:^|[^\d])(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?/);
  if (numericMatch) {
    const parsedYear = numericMatch[3] ? Number(numericMatch[3]) : year;
    const normalizedYear = parsedYear < 100 ? 2000 + parsedYear : parsedYear;
    const day = Number(numericMatch[1]);
    const month = Number(numericMatch[2]) - 1;
    const date = new Date(normalizedYear, month, day);
    if (date.getFullYear() === normalizedYear && date.getMonth() === month && date.getDate() === day) return date;
  }

  return parseDateOnly(text);
}

function parseTimeParts(value) {
  if (value === null || value === undefined || value === '') return { hours: 0, minutes: 0 };
  if (value instanceof Date && !isNaN(value.getTime())) return { hours: value.getHours(), minutes: value.getMinutes() };
  if (typeof value === 'number' && isFinite(value)) {
    const fraction = ((value % 1) + 1) % 1;
    const totalMinutes = Math.round(fraction * 24 * 60) % (24 * 60);
    return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
  }
  const numeric = numericValue(value);
  if (numeric != null && numeric >= 0 && numeric < 1) {
    const totalMinutes = Math.round(numeric * 24 * 60) % (24 * 60);
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

function calculateDemmDays(rowTotal, item) {
  const laytimeRate = parseNumber(item.laytimeRateRaw);
  if (!rowTotal || !laytimeRate) return null;

  const starts = (item.laytimeStarts || '').toString().trim().toLowerCase();
  const eta = combineDateTime(item.etaRaw, item.etaTimeRaw);
  const etb = combineDateTime(item.etbRaw, item.etbTimeRaw);
  const etc = combineDateTime(item.etcRaw, item.etcTimeRaw);
  if (!etc) return null;

  let laytimeStart = null;
  if (starts.indexOf('laycan') !== -1 && starts.indexOf('nor') !== -1) {
    const laycanStart = parseLaycanStart(item.laycanRaw, item.laycanYear);
    if (!laycanStart) return null;
    laytimeStart = new Date(laycanStart.getTime() + 6 * 60 * 60 * 1000);
  } else if (starts.indexOf('laycan') !== -1 && (starts.indexOf('all fast') !== -1 || starts.indexOf('allfast') !== -1)) {
    const laycanStart = parseLaycanStart(item.laycanRaw, item.laycanYear);
    if (!laycanStart) return null;
    laytimeStart = laycanStart;
  } else if (starts.indexOf('nor') !== -1) {
    if (!eta) return null;
    const laycanStart = parseLaycanStart(item.laycanRaw, item.laycanYear);
    laytimeStart = laycanStart && eta.getTime() <= laycanStart.getTime()
      ? laycanStart
      : new Date(eta.getTime() + 6 * 60 * 60 * 1000);
  } else if (starts.indexOf('all fast') !== -1 || starts.indexOf('allfast') !== -1) {
    if (!etb) return null;
    laytimeStart = etb;
  } else {
    return null;
  }

  const actualDays = (etc.getTime() - laytimeStart.getTime()) / (24 * 60 * 60 * 1000);
  const allowedDays = (rowTotal / laytimeRate) / 24;
  const demmDays = actualDays - allowedDays;
  return isFinite(demmDays) && demmDays > 0 ? demmDays : 0;
}

function formatDemmDays(value) {
  if (value === null || value === undefined || !isFinite(value) || value <= 0) return '';
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function calculateEstDemmurage(rowTotal, item) {
  const demmRate = parseNumber(item.demmRateRaw);
  if (!demmRate) return '';
  const demmDays = calculateDemmDays(rowTotal, item);
  if (!demmDays) return '';
  return formatMoney(demmDays * demmRate);
}

function parseMonthYear(value) {
  if (!value && value !== 0) return { month: -1, year: -1 };
  if (value instanceof Date) return { month: value.getMonth(), year: value.getFullYear() };
  const numeric = numericValue(value);
  if (numeric != null && numeric > 20000) {
    const d = serialToDate(numeric);
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

function resolveEntryMonth(laycanValue, fallbackMonthYear, now = new Date()) {
  const fallback = fallbackMonthYear || { month: -1, year: -1 };
  if (laycanValue !== null && laycanValue !== undefined && laycanValue !== '') {
    const fallbackYear = fallback.year >= 0 ? fallback.year : now.getFullYear();
    const start = parseLaycanStart(laycanValue, fallbackYear);
    if (start) return { month: start.getMonth(), year: start.getFullYear() };

    const text = laycanValue.toString().trim();
    const month = MONTHS_SHORT.findIndex(name => new RegExp(`\\b${name}`, 'i').test(text));
    if (month >= 0) {
      const explicitYear = text.match(/\b(20\d{2})\b/);
      let year = explicitYear ? Number(explicitYear[1]) : fallbackYear;
      if (!explicitYear && fallback.month >= 0) {
        if (month - fallback.month <= -6) year += 1;
        else if (month - fallback.month >= 6) year -= 1;
      }
      return { month, year };
    }
  }
  return fallback;
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
        demmKey: rowKey,
        vessel: e.vessel, vesselSize: e.vesselSize, charterer: e.charterer, entity: e.entity, isClosed: e.isClosed, port: e.port, shipper: e.shipper,
        demmurage: e.demmurage, estDemmurage: '', demmDays: '',
        laycan: e.laycan, cr: e.cr, eta: e.eta, etb: e.etb, etc: e.etc, cargoes: {}
      };
      vesselRows[rowKey]._calc = e;
    }
    vesselRows[rowKey].cargoes[e.cargo] = (vesselRows[rowKey].cargoes[e.cargo] || 0) + e.quantity;
  }

  const rows = Object.values(vesselRows);
  rows.forEach(r => {
    const rowTotal = Object.values(r.cargoes).reduce((sum, qty) => sum + (parseFloat(qty) || 0), 0);
    r.demmDays = formatDemmDays(calculateDemmDays(rowTotal, r._calc));
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

function buildExportSummary(mainData, eomData, { now = new Date(), allMonths = false } = {}) {
  if (!mainData || mainData.length === 0) {
    return { monthlyData: [], allCargoes: [], availableYears: [], today: '' };
  }

  const cm = now.getMonth(), cy = now.getFullYear();
  const pd = new Date(cy, cm - 1, 1), nd = new Date(cy, cm + 1, 1);
  let targetMonths = [
    { month: pd.getMonth(), year: pd.getFullYear(), label: `${MONTHS[pd.getMonth()]} ${pd.getFullYear()}` },
    { month: cm, year: cy, label: `${MONTHS[cm]} ${cy}` },
    { month: nd.getMonth(), year: nd.getFullYear(), label: `${MONTHS[nd.getMonth()]} ${nd.getFullYear()}` }
  ];

  const entriesByMonth = {};
  const allCargoes = {};

  for (let i = 1; i < mainData.length; i++) {
    const row = mainData[i];
    if (!row) continue;
    const vessel = row[COL.VESSEL] ? row[COL.VESSEL].toString().trim() : 'TBN';
    const vesselSize = parseNumber(row[COL.VSL_SIZE]);
    const charterer = row[COL.CHARTERER] ? row[COL.CHARTERER].toString().trim() : '';
    const entity = row[COL.ENTITY] ? row[COL.ENTITY].toString().trim() : '';
    const demmRateRaw = row[COL.DEMM];
    const laytimeRateRaw = row[COL.LAYTIME_RATE];
    const laytimeStarts = row[COL.LAYTIME_STARTS] ? row[COL.LAYTIME_STARTS].toString().trim() : '';
    const vesselMonthYear = parseMonthYear(row[COL.MONTH]);

    for (const base of PORT_COLUMNS) {
      const portName = row[base + OFFSET.PORT] ? row[base + OFFSET.PORT].toString().trim() : '';
      const status = row[base + OFFSET.STATUS] ? row[base + OFFSET.STATUS].toString().trim() : '';
      const shipper = row[base + OFFSET.SHIPPER] ? row[base + OFFSET.SHIPPER].toString().trim() : '';
      const quantity = row[base + OFFSET.QUANTITY];
      const cargo = row[base + OFFSET.CARGO] ? row[base + OFFSET.CARGO].toString().trim() : '';
      const portClosed = row[base + OFFSET.PORT_STATUS] ? row[base + OFFSET.PORT_STATUS].toString().trim().toLowerCase() : '';
      const laycanRaw = row[base + OFFSET.LAYCAN];
      const { month: entryMonth, year: entryYear } = resolveEntryMonth(laycanRaw, vesselMonthYear, now);

      if (!portName || status.toLowerCase() !== 'load') continue;
      if (!shipper) continue;
      const numQty = parseFloat(quantity) || 0;
      if (numQty <= 0) continue;
      if (entryMonth === -1) continue;
      if (!allMonths && !targetMonths.some(t => t.month === entryMonth && t.year === entryYear)) continue;

      const monthKey = `${entryYear}-${entryMonth < 10 ? '0' : ''}${entryMonth}`;

      if (cargo) allCargoes[cargo] = true;
      if (!entriesByMonth[monthKey]) entriesByMonth[monthKey] = [];
      entriesByMonth[monthKey].push({
        vessel, vesselSize, rowId: i, charterer, entity, isClosed: portClosed === 'closed',
        port: portName, shipper: shipper.toUpperCase(), quantity: numQty, cargo,
        demmurage: formatRate(row[COL.DEMM]),
        estDemmurage: '',
        demmRateRaw,
        laytimeRateRaw,
        laytimeStarts,
        laycan: formatDate(laycanRaw),
        laycanRaw,
        laycanYear: entryYear,
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

  if (allMonths) {
    targetMonths = Object.keys(entriesByMonth)
      .map(key => {
        const [year, month] = key.split('-').map(Number);
        return { month, year, label: `${MONTHS[month]} ${year}` };
      })
      .sort((a, b) => (a.year - b.year) || (a.month - b.month));
  }

  const eomLookup = buildEomLookup(eomData);
  const monthlyData = targetMonths.map(tm => {
    const monthKey = `${tm.year}-${tm.month < 10 ? '0' : ''}${tm.month}`;
    const result = buildSections(entriesByMonth[monthKey] || [], eomLookup, monthKey);
    return {
      key: `${tm.year}-${String(tm.month + 1).padStart(2, '0')}`,
      year: tm.year,
      month: tm.month + 1,
      label: tm.label,
      primarySections: result.primary,
      secondarySections: result.secondary,
    };
  });

  const today = `${String(now.getDate()).padStart(2,'0')}/${MONTHS_SHORT[cm]}/${String(cy).slice(-2)}`;
  const availableYears = [...new Set(targetMonths.map(month => month.year))].sort((a, b) => b - a);
  return { monthlyData, allCargoes: Object.keys(allCargoes), availableYears, today };
}

function etaToIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const numeric = numericValue(value);
  if (numeric != null && numeric > 20000) {
    const d = serialToDate(numeric);
    return d ? d.toISOString().slice(0, 10) : null;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime()) && value.match(/\d/)) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

// Flat list of vessel ETAs by (port, cargo) for overlay on stock summary chart.
// Uses ETA first, then CR when ETA is blank. Only includes dates inside the
// [start, end] window (ISO dates inclusive).
function buildVesselSchedule(mainData, startIso, endIso) {
  if (!mainData || mainData.length === 0) return [];
  const start = startIso ? new Date(startIso + 'T00:00:00') : null;
  const end = endIso ? new Date(endIso + 'T23:59:59') : null;
  const out = [];

  for (let i = 1; i < mainData.length; i++) {
    const row = mainData[i];
    if (!row) continue;
    const vessel = row[COL.VESSEL] ? row[COL.VESSEL].toString().trim() : 'TBN';

    for (const base of PORT_COLUMNS) {
      const portName = row[base + OFFSET.PORT] ? row[base + OFFSET.PORT].toString().trim() : '';
      const status = row[base + OFFSET.STATUS] ? row[base + OFFSET.STATUS].toString().trim() : '';
      const shipper = row[base + OFFSET.SHIPPER] ? row[base + OFFSET.SHIPPER].toString().trim().toUpperCase() : '';
      const cargo = row[base + OFFSET.CARGO] ? row[base + OFFSET.CARGO].toString().trim() : '';
      const quantity = parseFloat(row[base + OFFSET.QUANTITY]) || 0;
      const etaIso = etaToIso(row[base + OFFSET.ETA]) || etaToIso(row[base + OFFSET.CR]);
      const portClosed = row[base + OFFSET.PORT_STATUS] ? row[base + OFFSET.PORT_STATUS].toString().trim().toLowerCase() : '';

      if (!portName || !etaIso || quantity <= 0) continue;
      if (status.toLowerCase() !== 'load') continue;
      if (start && end) {
        const d = new Date(etaIso + 'T00:00:00');
        if (d < start || d > end) continue;
      }
      out.push({ vessel, port: portName, shipper, cargo, quantity, eta: etaIso, isClosed: portClosed === 'closed' });
    }
  }
  return out;
}

const DATA_DIR = process.env.DATA_DATABASE_DIR || path.join(__dirname, '../data/databases');
const exportSummaryCache = { signature: null, value: null };
const exportSummaryTotalCache = { signature: null, value: null };

function databaseFileSignature(databaseName) {
  try {
    const stat = fs.statSync(path.join(DATA_DIR, `${databaseName}.db`));
    return `${databaseName}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${databaseName}:missing`;
  }
}

function exportSummaryDatabaseSignature() {
  return `${databaseFileSignature('DB6')}|${databaseFileSignature('DB7')}`;
}

function databaseRows(databaseName, tableName, neededIndexes = null) {
  const file = path.join(DATA_DIR, `${databaseName}.db`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const schema = db.prepare(`PRAGMA table_info("${tableName}")`).all();
    const sourceColumns = schema.filter(column => column.name !== '_sheet_row');
    const selected = sourceColumns.filter((_, index) => !neededIndexes || neededIndexes.has(index));
    const select = selected.map(column => `"${column.name.replace(/"/g, '""')}"`).join(', ');
    const records = db.prepare(`SELECT ${select} FROM "${tableName}"`).all();
    const rows = [[]];
    for (const record of records) {
      const row = [];
      selected.forEach(column => {
        const index = sourceColumns.findIndex(sourceColumn => sourceColumn.name === column.name);
        const value = record[column.name];
        row[index] = numericValue(value) == null ? value : numericValue(value);
      });
      rows.push(row);
    }
    const metadata = db.prepare('SELECT pulled_at FROM _database_meta LIMIT 1').get();
    return { rows, updatedAt: metadata?.pulled_at || null };
  } finally {
    db.close();
  }
}

function loadExportSummaryDatabases() {
  const vesselIndexes = new Set([
    COL.CHARTERER, COL.ENTITY, COL.MONTH, COL.VESSEL, COL.EST_DEMM, COL.VSL_SIZE, COL.DEMM,
    COL.LAYTIME_RATE, COL.LAYTIME_STARTS,
  ]);
  for (const base of PORT_COLUMNS) {
    for (const offset of Object.values(OFFSET)) vesselIndexes.add(base + offset);
  }
  const vessel = databaseRows('DB6', 'vessel_db', vesselIndexes);
  const eom = databaseRows('DB7', 'eom');
  const updatedAt = [vessel.updatedAt, eom.updatedAt].filter(Boolean).sort().pop() || null;
  return { mainData: vessel.rows, eomData: eom.rows, updatedAt };
}

function buildExportSummaryFromDatabases() {
  const signature = exportSummaryDatabaseSignature();
  if (exportSummaryCache.value && exportSummaryCache.signature === signature) return exportSummaryCache.value;

  const { mainData, eomData, updatedAt } = loadExportSummaryDatabases();
  const value = { ...buildExportSummary(mainData, eomData), updatedAt };
  exportSummaryCache.signature = exportSummaryDatabaseSignature();
  exportSummaryCache.value = value;
  return value;
}

function buildExportSummaryTotalFromDatabases() {
  const signature = exportSummaryDatabaseSignature();
  if (exportSummaryTotalCache.value && exportSummaryTotalCache.signature === signature) {
    return exportSummaryTotalCache.value;
  }

  const { mainData, eomData, updatedAt } = loadExportSummaryDatabases();
  const value = { ...buildExportSummary(mainData, eomData, { allMonths: true }), updatedAt };
  exportSummaryTotalCache.signature = exportSummaryDatabaseSignature();
  exportSummaryTotalCache.value = value;
  return value;
}

module.exports = {
  buildExportSummary,
  buildExportSummaryFromDatabases,
  buildExportSummaryTotalFromDatabases,
  buildVesselSchedule,
  calculateDemmDays,
  calculateEstDemmurage,
  loadExportSummaryDatabases,
  resolveEntryMonth,
};
