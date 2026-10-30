'use strict';

// Serializes interactive Google Sheets mutations (vessel create/save/delete,
// vessel matching, contract unlink). These endpoints read a cached snapshot,
// check it, then write by row number; without serialization two users can be
// handed the same VSL ID / target row, or delete a row that another request
// just shifted. Writes are rare compared with reads, so one queue per process
// costs little. The backend runs as a single process (see server.js); a second
// instance would need a shared lock instead.

const DEFAULT_MAX_WAIT_MS = Number(process.env.SHEET_MUTATION_MAX_WAIT_MS || 10 * 1000);

let tail = Promise.resolve();
let pending = 0;

function busyError() {
  const error = new Error('Another change is being saved to the sheet. Please try again in a moment.');
  error.statusCode = 409;
  error.code = 'SHEET_BUSY';
  return error;
}

// Runs `task` after every previously queued mutation has finished. Rejects with
// SHEET_BUSY (409) when the wait exceeds `maxWaitMs`, so the browser's request
// timeout is not reached while the server would still write later.
function runSheetMutation(task, { maxWaitMs = DEFAULT_MAX_WAIT_MS } = {}) {
  const previous = tail;
  let release;
  tail = new Promise(resolve => { release = resolve; });
  pending += 1;

  return new Promise((resolve, reject) => {
    let abandoned = false;
    const timer = setTimeout(() => {
      abandoned = true;
      reject(busyError());
    }, maxWaitMs);

    previous.then(async () => {
      clearTimeout(timer);
      let outcome;
      if (!abandoned) {
        try {
          outcome = { value: await task() };
        } catch (error) {
          outcome = { error };
        }
      }
      pending -= 1;
      release();
      if (outcome?.error) reject(outcome.error);
      else if (outcome) resolve(outcome.value);
    });
  });
}

function sheetMutationStats() {
  return { pending };
}

module.exports = { runSheetMutation, sheetMutationStats };
