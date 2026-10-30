// Port of Dashboard.gs - Vessel / Contract Dashboard backend

const VDB_PORT_STARTS = [20, 36, 52, 68, 84, 100, 116, 132, 148, 164];
const VDB_OFF = { STATUS:1, SHIPPER:2, PRICE:3, QTY:4, CARGO:5, LAYCAN:7, ETA:9, ETA_TIME:10, ETB:11, ETB_TIME:12, ETC:13, ETC_TIME:14 };

// Column indices in Matching sheet (0-based)
const C = {
  VSLID: 2, STATUS: 3, VESSEL: 4, LOADP: 5, LAYCAN: 6, ETA: 8, ETB: 9, ETC: 10,
  BUYER: 11, CONTNO: 12, CERT: 13, CARGO: 14, QTY: 16, TLR: 17,
  PSTART: 18, PEND: 19, PAY: 20, PROVPR: 21, FINPR: 22,
  SHIPPER: 25, ENTITY: 26, ABFLAG: 27, DEMM: 28, ALLOC: 31
};
const MATCHING_MAX_COL = 32;
const VDB_MAX_COL = 179;

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function str(val) { return val == null ? '' : val.toString().trim(); }

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
  if (!vdbData || vdbData.length === 0) return { totals: {}, byPort: {}, discharge: {} };
  const totals = {};
  const byPort = {};
  const discharge = {};

  for (let r = 1; r < vdbData.length; r++) {
    const row = vdbData[r];
    if (!row) continue;
    const baseId = row[0] ? row[0].toString().trim() : '';
    if (!baseId) continue;

    for (const base of VDB_PORT_STARTS) {
      if (base + VDB_OFF.ETC >= VDB_MAX_COL) break;
      const port = row[base] ? row[base].toString().trim() : '';
      if (!port) continue;

      const portStatus = row[base + VDB_OFF.STATUS] ? row[base + VDB_OFF.STATUS].toString().trim().toLowerCase() : '';
      const shipper = row[base + VDB_OFF.SHIPPER] ? row[base + VDB_OFF.SHIPPER].toString().trim().toUpperCase() : '';
      const qty = parseFloat(row[base + VDB_OFF.QTY]) || 0;
      const cargo = row[base + VDB_OFF.CARGO] ? row[base + VDB_OFF.CARGO].toString().trim() : '';

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

      if (!cargo || qty <= 0) continue;

      if (!totals[baseId]) totals[baseId] = {};
      totals[baseId][cargo] = (totals[baseId][cargo] || 0) + qty;

      if (!byPort[baseId]) byPort[baseId] = {};
      if (!byPort[baseId][port]) byPort[baseId][port] = [];
      byPort[baseId][port].push({ cargo, qty, shipper });
    }
  }

  return { totals, byPort, discharge };
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

    const groupId = vslId ? vslId.replace(/_[^_]+$/, '') : '';
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
      if (!v.loadports[loadport]) {
        v.loadports[loadport] = {
          loadport, laycan: str(row[C.LAYCAN]), eta: str(row[C.ETA]),
          etb: str(row[C.ETB]), etc: str(row[C.ETC]), cargoes: {}
        };
      } else {
        const lp = v.loadports[loadport];
        if (!lp.laycan) lp.laycan = str(row[C.LAYCAN]);
        if (!lp.eta) lp.eta = str(row[C.ETA]);
        if (!lp.etb) lp.etb = str(row[C.ETB]);
        if (!lp.etc) lp.etc = str(row[C.ETC]);
      }
      if (rowCargo && rowQty) {
        const lpObj = v.loadports[loadport];
        lpObj.cargoes[rowCargo] = (lpObj.cargoes[rowCargo] || 0) + parseQty(rowQty);
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
      contractNo: str(row[C.CONTNO]),
      counterparty: str(row[C.BUYER]),
      cargo: rowCargo,
      cert: str(row[C.CERT]),
      qty: rowQty,
      tolerance: str(row[C.TLR]),
      periodStart: str(row[C.PSTART]),
      periodEnd: str(row[C.PEND]),
      payment: str(row[C.PAY]),
      pricing, pricingType,
      entity, isGR, status
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

  const vessels = [];
  for (const key of order) {
    const v = vesselMap[key];
    if (v.purchases.length === 0 && v.sales.length === 0) continue;

    const nonEmpty = v.statuses.filter(s => s !== '');
    const allClosed = nonEmpty.length > 0 && nonEmpty.every(s => s === 'CLOSED');

    const loadportList = Object.values(v.loadports);

    let badge = '';
    for (const s of v.statuses) { if (s) { badge = s; break; } }

    let totalPurchase = 0; v.purchases.forEach(c => totalPurchase += parseQty(c.qty));
    let totalSales = 0; v.sales.forEach(c => totalSales += parseQty(c.qty));

    const hasVDBData = vdbLookup.totals[v.vslId] && Object.keys(vdbLookup.totals[v.vslId]).length > 0;

    const purchaseByCargo = {};
    if (hasVDBData) {
      const vdbDataForVsl = vdbLookup.totals[v.vslId];
      for (const vc in vdbDataForVsl) purchaseByCargo[vc] = (purchaseByCargo[vc] || 0) + vdbDataForVsl[vc];
    } else {
      v.purchases.forEach(c => { if (c.cargo) purchaseByCargo[c.cargo] = (purchaseByCargo[c.cargo] || 0) + parseQty(c.qty); });
    }

    const salesByCargo = {};
    v.sales.forEach(c => { if (c.cargo) salesByCargo[c.cargo] = (salesByCargo[c.cargo] || 0) + parseQty(c.qty); });

    const allBalanceCargoes = {};
    for (const pc in purchaseByCargo) allBalanceCargoes[pc] = true;
    for (const sc in salesByCargo) allBalanceCargoes[sc] = true;

    const balanceLines = [];
    for (const blCargo in allBalanceCargoes) {
      const pQty = purchaseByCargo[blCargo] || 0;
      const sQty = salesByCargo[blCargo] || 0;
      const diff = pQty - sQty;
      if (Math.round(diff) > 0 && !v.jpnCargoes[blCargo]) {
        balanceLines.push({ label: 'Sales needed', amount: diff, cargo: blCargo, purchase: pQty, sales: sQty });
      } else if (Math.round(diff) < 0 && !hasVDBData) {
        balanceLines.push({ label: 'Purchase needed', amount: Math.abs(diff), cargo: blCargo, purchase: pQty, sales: sQty });
      }
    }

    let firstEta = '';
    for (const lpn in v.loadports) {
      const lpEta = v.loadports[lpn].eta;
      if (lpEta) { firstEta = lpEta; break; }
    }

    const vdbByPort = vdbLookup.byPort[v.vslId] || null;
    const dischargePorts = vdbLookup.discharge[v.vslId] || [];

    vessels.push({
      vessel: v.vessel,
      vslId: v.vslId,
      entity: v.entity,
      shipper: v.shipper,
      status: badge,
      isClosed: allClosed,
      demmurage: v.demmurage || 'TBA',
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

module.exports = { buildContractDashboard };
