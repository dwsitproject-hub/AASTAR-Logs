// Write queue: collects writes, dedupes by cell, flushes per-spreadsheet via batchUpdate.
const { google } = require('googleapis');

let serviceAccounts = [];
let flushIntervalMs = 1500;
let onCacheUpdate = null; // callback to update in-memory cache after queueing
let getAuth = null;

// queue[spreadsheetId][tabName][range] = { values, accountIndex, queuedAt }
const queue = {};
let flushing = false;
let stats = { totalQueued: 0, totalFlushed: 0, totalApiCalls: 0, lastFlushAt: null, lastError: null };

function configureQueue({ accounts, intervalMs, authClient }) {
  serviceAccounts = accounts;
  flushIntervalMs = intervalMs || 1500;
  getAuth = authClient;
}

function enqueueWrite({ sheetId, tabName, range, values, accountIndex }) {
  if (!queue[sheetId]) queue[sheetId] = {};
  if (!queue[sheetId][tabName]) queue[sheetId][tabName] = {};
  // Last-write-wins for the same range within a flush window
  queue[sheetId][tabName][range] = { values, accountIndex, queuedAt: Date.now() };
  stats.totalQueued++;
}

async function flushOnce() {
  if (flushing) return;
  flushing = true;
  try {
    const spreadsheetIds = Object.keys(queue);
    for (const sheetId of spreadsheetIds) {
      const tabs = queue[sheetId];
      if (!tabs || Object.keys(tabs).length === 0) continue;

      // Collect ranges for this spreadsheet, grouped by service account.
      // batchUpdate auth is tied to one account, so split into one call per account.
      const byAccount = {};
      for (const tabName of Object.keys(tabs)) {
        for (const range of Object.keys(tabs[tabName])) {
          const entry = tabs[tabName][range];
          const idx = entry.accountIndex;
          if (!byAccount[idx]) byAccount[idx] = [];
          byAccount[idx].push({ range: `${tabName}!${range}`, values: entry.values });
        }
      }

      // Take a snapshot of what we're flushing, then clear the queue for this sheet.
      // If a write fails, we'll re-enqueue it.
      const snapshot = JSON.parse(JSON.stringify(queue[sheetId]));
      delete queue[sheetId];

      for (const accountIdx of Object.keys(byAccount)) {
        const data = byAccount[accountIdx];
        try {
          const auth = getAuth(parseInt(accountIdx));
          if (!auth) throw new Error(`No auth for account #${accountIdx}`);
          const sheets = google.sheets({ version: 'v4', auth });
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
              valueInputOption: 'USER_ENTERED',
              data
            }
          });
          stats.totalApiCalls++;
          stats.totalFlushed += data.length;
        } catch (err) {
          stats.lastError = `${new Date().toISOString()}: ${err.message}`;
          console.error(`Batch flush failed for ${sheetId} (account ${accountIdx}):`, err.message);
          // Re-enqueue everything for this account from snapshot
          for (const tabName of Object.keys(snapshot)) {
            for (const range of Object.keys(snapshot[tabName])) {
              if (snapshot[tabName][range].accountIndex === parseInt(accountIdx)) {
                enqueueWrite({ sheetId, tabName, range, values: snapshot[tabName][range].values, accountIndex: snapshot[tabName][range].accountIndex });
              }
            }
          }
        }
      }
    }
    stats.lastFlushAt = new Date().toISOString();
  } finally {
    flushing = false;
  }
}

function startQueueWorker() {
  setInterval(flushOnce, flushIntervalMs);
}

function getQueueStats() {
  let pending = 0;
  for (const sid of Object.keys(queue)) {
    for (const tab of Object.keys(queue[sid])) pending += Object.keys(queue[sid][tab]).length;
  }
  return { ...stats, pending };
}

module.exports = { configureQueue, enqueueWrite, flushOnce, startQueueWorker, getQueueStats };
