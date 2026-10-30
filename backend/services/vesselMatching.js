'use strict';

const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DATABASES } = require('../config/dataSources');
const { TAB_CONFIGS } = require('./matchingSales');
const { writeSourceCells, getSourceMergeGroup, insertSourcePartialRow, deleteSourcePartialRow, refreshBulkDatabases } = require('./bulkDataSync');
const { rebuildVesselLinks } = require('./vesselLinks');
const { loadActiveAssignments, upsertVesselLink, deactivateVesselLink, deactivateVesselLinksByVslIds, remapVesselLinksByVslIds } = require('./vesselLinkStore');
const { colToA1, loadVesselDatabase, getValidLoadSlotIds } = require('./vesselUpdate');
const { invalidateContractDashboardCache } = require('./contractDashboard');

const DATA_DIR = process.env.DATA_DATABASE_DIR || path.join(__dirname, '../data/databases');

const STANDARD_DEFINITIONS = [
  {
    tab: 'AASTAR SALES', database: 'DB1', table: 'aastar_sales_with_shadow', rowColumn: '_sales_row', sourceColumnCount: 47,
    refField: 'sales_ref', qtyField: 'sales_qty', intentionField: 'sales_intention_vessel', vslField: 'sales_vsl_id', matchIdField: 'sales_erp_match_id',
    provPriceField: 'sales_prov_price', finalPriceField: 'sales_final_price',
    partialField: 'sales_partial', partialQtyField: 'sales_partial_qty'
  },
  {
    tab: 'AASTAR PURCHASE', database: 'DB2', table: 'aastar_purchase_with_shadow', rowColumn: '_purchase_row', sourceColumnCount: 37,
    refField: 'purchase_ref', qtyField: 'purchase_qty', intentionField: 'purchase_intention_vessel', vslField: 'purchase_vsl_id', matchIdField: 'purchase_erp_match_id',
    provPriceField: 'purchase_prov_price', finalPriceField: 'purchase_final_price',
    partialField: 'purchase_partial', partialQtyField: 'purchase_partial_qty'
  },
  {
    tab: 'KIMARA SALES', database: 'DB3', table: 'kimara_sales_with_shadow', rowColumn: '_kimara_sales_row', sourceColumnCount: 43,
    refField: 'kimara_sales_ref', qtyField: 'kimara_sales_qty', intentionField: 'kimara_sales_intention_vessel', vslField: 'kimara_sales_vsl_id', matchIdField: 'kimara_sales_erp_match_id',
    provPriceField: 'kimara_sales_prov_price', finalPriceField: 'kimara_sales_final_price',
    partialField: 'kimara_sales_partial', partialQtyField: 'kimara_sales_partial_qty'
  },
  {
    tab: 'KIMARA PURCHASE', database: 'DB4', table: 'kimara_purchase_with_shadow', rowColumn: '_kimara_purchase_row', sourceColumnCount: 37,
    refField: 'kimara_purchase_ref', qtyField: 'kimara_purchase_qty', intentionField: 'kimara_purchase_intention_vessel', vslField: 'kimara_purchase_vsl_id', matchIdField: 'kimara_purchase_erp_match_id',
    provPriceField: 'kimara_purchase_prov_price', finalPriceField: 'kimara_purchase_final_price',
    partialField: 'kimara_purchase_partial', partialQtyField: 'kimara_purchase_partial_qty'
  },
];

const GR_DEFINITIONS = [
  {
    tab: 'GR SALES',
    database: 'DB5',
    table: 'main_shipment_file_with_shadow_gr',
    rowColumn: '_main_row',
    sourceColumnCount: 66,
    mergeAnchorField: 'main_contract_no', defaultMergeFrom: 'main_preship', defaultMergeTo: 'main_remarks',
    refField: 'main_ref', qtyField: 'main_quantity', intentionField: 'main_vessel_name', vslField: 'main_vsl_id_2', matchIdField: 'main_erp_match_id',
    partialField: 'main_partial', partialQtyField: 'main_partial_qty',
    fields: {
      ref: 'main_ref', year: 'main_year', status: 'main_status', trader: 'main_trader', trade_date: 'main_trade_date',
      cargo: 'main_cargo', buyer: 'main_buyer', contract_no: 'main_contract_no', broker: 'main_broker', broker_ref: 'main_broker_ref',
      qty: 'main_quantity', tolerance: 'main_tlr', incoterm: 'main_incoterm', basis: 'main_bp', contract_start: 'main_shpt_period_start',
      contract_end: 'main_shpt_period_end', load_port: 'main_load_port', discharge_port: 'main_discharge_port',
      discharge_country: 'main_discharge_country', payment_terms: 'main_payment_terms', remarks: 'main_remarks',
      final_price: 'main_price',
      intention_vessel: 'main_vessel_name', vsl_id: 'main_vsl_id_2', partial: 'main_partial', partial_qty: 'main_partial_qty'
    },
    filterFields: {
      status: 'main_status', cargo: 'main_cargo', buyer: 'main_buyer', contract_no: 'main_contract_no',
      contract_start: 'main_shpt_period_start', contract_end: 'main_shpt_period_end', year: 'main_year',
      vessel: 'main_vessel_name', vsl_id: 'main_vsl_id_2'
    }
  },
  {
    tab: 'GR PURCHASE',
    database: 'DB5',
    table: 'main_shipment_file_with_shadow_gr',
    rowColumn: '_main_row',
    sourceColumnCount: 66,
    mergeAnchorField: 'main_contract', defaultMergeFrom: 'main_bp_2', defaultMergeTo: 'main_purchase_amount',
    refField: 'main_ref', qtyField: 'main_quantity_2', intentionField: 'main_vessel_name', vslField: 'main_vsl_id_2', matchIdField: 'main_erp_match_id',
    partialField: 'main_partial', partialQtyField: 'main_partial_qty',
    fields: {
      ref: 'main_ref', year: 'main_year', status: 'main_status_2', trader: 'main_trader', trade_date: 'main_trade_date_2',
      cargo: 'main_cargo', buyer: 'main_seller', contract_no: 'main_contract', broker: 'main_broker', broker_ref: 'main_broker_ref',
      qty: 'main_quantity_2', tolerance: 'main_tlr', incoterm: 'main_incoterm', basis: 'main_bp_2', contract_start: 'main_shpt_period_start',
      contract_end: 'main_shpt_period_end', load_port: 'main_load_port', discharge_port: 'main_discharge_port',
      discharge_country: 'main_discharge_country', payment_terms: 'main_payment_terms', remarks: 'main_remarks_2',
      final_price: 'main_price',
      intention_vessel: 'main_vessel_name', vsl_id: 'main_vsl_id_2', partial: 'main_partial', partial_qty: 'main_partial_qty'
    },
    filterFields: {
      status: 'main_status_2', cargo: 'main_cargo', buyer: 'main_seller', contract_no: 'main_contract',
      contract_start: 'main_shpt_period_start', contract_end: 'main_shpt_period_end', year: 'main_year',
      vessel: 'main_vessel_name', vsl_id: 'main_vsl_id_2'
    }
  }
];

const DEFINITIONS = [...STANDARD_DEFINITIONS, ...GR_DEFINITIONS];
const DEFINITION_BY_TAB = new Map(DEFINITIONS.map(definition => [definition.tab, definition]));

function dbPath(name) {
  return path.join(DATA_DIR, `${name}.db`);
}

function rebuildMatchingGraph() {
  const result = rebuildVesselLinks();
  invalidateContractDashboardCache();
  return result;
}

function str(value) {
  return value == null ? '' : String(value).trim();
}

function matchIdOwnerRows(records, definition) {
  const owners = new Map();
  for (const record of records) {
    const matchId = str(record[definition.matchIdField]).toLowerCase();
    const rowNumber = Number(record[definition.rowColumn]) || 0;
    if (!matchId || !rowNumber) continue;
    const current = owners.get(matchId);
    if (!current || rowNumber < current) owners.set(matchId, rowNumber);
  }
  return owners;
}

function formatDate(value) {
  const raw = str(value);
  const serial = Number(raw);
  if (!raw || !Number.isFinite(serial) || serial < 20000 || serial > 80000) return raw;
  const date = new Date((serial - 25569) * 86400 * 1000);
  if (Number.isNaN(date.getTime())) return raw;
  return `${String(date.getUTCDate()).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function formatRowDates(row) {
  for (const field of ['trade_date', 'contract_start', 'contract_end', 'shpt_mth']) {
    if (row[field]) row[field] = formatDate(row[field]);
  }
  if (str(row.vsl_id).toUpperCase() === 'VSL_00_0000') row.vsl_id = '';
  return row;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function readTable(definition) {
  const db = new Database(dbPath(definition.database), { readonly: true, fileMustExist: true });
  try {
    const schema = db.prepare(`PRAGMA table_info(${quoteIdentifier(definition.table)})`).all();
    const records = db.prepare(`SELECT * FROM ${quoteIdentifier(definition.table)}`).all();
    const metadata = db.prepare('SELECT pulled_at FROM _database_meta LIMIT 1').get();
    const sourceColumns = schema
      .filter(column => column.name !== '_sheet_row' && column.name !== definition.rowColumn)
      .slice(0, definition.sourceColumnCount)
      .map(column => column.name);
    return { records, sourceColumns, updatedAt: metadata?.pulled_at || null };
  } finally {
    db.close();
  }
}

function valueAt(record, sourceColumns, index) {
  if (!Number.isInteger(index) || index < 0 || index >= sourceColumns.length) return '';
  return str(record[sourceColumns[index]]);
}

function indexByName(sourceColumns, name) {
  return sourceColumns.indexOf(name);
}

function standardTabConfig(definition, sourceColumns) {
  return {
    ...TAB_CONFIGS[definition.tab],
    columns: {
      ...TAB_CONFIGS[definition.tab].columns,
      prov_price: indexByName(sourceColumns, definition.provPriceField),
      final_price: indexByName(sourceColumns, definition.finalPriceField),
      partial_qty: indexByName(sourceColumns, definition.partialQtyField),
    },
    sourceDatabase: definition.database,
    sourceTable: definition.table,
    sourceRowColumn: definition.rowColumn,
  };
}

function grTabConfig(definition, sourceColumns) {
  const columns = Object.fromEntries(Object.entries(definition.fields).map(([field, name]) => [field, indexByName(sourceColumns, name)]));
  const filters = Object.fromEntries(Object.entries(definition.filterFields).map(([field, name]) => [field, indexByName(sourceColumns, name)]));
  return {
    label: definition.tab,
    columns,
    collapsed: ['ref', 'qty', 'cargo', 'buyer', 'contract_no', 'broker', 'broker_ref', 'intention_vessel', 'contract_start', 'contract_end'],
    editBoxCollapsed: ['vsl_id'],
    primaryEditable: ['intention_vessel', 'vsl_id'],
    filters,
    defaultStatus: ['OPEN', 'PROV', 'SPACE'],
    defaultYear: ['2026', '2027'],
    sourceDatabase: definition.database,
    sourceTable: definition.table,
    sourceRowColumn: definition.rowColumn,
  };
}

function mapStandardRow(record, definition, sourceColumns) {
  const config = TAB_CONFIGS[definition.tab];
  const row = { _row: Number(record[definition.rowColumn]) || 0 };
  for (const [field, index] of Object.entries(config.columns)) row[field] = valueAt(record, sourceColumns, index);
  row.prov_price = str(record[definition.provPriceField]);
  row.final_price = str(record[definition.finalPriceField]);
  row.partial_qty = str(record[definition.partialQtyField]);
  row.match_id = str(record[definition.matchIdField]);
  row.source_vsl_id = str(row.vsl_id);
  return formatRowDates(row);
}

function mapGrRow(record, definition, sourceColumns) {
  const row = { _row: Number(record[definition.rowColumn]) || 0 };
  for (const [field, name] of Object.entries(definition.fields)) row[field] = str(record[name]);
  row.match_id = str(record[definition.matchIdField]);
  row.source_vsl_id = str(row.vsl_id);
  return formatRowDates(row);
}

function applyAuthoritativeVesselLink(row, assignments) {
  const matchId = str(row.match_id).toLowerCase();
  row.vsl_id = matchId ? (assignments.get(matchId) || '') : '';
  return row;
}

function assertExpectedRow(currentRow, expectedRef, expectedMatchId) {
  if (expectedMatchId && expectedMatchId !== currentRow.match_id) {
    throw Object.assign(new Error('Row shifted or was copied. Reload and try again.'), { statusCode: 409 });
  }
  if (expectedRef && expectedRef !== currentRow.ref) {
    throw Object.assign(new Error(`Row shifted (expected ${expectedRef}, found ${currentRow.ref})`), { statusCode: 409 });
  }
}

function updateLocalSourceFields(definition, rowNumber, fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const db = new Database(dbPath(definition.database));
  try {
    const result = db.prepare(`
      UPDATE ${quoteIdentifier(definition.table)}
      SET ${entries.map(([field]) => `${quoteIdentifier(field)} = ?`).join(', ')}
      WHERE ${quoteIdentifier(definition.rowColumn)} = ?
    `).run(...entries.map(([, value]) => value), String(rowNumber));
    if (!result.changes) throw Object.assign(new Error('Database row was not updated'), { statusCode: 409 });
  } finally {
    db.close();
  }
}

function meaningful(row) {
  return !!(row.ref || row.contract_no || row.buyer || row.qty || row.vsl_id);
}

function isPartialValue(value) {
  return str(value).toUpperCase() === 'PARTIAL';
}

const PARTIAL_ROW_LOCAL_FIELDS = new Set([
  '_row', '_duplicateMatchId', '_partialChild',
  'ref', 'intention_vessel', 'vsl_id', 'source_vsl_id',
  'match_id', 'partial', 'partial_qty',
]);

function materializePartialChild(row, record, previousRow, previousRecord, definition) {
  if (!previousRow || !previousRecord) return false;
  const contiguous = Number(record[definition.rowColumn]) === Number(previousRecord[definition.rowColumn]) + 1;
  if (!contiguous || !isPartialValue(record[definition.partialField]) || !isPartialValue(previousRecord[definition.partialField])) {
    return false;
  }

  let belongsToPrevious = true;
  if (definition.mergeAnchorField) {
    const anchor = str(record[definition.mergeAnchorField]);
    const previousAnchor = str(previousRecord[definition.mergeAnchorField]);
    const sameAnchor = !!anchor && anchor === previousAnchor;
    const mergedTail = !anchor && !str(record[definition.refField]) && !!str(record[definition.matchIdField]);
    belongsToPrevious = sameAnchor || mergedTail;
  }
  if (!belongsToPrevious) return false;

  row._partialChild = true;
  for (const [field, value] of Object.entries(previousRow)) {
    if (PARTIAL_ROW_LOCAL_FIELDS.has(field) || str(row[field]) || !str(value)) continue;
    row[field] = value;
  }
  return true;
}

function numberValue(value) {
  const parsed = Number(str(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function partialGroup(records, targetIndex, definition) {
  let start = targetIndex;
  let end = targetIndex;
  if (!isPartialValue(records[targetIndex]?.[definition.partialField])) return { start, end };
  while (
    start > 0 &&
    Number(records[start - 1][definition.rowColumn]) === Number(records[start][definition.rowColumn]) - 1 &&
    isPartialValue(records[start - 1][definition.partialField])
  ) start--;
  while (
    end + 1 < records.length &&
    Number(records[end + 1][definition.rowColumn]) === Number(records[end][definition.rowColumn]) + 1 &&
    isPartialValue(records[end + 1][definition.partialField])
  ) end++;
  return { start, end };
}

async function resolvedPartialGroup(records, targetIndex, definition, source, databaseDefinition) {
  if (!GR_DEFINITIONS.includes(definition)) return { ...partialGroup(records, targetIndex, definition), merged: false };
  const anchorColumn = indexByName(source.sourceColumns, definition.mergeAnchorField);
  if (anchorColumn < 0) throw Object.assign(new Error('GR contract merge anchor is not available'), { statusCode: 503 });
  const targetRow = Number(records[targetIndex][definition.rowColumn]);
  const liveGroup = await getSourceMergeGroup(databaseDefinition, { row: targetRow, anchorColumns: [anchorColumn] });
  const start = records.findIndex(record => Number(record[definition.rowColumn]) === liveGroup.startRow);
  const end = records.findIndex(record => Number(record[definition.rowColumn]) === liveGroup.endRow);
  if (start < 0 || end < start) {
    throw Object.assign(new Error('GR merge group does not match the current database rows'), { statusCode: 409 });
  }
  return { start, end, merged: liveGroup.merged };
}

async function refreshAfterRowInsert() {
  const refresh = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const result = await refreshBulkDatabases();
        if (!result?.skipped) return;
      } catch (err) {
        console.error('Post-partial database refresh failed:', err.message);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.error('Post-partial database refresh skipped: bulk sync remained busy');
  };
  setTimeout(refresh, 100);
  return { queued: true };
}

function buildFilters(rows, tabConfig) {
  const filters = {};
  for (const [filterKey, sourceIndex] of Object.entries(tabConfig.filters || {})) {
    const field = Object.entries(tabConfig.columns || {}).find(([, index]) => index === sourceIndex)?.[0];
    const values = new Set();
    rows.forEach(row => {
      const value = field ? str(row[field]) : '';
      if (value) values.add(value);
    });
    filters[filterKey] = [...values].sort();
  }
  return filters;
}

function buildGrFilters(rows, definition) {
  const filters = {};
  for (const [filterKey, fieldName] of Object.entries(definition.filterFields)) {
    const values = new Set();
    rows.forEach(row => { if (row[fieldName] || row[filterKey]) values.add(str(row[filterKey])); });
    filters[filterKey] = [...values].filter(Boolean).sort();
  }
  return filters;
}

function buildTab(definition) {
  const source = readTable(definition);
  const isStandard = STANDARD_DEFINITIONS.includes(definition);
  const tabConfig = isStandard ? standardTabConfig(definition, source.sourceColumns) : grTabConfig(definition, source.sourceColumns);
  const rows = [];
  const assignments = loadActiveAssignments();
  const matchIdOwners = matchIdOwnerRows(source.records, definition);

  let previousRecord = null;
  let previousRow = null;
  for (const record of source.records) {
    const row = isStandard
      ? mapStandardRow(record, definition, source.sourceColumns)
      : mapGrRow(record, definition, source.sourceColumns);
    if (str(row.source_vsl_id).toUpperCase() === 'VSL_00_0000') continue;
    const matchId = str(row.match_id).toLowerCase();
    const ownerRow = matchId ? matchIdOwners.get(matchId) : 0;
    if (ownerRow && ownerRow !== row._row) {
      row.vsl_id = '';
      row._duplicateMatchId = true;
    } else {
      applyAuthoritativeVesselLink(row, assignments);
    }
    materializePartialChild(row, record, previousRow, previousRecord, definition);
    if (!meaningful(row)) continue;
    rows.push(row);
    previousRecord = record;
    previousRow = row;
  }

  return {
    rows,
    filters: isStandard ? buildFilters(rows, tabConfig) : buildGrFilters(rows, definition),
    tabConfig,
    updatedAt: source.updatedAt,
  };
}

function getVesselMatchingData() {
  const tabs = {};
  const updatedAt = [];
  for (const definition of DEFINITIONS) {
    const tab = buildTab(definition);
    tabs[definition.tab] = tab;
    if (tab.updatedAt) updatedAt.push(tab.updatedAt);
  }
  return {
    tabs,
    updatedAt: updatedAt.sort().at(-1) || null,
    source: 'DB1-DB6 + DB10 Vessel Links',
  };
}

async function saveVesselMatching({ tab, row, value, expectedRef, expectedMatchId, expectedAssignedVslId }) {
  const definition = DEFINITION_BY_TAB.get(tab);
  if (!definition) throw Object.assign(new Error(`Invalid matching tab: ${tab}`), { statusCode: 400 });
  const rowNumber = Number(row);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw Object.assign(new Error('Invalid source row'), { statusCode: 400 });

  const source = readTable(definition);
  const record = source.records.find(candidate => String(candidate[definition.rowColumn]) === String(rowNumber));
  if (!record) throw Object.assign(new Error('Source row not found in database'), { statusCode: 409 });
  const currentRow = STANDARD_DEFINITIONS.includes(definition)
    ? mapStandardRow(record, definition, source.sourceColumns)
    : mapGrRow(record, definition, source.sourceColumns);
  assertExpectedRow(currentRow, expectedRef, expectedMatchId);
  const ownerRow = currentRow.match_id
    ? matchIdOwnerRows(source.records, definition).get(currentRow.match_id.toLowerCase())
    : 0;
  if (ownerRow && ownerRow !== rowNumber) {
    throw Object.assign(new Error('This copied row is waiting for a unique ERP Match ID. Reload after the next successful sheet sync.'), { statusCode: 409 });
  }

  const vslColumnIndex = indexByName(source.sourceColumns, definition.vslField);
  const vslColumnName = source.sourceColumns[vslColumnIndex];
  if (!vslColumnName) throw Object.assign(new Error('VSL_ID column is not available'), { statusCode: 503 });
  if (!currentRow.match_id) throw Object.assign(new Error('ERP Match ID is not ready yet. Please reload in a moment.'), { statusCode: 503 });
  if (expectedAssignedVslId !== undefined) {
    const currentAssignment = str(loadActiveAssignments().get(currentRow.match_id.toLowerCase())).toUpperCase();
    if (currentAssignment !== str(expectedAssignedVslId).toUpperCase()) {
      throw Object.assign(new Error('This contract assignment changed. Reload and try again.'), { statusCode: 409 });
    }
  }
  const databaseDefinition = DATA_DATABASES.find(item => item.name === definition.database);
  if (!databaseDefinition) throw Object.assign(new Error(`Database definition missing: ${definition.database}`), { statusCode: 503 });

  const nextValue = str(value);
  if (nextValue) {
    const validSlots = getValidLoadSlotIds(loadVesselDatabase().rows);
    if (!validSlots.has(nextValue.toLowerCase())) {
      throw Object.assign(new Error('This loadport is no longer available. Reload Vessel Matching and choose another loadport.'), { statusCode: 409 });
    }
    await upsertVesselLink({
      matchId: currentRow.match_id,
      sourceTab: definition.tab === 'GR SALES' || definition.tab === 'GR PURCHASE' ? 'MAIN SHIPMENT FILE' : definition.tab,
      contractRef: currentRow.ref || currentRow.contract_no,
      sourceRow: rowNumber,
      vslId: nextValue,
      updatedBy: 'ERP Vessel Matching',
    });
  } else {
    await deactivateVesselLink(currentRow.match_id, 'ERP Vessel Matching');
  }
  const graph = rebuildMatchingGraph();
  let legacyVslSynced = true;
  try {
    await writeSourceCells(databaseDefinition, [{ range: `${colToA1(vslColumnIndex)}${rowNumber}`, value: nextValue }]);
    updateLocalSourceFields(definition, rowNumber, { [vslColumnName]: nextValue });
  } catch (err) {
    // DB10 is authoritative. A failure to mirror the value into the old VSL
    // column must not leave Vessel Contract on the previous graph.
    legacyVslSynced = false;
    console.error('Legacy VSL mirror write failed after DB10 matching save:', {
      tab,
      row: rowNumber,
      error: err.message,
    });
  }

  return {
    saved: 1,
    tab,
    row: rowNumber,
    vsl_id: nextValue,
    graph: { childNodes: graph.childNodes, links: graph.links },
    legacyVslSynced,
  };
}

async function addVesselMatchingPartial({ tab, row, expectedRef, expectedMatchId }) {
  const definition = DEFINITION_BY_TAB.get(tab);
  if (!definition) throw Object.assign(new Error(`Invalid matching tab: ${tab}`), { statusCode: 400 });
  const rowNumber = Number(row);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw Object.assign(new Error('Invalid source row'), { statusCode: 400 });

  const source = readTable(definition);
  const records = [...source.records].sort((a, b) => Number(a[definition.rowColumn]) - Number(b[definition.rowColumn]));
  const targetIndex = records.findIndex(record => String(record[definition.rowColumn]) === String(rowNumber));
  if (targetIndex < 0) throw Object.assign(new Error('Source row not found in database'), { statusCode: 409 });
  const targetRecord = records[targetIndex];
  const targetRow = STANDARD_DEFINITIONS.includes(definition)
    ? mapStandardRow(targetRecord, definition, source.sourceColumns)
    : mapGrRow(targetRecord, definition, source.sourceColumns);
  assertExpectedRow(targetRow, expectedRef, expectedMatchId);

  const databaseDefinition = DATA_DATABASES.find(item => item.name === definition.database);
  if (!databaseDefinition) throw Object.assign(new Error(`Database definition missing: ${definition.database}`), { statusCode: 503 });
  const group = await resolvedPartialGroup(records, targetIndex, definition, source, databaseDefinition);
  const groupStartIndex = group.start;
  const groupEndIndex = group.end;

  const parentRecord = records[groupStartIndex];
  const groupRecords = records.slice(groupStartIndex, groupEndIndex + 1);
  const groupStartRow = Number(parentRecord[definition.rowColumn]);
  const groupEndRow = Number(records[groupEndIndex][definition.rowColumn]);
  const refColumn = indexByName(source.sourceColumns, definition.refField);
  const intentionColumn = indexByName(source.sourceColumns, definition.intentionField);
  const vslColumn = indexByName(source.sourceColumns, definition.vslField);
  const matchIdColumn = indexByName(source.sourceColumns, definition.matchIdField);
  const partialColumn = indexByName(source.sourceColumns, definition.partialField);
  const partialQtyColumn = indexByName(source.sourceColumns, definition.partialQtyField);
  const requiredColumns = [refColumn, intentionColumn, vslColumn, matchIdColumn, partialColumn, partialQtyColumn];
  if (requiredColumns.some(column => column < 0)) {
    throw Object.assign(new Error('Partial-shipment columns are not available'), { statusCode: 503 });
  }

  const previousRecord = records[groupEndIndex] || parentRecord;
  const newRow = source.sourceColumns.map(column => {
    const previousValue = previousRecord[column];
    return str(previousValue) ? previousValue : (parentRecord[column] == null ? '' : parentRecord[column]);
  });
  const mergeStartRows = Object.fromEntries(source.sourceColumns.map((column, index) => [
    index,
    groupEndIndex > groupStartIndex && str(previousRecord[column]) ? groupEndRow : groupStartRow,
  ]));
  newRow[refColumn] = '';
  newRow[intentionColumn] = '';
  newRow[vslColumn] = '';
  newRow[matchIdColumn] = crypto.randomUUID();
  newRow[partialColumn] = 'PARTIAL';
  newRow[partialQtyColumn] = '0';

  const fullQuantity = numberValue(parentRecord[definition.qtyField]);
  const allocatedChildren = groupRecords.slice(1).reduce((sum, record) => sum + numberValue(record[definition.partialQtyField]), 0);
  const parentPartialQty = String(Math.max(0, fullQuantity - allocatedChildren));
  const parentUpdates = [
    { column: partialColumn, value: 'PARTIAL' },
    { column: partialQtyColumn, value: parentPartialQty },
  ];

  const isGr = GR_DEFINITIONS.includes(definition);
  const mergeBeforeColumn = isGr ? indexByName(source.sourceColumns, 'main_payment_status') : source.sourceColumns.length;
  const defaultMergeFrom = isGr ? indexByName(source.sourceColumns, definition.defaultMergeFrom) : -1;
  const defaultMergeTo = isGr ? indexByName(source.sourceColumns, definition.defaultMergeTo) : -1;
  const newMergeColumns = isGr && !group.merged && defaultMergeFrom >= 0 && defaultMergeTo >= defaultMergeFrom
    ? Array.from({ length: defaultMergeTo - defaultMergeFrom + 1 }, (_, offset) => defaultMergeFrom + offset)
    : [];
  const inserted = await insertSourcePartialRow(databaseDefinition, {
    groupStartRow,
    groupEndRow,
    columnCount: source.sourceColumns.length,
    newRow,
    parentUpdates,
    noMergeColumns: [refColumn, intentionColumn, vslColumn, matchIdColumn, partialColumn, partialQtyColumn],
    mergeStartRows,
    preserveMergeTopology: isGr,
    mergeBeforeColumn,
    newMergeColumns,
  });
  const refresh = await refreshAfterRowInsert();
  return {
    ok: true,
    tab,
    parentRow: groupStartRow,
    newRow: inserted.inserted,
    parentPartialQty,
    childPartialQty: '0',
    refreshed: false,
    refreshQueued: !!refresh?.queued,
  };
}

async function removeVesselMatchingPartial({ tab, row, expectedRef, expectedMatchId }) {
  const definition = DEFINITION_BY_TAB.get(tab);
  if (!definition) throw Object.assign(new Error(`Invalid matching tab: ${tab}`), { statusCode: 400 });
  const rowNumber = Number(row);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw Object.assign(new Error('Invalid source row'), { statusCode: 400 });

  const source = readTable(definition);
  const records = [...source.records].sort((a, b) => Number(a[definition.rowColumn]) - Number(b[definition.rowColumn]));
  const targetIndex = records.findIndex(record => String(record[definition.rowColumn]) === String(rowNumber));
  if (targetIndex < 0) throw Object.assign(new Error('Source row not found in database'), { statusCode: 409 });
  const targetRecord = records[targetIndex];
  if (!isPartialValue(targetRecord[definition.partialField])) {
    throw Object.assign(new Error('Only a partial-shipment child can be removed'), { statusCode: 400 });
  }
  const targetRow = STANDARD_DEFINITIONS.includes(definition)
    ? mapStandardRow(targetRecord, definition, source.sourceColumns)
    : mapGrRow(targetRecord, definition, source.sourceColumns);
  assertExpectedRow(targetRow, expectedRef, expectedMatchId);

  const databaseDefinition = DATA_DATABASES.find(item => item.name === definition.database);
  if (!databaseDefinition) throw Object.assign(new Error(`Database definition missing: ${definition.database}`), { statusCode: 503 });
  const group = await resolvedPartialGroup(records, targetIndex, definition, source, databaseDefinition);
  if (targetIndex === group.start) {
    throw Object.assign(new Error('The parent contract cannot be deleted. Remove one of its partial child rows.'), { statusCode: 400 });
  }

  const groupRecords = records.slice(group.start, group.end + 1);
  const parentRecord = groupRecords[0];
  const groupStartRow = Number(parentRecord[definition.rowColumn]);
  const groupEndRow = Number(records[group.end][definition.rowColumn]);
  const remainingChildren = groupRecords.slice(1).filter(record => record !== targetRecord);
  const partialColumn = indexByName(source.sourceColumns, definition.partialField);
  const partialQtyColumn = indexByName(source.sourceColumns, definition.partialQtyField);
  if (partialColumn < 0 || partialQtyColumn < 0) {
    throw Object.assign(new Error('Partial-shipment columns are not available'), { statusCode: 503 });
  }

  const fullQuantity = numberValue(parentRecord[definition.qtyField]);
  const allocatedChildren = remainingChildren.reduce(
    (sum, record) => sum + numberValue(record[definition.partialQtyField]),
    0
  );
  const parentUpdates = remainingChildren.length
    ? [
        { column: partialColumn, value: 'PARTIAL' },
        { column: partialQtyColumn, value: String(Math.max(0, fullQuantity - allocatedChildren)) },
      ]
    : [
        { column: partialColumn, value: '' },
        { column: partialQtyColumn, value: '' },
      ];

  const mergeBeforeColumn = GR_DEFINITIONS.includes(definition)
    ? indexByName(source.sourceColumns, 'main_payment_status')
    : source.sourceColumns.length;
  await deleteSourcePartialRow(databaseDefinition, {
    groupStartRow,
    groupEndRow,
    row: rowNumber,
    parentUpdates,
    mergeBeforeColumn,
    deleteRowOnly: true,
  });
  try {
    await deactivateVesselLink(targetRow.match_id, 'ERP Vessel Matching');
    rebuildMatchingGraph();
  } catch (err) {
    // The source row is already deleted, so an orphaned inactive-link cleanup
    // can safely be retried by the next edit without restoring the child row.
    console.error('Vessel link cleanup after partial deletion failed:', err.message);
  }
  const refresh = await refreshAfterRowInsert();
  return {
    ok: true,
    tab,
    deletedRow: rowNumber,
    parentRow: groupStartRow,
    remainingChildren: remainingChildren.length,
    refreshed: false,
    refreshQueued: !!refresh?.queued,
  };
}

async function saveVesselMatchingPartialQty({ tab, row, value, expectedRef, expectedMatchId }) {
  const definition = DEFINITION_BY_TAB.get(tab);
  if (!definition) throw Object.assign(new Error(`Invalid matching tab: ${tab}`), { statusCode: 400 });
  const rowNumber = Number(row);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw Object.assign(new Error('Invalid source row'), { statusCode: 400 });
  const rawValue = str(value).replace(/,/g, '');
  const nextQuantity = Number(rawValue);
  if (rawValue === '' || !Number.isFinite(nextQuantity) || nextQuantity < 0) {
    throw Object.assign(new Error('Partial quantity must be a non-negative number'), { statusCode: 400 });
  }

  const source = readTable(definition);
  const records = [...source.records].sort((a, b) => Number(a[definition.rowColumn]) - Number(b[definition.rowColumn]));
  const targetIndex = records.findIndex(record => String(record[definition.rowColumn]) === String(rowNumber));
  if (targetIndex < 0) throw Object.assign(new Error('Source row not found in database'), { statusCode: 409 });
  const targetRecord = records[targetIndex];
  if (!isPartialValue(targetRecord[definition.partialField])) {
    throw Object.assign(new Error('Partial quantity can only be edited on a partial contract'), { statusCode: 400 });
  }
  const targetRow = STANDARD_DEFINITIONS.includes(definition)
    ? mapStandardRow(targetRecord, definition, source.sourceColumns)
    : mapGrRow(targetRecord, definition, source.sourceColumns);
  assertExpectedRow(targetRow, expectedRef, expectedMatchId);

  const databaseDefinition = DATA_DATABASES.find(item => item.name === definition.database);
  if (!databaseDefinition) throw Object.assign(new Error(`Database definition missing: ${definition.database}`), { statusCode: 503 });

  const partialQtyColumn = indexByName(source.sourceColumns, definition.partialQtyField);
  const partialQtyColumnName = source.sourceColumns[partialQtyColumn];
  if (!partialQtyColumnName) throw Object.assign(new Error('Partial quantity column is not available'), { statusCode: 503 });
  const normalized = String(nextQuantity);
  await writeSourceCells(databaseDefinition, [{ range: `${colToA1(partialQtyColumn)}${rowNumber}`, value: normalized }]);

  updateLocalSourceFields(definition, rowNumber, { [partialQtyColumnName]: normalized });
  return { saved: 1, tab, row: rowNumber, partial_qty: normalized };
}

async function reconcileVesselMatchingSlots({ remaps = [], clearVslIds = [] }, updatedBy = 'ERP Vessel Update') {
  const remapped = await remapVesselLinksByVslIds(remaps, updatedBy);
  const cleared = await deactivateVesselLinksByVslIds(clearVslIds, updatedBy);
  if (remapped.changed || cleared.changed) rebuildMatchingGraph();
  return { remapped: remapped.changed, cleared: cleared.changed };
}

module.exports = {
  getVesselMatchingData,
  saveVesselMatching,
  addVesselMatchingPartial,
  removeVesselMatchingPartial,
  saveVesselMatchingPartialQty,
  reconcileVesselMatchingSlots,
  DEFINITIONS,
  __test: { materializePartialChild },
};
