'use strict';

const { buildVesselList } = require('./vesselUpdate');

const DEMURRAGE_RECORDS_COLUMN = 'demurrage_records';
const DEMURRAGE_STATUS_COLUMN = 'demurrage_status';
const SHOW_COLUMN = 'show';
const NIL_DEMURRAGE_COLUMN = 'nil_demurrage';

function text(value) {
  return value == null ? '' : String(value).trim();
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function spreadsheetSafeText(value) {
  const input = value == null ? '' : String(value);
  return /^\s*[=+\-@]/.test(input) ? `'${input}` : input;
}

function buildDemurrageRecords(snapshot) {
  const columns = Array.isArray(snapshot?.columns) ? snapshot.columns : [];
  const demurrageRecordsColumn = columns.indexOf(DEMURRAGE_RECORDS_COLUMN);
  const demurrageStatusColumn = columns.indexOf(DEMURRAGE_STATUS_COLUMN);
  const showColumn = columns.indexOf(SHOW_COLUMN);
  const nilDemurrageColumn = columns.indexOf(NIL_DEMURRAGE_COLUMN);
  if (demurrageRecordsColumn < 0) {
    const error = new Error('DB6 is missing the Demurrage Records column');
    error.statusCode = 503;
    throw error;
  }
  if (demurrageStatusColumn < 0) {
    const error = new Error('DB6 is missing the Demurrage Status column');
    error.statusCode = 503;
    throw error;
  }
  if (showColumn < 0) {
    const error = new Error('DB6 is missing the Show column');
    error.statusCode = 503;
    throw error;
  }
  if (nilDemurrageColumn < 0) {
    const error = new Error('DB6 is missing the Nil Demurrage column');
    error.statusCode = 503;
    throw error;
  }

  const result = buildVesselList(snapshot.rows, {
    statusFilter: 'all',
    sheetRows: snapshot.sheetRows,
    demurrageRecordsColumn,
    demurrageStatusColumn,
    showColumn,
    nilDemurrageColumn,
  });

  const records = result.vessels.map(vessel => {
    const ports = vessel.ports
      .map((port, index) => ({
        rotation: index + 1,
        type: text(port.status_ld),
        port: text(port.port_name),
        shipper: text(port.shipper),
        entity: text(port.port_entity),
        cargo: text(port.l_cargo),
        quantity: text(port.qty),
        status: text(port.status_oc),
        laycan: text(port.laycan),
        cr: text(port.cr_display || port.cr),
        eta: text(port.eta_display || port.eta),
        etb: text(port.etb_display || port.etb),
        etc: text(port.etc_display || port.etc),
      }))
      .filter(port => port.port || port.cargo || port.quantity || port.shipper);
    const loadports = ports.filter(port => port.type.toLowerCase() === 'load');

    return {
      row: vessel.row,
      vslId: vessel.vsl_id,
      vessel: vessel.vessel || 'TBN',
      voyage: vessel.voyage,
      charterer: vessel.charterer,
      entity: vessel.entity,
      status: vessel.status,
      ops: vessel.ops,
      demurrageRate: vessel.demm_rate_display || vessel.demm_rate,
      laytimeRate: vessel.laytime_rate,
      laytimeStarts: vessel.laytime_starts,
      estimatedDemurrage: vessel.est_demmurage,
      remarks: vessel.remarks,
      nominated: vessel.nominated,
      demurrageRecords: vessel.demurrage_records || '',
      demurrageStatus: Boolean(vessel.demurrage_status),
      showDemurrage: Boolean(vessel.show),
      nilDemurrage: Boolean(vessel.nil_demurrage),
      cargos: unique(loadports.map(port => port.cargo)),
      loadports: unique(loadports.map(port => port.port)),
      shippers: unique(loadports.map(port => port.shipper)),
      ports,
    };
  });

  return {
    records,
    options: {
      entities: unique(records.map(record => record.entity)),
      cargos: unique(records.flatMap(record => record.cargos)),
      loadports: unique(records.flatMap(record => record.loadports)),
      statuses: unique(records.map(record => record.status)),
    },
    demurrageRecordsColumn,
    demurrageStatusColumn,
    showColumn,
    nilDemurrageColumn,
    updatedAt: snapshot.updatedAt || null,
  };
}

function findRecordAtSheetRow(snapshot, row) {
  const sheetRows = Array.isArray(snapshot?.sheetRows) ? snapshot.sheetRows : [];
  const index = sheetRows.findIndex(sheetRow => Number(sheetRow) === Number(row));
  if (index < 0) return null;
  return snapshot.rows?.[index + 1] || null;
}

module.exports = {
  DEMURRAGE_RECORDS_COLUMN,
  DEMURRAGE_STATUS_COLUMN,
  SHOW_COLUMN,
  NIL_DEMURRAGE_COLUMN,
  buildDemurrageRecords,
  findRecordAtSheetRow,
  spreadsheetSafeText,
};
