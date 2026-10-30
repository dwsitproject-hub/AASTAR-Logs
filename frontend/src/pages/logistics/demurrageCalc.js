// Demurrage calculation — ported verbatim from the backend's canonical logic in
// backend/services/exportSummary.js (calculateDemmDays / calculateEstDemmurage).
// Keep these two in sync: this is the same company formula, run client-side so
// the Demurrage calculator page recomputes instantly on input change.
//
// Formula:
//   laytimeStart = ETA + 6h ("NOR +6") | ETB ("All Fast")
//                = first laycan date + 6h ("Laycan NOR+6")
//                | first laycan date at 00:00 ("Laycan All Fast")
//   allowedDays  = (totalCargo / laytimeRate) / 24
//   actualDays   = (ETC - laytimeStart) / 24h
//   demmDays     = max(0, actualDays - allowedDays)
//   estDemurrage = demmDays * demmRate

export function parseNumber(value) {
  if (value == null || value === '') return null;
  const m = value.toString().match(/-?[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// Accepts an ISO date string (YYYY-MM-DD) or a Date; returns a Date at local midnight.
function parseDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
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

export function parseLaycanStart(value, fallbackYear) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const text = value.toString().trim();
  if (!text) return null;
  const year = Number(fallbackYear) || new Date().getFullYear();

  const monthMatch = text.match(/(?:^|[^\d])(\d{1,2})\s*([A-Za-z]{3,9})(?:\s*,?\s*(\d{2,4}))?\b/);
  if (monthMatch) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const month = months.indexOf(monthMatch[2].slice(0, 3).toLowerCase());
    if (month >= 0) {
      const parsedYear = monthMatch[3] ? Number(monthMatch[3]) : year;
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

// Accepts "HH:MM" (24h) strings; empty -> midnight.
export function parseTimeParts(value) {
  if (value === null || value === undefined || value === '') return { hours: 0, minutes: 0 };
  if (value instanceof Date && !isNaN(value.getTime())) return { hours: value.getHours(), minutes: value.getMinutes() };
  const m = value.toString().trim().match(/(\d{1,2}):(\d{2})/);
  if (!m) return { hours: 0, minutes: 0 };
  return {
    hours: Math.min(23, Math.max(0, parseInt(m[1], 10))),
    minutes: Math.min(59, Math.max(0, parseInt(m[2], 10))),
  };
}

// Normalize a sheet time value (e.g. "2:00 PM", "1400", "14:00") to "HH:MM" for <input type="time">.
export function normalizeTime(value) {
  if (value == null || value === '') return '';
  const s = value.toString().trim();
  let m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return `${String(Math.min(23, h)).padStart(2, '0')}:${String(Math.min(59, min)).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{2})(\d{2})$/); // "1400"
  if (m) return `${m[1]}:${m[2]}`;
  return '';
}

export function combineDateTime(dateValue, timeValue) {
  const d = parseDateOnly(dateValue);
  if (!d) return null;
  const t = parseTimeParts(timeValue);
  d.setHours(t.hours, t.minutes, 0, 0);
  return d;
}

export function formatMoney(value) {
  if (!isFinite(value) || value <= 0) return '';
  return `USD ${Math.round(value).toLocaleString('en-US')}`;
}

// Which of ETA/ETB drives laytime start, from the "Laytime Starts" basis string.
export function laytimeStartBasis(laytimeStarts) {
  const s = (laytimeStarts || '').toString().trim().toLowerCase();
  if (s.indexOf('laycan') !== -1 && s.indexOf('nor') !== -1) return 'laycan_nor';
  if (s.indexOf('laycan') !== -1 && (s.indexOf('all fast') !== -1 || s.indexOf('allfast') !== -1)) return 'laycan_allfast';
  if (s.indexOf('nor') !== -1) return 'nor';
  if (s.indexOf('all fast') !== -1 || s.indexOf('allfast') !== -1) return 'allfast';
  return null;
}

/**
 * Compute a full demurrage breakdown for the calculator.
 * inputs: { totalCargo, laytimeRate, demmRate, laytimeStarts,
 *           etaDate, etaTime, etbDate, etbTime, etcDate, etcTime }
 * Returns { ok, error, basis, laytimeStart, allowedDays, actualDays,
 *           rawDiffDays, demmDays, estDemurrage, withinLaytime }
 */
export function calculateDemurrage(inputs) {
  const totalCargo = parseNumber(inputs.totalCargo);
  const laytimeRate = parseNumber(inputs.laytimeRate);
  const demmRate = parseNumber(inputs.demmRate);
  const basis = laytimeStartBasis(inputs.laytimeStarts);

  if (!basis) return { ok: false, error: 'Set Laytime Starts to "NOR +6", "All Fast", "Laycan NOR+6", or "Laycan All Fast".' };
  if (!totalCargo) return { ok: false, error: 'Enter a total cargo quantity.' };
  if (!laytimeRate) return { ok: false, error: 'Enter a laytime rate (MT/hr).' };

  const eta = combineDateTime(inputs.etaDate, inputs.etaTime);
  const etb = combineDateTime(inputs.etbDate, inputs.etbTime);
  const etc = combineDateTime(inputs.etcDate, inputs.etcTime);
  if (!etc) return { ok: false, error: 'Enter a valid ETC (completion) date.' };

  let laytimeStart = null;
  if (basis === 'nor') {
    if (!eta) return { ok: false, error: 'NOR basis needs a valid ETA date.' };
    laytimeStart = new Date(eta.getTime() + 6 * 60 * 60 * 1000);
  } else if (basis === 'allfast') {
    if (!etb) return { ok: false, error: 'All Fast basis needs a valid ETB date.' };
    laytimeStart = etb;
  } else if (basis === 'laycan_nor' || basis === 'laycan_allfast') {
    laytimeStart = parseLaycanStart(inputs.laycan, inputs.laycanYear || (inputs.etaDate || inputs.etbDate || inputs.etcDate || '').slice(0, 4));
    if (!laytimeStart) return { ok: false, error: 'Laycan basis needs a valid first laycan date.' };
    if (basis === 'laycan_nor') laytimeStart = new Date(laytimeStart.getTime() + 6 * 60 * 60 * 1000);
  }

  const actualDays = (etc.getTime() - laytimeStart.getTime()) / (24 * 60 * 60 * 1000);
  const allowedDays = (totalCargo / laytimeRate) / 24;
  const rawDiffDays = actualDays - allowedDays;
  const demmDays = isFinite(rawDiffDays) && rawDiffDays > 0 ? rawDiffDays : 0;
  const estDemurrage = demmRate ? demmDays * demmRate : null;

  return {
    ok: true,
    basis,
    laytimeStart,
    allowedDays,
    actualDays,
    rawDiffDays,
    demmDays,
    estDemurrage,
    withinLaytime: rawDiffDays <= 0,
  };
}
