'use strict';

// Unified matching sales/purchase service — handles 4 tabs with different column layouts.
// Each tab has its own config describing which columns to display, edit, filter, and merge-exclude.

const TAB_CONFIGS = {
  'AASTAR SALES': {
    label: 'AASTAR SALES',
    // Columns to display (field name → column index)
    columns: {
      ref: 0, year: 1, status: 9, trader: 10, trade_date: 11, cargo: 12, buyer: 13,
      contract_no: 14, broker: 15, broker_ref: 16, brokerage: 17, qty: 18, tolerance: 19,
      incoterm: 20, basis: 21, contract_start: 26, contract_end: 27, shpt_mth: 29,
      discharge_port: 32, discharge_country: 33, payment_terms: 34, remarks: 35,
      intention_vessel: 36, vsl_id: 43, partial: 44
    },
    // Collapsed card fields (in order)
    collapsed: ['ref', 'qty', 'cargo', 'buyer', 'contract_no', 'broker', 'broker_ref', 'intention_vessel', 'contract_start', 'contract_end'],
    // Editable text-box fields shown on collapsed card
    editBoxCollapsed: ['vsl_id'],
    // Primary editable fields (highlighted)
    primaryEditable: ['intention_vessel', 'vsl_id'],
    // Filters
    filters: { status: 9, cargo: 12, buyer: 13, contract_no: 14, contract_start: 26, contract_end: 27, year: 1, vessel: 36, vsl_id: 43 },
    // Default filter values
    defaultStatus: ['OPEN', 'PROV', 'SPACE'],
    defaultYear: ['1899', '2026'],
    // Columns excluded from merge (partial shipment)
    noMerge: [0, 36, 43, 44],
    // Column for partial indicator
    partialCol: 44,
    // Columns NOT filled down
    noFillDown: [0, 36, 43, 44],
  },
  'AASTAR PURCHASE': {
    label: 'AASTAR PURCHASE',
    columns: {
      ref: 0, year: 1, status: 8, trader: 9, trade_date: 10, cargo: 11, buyer: 12,
      seller_ref: 13, contract_no: 14, broker: 15, broker_ref: 16, qty: 17, tolerance: 18,
      incoterm: 19, basis: 20, contract_start: 24, contract_end: 25,
      origin_country: 26, load_port: 27, discharge_port: 28, discharge_country: 29,
      payment_terms: 30, remarks: 31, intention_vessel: 32, vsl_id: 33, partial: 34
    },
    collapsed: ['ref', 'qty', 'cargo', 'buyer', 'contract_no', 'broker', 'broker_ref', 'intention_vessel', 'contract_start', 'contract_end'],
    editBoxCollapsed: ['vsl_id'],
    primaryEditable: ['intention_vessel', 'vsl_id'],
    filters: { status: 8, cargo: 11, buyer: 12, contract_no: 14, contract_start: 24, contract_end: 25, year: 1, vessel: 32, vsl_id: 33 },
    defaultStatus: ['OPEN', 'PROV', 'SPACE'],
    defaultYear: ['1899', '2026', '2027'],
    noMerge: [0, 32, 33, 34],
    partialCol: 34,
    noFillDown: [0, 32, 33, 34],
  },
  'KIMARA SALES': {
    label: 'KIMARA SALES',
    columns: {
      ref: 0, year: 1, status: 9, trader: 10, trade_date: 11, cargo: 12, buyer: 13,
      contract_no: 14, broker: 15, broker_ref: 16, brokerage: 17, qty: 18, tolerance: 19,
      incoterm: 20, basis: 21, contract_start: 26, contract_end: 27, shpt_mth: 29,
      discharge_port: 32, discharge_country: 33, payment_terms: 34, remarks: 35,
      intention_vessel: 36, vsl_id: 39, partial: 40
    },
    collapsed: ['ref', 'qty', 'cargo', 'buyer', 'contract_no', 'broker', 'broker_ref', 'intention_vessel', 'contract_start', 'contract_end'],
    editBoxCollapsed: ['vsl_id'],
    primaryEditable: ['intention_vessel', 'vsl_id'],
    filters: { status: 9, cargo: 12, buyer: 13, contract_no: 14, contract_start: 26, contract_end: 27, year: 1, vessel: 36, vsl_id: 39 },
    defaultStatus: ['OPEN', 'PROV', 'SPACE'],
    defaultYear: ['1899', '2026', '2027'],
    noMerge: [0, 36, 39, 40],
    partialCol: 40,
    noFillDown: [0, 36, 39, 40],
  },
  'KIMARA PURCHASE': {
    label: 'KIMARA PURCHASE',
    columns: {
      ref: 0, year: 1, status: 8, trader: 9, trade_date: 10, cargo: 11, buyer: 12,
      seller_ref: 13, contract_no: 14, broker: 15, broker_ref: 16, qty: 17, tolerance: 18,
      incoterm: 19, basis: 20, contract_start: 25, contract_end: 26,
      load_port: 27, discharge_port: 28, discharge_country: 29,
      payment_terms: 30, remarks: 31, intention_vessel: 32, vsl_id: 33, partial: 34
    },
    collapsed: ['ref', 'qty', 'cargo', 'buyer', 'contract_no', 'broker', 'broker_ref', 'intention_vessel', 'contract_start', 'contract_end'],
    editBoxCollapsed: ['vsl_id'],
    primaryEditable: ['intention_vessel', 'vsl_id'],
    filters: { status: 8, cargo: 11, buyer: 12, contract_no: 14, contract_start: 25, contract_end: 26, year: 1, vessel: 32, vsl_id: 33 },
    defaultStatus: ['OPEN', 'PROV', 'SPACE'],
    defaultYear: ['1899', '2026', '2027'],
    noMerge: [0, 32, 33, 34],
    partialCol: 34,
    noFillDown: [0, 32, 33, 34],
  }
};

const LABELS = {
  ref:'Ref', year:'Year', status:'Status', trader:'Trader', trade_date:'Trade Date',
  cargo:'Cargo', buyer:'Buyer/Seller', contract_no:'Contract No', broker:'Broker',
  broker_ref:'Broker Ref', brokerage:'Brokerage/MT', qty:'Qty', tolerance:'Tolerance',
  incoterm:'Incoterm', basis:'Basis', contract_start:'Contract Start', contract_end:'Contract End',
  shpt_mth:'Shpt Mth', discharge_port:'Discharge Port', discharge_country:'Discharge Country',
  payment_terms:'Payment Terms', remarks:'Remarks', intention_vessel:'Intention Vessel',
  vsl_id:'VSL_ID', partial:'Partial', seller_ref:'Seller Ref', origin_country:'Origin',
  load_port:'Load Port'
};

function str(v) { return v == null ? '' : v.toString().trim(); }

function buildRows(data, tabConfig) {
  if (!data || data.length < 2) return { rows: [], filters: {} };
  const { columns, noFillDown, partialCol, filters: filterDefs } = tabConfig;
  const noFill = new Set(noFillDown || []);

  const rows = [];
  const filterSets = {};
  for (const key of Object.keys(filterDefs)) filterSets[key] = new Set();
  let prevRow = null;

  for (let r = 1; r < data.length; r++) {
    const raw = data[r];
    if (!raw) continue;
    const row = { _row: r + 1 };

    for (const [fieldName, colIdx] of Object.entries(columns)) {
      let val = str(raw[colIdx]);
      if (!val && prevRow && !noFill.has(colIdx)) {
        val = prevRow[fieldName] || '';
      }
      row[fieldName] = val;
    }

    rows.push(row);
    prevRow = row;

    // Collect filter values
    for (const [filterKey, colIdx] of Object.entries(filterDefs)) {
      const val = str(raw[colIdx]);
      if (val) filterSets[filterKey].add(val);
    }
  }

  const filters = {};
  for (const [key, set] of Object.entries(filterSets)) {
    filters[key] = [...set].sort();
  }
  return { rows, filters };
}

module.exports = { TAB_CONFIGS, LABELS, buildRows };
