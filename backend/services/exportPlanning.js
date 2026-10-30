'use strict';

const { loadVesselDatabase, buildVesselList } = require('./vesselUpdate');
const { buildVesselContractFromDatabases } = require('./vesselContract');

function str(value) {
  return value == null ? '' : value.toString().trim();
}

function isDischargePort(port) {
  const status = str(port.status_ld).toLowerCase();
  const shipper = str(port.shipper).toLowerCase();
  return status === 'discharge' || shipper === 'discharge' || shipper === 'disch';
}

function uniquePorts(ports) {
  const seen = new Set();
  return (ports || []).filter(port => {
    const key = `${str(port.port_name).toLowerCase()}|${str(port.vslid).toLowerCase()}`;
    if (!str(port.port_name) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonical(value) {
  return str(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function uniqueContracts(contracts) {
  const seen = new Set();
  return (contracts || []).filter(contract => {
    const key = `${str(contract.id || contract.contractNo || contract.ref)}|${str(contract.qty)}|${str(contract.cargo)}`;
    if (!key.replace(/\|/g, '') || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function attachContracts(rows, contractRows) {
  const byVslId = new Map();
  const byFallback = new Map();

  for (const contractRow of contractRows || []) {
    const vslId = canonical(contractRow.vslId);
    const fallback = `${canonical(contractRow.vessel)}|${canonical(contractRow.loadport)}|${canonical(contractRow.cargo)}`;
    if (vslId) {
      if (!byVslId.has(vslId)) byVslId.set(vslId, []);
      byVslId.get(vslId).push(contractRow);
    }
    if (!byFallback.has(fallback)) byFallback.set(fallback, []);
    byFallback.get(fallback).push(contractRow);
  }

  return rows.map(row => {
    const cargo = canonical(row.cargo);
    const exactRows = byVslId.get(canonical(row.loadportVslId)) || [];
    const fallbackKey = `${canonical(row.vessel)}|${canonical(row.loadport)}|${cargo}`;
    const fallbackRows = byFallback.get(fallbackKey) || [];
    const matches = (exactRows.length ? exactRows : fallbackRows).filter(contractRow => {
      const contractCargo = canonical(contractRow.cargo);
      return !cargo || !contractCargo || cargo === contractCargo;
    });
    return {
      ...row,
      purchaseContracts: uniqueContracts(matches.flatMap(contractRow => contractRow.purchaseContracts || [])),
      salesContracts: uniqueContracts(matches.flatMap(contractRow => contractRow.salesContracts || [])),
    };
  });
}

function buildExportPlanningRows(vessels) {
  const rows = [];

  for (const vessel of vessels || []) {
    const ports = (vessel.ports || []).filter(port => str(port.port_name));
    const dischargePorts = uniquePorts(ports.filter(isDischargePort)).map(port => ({
      port: str(port.port_name),
      vslId: str(port.vslid),
      cargo: str(port.l_cargo),
      quantity: str(port.qty),
      eta: str(port.eta),
    }));
    const loadPorts = ports.filter(port => !isDischargePort(port));
    const planningStatus = /pending/i.test(str(vessel.ops)) ? 'Pending' : 'Scheduled';
    const common = {
      vessel: str(vessel.vessel) || 'TBN',
      vslId: str(vessel.vsl_id),
      charterer: str(vessel.charterer),
      entity: str(vessel.entity),
      vesselStatus: str(vessel.status),
      ops: str(vessel.ops),
      planningStatus,
      dischargePorts,
    };

    if (loadPorts.length === 0) {
      rows.push({
        key: `${common.vslId || common.vessel}:unassigned`,
        ...common,
        loadport: '', loadportVslId: '', shipper: '', cargo: '', quantity: '',
        portStatus: '', laycan: '', cr: '', eta: '', etb: '', etc: '',
      });
      continue;
    }

    loadPorts.forEach((port, index) => {
      rows.push({
        key: `${common.vslId || common.vessel}:${str(port.vslid) || str(port.port_name)}:${index}`,
        ...common,
        loadport: str(port.port_name),
        loadportVslId: str(port.vslid),
        shipper: str(port.shipper),
        cargo: str(port.l_cargo),
        quantity: str(port.qty),
        portStatus: str(port.status_oc),
        laycan: str(port.laycan),
        cr: str(port.cr),
        eta: str(port.eta),
        etb: str(port.etb),
        etc: str(port.etc),
      });
    });
  }

  return rows;
}

function buildExportPlanningFromDatabase() {
  const { rows: vesselRows, updatedAt } = loadVesselDatabase();
  const result = buildVesselList(vesselRows, { statusFilter: 'all' });
  let contractResult = { rows: [], updatedAt: null };
  try {
    contractResult = buildVesselContractFromDatabases();
  } catch (error) {
    console.warn('Export Planning contract overlay unavailable:', error.message);
  }
  const rows = attachContracts(buildExportPlanningRows(result.vessels), contractResult.rows);
  const options = {
    charterers: [...new Set(rows.map(row => row.charterer).filter(Boolean))].sort(),
    vessels: [...new Set(rows.map(row => row.vessel).filter(Boolean))].sort(),
    loadports: [...new Set(rows.map(row => row.loadport).filter(Boolean))].sort(),
    cargoes: [...new Set(rows.map(row => row.cargo).filter(Boolean))].sort(),
    statuses: [...new Set(rows.map(row => row.vesselStatus).filter(Boolean))].sort(),
    planningStatuses: [...new Set(rows.map(row => row.planningStatus).filter(Boolean))].sort(),
  };
  return { rows, options, updatedAt: [updatedAt, contractResult.updatedAt].filter(Boolean).sort().pop() || updatedAt };
}

module.exports = { buildExportPlanningFromDatabase, buildExportPlanningRows };
