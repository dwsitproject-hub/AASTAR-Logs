const { buildContractDashboard, buildContractDashboardFromDatabases } = require('./contractDashboard');
const { getVesselMatchingData } = require('./vesselMatching');

const vesselContractCache = { key: null, value: null };

function str(v) { return v == null ? '' : v.toString().trim(); }

function parseQty(value) {
  if (value == null || value === '') return 0;
  const n = parseFloat(value.toString().replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function roundQty(value) {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Math.round(value * 1000) / 1000;
}

function contractQtyTotal(contracts) {
  return roundQty((contracts || []).reduce((sum, c) => sum + parseQty(c.qty), 0));
}

function realVslId(value) {
  const vslId = str(value).toUpperCase();
  return vslId && vslId !== 'VSL_00_0000' ? vslId : '';
}

function comparePortSlots(a, b) {
  const aId = realVslId(a.vslId);
  const bId = realVslId(b.vslId);
  const aMatch = aId.match(/_(\d+)$/);
  const bMatch = bId.match(/_(\d+)$/);
  if (aMatch && bMatch) {
    const suffixDiff = Number(aMatch[1]) - Number(bMatch[1]);
    if (suffixDiff) return suffixDiff;
  } else if (aMatch) {
    return -1;
  } else if (bMatch) {
    return 1;
  }
  return str(a.loadport).localeCompare(str(b.loadport), undefined, { sensitivity: 'base' });
}

function contractMatches(contract, loadport, cargo, vslId) {
  const cPort = str(contract.loadport);
  const cCargo = str(contract.cargo).toUpperCase();
  const expectedCargo = str(cargo).toUpperCase();
  const cVslId = realVslId(contract.vslId);
  const expectedVslId = realVslId(vslId);
  const portOk = !loadport || !cPort || cPort === loadport;
  const cargoOk = !expectedCargo || !cCargo || cCargo === expectedCargo;
  const locationOk = expectedVslId && cVslId ? cVslId === expectedVslId : portOk;
  return cargoOk && locationOk;
}

function compactContracts(contracts) {
  return (contracts || []).map(c => ({
    id: c.id,
    vslId: c.vslId,
    contractNo: c.contractNo,
    counterparty: c.counterparty,
    cargo: c.cargo,
    qty: c.qty,
    tolerance: c.tolerance,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    payment: c.payment,
    pricing: c.pricing,
    pricingType: c.pricingType,
    broker: c.broker,
    brokerRef: c.brokerRef,
    status: c.status,
    loadport: c.loadport,
    isPartial: c.isPartial
  }));
}

function shapeVesselContract(dashboard) {
  const rows = [];
  const entitySet = {};
  const cargoSet = {};
  const portSet = {};
  const statusSet = {};

  for (const vessel of dashboard.vessels || []) {
    if (vessel.entity) entitySet[vessel.entity] = true;
    if (vessel.status) statusSet[vessel.status] = true;

    const portMap = {};
    (vessel.loadports || []).forEach(lp => {
      const portName = str(lp.loadport) || 'Unassigned';
      const portVslId = str(lp.vslid);
      const portKey = portVslId || portName;
      if (!portMap[portKey]) {
        portMap[portKey] = {
          vslId: portVslId,
          loadport: portName,
          laycan: lp.laycan || '',
          eta: lp.eta || '',
          etb: lp.etb || '',
          etc: lp.etc || '',
          cargoes: {}
        };
      }
      Object.entries(lp.cargoes || {}).forEach(([cargo, qty]) => {
        if (!cargo) return;
        portMap[portKey].cargoes[cargo] = (portMap[portKey].cargoes[cargo] || 0) + parseQty(qty);
      });
    });

    vessel.purchases.concat(vessel.sales).forEach(contract => {
      const portName = str(contract.loadport) || 'Unassigned';
      const portVslId = str(contract.vslId);
      const portKey = portVslId || portName;
      if (!portMap[portKey]) {
        portMap[portKey] = { vslId: portVslId, loadport: portName, laycan: '', eta: '', etb: '', etc: '', cargoes: {} };
      }
      if (contract.cargo && !portMap[portKey].cargoes[contract.cargo]) {
        portMap[portKey].cargoes[contract.cargo] = 0;
      }
    });

    Object.values(portMap).sort(comparePortSlots).forEach(lp => {
      if (lp.loadport && lp.loadport !== 'Unassigned') portSet[lp.loadport] = true;
      const cargoes = Object.keys(lp.cargoes || {});
      if (cargoes.length === 0) cargoes.push('');

      cargoes.forEach(cargo => {
        if (cargo) cargoSet[cargo] = true;
        const purchases = compactContracts(vessel.purchases.filter(c => contractMatches(c, lp.loadport === 'Unassigned' ? '' : lp.loadport, cargo, lp.vslId)));
        const sales = compactContracts(vessel.sales.filter(c => contractMatches(c, lp.loadport === 'Unassigned' ? '' : lp.loadport, cargo, lp.vslId)));
        const loadedQty = roundQty(parseQty(lp.cargoes && lp.cargoes[cargo]));
        const purchaseQty = contractQtyTotal(purchases);
        const salesQty = contractQtyTotal(sales);

        rows.push({
          key: `${vessel.vslId || vessel.vessel}-${lp.vslId || lp.loadport}-${cargo || 'none'}`,
          vessel: vessel.vessel,
          vslId: lp.vslId || vessel.vslId,
          entity: vessel.entity,
          imo: vessel.imo || '',
          mmsi: vessel.mmsi || '',
          status: vessel.status,
          nominated: vessel.nominated,
          demmurage: vessel.demmurage,
          loadport: lp.loadport,
          laycan: lp.laycan,
          eta: lp.eta,
          etb: lp.etb,
          etc: lp.etc,
          cargo,
          loadedQty,
          purchaseQty,
          salesQty,
          // Use purchase total for contract matching while retaining the
          // DB6 loaded balance for sales-only rows and diagnostics.
          balanceToPurchase: roundQty(purchaseQty - salesQty),
          balanceToLoaded: roundQty(loadedQty - salesQty),
          purchaseContracts: purchases,
          salesContracts: sales,
          dischargePorts: vessel.dischargePorts || [],
          balanceLines: vessel.balanceLines || []
        });
      });
    });
  }

  return {
    rows,
    options: {
      entities: Object.keys(entitySet).sort(),
      cargoes: Object.keys(cargoSet).sort(),
      loadports: Object.keys(portSet).sort(),
      statuses: Object.keys(statusSet).sort()
    },
    updatedAt: null,
    counts: {
      vessels: (dashboard.vessels || []).length,
      rows: rows.length
    }
  };
}

function buildVesselContract(matchingData, vdbData) {
  return shapeVesselContract(buildContractDashboard(matchingData, vdbData));
}

function buildVesselContractFromDatabases() {
  const dashboard = buildContractDashboardFromDatabases();
  const key = dashboard.cache?.builtAt || dashboard.updatedAt || dashboard.today;
  if (vesselContractCache.value && vesselContractCache.key === key) return vesselContractCache.value;
  const value = { ...shapeVesselContract(dashboard), updatedAt: dashboard.updatedAt };
  vesselContractCache.key = key;
  vesselContractCache.value = value;
  return value;
}

function pendingContractRow(sourceTab, row) {
  const side = sourceTab.endsWith('PURCHASE') ? 'Purchase' : 'Sales';
  const isPartial = str(row.partial).toUpperCase() === 'PARTIAL';
  return {
    key: `${sourceTab}:${row.match_id || row._row}`,
    sourceTab,
    side,
    sourceRow: Number(row._row) || 0,
    matchId: str(row.match_id),
    ref: str(row.ref),
    contractNo: str(row.contract_no),
    counterparty: str(row.buyer),
    cargo: str(row.cargo),
    qty: str(isPartial && row.partial_qty ? row.partial_qty : row.qty),
    tolerance: str(row.tolerance),
    status: str(row.status),
    loadport: str(row.load_port),
    dischargePort: str(row.discharge_port),
    contractStart: str(row.contract_start),
    contractEnd: str(row.contract_end),
    broker: str(row.broker),
    brokerRef: str(row.broker_ref),
    intentionVessel: str(row.intention_vessel),
    paymentTerms: str(row.payment_terms),
    remarks: str(row.remarks),
    isPartial
  };
}

function pendingMatchesQuery(row, query) {
  if (!query) return true;
  return [
    row.sourceTab, row.side, row.ref, row.contractNo, row.counterparty, row.cargo,
    row.qty, row.status, row.loadport, row.dischargePort, row.contractStart,
    row.contractEnd, row.broker, row.brokerRef, row.intentionVessel,
    row.paymentTerms, row.remarks
  ].join(' ').toLowerCase().includes(query);
}

function isLegacyClearedContract(row) {
  return str(row.source_vsl_id).toUpperCase() === 'VSL_00_0000';
}

function listPendingVesselContracts({ q = '', offset = 0, limit = 100 } = {}) {
  const matching = getVesselMatchingData();
  const query = str(q).toLowerCase();
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const safeLimit = Math.min(500, Math.max(20, Number.parseInt(limit, 10) || 100));

  const rows = Object.entries(matching.tabs || [])
    .flatMap(([sourceTab, tab]) => (tab.rows || [])
      .filter(row => !realVslId(row.vsl_id) && !isLegacyClearedContract(row))
      .map(row => pendingContractRow(sourceTab, row)))
    .filter(row => pendingMatchesQuery(row, query))
    .sort((a, b) => b.sourceRow - a.sourceRow || a.sourceTab.localeCompare(b.sourceTab));

  const page = rows.slice(safeOffset, safeOffset + safeLimit);
  const sourceCounts = rows.reduce((counts, row) => {
    counts[row.sourceTab] = (counts[row.sourceTab] || 0) + 1;
    return counts;
  }, {});
  return {
    rows: page,
    sourceCounts,
    updatedAt: matching.updatedAt,
    pagination: {
      offset: safeOffset,
      limit: safeLimit,
      total: rows.length,
      nextOffset: safeOffset + page.length < rows.length ? safeOffset + page.length : null,
      hasMore: safeOffset + page.length < rows.length
    }
  };
}

module.exports = { buildVesselContract, buildVesselContractFromDatabases, listPendingVesselContracts };
