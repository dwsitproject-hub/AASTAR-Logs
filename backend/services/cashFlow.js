'use strict';

// Pure cash-flow analytics over Shpt File rows. No I/O — the route feeds it rows
// from shpt_file.db. Timing basis (per user): cash OUT at PMT DATE else B/L DATE;
// cash IN at PMT REC DATE else DUE DATE else B/L DATE. All figures USD.

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

// Parse "$ 223,750.00", "250.000", "$ -", "(1,234)" -> number (0 if blank/dash).
function num(v) {
  if (v == null) return 0;
  let t = String(v).replace(/[$,\s]/g, '');
  if (t === '' || t === '-' || t === '–') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  const m = t.match(/-?\d+(\.\d+)?/);
  if (!m) return 0;
  let n = parseFloat(m[0]);
  return neg ? -n : n;
}

// Parse "1 Jan 24", "19-Jan-24", "JAN'24", "Jan-2024" -> {y, m, key:'YYYY-MM'} | null
function parseMonth(v) {
  if (!v) return null;
  const t = String(v).trim();
  let mo = null, yr = null;
  let m = t.match(/(\d{1,2})[-\s]+([A-Za-z]{3,})[-'\s.]*(\d{2,4})/); // day mon year
  if (m) { mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; yr = parseInt(m[3], 10); }
  else {
    m = t.match(/([A-Za-z]{3,})[-'\s.]*(\d{2,4})/); // mon year
    if (m) { mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; yr = parseInt(m[2], 10); }
  }
  if (!mo || !yr) return null;
  if (yr < 100) yr += 2000;
  return { y: yr, m: mo, key: `${yr}-${String(mo).padStart(2, '0')}` };
}
const addMonths = (key, n) => {
  const [y, m] = key.split('-').map(Number);
  const idx = (y * 12 + (m - 1)) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
};

function computeCashFlow(rows, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const nowKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const monthly = {};        // key -> {out, in}
  const bump = (k, field, val) => { if (!k || !val) return; (monthly[k] || (monthly[k] = { out: 0, in: 0 }))[field] += val; };

  const byCargo = {}, bySeller = {}, byBuyer = {};
  const add = (obj, key, o, s, q) => { if (!key) return; const e = obj[key] || (obj[key] = { key, purchase: 0, sale: 0, qty: 0, count: 0 }); e.purchase += o; e.sale += s; e.qty += q; e.count++; };

  let totalPurchase = 0, totalSale = 0, totalQty = 0;
  let receivablesOutstanding = 0, payablesOpen = 0;
  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };

  for (const r of rows) {
    const outVal = num(r.purchase_value_usd) + num(r.other_costs);
    const inVal = num(r.invoice_value_usd);
    const qty = num(r.bl_quantity);
    totalPurchase += outVal; totalSale += inVal; totalQty += qty;

    const outMonth = (parseMonth(r.pmt_date) || parseMonth(r.bl_date) || {}).key;
    const inMonth = (parseMonth(r.pmt_rec_date) || parseMonth(r.due_date) || parseMonth(r.bl_date) || {}).key;
    bump(outMonth, 'out', outVal);
    bump(inMonth, 'in', inVal);

    add(byCargo, r.cargo || '(none)', outVal, inVal, qty);
    add(bySeller, r.seller || '(none)', outVal, inVal, qty);
    add(byBuyer, r.buyer || '(none)', outVal, inVal, qty);

    // Open exposure
    const outstanding = num(r.invoice_outstanding_usd);
    if (outstanding > 0.5) {
      receivablesOutstanding += outstanding;
      let od = num(r.nod_overdue);
      if (!od) { const dm = parseMonth(r.due_date); if (dm) { const due = new Date(Date.UTC(dm.y, dm.m - 1, 15)); od = Math.round((now - due) / 86400000); } }
      if (od <= 0) aging.current += outstanding;
      else if (od <= 30) aging.d1_30 += outstanding;
      else if (od <= 60) aging.d31_60 += outstanding;
      else if (od <= 90) aging.d61_90 += outstanding;
      else aging.d90p += outstanding;
    }
    if (!String(r.pmt_date || '').trim() && outVal > 0.5) payablesOpen += outVal;
  }

  // Monthly series + cumulative financing line
  const series = Object.keys(monthly).sort().map(k => ({ month: k, out: round(monthly[k].out), in: round(monthly[k].in), net: round(monthly[k].in - monthly[k].out) }));
  let cum = 0, minCum = 0, minMonth = null;
  for (const p of series) { cum += p.net; p.cumulative = round(cum); if (cum < minCum) { minCum = cum; minMonth = p.month; } }
  const peakFinancing = round(-minCum);

  // Historical run-rate (last 6 months that have any data, up to now)
  const hist = series.filter(p => p.month <= nowKey).slice(-6);
  const avgOut = hist.length ? hist.reduce((s, p) => s + p.out, 0) / hist.length : 0;
  const avgIn = hist.length ? hist.reduce((s, p) => s + p.in, 0) / hist.length : 0;

  // Forward projection: next 6 months. Month 1 also absorbs current open payables
  // (cash out) and open receivables (cash in); every month adds the historical
  // average run-rate. Cumulative from 0 -> projected peak financing need.
  const projection = [];
  let pcum = 0, pmin = 0;
  for (let i = 1; i <= 6; i++) {
    const month = addMonths(nowKey, i);
    let pOut = avgOut, pIn = avgIn;
    if (i === 1) { pOut += payablesOpen; pIn += receivablesOutstanding; }
    const net = pIn - pOut;
    pcum += net;
    if (pcum < pmin) pmin = pcum;
    projection.push({ month, out: round(pOut), in: round(pIn), net: round(net), cumulative: round(pcum) });
  }
  const projectedPeakFinancing = round(-pmin);

  const topN = (obj, key = 'purchase', n = 12) => Object.values(obj)
    .map(e => ({ key: e.key, purchase: round(e.purchase), sale: round(e.sale), qty: round(e.qty), count: e.count }))
    .sort((a, b) => b[key] - a[key]).slice(0, n);

  return {
    generatedAt: new Date().toISOString(),
    now: nowKey,
    totals: { rows: rows.length, purchase: round(totalPurchase), sale: round(totalSale), qty: round(totalQty), netMargin: round(totalSale - totalPurchase) },
    series,
    peakFinancing, peakMonth: minMonth,
    exposure: { receivablesOutstanding: round(receivablesOutstanding), payablesOpen: round(payablesOpen), netExposure: round(receivablesOutstanding - payablesOpen), aging: mapRound(aging) },
    runRate: { avgOut: round(avgOut), avgIn: round(avgIn), avgNet: round(avgIn - avgOut), monthsUsed: hist.length },
    projection, projectedPeakFinancing,
    breakdown: { byCargo: topN(byCargo, 'purchase'), bySeller: topN(bySeller, 'purchase'), byBuyer: topN(byBuyer, 'sale') },
  };
}

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const mapRound = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));

module.exports = { computeCashFlow, num, parseMonth };
