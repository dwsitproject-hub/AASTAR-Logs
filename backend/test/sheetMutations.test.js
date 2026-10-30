'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSheetMutation, sheetMutationStats } = require('../services/sheetMutations');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('sheet mutations run one at a time in arrival order', async () => {
  const events = [];
  let active = 0;
  let maxActive = 0;
  const task = name => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`start ${name}`);
    await delay(15);
    events.push(`end ${name}`);
    active -= 1;
    return name;
  };
  const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map(name => runSheetMutation(task(name))));
  assert.deepEqual(results, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(maxActive, 1);
  assert.deepEqual(events.slice(0, 4), ['start a', 'end a', 'start b', 'end b']);
  assert.equal(sheetMutationStats().pending, 0);
});

test('a failing mutation does not block the next one', async () => {
  await assert.rejects(runSheetMutation(async () => { throw new Error('sheet write failed'); }), /sheet write failed/);
  assert.equal(await runSheetMutation(async () => 'next'), 'next');
});

test('a request that waits too long gets SHEET_BUSY and is never executed', async () => {
  let lateRan = false;
  const slow = runSheetMutation(() => delay(80).then(() => 'slow'));
  const late = runSheetMutation(async () => { lateRan = true; }, { maxWaitMs: 20 });
  await assert.rejects(late, error => error.code === 'SHEET_BUSY' && error.statusCode === 409);
  assert.equal(await slow, 'slow');
  assert.equal(await runSheetMutation(async () => 'after'), 'after');
  assert.equal(lateRan, false);
});
