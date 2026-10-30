'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { loadVesselDatabase, buildVesselList } = require('./vesselUpdate');

const DATA_DIR = process.env.DATA_DATABASE_DIR || path.join(__dirname, '../data/databases');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ACTIVE_EXPORT_STATUSES = new Set(['OPEN', 'PROV', 'NOVATED']);
const EXECUTED_LOOKBACK_DAYS = 30;
const OPEN_GRACE_DAYS = 14;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function numberValue(value) {
  const normalized = text(value).replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function displayQuantity(value) {
  return value == null ? '' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function checkbox(value) {
  if (value === true) return true;
  return ['true', 'yes', 'y', '1', 'checked'].includes(text(value).toLowerCase());
}

function sheetDate(value) {
  const serial = numberValue(value);
  if (serial != null && serial >= 20000 && serial <= 80000) {
    const date = new Date((serial - 25569) * 86400 * 1000);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const parsed = Date.parse(text(value));
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function dateIso(value) {
  const date = sheetDate(value);
  return date ? date.toISOString().slice(0, 10) : '';
}

function displayDate(value) {
  const date = sheetDate(value);
  if (!date) return text(value);
  return `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]}`;
}

function displayPeriod(start, end, fallback = '') {
  const first = displayDate(start);
  const last = displayDate(end);
  if (first && last && first !== last) return `${first} - ${last}`;
  return first || last || text(fallback);
}

function databasePath(name) {
  return path.join(DATA_DIR, `${name}.db`);
}

function readDatabase(name, tableName, rowColumn) {
  const file = databasePath(name);
  if (!fs.existsSync(file)) throw new Error(`${name} database not found`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const escapedTable = tableName.replace(/"/g, '""');
    const escapedRow = rowColumn.replace(/"/g, '""');
    const rows = db.prepare(`SELECT * FROM "${escapedTable}" ORDER BY CAST("${escapedRow}" AS INTEGER)`).all();
    const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_database_meta'").get();
    const updatedAt = meta ? db.prepare('SELECT pulled_at FROM _database_meta LIMIT 1').get()?.pulled_at || null : null;
    return { rows, updatedAt };
  } finally {
    db.close();
  }
}

function mapLocalDelivery(row, side) {
  return {
    id: text(row.no),
    paymentStatus: checkbox(row.payment),
    side,
    counterparty: text(row.seller_buyer),
    certification: text(row.certification),
    cargo: text(row.cargo),
    quantity: numberValue(row.quantity),
    performed: numberValue(row.performed),
    balance: numberValue(row.balance),
    outspecQty: numberValue(row.outspec_qty),
    tolerance: numberValue(row.tolerance),
    shipmentPeriod: text(row.shipment_period) || displayPeriod(row.shpt_period_start, row.shpt_period_end),
    paymentTerms: text(row.payment_terms),
    remarks: text(row.remarks),
  };
}

function buildLocalDeliveries(purchases, sales) {
  const open = row => text(row.status).toUpperCase() === 'OPEN' && text(row.no);
  return [
    ...purchases.filter(open).map(row => mapLocalDelivery(row, 'Purchase')),
    ...sales.filter(open).map(row => mapLocalDelivery(row, 'Sales')),
  ];
}

function buildEvac(rows) {
  return rows
    .filter(row => text(row.status).toUpperCase() === 'OPEN' && text(row.no))
    .map(row => ({
      id: text(row.no),
      dischargePort: text(row.discharge_port),
      loadport: text(row.loadport),
      vessel: text(row.vessel) || 'TBN',
      etaAta: displayDate(row.eta_ata),
      etcAtc: displayDate(row.etc_atc),
      laycan: text(row.laycan),
      certification: text(row.certification),
      cargo: text(row.cargo),
      bookedQty: numberValue(row.b_qty),
      remarks: text(row.remarks),
    }));
}

function canonical(value) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildVesselPortLookup(vesselRows) {
  const result = buildVesselList(vesselRows, { statusFilter: 'all', query: '' });
  const byVslId = new Map();
  const byVessel = new Map();
  for (const vessel of result.vessels || []) {
    if (vessel.vessel) byVessel.set(canonical(vessel.vessel), vessel);
    for (const port of vessel.ports || []) {
      const record = { vessel, port };
      if (port.vslid) byVslId.set(canonical(port.vslid), record);
    }
  }
  return { byVslId, byVessel };
}

function mapExport(row, vesselLookup) {
  const exact = vesselLookup.byVslId.get(canonical(row.main_vsl_id_2));
  const vessel = exact?.vessel || vesselLookup.byVessel.get(canonical(row.main_vessel_name));
  const port = exact?.port || (vessel?.ports || []).find(item => item.port_name && text(row.main_load_port).toUpperCase().includes(text(item.port_name).split(',')[0].toUpperCase()));
  const contractQuantity = numberValue(row.main_quantity);
  const isPartialShipment = canonical(row.main_partial) === 'PARTIAL';
  const partialQuantity = isPartialShipment ? numberValue(row.main_partial_qty) : null;
  const shipmentQuantity = isPartialShipment ? partialQuantity : contractQuantity;
  const certification = text(row.main_sd_type);
  const cargo = text(port?.l_cargo);
  return {
    id: text(row.main_ref) || text(row.main_contract_no),
    status: text(row.main_status),
    paymentStatus: checkbox(row.main_payment_status),
    contractStatus: checkbox(row.main_ctr),
    vesselNominated: checkbox(row.main_vsl_nom),
    siStatus: checkbox(row.main_si_2) || Boolean(text(row.main_si)),
    sdStatus: checkbox(row.main_sd_status),
    blDate: displayDate(row.main_bl_date),
    blDateIso: dateIso(row.main_bl_date),
    vessel: text(vessel?.vessel) || text(row.main_vessel_name) || 'TBN',
    certification,
    cargo,
    contractQuantity,
    isPartialShipment,
    partialQuantity,
    shipmentQuantity,
    cargoSummary: [shipmentQuantity == null ? '' : `${displayQuantity(shipmentQuantity)}mts`, certification, cargo]
      .filter(value => value !== '').join(' '),
    buyer: text(row.main_buyer),
    shipper: text(port?.shipper),
    loadport: text(port?.port_name) || text(row.main_load_port),
    cr: text(port?.cr),
    eta: text(port?.eta),
    shipmentPeriod: displayPeriod(row.main_shpt_period_start, row.main_shpt_period_end),
    shipmentPeriodStartIso: dateIso(row.main_shpt_period_start),
    shipmentPeriodEndIso: dateIso(row.main_shpt_period_end),
    paymentTerms: text(row.main_payment_terms),
    remarks: text(row.main_remarks_2) || text(row.main_remarks),
  };
}

function isFullyCompleteExport(row) {
  return row.paymentStatus
    && row.contractStatus
    && row.vesselNominated
    && row.siStatus
    && row.sdStatus;
}

function buildExports(rows, vesselLookup, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = today - EXECUTED_LOOKBACK_DAYS * 86400 * 1000;
  const openCutoff = today - OPEN_GRACE_DAYS * 86400 * 1000;
  const tpgGlm = [];
  const gr = { executed: [], open: [], upcoming: [] };

  for (const row of rows) {
    if (!text(row.main_ref) || !text(row.main_cargo)) continue;
    const status = text(row.main_status).toUpperCase();
    const blDate = sheetDate(row.main_bl_date);
    const blTime = blDate ? Date.UTC(blDate.getUTCFullYear(), blDate.getUTCMonth(), blDate.getUTCDate()) : null;
    const periodEnd = sheetDate(row.main_shpt_period_end);
    const periodEndTime = periodEnd ? Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate()) : null;
    const periodStart = sheetDate(row.main_shpt_period_start);
    const periodStartTime = periodStart ? Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()) : null;
    const mapped = mapExport(row, vesselLookup);
    const shipper = mapped.shipper.toUpperCase();
    const group = ['TPG', 'GLM'].includes(shipper) ? 'tpgGlm' : ['EUP', 'PMC'].includes(shipper) ? 'gr' : '';
    if (!group) continue;

    let stage = '';
    if (!['CANCEL', 'WASHOUT'].includes(status) && blTime != null && blTime >= cutoff && blTime <= today) {
      stage = 'executed';
    } else if (ACTIVE_EXPORT_STATUSES.has(status) && blTime == null && (periodEndTime == null || periodEndTime >= openCutoff)) {
      stage = periodStartTime != null && periodStartTime > today ? 'upcoming' : 'open';
    }
    if (!stage || isFullyCompleteExport(mapped)) continue;

    const staged = { ...mapped, stage };
    if (group === 'tpgGlm') tpgGlm.push(staged);
    else gr[stage].push(staged);
  }

  const sorter = (left, right) => (left.shipmentPeriodStartIso || '9999').localeCompare(right.shipmentPeriodStartIso || '9999') || left.id.localeCompare(right.id);
  const executedSorter = (left, right) => (right.blDateIso || '').localeCompare(left.blDateIso || '') || left.id.localeCompare(right.id);
  const stageOrder = { executed: 0, open: 1, upcoming: 2 };
  tpgGlm.sort((left, right) => stageOrder[left.stage] - stageOrder[right.stage]
    || (left.stage === 'executed' ? executedSorter(left, right) : sorter(left, right)));
  gr.executed.sort(executedSorter);
  gr.open.sort(sorter);
  gr.upcoming.sort(sorter);
  return { tpgGlm, tpg: tpgGlm, gr };
}

function buildWeeklyOpsMeetingFromDatabases({ now = new Date() } = {}) {
  const db5 = readDatabase('DB5', 'main_shipment_file_with_shadow_gr', '_main_row');
  const db12 = readDatabase('DB12', 'tpg_imports', '_sheet_row');
  const db13 = readDatabase('DB13', 'tpg_local_purchase', '_sheet_row');
  const db14 = readDatabase('DB14', 'tpg_local_sales', '_sheet_row');
  const db15 = readDatabase('DB15', 'glm_imports', '_sheet_row');
  const db16 = readDatabase('DB16', 'glm_local_purchase', '_sheet_row');
  const db17 = readDatabase('DB17', 'glm_local_sales', '_sheet_row');
  const vesselSnapshot = loadVesselDatabase();
  const tpgLocalDeliveries = buildLocalDeliveries(db13.rows, db14.rows);
  const glmLocalDeliveries = buildLocalDeliveries(db16.rows, db17.rows);
  const tpgImports = buildEvac(db12.rows);
  const glmImports = buildEvac(db15.rows);
  const exports = buildExports(db5.rows, buildVesselPortLookup(vesselSnapshot.rows), now);
  const updatedAt = [db5.updatedAt, db12.updatedAt, db13.updatedAt, db14.updatedAt, db15.updatedAt, db16.updatedAt, db17.updatedAt, vesselSnapshot.updatedAt]
    .filter(Boolean).sort().pop() || null;

  return {
    updatedAt,
    generatedAt: now.toISOString(),
    localDeliveries: tpgLocalDeliveries,
    evac: tpgImports,
    tpgLocalDeliveries,
    glmLocalDeliveries,
    tpgImports,
    glmImports,
    exports,
    counts: {
      localDeliveries: tpgLocalDeliveries.length,
      imports: tpgImports.length,
      glmLocalDeliveries: glmLocalDeliveries.length,
      glmImports: glmImports.length,
      tpgExports: exports.tpgGlm.length,
      tpgGlmExports: exports.tpgGlm.length,
      grExports: exports.gr.executed.length + exports.gr.open.length + exports.gr.upcoming.length,
    },
  };
}

module.exports = {
  buildWeeklyOpsMeetingFromDatabases,
  buildLocalDeliveries,
  buildEvac,
  buildExports,
  buildVesselPortLookup,
  isFullyCompleteExport,
  checkbox,
  displayDate,
  displayPeriod,
};
