// Port of Dashboard.gs - Vessel / Contract Dashboard backend

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { loadVesselDatabase } = require('./vesselUpdate');
const { loadActiveAssignments } = require('./vesselLinkStore');

const VDB_PORT_STARTS = [20, 36, 52, 68, 84, 100, 116, 132, 148, 164];
const VDB_OFF = { STATUS:1, SHIPPER:2, PRICE:3, QTY:4, CARGO:5, LAYCAN:7, ETA:9, ETA_TIME:10, ETB:11, ETB_TIME:12, ETC:13, ETC_TIME:14 };
const VDB_COL = { ENTITY: 2, VESSEL: 4, IMO: 7, MMSI: 8, STATUS: 9, DEMM: 14, NOMINATED: 18 };

// Column indices in Matching sheet (0-based)
const C = {
  VSLID: 2, STATUS: 3, VESSEL: 4, LOADP: 5, LAYCAN: 6, ETA: 8, ETB: 9, ETC: 10,
  BUYER: 11, CONTNO: 12, CERT: 13, CARGO: 14, QTY: 16, TLR: 17,
  PSTART: 18, PEND: 19, PAY: 20, PROVPR: 21, FINPR: 22,
  SHIPPER: 25, ENTITY: 26, ABFLAG: 27, DEMM: 28, ALLOC: 31,
  BROKER: 34, BROKER_REF: 35
};
const MATCHING_MAX_COL = 36;
const VDB_MAX_COL = 179;
const PURCHASE_COVERED_SHIPPERS = new Set(['EUP', 'SPC', 'PMC', 'TPG', 'GLM', 'JPN']);

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DATA_DIR = process.env.DATA_DATABASE_DIR || path.join(__dirname, '../data/databases');
const DASHBOARD_DATABASES = ['DB1', 'DB2', 'DB3', 'DB4', 'DB5', 'DB6', 'DB10', 'vessel_links'];
const dashboardCache = { signature: null, result: null, builtAt: null, hits: 0, misses: 0 };

const CONTRACT_SOURCE_DEFINITIONS = [
  {
    database: 'DB1', table: 'aastar_sales_with_shadow', side: 'sales',
    fields: {
      ref: 'sales_ref', contractNo: ['sales_contract_no', 'shadow_as_contract'],
      status: 'sales_status', vessel: 'sales_intention_vessel', loadport: 'sales_intention_load_port',
      counterparty: 'sales_buyer', cargo: 'sales_cargo', qty: 'sales_qty', tolerance: 'sales_tolerance',
      periodStart: 'sales_contract_start', periodEnd: 'sales_contract_end', payment: 'sales_payment_terms',
      provPrice: 'sales_prov_price', finalPrice: 'sales_final_price', broker: 'sales_broker',
      brokerRef: 'sales_broker_buyer_ref_no', partial: 'sales_partial', partialQty: 'sales_partial_qty',
      matchId: 'sales_erp_match_id'
    }
  },
  {
    database: 'DB2', table: 'aastar_purchase_with_shadow', side: 'purchase',
    fields: {
      ref: 'purchase_ref', contractNo: ['shadow_ap_contract', 'purchase_ref'],
      status: 'purchase_status', vessel: 'purchase_intention_vessel', loadport: 'purchase_load_port',
      counterparty: 'purchase_seller_name', cargo: 'purchase_cargo', qty: 'purchase_qty', tolerance: 'purchase_tolerance',
      periodStart: 'purchase_start_ctr_shpt_period', periodEnd: 'purchase_end_ctr_shpt_period', payment: 'purchase_payment_terms',
      provPrice: 'purchase_prov_price', finalPrice: 'purchase_final_price', broker: 'purchase_broker',
      brokerRef: 'purchase_broker_ref_no', partial: 'purchase_partial', partialQty: 'purchase_partial_qty',
      matchId: 'purchase_erp_match_id'
    }
  },
  {
    database: 'DB3', table: 'kimara_sales_with_shadow', side: 'sales',
    fields: {
      ref: 'kimara_sales_ref', contractNo: ['kimara_sales_contract_no', 'shadow_ks_contract'],
      status: 'kimara_sales_status', vessel: 'kimara_sales_intention_vessel', loadport: 'kimara_sales_intention_load_port',
      counterparty: 'kimara_sales_buyer', cargo: 'kimara_sales_cargo', qty: 'kimara_sales_qty', tolerance: 'kimara_sales_tolerance',
      periodStart: 'kimara_sales_contract_start', periodEnd: 'kimara_sales_contract_end', payment: 'kimara_sales_payment_terms',
      provPrice: 'kimara_sales_prov_price', finalPrice: 'kimara_sales_final_price', broker: 'kimara_sales_broker',
      brokerRef: 'kimara_sales_broker_buyer_ref_no', partial: 'kimara_sales_partial', partialQty: 'kimara_sales_partial_qty',
      matchId: 'kimara_sales_erp_match_id'
    }
  },
  {
    database: 'DB4', table: 'kimara_purchase_with_shadow', side: 'purchase',
    fields: {
      ref: 'kimara_purchase_ref', contractNo: ['shadow_kp_contract', 'kimara_purchase_ref'],
      status: 'kimara_purchase_status', vessel: 'kimara_purchase_intention_vessel', loadport: 'kimara_purchase_load_port',
      counterparty: 'kimara_purchase_seller_name', cargo: 'kimara_purchase_cargo', qty: 'kimara_purchase_qty', tolerance: 'kimara_purchase_tolerance',
      periodStart: 'kimara_purchase_start_ctr_shpt_period', periodEnd: 'kimara_purchase_end_ctr_shpt_period', payment: 'kimara_purchase_payment_terms',
      provPrice: 'kimara_purchase_prov_price', finalPrice: 'kimara_purchase_final_price', broker: 'kimara_purchase_broker',
      brokerRef: 'kimara_purchase_broker_ref_no', partial: 'kimara_purchase_partial', partialQty: 'kimara_purchase_partial_qty',
      matchId: 'kimara_purchase_erp_match_id'
    }
  }
];

function str(val) { return val == null ? '' : val.toString().trim(); }

function canonicalVslId(value) {
  return str(value).replace(/\u00a0/g, ' ').replace(/\s+/g, '').toUpperCase();
}

function hasAuthoritativeAssignment(record, matchIdField, context, assignments) {
  const matchId = str(getField(record, matchIdField)).toLowerCase();
  const assignedVslId = canonicalVslId(matchId ? assignments.get(matchId) : '');
  const contextVslId = canonicalVslId(context?.portVslId || context?.vslId);
  return !!(matchId && assignedVslId && contextVslId && assignedVslId === contextVslId);
}

function matchIdOwnerRows(records, rowColumn, matchIdField) {
  const owners = new Map();
  for (const record of records) {
    const matchId = str(getField(record, matchIdField)).toLowerCase();
    const rowNumber = Number(record[rowColumn]) || 0;
    if (!matchId || !rowNumber) continue;
    const current = owners.get(matchId);
    if (!current || rowNumber < current) owners.set(matchId, rowNumber);
  }
  return owners;
}

function ownsMatchId(record, rowColumn, matchIdField, owners) {
  const matchId = str(getField(record, matchIdField)).toLowerCase();
  const rowNumber = Number(record[rowColumn]) || 0;
  return !!(matchId && rowNumber && owners.get(matchId) === rowNumber);
}

function isTruthy(val) {
  if (val === true) return true;
  const s = str(val).toLowerCase();
  return ['true', 'yes', 'y', '1', 'checked'].includes(s);
}

function normalizeStatus(val) {
  const s = str(val).toUpperCase();
  if (s === 'CLOSE') return 'CLOSED';
  return s;
}

function isPurchaseCoveredShipper(shipper) {
  return PURCHASE_COVERED_SHIPPERS.has(str(shipper).toUpperCase());
}

function parseQty(q) {
  if (!q) return 0;
  const n = parseFloat(q.toString().replace(/[, ]/g, ''));
  return isNaN(n) ? 0 : n;
}

function isPartialShipment(text) {
  if (!text) return false;
  const upper = text.toUpperCase();
  const mtCount = (upper.match(/MT/g) || []).length;
  const dashCount = (text.match(/-/g) || []).length;
  return (mtCount >= 2 && dashCount >= 1);
}

function getAllocatedQty(allocText) {
  if (!allocText) return null;
  const dashIdx = allocText.indexOf('-');
  if (dashIdx === -1) return null;
  const afterDash = allocText.substring(dashIdx + 1).toUpperCase();
  const numMatch = afterDash.match(/([\d,]+)\s*MT/);
  if (numMatch) return numMatch[1].replace(/,/g, '');
  return null;
}

// VESSEL DB uses unformatted values, so dates come as serial numbers
function serialToDate(serial) {
  if (typeof serial !== 'number' || !isFinite(serial)) return null;
  const ms = (serial - 25569) * 86400 * 1000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}
function formatVDBDate(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') {
    const d = serialToDate(value);
    if (d) return `${String(d.getDate()).padStart(2,'0')} ${MONTHS_SHORT[d.getMonth()]}`;
  }
  return value.toString().trim();
}

function getVesselDBPurchaseLookup(vdbData) {
  if (!vdbData || vdbData.length === 0) return { totals: {}, byPort: {}, discharge: {}, vessels: {}, demmurage: {}, nominated: {}, statuses: {}, meta: {} };
  const totals = {};
  const byPort = {};
  const discharge = {};
  const vessels = {};
  const demmurage = {};
  const nominated = {};
  const statuses = {};
  const meta = {};

  for (let r = 1; r < vdbData.length; r++) {
    const row = vdbData[r];
    if (!row) continue;
    const baseId = row[0] ? row[0].toString().trim() : '';
    if (!baseId) continue;
    const entity = str(row[VDB_COL.ENTITY]);
    const vesselName = str(row[VDB_COL.VESSEL]);
    const imo = str(row[VDB_COL.IMO]);
    const mmsi = str(row[VDB_COL.MMSI]);
    if (vesselName) vessels[baseId] = vesselName;
    const status = normalizeStatus(row[VDB_COL.STATUS]);
    if (status) statuses[baseId] = status;
    const demm = str(row[VDB_COL.DEMM]);
    if (demm) demmurage[baseId] = demm;
    nominated[baseId] = isTruthy(row[VDB_COL.NOMINATED]);
    if (!meta[baseId]) {
      meta[baseId] = {
        vslId: baseId,
        vessel: vesselName || 'TBN',
        entity,
        imo,
        mmsi,
        status,
        loadports: {}
      };
    }

    for (const base of VDB_PORT_STARTS) {
      if (base + VDB_OFF.ETC >= VDB_MAX_COL) break;
      const port = row[base] ? row[base].toString().trim() : '';
      if (!port) continue;

      const portStatus = row[base + VDB_OFF.STATUS] ? row[base + VDB_OFF.STATUS].toString().trim().toLowerCase() : '';
      const shipper = row[base + VDB_OFF.SHIPPER] ? row[base + VDB_OFF.SHIPPER].toString().trim().toUpperCase() : '';
      const qty = parseFloat(row[base + VDB_OFF.QTY]) || 0;
      const cargo = row[base + VDB_OFF.CARGO] ? row[base + VDB_OFF.CARGO].toString().trim() : '';
      const portVslId = str(row[base - 1]);
      const loadportEntry = {
        vslid: portVslId,
        loadport: port,
        laycan: formatVDBDate(row[base + VDB_OFF.LAYCAN]),
        eta: formatVDBDate(row[base + VDB_OFF.ETA]),
        etb: formatVDBDate(row[base + VDB_OFF.ETB]),
        etc: formatVDBDate(row[base + VDB_OFF.ETC]),
        cargoes: {}
      };

      if (portStatus === 'discharge' || shipper === 'DISCH') {
        if (!discharge[baseId]) discharge[baseId] = [];
        const dischEntry = {
          port,
          cargo,
          qty: qty > 0 ? qty : 0,
          eta: formatVDBDate(row[base + VDB_OFF.ETA]),
          etb: formatVDBDate(row[base + VDB_OFF.ETB]),
          etc: formatVDBDate(row[base + VDB_OFF.ETC])
        };
        const isDupe = discharge[baseId].some(d => d.port === port && d.cargo === cargo);
        if (!isDupe) discharge[baseId].push(dischEntry);
        continue;
      }

      if (portStatus === 'load') {
        const loadportKey = portVslId || port;
        if (!meta[baseId].loadports[loadportKey]) meta[baseId].loadports[loadportKey] = loadportEntry;
        const lp = meta[baseId].loadports[loadportKey];
        if (!lp.laycan) lp.laycan = loadportEntry.laycan;
        if (!lp.eta) lp.eta = loadportEntry.eta;
        if (!lp.etb) lp.etb = loadportEntry.etb;
        if (!lp.etc) lp.etc = loadportEntry.etc;
        if (cargo && qty > 0) lp.cargoes[cargo] = (lp.cargoes[cargo] || 0) + qty;
      }

      if (!cargo || qty <= 0) continue;

      if (!totals[baseId]) totals[baseId] = {};
      totals[baseId][cargo] = (totals[baseId][cargo] || 0) + qty;

      if (!byPort[baseId]) byPort[baseId] = {};
      if (!byPort[baseId][port]) byPort[baseId][port] = [];
      byPort[baseId][port].push({ cargo, qty, shipper, vslid: portVslId });
    }
  }

  return { totals, byPort, discharge, vessels, demmurage, nominated, statuses, meta };
}

function buildContractDashboard(matchingData, vdbData) {
  if (!matchingData || matchingData.length === 0) {
    return { vessels: [], cargoes: [], entities: [], today: '', counts: { vessels: 0 } };
  }

  const vdbLookup = getVesselDBPurchaseLookup(vdbData);

  const vesselMap = {};
  const order = [];

  for (let r = 1; r < matchingData.length; r++) {
    const row = matchingData[r];
    if (!row) continue;
    const vslId = str(row[C.VSLID]);
    const vessel = str(row[C.VESSEL]);
    if (!vslId && !vessel) continue;

    const normalizedVslId = vslId.toLowerCase();
    const groupId = vslId
      ? (vdbLookup.meta[normalizedVslId] ? normalizedVslId : normalizedVslId.replace(/_[^_]+$/, ''))
      : '';
    const key = groupId || vessel;

    const status = str(row[C.STATUS]);
    let abFlag = str(row[C.ABFLAG]).toLowerCase();
    const entity = str(row[C.ENTITY]);
    const shipper = str(row[C.SHIPPER]);

    if (!vesselMap[key]) {
      vesselMap[key] = {
        vslId: groupId || vslId,
        vessel: vessel || 'TBN',
        loadports: {},
        purchases: [],
        sales: [],
        statuses: [],
        entity,
        shipper,
        jpnCargoes: {},
        demmurage: ''
      };
      order.push(key);
    }
    const v = vesselMap[key];

    if (vessel && v.vessel === 'TBN') v.vessel = vessel;
    if (entity && !v.entity) v.entity = entity;
    if (shipper && !v.shipper) v.shipper = shipper;
    v.statuses.push(status.toUpperCase());

    const rowCargo = str(row[C.CARGO]);
    if (shipper.toUpperCase() === 'JPN' && rowCargo) v.jpnCargoes[rowCargo] = true;

    if (!v.demmurage) {
      const demm = str(row[C.DEMM]);
      if (demm) v.demmurage = demm;
    }

    const loadport = str(row[C.LOADP]);
    const rowQty = str(row[C.QTY]);

    if (loadport) {
      const loadportKey = vslId || loadport;
      if (!v.loadports[loadportKey]) {
        v.loadports[loadportKey] = {
          vslid: vslId, loadport, laycan: str(row[C.LAYCAN]), eta: str(row[C.ETA]),
          etb: str(row[C.ETB]), etc: str(row[C.ETC]), cargoes: {}
        };
      } else {
        const lp = v.loadports[loadportKey];
        if (!lp.laycan) lp.laycan = str(row[C.LAYCAN]);
        if (!lp.eta) lp.eta = str(row[C.ETA]);
        if (!lp.etb) lp.etb = str(row[C.ETB]);
        if (!lp.etc) lp.etc = str(row[C.ETC]);
      }
    }

    const shipperUp = shipper.toUpperCase();
    const isSupplyShipper = ['EUP','SPC','PMC','TPG','GLM'].includes(shipperUp);
    if (abFlag !== 'purchase' && abFlag !== 'sales') {
      if (!isSupplyShipper) continue;
      abFlag = 'sales';
    }

    const isGR = entity.toUpperCase() === 'GR';
    const finalPr = str(row[C.FINPR]);
    const provPr = str(row[C.PROVPR]);
    let pricing = '', pricingType = '';
    if (finalPr) { pricing = finalPr; pricingType = 'Final'; }
    else if (provPr) { pricing = provPr; pricingType = 'Prov'; }

    const contract = {
      id: str(row[0]),
      vslId,
      contractNo: str(row[C.CONTNO]),
      counterparty: str(row[C.BUYER]),
      loadport,
      cargo: rowCargo,
      cert: str(row[C.CERT]),
      qty: rowQty,
      tolerance: str(row[C.TLR]),
      periodStart: str(row[C.PSTART]),
      periodEnd: str(row[C.PEND]),
      payment: str(row[C.PAY]),
      pricing, pricingType,
      broker: str(row[C.BROKER]),
      brokerRef: str(row[C.BROKER_REF]),
      entity, isGR, status,
      isPartial: str(row[C.ALLOC]).toUpperCase() === 'PARTIAL',
    };

    const allocCell = str(row[C.ALLOC]);
    if (isPartialShipment(allocCell)) {
      const allocQty = getAllocatedQty(allocCell);
      if (allocQty !== null) contract.qty = allocQty;
    }

    if (!contract.contractNo && !contract.counterparty && !contract.cargo && !contract.qty) continue;

    if (abFlag === 'purchase') v.purchases.push(contract);
    else v.sales.push(contract);
  }

  for (const [vslId, meta] of Object.entries(vdbLookup.meta || {})) {
    if (vesselMap[vslId]) {
      const v = vesselMap[vslId];
      if ((!v.vessel || v.vessel === 'TBN') && meta.vessel) v.vessel = meta.vessel;
      if (!v.entity && meta.entity) v.entity = meta.entity;
      Object.entries(meta.loadports || {}).forEach(([port, lp]) => {
        const loadportKey = lp.vslid || port;
        if (!v.loadports[loadportKey]) {
          v.loadports[loadportKey] = lp;
          return;
        }
        const existing = v.loadports[loadportKey];
        // DB6 is authoritative for the vessel-slot identity and location.
        if (lp.vslid) existing.vslid = lp.vslid;
        if (lp.loadport) existing.loadport = lp.loadport;
        if (lp.laycan) existing.laycan = lp.laycan;
        if (lp.eta) existing.eta = lp.eta;
        if (lp.etb) existing.etb = lp.etb;
        if (lp.etc) existing.etc = lp.etc;
        // DB6 is authoritative for loaded quantity; contract rows must not be added here.
        existing.cargoes = { ...(lp.cargoes || {}) };
      });
      continue;
    }

    vesselMap[vslId] = {
      vslId,
      vessel: meta.vessel || 'TBN',
      loadports: meta.loadports || {},
      purchases: [],
      sales: [],
      statuses: [],
      entity: meta.entity || '',
      shipper: '',
      jpnCargoes: {},
      demmurage: ''
    };
    order.push(vslId);
  }

  const vessels = [];
  for (const key of order) {
    const v = vesselMap[key];

    const vdbStatus = normalizeStatus(vdbLookup.statuses[v.vslId]);
    const nonEmpty = v.statuses.map(normalizeStatus).filter(s => s !== '');
    const allClosed = vdbStatus ? vdbStatus === 'CLOSED' : (nonEmpty.length > 0 && nonEmpty.every(s => s === 'CLOSED'));

    const loadportList = Object.values(v.loadports);

    let badge = '';
    if (vdbStatus) badge = vdbStatus;
    for (const s of v.statuses) { if (s) { badge = s; break; } }
    badge = vdbStatus || normalizeStatus(badge);

    let totalPurchase = 0; v.purchases.forEach(c => totalPurchase += parseQty(c.qty));
    let totalSales = 0; v.sales.forEach(c => totalSales += parseQty(c.qty));

    const hasVDBData = vdbLookup.totals[v.vslId] && Object.keys(vdbLookup.totals[v.vslId]).length > 0;

    const purchaseByCargo = {};
    const loadedByCargo = {};
    const thirdPartyByCargo = {};
    const contractPurchaseByCargo = {};
    v.purchases.forEach(c => {
      if (c.cargo) contractPurchaseByCargo[c.cargo] = (contractPurchaseByCargo[c.cargo] || 0) + parseQty(c.qty);
    });
    if (hasVDBData) {
      const vdbByPortForVsl = vdbLookup.byPort[v.vslId] || {};
      Object.values(vdbByPortForVsl).flat().forEach(entry => {
        if (!entry.cargo) return;
        loadedByCargo[entry.cargo] = (loadedByCargo[entry.cargo] || 0) + (entry.qty || 0);
        if (isPurchaseCoveredShipper(entry.shipper)) {
          purchaseByCargo[entry.cargo] = (purchaseByCargo[entry.cargo] || 0) + (entry.qty || 0);
        } else {
          thirdPartyByCargo[entry.cargo] = (thirdPartyByCargo[entry.cargo] || 0) + (entry.qty || 0);
        }
      });
      for (const cargo in contractPurchaseByCargo) {
        purchaseByCargo[cargo] = (purchaseByCargo[cargo] || 0) + contractPurchaseByCargo[cargo];
      }
    } else {
      for (const cargo in contractPurchaseByCargo) purchaseByCargo[cargo] = contractPurchaseByCargo[cargo];
    }

    const salesByCargo = {};
    v.sales.forEach(c => { if (c.cargo) salesByCargo[c.cargo] = (salesByCargo[c.cargo] || 0) + parseQty(c.qty); });

    const allBalanceCargoes = {};
    for (const lc in loadedByCargo) allBalanceCargoes[lc] = true;
    for (const pc in purchaseByCargo) allBalanceCargoes[pc] = true;
    for (const sc in salesByCargo) allBalanceCargoes[sc] = true;
    for (const tc in thirdPartyByCargo) allBalanceCargoes[tc] = true;

    const balanceLines = [];
    for (const blCargo in allBalanceCargoes) {
      const pQty = purchaseByCargo[blCargo] || 0;
      const sQty = salesByCargo[blCargo] || 0;
      const salesNeedBaseQty = hasVDBData ? (loadedByCargo[blCargo] || 0) : pQty;
      const thirdPartyQty = thirdPartyByCargo[blCargo] || 0;
      const contractPurchaseQty = contractPurchaseByCargo[blCargo] || 0;
      const uncoveredThirdPartyQty = Math.max(0, thirdPartyQty - contractPurchaseQty);
      const salesDiff = salesNeedBaseQty - sQty;
      const purchaseDiff = pQty - sQty;
      if (Math.round(salesDiff) > 0 && !v.jpnCargoes[blCargo]) {
        balanceLines.push({ label: 'Sales needed', amount: salesDiff, cargo: blCargo, purchase: salesNeedBaseQty, sales: sQty });
      }
      if (Math.round(purchaseDiff) < 0 || uncoveredThirdPartyQty > 0) {
        const amount = Math.max(Math.abs(Math.min(purchaseDiff, 0)), uncoveredThirdPartyQty);
        balanceLines.push({ label: 'Purchase needed', amount, cargo: blCargo, purchase: pQty, sales: sQty });
      }
    }

    let firstEta = '';
    for (const lpn in v.loadports) {
      const lpEta = v.loadports[lpn].eta;
      if (lpEta) { firstEta = lpEta; break; }
    }

    const vdbByPort = vdbLookup.byPort[v.vslId] || null;
    const dischargePorts = vdbLookup.discharge[v.vslId] || [];
    const vdbVessel = vdbLookup.vessels[v.vslId] || '';
    const vdbDemmurage = vdbLookup.demmurage[v.vslId] || '';
    const vdbMeta = vdbLookup.meta[v.vslId] || {};
    const nominated = !!vdbLookup.nominated[v.vslId];

    vessels.push({
      vessel: vdbVessel || v.vessel,
      vslId: v.vslId,
      entity: v.entity,
      imo: vdbMeta.imo || '',
      mmsi: vdbMeta.mmsi || '',
      shipper: v.shipper,
      status: badge,
      isClosed: allClosed,
      nominated,
      demmurage: vdbDemmurage || v.demmurage || 'TBA',
      loadports: loadportList,
      dischargePorts,
      purchases: v.purchases,
      sales: v.sales,
      totalPurchase, totalSales,
      balanceLines,
      vdbByPort,
      firstEta
    });
  }

  vessels.sort((a, b) => {
    if (!a.firstEta && !b.firstEta) return 0;
    if (!a.firstEta) return 1;
    if (!b.firstEta) return -1;
    return a.firstEta.localeCompare(b.firstEta);
  });

  const cargoSet = {}, entitySet = {};
  vessels.forEach(vv => {
    if (vv.entity) entitySet[vv.entity] = true;
    vv.purchases.concat(vv.sales).forEach(c => { if (c.cargo) cargoSet[c.cargo] = true; });
  });

  const now = new Date();
  const today = `${String(now.getDate()).padStart(2,'0')}/${MONTHS_SHORT[now.getMonth()]}/${String(now.getFullYear()).slice(-2)} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  return {
    vessels,
    cargoes: Object.keys(cargoSet).sort(),
    entities: Object.keys(entitySet).sort(),
    today,
    counts: { vessels: vessels.length }
  };
}

function databaseFile(name) {
  return path.join(DATA_DIR, `${name}.db`);
}

function dashboardDatabaseSignature() {
  return DASHBOARD_DATABASES.map(name => {
    try {
      const stat = fs.statSync(databaseFile(name));
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${name}:missing`;
    }
  }).join('|');
}

function invalidateContractDashboardCache() {
  dashboardCache.signature = null;
  dashboardCache.result = null;
}

function readDatabaseTable(databaseName, tableName) {
  const db = new Database(databaseFile(databaseName), { readonly: true, fileMustExist: true });
  try {
    const schema = db.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`).all();
    const records = db.prepare(`SELECT * FROM "${tableName.replace(/"/g, '""')}"`).all();
    const metadata = db.prepare('SELECT pulled_at FROM _database_meta LIMIT 1').get();
    return { schema, records, updatedAt: metadata?.pulled_at || null };
  } finally {
    db.close();
  }
}

function getField(record, field) {
  const fields = Array.isArray(field) ? field : [field];
  for (const name of fields) {
    if (name && record[name] != null && str(record[name]) !== '') return record[name];
  }
  return '';
}

function formatContractDate(value) {
  if (value == null || value === '') return '';
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 20000) {
    const date = serialToDate(numeric);
    if (date) return `${String(date.getDate()).padStart(2, '0')} ${MONTHS_SHORT[date.getMonth()]}`;
  }
  return str(value);
}

function contractRow(values) {
  const row = new Array(MATCHING_MAX_COL).fill('');
  const set = (column, value) => { row[column] = value == null ? '' : value; };
  set(0, values.ref);
  set(C.VSLID, values.vslId);
  set(C.STATUS, values.status);
  set(C.VESSEL, values.vessel);
  set(C.LOADP, values.loadport);
  set(C.LAYCAN, values.laycan);
  set(C.ETA, values.eta);
  set(C.ETB, values.etb);
  set(C.ETC, values.etc);
  set(C.BUYER, values.counterparty);
  set(C.CONTNO, values.contractNo);
  set(C.CERT, values.cert);
  set(C.CARGO, values.cargo);
  set(C.QTY, values.qty);
  set(C.TLR, values.tolerance);
  set(C.PSTART, values.periodStart);
  set(C.PEND, values.periodEnd);
  set(C.PAY, values.payment);
  set(C.PROVPR, values.provPrice);
  set(C.FINPR, values.finalPrice);
  set(C.SHIPPER, values.shipper);
  set(C.ENTITY, values.entity);
  set(C.ABFLAG, values.side);
  set(C.DEMM, values.demmurage);
  set(C.ALLOC, values.partial ? 'PARTIAL' : '');
  set(C.BROKER, values.broker);
  set(C.BROKER_REF, values.brokerRef);
  return row;
}

function buildVesselContext() {
  const snapshot = loadVesselDatabase();
  const rawVesselDb = readDatabaseTable('DB6', 'vessel_db');
  const rowsBySourceRow = new Map();
  const rawBySourceRow = new Map();
  const rawRecords = [...rawVesselDb.records].sort((a, b) => Number(a._sheet_row) - Number(b._sheet_row));
  rawRecords.forEach((record, index) => {
    rawBySourceRow.set(String(record._sheet_row), record);
    rowsBySourceRow.set(String(record._sheet_row), snapshot.rows[index + 1] || []);
  });

  const linksDb = new Database(databaseFile('vessel_links'), { readonly: true, fileMustExist: true });
  try {
    const parentRows = linksDb.prepare('SELECT source_row, vsl_id FROM parent_nodes').all();
    const baseByParentRow = new Map();
    for (const parent of parentRows) {
      const rawRow = rawBySourceRow.get(String(parent.source_row));
      const baseId = str(rawRow?.vsl_id).toLowerCase();
      if (baseId) baseByParentRow.set(String(parent.source_row), baseId);
    }

    const childRows = linksDb.prepare(`
      SELECT child_database, child_table, child_row, parent_row, parent_column
      FROM links
    `).all();
    const childContext = new Map();
    for (const link of childRows) {
      const baseId = baseByParentRow.get(String(link.parent_row));
      if (!baseId) continue;
      const key = `${link.child_database}:${link.child_table}:${link.child_row}`;
      if (childContext.has(key)) continue;
      const parentRow = rowsBySourceRow.get(String(link.parent_row)) || [];
      const match = str(link.parent_column).match(/_(\d+)$/);
      const slot = match ? parseInt(match[1], 10) : 1;
      const base = VDB_PORT_STARTS[slot - 1] ?? VDB_PORT_STARTS[0];
      childContext.set(key, {
        vslId: baseId,
        portVslId: str(parentRow[base - 1]) || baseId,
        entity: str(parentRow[VDB_COL.ENTITY]),
        imo: str(parentRow[VDB_COL.IMO]),
        mmsi: str(parentRow[VDB_COL.MMSI]),
        demmurage: str(parentRow[VDB_COL.DEMM]),
        status: normalizeStatus(parentRow[VDB_COL.STATUS]),
        vessel: str(parentRow[VDB_COL.VESSEL]),
        shipper: str(parentRow[base + VDB_OFF.SHIPPER]),
        loadport: str(parentRow[base + VDB_OFF.STATUS]) === 'Discharge' ? '' : str(parentRow[base]),
        laycan: formatVDBDate(parentRow[base + VDB_OFF.LAYCAN]),
        eta: formatVDBDate(parentRow[base + VDB_OFF.ETA]),
        etb: formatVDBDate(parentRow[base + VDB_OFF.ETB]),
        etc: formatVDBDate(parentRow[base + VDB_OFF.ETC]),
      });
    }
    return { snapshot, childContext };
  } finally {
    linksDb.close();
  }
}

function makeDatabaseContractRow(record, definition, context) {
  const fields = definition.fields;
  const partial = str(getField(record, fields.partial)).toUpperCase() === 'PARTIAL';
  const fullQty = getField(record, fields.qty);
  const partialQty = getField(record, fields.partialQty);
  const contextVessel = context || {};
  return contractRow({
    ref: getField(record, fields.ref),
    vslId: contextVessel.portVslId || contextVessel.vslId,
    status: getField(record, fields.status) || contextVessel.status,
    vessel: getField(record, fields.vessel) || contextVessel.vessel,
    // The linked DB6 slot is the source of truth for the vessel's loadport.
    // Contract databases can retain an older intention port after a vessel
    // update, which would otherwise overwrite the live vessel location.
    loadport: contextVessel.loadport || getField(record, fields.loadport),
    laycan: contextVessel.laycan,
    eta: contextVessel.eta,
    etb: contextVessel.etb,
    etc: contextVessel.etc,
    counterparty: getField(record, fields.counterparty),
    contractNo: getField(record, fields.contractNo),
    cargo: getField(record, fields.cargo),
    cert: '',
    qty: partial && str(partialQty) !== '' ? partialQty : fullQty,
    tolerance: getField(record, fields.tolerance),
    periodStart: formatContractDate(getField(record, fields.periodStart)),
    periodEnd: formatContractDate(getField(record, fields.periodEnd)),
    payment: getField(record, fields.payment),
    provPrice: getField(record, fields.provPrice),
    finalPrice: getField(record, fields.finalPrice),
    shipper: contextVessel.shipper,
    entity: contextVessel.entity,
    side: definition.side,
    demmurage: contextVessel.demmurage,
    partial,
    broker: getField(record, fields.broker),
    brokerRef: getField(record, fields.brokerRef),
  });
}

function makeMainShipmentRows(record, context) {
  const values = [];
  const common = {
    vslId: context.portVslId || context.vslId,
    status: getField(record, ['main_status_2', 'main_status']) || context.status,
    vessel: getField(record, 'main_vessel_name') || context.vessel,
    // Use the matched DB6 slot before the shipment file's copied loadport.
    loadport: context.loadport || getField(record, 'main_load_port'),
    laycan: context.laycan,
    eta: context.eta,
    etb: context.etb,
    etc: context.etc,
    cargo: getField(record, 'main_cargo'),
    cert: getField(record, 'main_sd_type'),
    tolerance: getField(record, 'main_tlr'),
    periodStart: formatContractDate(getField(record, 'main_shpt_period_start')),
    periodEnd: formatContractDate(getField(record, 'main_shpt_period_end')),
    payment: getField(record, 'main_payment_terms'),
    provPrice: '',
    finalPrice: getField(record, 'main_price'),
    shipper: context.shipper || getField(record, 'main_seller'),
    entity: context.entity,
    demmurage: context.demmurage,
    partial: str(getField(record, 'main_partial')).toUpperCase() === 'PARTIAL',
    partialQty: getField(record, 'main_partial_qty'),
    broker: getField(record, 'main_broker'),
    brokerRef: getField(record, 'main_broker_ref'),
  };
  const salesContract = getField(record, 'main_contract_no');
  if (str(salesContract) || str(record.main_buyer) || str(record.main_quantity)) {
    values.push(contractRow({
      ...common,
      ref: getField(record, 'main_ref'),
      contractNo: salesContract,
      counterparty: getField(record, 'main_buyer'),
      qty: common.partial && str(common.partialQty) !== '' ? common.partialQty : getField(record, 'main_quantity'),
      side: 'sales',
    }));
  }
  const purchaseContract = getField(record, 'main_contract');
  if (str(purchaseContract) || str(record.main_seller) || str(record.main_quantity_2)) {
    values.push(contractRow({
      ...common,
      ref: getField(record, 'main_ref'),
      contractNo: purchaseContract,
      counterparty: getField(record, 'main_seller'),
      qty: common.partial && str(common.partialQty) !== '' ? common.partialQty : (getField(record, 'main_quantity_2') || getField(record, 'main_quantity')),
      side: 'purchase',
    }));
  }
  return values;
}

function buildContractDashboardFromDatabases() {
  const signature = dashboardDatabaseSignature();
  if (dashboardCache.result && dashboardCache.signature === signature) {
    dashboardCache.hits++;
    return {
      ...dashboardCache.result,
      cache: { hit: true, builtAt: dashboardCache.builtAt, hits: dashboardCache.hits, misses: dashboardCache.misses },
    };
  }

  dashboardCache.misses++;
  const { snapshot, childContext } = buildVesselContext();
  const activeAssignments = loadActiveAssignments();
  const matchingData = [[]];
  const updatedAt = [snapshot.updatedAt];

  for (const definition of CONTRACT_SOURCE_DEFINITIONS) {
    const source = readDatabaseTable(definition.database, definition.table);
    updatedAt.push(source.updatedAt);
    const rowColumn = definition.database === 'DB1' ? '_sales_row'
      : definition.database === 'DB2' ? '_purchase_row'
      : definition.database === 'DB3' ? '_kimara_sales_row'
      : '_kimara_purchase_row';
    const matchIdOwners = matchIdOwnerRows(source.records, rowColumn, definition.fields.matchId);
    for (const record of source.records) {
      const key = `${definition.database}:${definition.table}:${record[rowColumn]}`;
      const context = childContext.get(key);
      if (!ownsMatchId(record, rowColumn, definition.fields.matchId, matchIdOwners)) continue;
      if (!context || !hasAuthoritativeAssignment(record, definition.fields.matchId, context, activeAssignments)) continue;
      matchingData.push(makeDatabaseContractRow(record, definition, context));
    }
  }

  const main = readDatabaseTable('DB5', 'main_shipment_file_with_shadow_gr');
  updatedAt.push(main.updatedAt);
  const mainMatchIdOwners = matchIdOwnerRows(main.records, '_main_row', 'main_erp_match_id');
  for (const record of main.records) {
    const key = `DB5:main_shipment_file_with_shadow_gr:${record._main_row}`;
    const context = childContext.get(key);
    if (!ownsMatchId(record, '_main_row', 'main_erp_match_id', mainMatchIdOwners)) continue;
    if (!context || !hasAuthoritativeAssignment(record, 'main_erp_match_id', context, activeAssignments)) continue;
    matchingData.push(...makeMainShipmentRows(record, context));
  }

  const result = buildContractDashboard(matchingData, snapshot.rows);
  const cachedResult = {
    ...result,
    updatedAt: updatedAt.filter(Boolean).sort().pop() || null,
    source: 'DB1-DB6 + DB10 Vessel Links',
  };
  dashboardCache.signature = dashboardDatabaseSignature();
  dashboardCache.builtAt = new Date().toISOString();
  dashboardCache.result = cachedResult;
  return {
    ...cachedResult,
    cache: { hit: false, builtAt: dashboardCache.builtAt, hits: dashboardCache.hits, misses: dashboardCache.misses },
  };
}

module.exports = {
  buildContractDashboard,
  buildContractDashboardFromDatabases,
  invalidateContractDashboardCache,
};
