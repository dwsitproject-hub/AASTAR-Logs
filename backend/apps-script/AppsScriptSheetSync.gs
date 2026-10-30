const ERP_SYNC_SHEET_NAME = 'Sheet1';
const ERP_SYNC_DATA_COLUMNS = 5;
const ERP_SYNC_RECORD_ID_COLUMN = 6;
const ERP_SYNC_RECORD_ID_HEADER = '_ERP_ROW_ID';

/**
 * Run once after setting ERP_SYNC_URL and ERP_SYNC_SECRET in Apps Script's
 * project properties. This installs the edit/change triggers and prepares the
 * hidden stable row ID column used by the VPS sync coordinator.
 */
function installErpSheetSync() {
  const config = getErpSyncConfig_();
  if (!config.url || !config.secret) {
    throw new Error('Set ERP_SYNC_URL and ERP_SYNC_SECRET in Script Properties first.');
  }

  const spreadsheet = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(trigger => {
    const handler = trigger.getHandlerFunction();
    if (handler === 'erpSheetOnEdit' || handler === 'erpSheetOnChange') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('erpSheetOnEdit').forSpreadsheet(spreadsheet).onEdit().create();
  ScriptApp.newTrigger('erpSheetOnChange').forSpreadsheet(spreadsheet).onChange().create();

  const sheet = spreadsheet.getSheetByName(ERP_SYNC_SHEET_NAME);
  if (!sheet) throw new Error(`Sheet not found: ${ERP_SYNC_SHEET_NAME}`);
  prepareRecordIds_(sheet, 2, Math.max(0, sheet.getLastRow() - 1));
  sheet.hideColumns(ERP_SYNC_RECORD_ID_COLUMN);
}

/** Installable edit-trigger handler. Do not run this function manually. */
function erpSheetOnEdit(event) {
  if (!event || !event.range) return;
  const range = event.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== ERP_SYNC_SHEET_NAME) return;

  const firstDataRow = Math.max(2, range.getRow());
  const lastEditedRow = range.getLastRow();
  const dataRowCount = Math.max(0, lastEditedRow - firstDataRow + 1);
  let recordIds = [];
  let rowValues = [];

  if (dataRowCount) {
    const lock = LockService.getDocumentLock();
    lock.waitLock(5000);
    try {
      recordIds = prepareRecordIds_(sheet, firstDataRow, dataRowCount);
      SpreadsheetApp.flush();
      rowValues = sheet
        .getRange(firstDataRow, 1, dataRowCount, ERP_SYNC_DATA_COLUMNS)
        .getDisplayValues();
    } finally {
      lock.releaseLock();
    }
  }

  postErpSyncEvent_({
    eventId: Utilities.getUuid(),
    eventType: 'edit',
    spreadsheetId: event.source.getId(),
    sheetName: sheet.getName(),
    row: range.getRow(),
    column: range.getColumn(),
    numRows: range.getNumRows(),
    numColumns: range.getNumColumns(),
    values: range.getDisplayValues(),
    rowValues,
    recordIds,
    changedAt: new Date().toISOString(),
  });
}

/** Installable change-trigger handler. Ordinary edits are handled above. */
function erpSheetOnChange(event) {
  if (!event || event.changeType === 'EDIT') return;
  postErpSyncEvent_({
    eventId: Utilities.getUuid(),
    eventType: 'structure',
    changeType: event.changeType || 'OTHER',
    spreadsheetId: event.source.getId(),
    sheetName: ERP_SYNC_SHEET_NAME,
    changedAt: new Date().toISOString(),
  });
}

function prepareRecordIds_(sheet, firstRow, rowCount) {
  if (!rowCount) return [];
  const header = String(sheet.getRange(1, ERP_SYNC_RECORD_ID_COLUMN).getValue() || '').trim();
  if (header && header !== ERP_SYNC_RECORD_ID_HEADER) {
    throw new Error(`Column F is reserved for ${ERP_SYNC_RECORD_ID_HEADER}.`);
  }
  if (!header) sheet.getRange(1, ERP_SYNC_RECORD_ID_COLUMN).setValue(ERP_SYNC_RECORD_ID_HEADER);

  const range = sheet.getRange(firstRow, ERP_SYNC_RECORD_ID_COLUMN, rowCount, 1);
  const values = range.getValues();
  let changed = false;
  values.forEach(row => {
    if (!String(row[0] || '').trim()) {
      row[0] = Utilities.getUuid();
      changed = true;
    }
  });
  if (changed) range.setValues(values);
  return values.map(row => String(row[0] || ''));
}

function getErpSyncConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const legacyConfig = typeof CONFIG !== 'undefined' && CONFIG ? CONFIG : {};
  return {
    url: String(properties.getProperty('ERP_SYNC_URL') || legacyConfig.vpsEventsUrl || '').trim(),
    secret: String(properties.getProperty('ERP_SYNC_SECRET') || legacyConfig.secret || '').trim(),
  };
}

function postErpSyncEvent_(eventPayload) {
  const config = getErpSyncConfig_();
  if (!config.url || !config.secret) throw new Error('ERP sync properties are not configured.');
  const response = UrlFetchApp.fetch(config.url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ secret: config.secret, ...eventPayload }),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error(`ERP sync returned HTTP ${status}: ${response.getContentText().slice(0, 250)}`);
  }
}
