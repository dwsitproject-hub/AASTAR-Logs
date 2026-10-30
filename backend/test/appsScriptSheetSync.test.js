'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sheet-sync-'));
process.env.DB_PATH = path.join(tempDir, 'erp.db');

const { getDb, initDb } = require('../db/database');
const sync = require('../services/appsScriptSheetSync');

initDb();

test.after(() => {
  getDb().close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('pending appends are persisted and later edits are coalesced', () => {
  const appended = sync.queueAppend(['1', 'Buyer A', 'C-001', 'FOB', '900']);
  sync.queueCellUpdates({
    recordId: appended.recordId,
    changes: [{ column: 5, value: '925' }],
  });

  const row = sync.getRowsResponse().rows.find(item => item.recordId === appended.recordId);
  assert.equal(row.values[4], '925');
  assert.equal(row.pending, true);

  const outbox = getDb().prepare(
    'SELECT operation, values_json FROM apps_script_sheet_outbox WHERE record_id = ?'
  ).all(appended.recordId);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].operation, 'append');
  assert.equal(JSON.parse(outbox[0].values_json)[4], '925');
});

test('insert-below shifts later rows and keeps pending edits in one insert job', () => {
  sync.ingestEvent({
    eventId: 'event-insert-anchor',
    eventType: 'edit',
    row: 10,
    column: 1,
    numRows: 1,
    numColumns: 5,
    rowValues: [['10', 'Anchor Buyer', 'C-010', 'FOB', '1000']],
    recordIds: ['insert-anchor'],
  });
  sync.ingestEvent({
    eventId: 'event-insert-follower',
    eventType: 'edit',
    row: 11,
    column: 1,
    numRows: 1,
    numColumns: 5,
    rowValues: [['11', 'Follower Buyer', 'C-011', 'CIF', '1100']],
    recordIds: ['insert-follower'],
  });

  const inserted = sync.queueInsert(
    ['10A', 'Inserted Buyer', 'C-010A', 'FOB', '1050'],
    { afterRecordId: 'insert-anchor' }
  );
  assert.equal(inserted.rowNumber, 11);
  assert.equal(sync.getRowsResponse().rows.find(row => row.recordId === 'insert-follower').rowNumber, 12);

  sync.queueCellUpdates({
    recordId: inserted.recordId,
    changes: [{ column: 5, value: '1075' }],
  });
  const outbox = getDb().prepare(
    'SELECT operation, values_json FROM apps_script_sheet_outbox WHERE record_id = ?'
  ).all(inserted.recordId);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].operation, 'insert');
  const payload = JSON.parse(outbox[0].values_json);
  assert.equal(payload.afterRecordId, 'insert-anchor');
  assert.equal(payload.rowValues[4], '1075');
  assert.throws(
    () => sync.queueInsert(['nested'], { afterRecordId: inserted.recordId }),
    /finish syncing/
  );
});

test('inbound events are idempotent and preserve unrelated queued changes', () => {
  sync.ingestEvent({
    eventId: 'event-create-row',
    eventType: 'edit',
    row: 3,
    column: 1,
    numRows: 1,
    numColumns: 5,
    rowValues: [['2', 'Remote Buyer', 'C-002', 'CIF', '1000']],
    recordIds: ['record-from-sheet'],
  });
  sync.queueCellUpdates({
    recordId: 'record-from-sheet',
    changes: [{ column: 2, value: 'ERP Buyer' }],
  });

  const first = sync.ingestEvent({
    eventId: 'event-update-contract',
    eventType: 'edit',
    row: 3,
    column: 3,
    numRows: 1,
    numColumns: 1,
    values: [['C-002A']],
    rowValues: [['2', 'Remote Buyer', 'C-002A', 'CIF', '1000']],
    recordIds: ['record-from-sheet'],
  });
  const duplicate = sync.ingestEvent({
    eventId: 'event-update-contract',
    eventType: 'edit',
    row: 3,
    column: 3,
    numRows: 1,
    numColumns: 1,
    values: [['C-002A']],
    rowValues: [['2', 'Remote Buyer', 'C-002A', 'CIF', '1000']],
    recordIds: ['record-from-sheet'],
  });

  assert.equal(first.changed, true);
  assert.equal(duplicate.duplicate, true);
  const row = sync.getRowsResponse().rows.find(item => item.recordId === 'record-from-sheet');
  assert.deepEqual(row.values, ['2', 'ERP Buyer', 'C-002A', 'CIF', '1000']);
  assert.ok(getDb().prepare(
    "SELECT 1 FROM apps_script_sheet_outbox WHERE dedupe_key = 'cell:record-from-sheet:2'"
  ).get());
});

test('a later Sheet edit cancels an overlapping queued ERP cell write', () => {
  sync.ingestEvent({
    eventId: 'event-update-buyer',
    eventType: 'edit',
    row: 3,
    column: 2,
    numRows: 1,
    numColumns: 1,
    values: [['Final Sheet Buyer']],
    rowValues: [['2', 'Final Sheet Buyer', 'C-002A', 'CIF', '1000']],
    recordIds: ['record-from-sheet'],
  });

  const row = sync.getRowsResponse().rows.find(item => item.recordId === 'record-from-sheet');
  assert.equal(row.values[1], 'Final Sheet Buyer');
  assert.equal(getDb().prepare(
    "SELECT 1 FROM apps_script_sheet_outbox WHERE dedupe_key = 'cell:record-from-sheet:2'"
  ).get(), undefined);
});

test('row moves reorder the local mirror and persist a stable target', () => {
  getDb().prepare('DELETE FROM apps_script_sheet_outbox').run();
  getDb().prepare('DELETE FROM apps_script_sheet_rows').run();
  [
    [2, 'move-a', 'A'],
    [3, 'move-b', 'B'],
    [4, 'move-c', 'C'],
    [5, 'move-d', 'D'],
  ].forEach(([row, recordId, value]) => {
    sync.ingestEvent({
      eventId: `event-${recordId}`,
      eventType: 'edit',
      row,
      column: 1,
      numRows: 1,
      numColumns: 5,
      rowValues: [[value, `${value} Buyer`, `${value}-001`, 'FOB', '1000']],
      recordIds: [recordId],
    });
  });

  const moved = sync.queueMove({
    recordId: 'move-b',
    targetRecordId: 'move-d',
    position: 'after',
  });
  assert.equal(moved.fromRow, 3);
  assert.equal(moved.rowNumber, 5);
  assert.deepEqual(
    sync.getRowsResponse().rows.map(row => row.recordId),
    ['move-a', 'move-c', 'move-d', 'move-b']
  );

  const outbox = getDb().prepare(
    "SELECT operation, record_id, values_json FROM apps_script_sheet_outbox WHERE operation = 'move'"
  ).get();
  assert.equal(outbox.operation, 'move');
  assert.equal(outbox.record_id, 'move-b');
  assert.deepEqual(JSON.parse(outbox.values_json), {
    targetRecordId: 'move-d',
    position: 'after',
  });
  assert.throws(
    () => sync.queueAppend(['blocked']),
    /row movement/
  );

  getDb().prepare("DELETE FROM apps_script_sheet_outbox WHERE operation = 'move'").run();
  assert.equal(sync.queueMove({
    recordId: 'move-b',
    targetRecordId: 'move-d',
    position: 'after',
  }).queued, false);
});
