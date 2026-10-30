'use strict';

// Auto-merge checker — runs after each cache refresh cycle.
// Scans Matching Sales tabs for PARTIAL rows that aren't merged and merges them.

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { TAB_CONFIGS } = require('./matchingSales');

const SHEET_ID = '1AlO_PUh0vakXXYGu3r-vIZW4O1NV4bePieNkaYhPPdE';
const SA_INDEX = 1;

let running = false;

function str(v) { return v == null ? '' : v.toString().trim(); }

function getAuth() {
  const keysDir = process.env.SERVICE_ACCOUNTS_DIR || path.join(__dirname, '../service-accounts');
  const files = fs.readdirSync(keysDir).filter(f => f.endsWith('.json') && f !== 'kpnstock.json').sort();
  const key = JSON.parse(fs.readFileSync(path.join(keysDir, files[SA_INDEX]), 'utf8'));
  return new google.auth.GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

function colToA1(c) {
  let s = '';
  c = parseInt(c);
  while (true) {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
    if (c < 0) break;
  }
  return s;
}

// Find groups of contiguous PARTIAL rows and return their expected merge ranges
function findPartialGroups(data, partialCol) {
  const groups = []; // each group = { start (0-based), end (exclusive, 0-based) }
  let i = 1;
  while (i < data.length) {
    const row = data[i] || [];
    if (str(row[partialCol]).toUpperCase() === 'PARTIAL') {
      // Walk backwards to find the parent (first row of this group that may or may not have PARTIAL)
      let start = i;
      // The parent is the row above the first PARTIAL if it doesn't have PARTIAL itself
      if (start > 1 && str(data[start - 1]?.[partialCol]).toUpperCase() !== 'PARTIAL') {
        start = start - 1; // include the parent
      }
      // Walk forward to find end of group
      let end = i;
      while (end + 1 < data.length && str(data[end + 1]?.[partialCol]).toUpperCase() === 'PARTIAL') {
        end++;
      }
      if (end > start) { // only care about groups with 2+ rows
        groups.push({ start, end: end + 1 }); // end is exclusive
      }
      i = end + 1;
    } else {
      i++;
    }
  }
  return groups;
}

async function checkAndMerge() {
  if (running) return;
  running = true;
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Get all tab metadata (merges)
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets(properties(sheetId,title),merges)'
    });

    for (const [tabName, tabConfig] of Object.entries(TAB_CONFIGS)) {
      const tabMeta = (meta.data.sheets || []).find(s => s.properties.title === tabName);
      if (!tabMeta) continue;
      const sheetId = tabMeta.properties.sheetId;
      const existingMerges = tabMeta.merges || [];

      // Get current data for this tab from cache
      const { getCached } = require('./sheetsCache');
      const cached = getCached(SHEET_ID, tabName, true);
      if (!cached || !cached.data || cached.data.length < 2) continue;

      const groups = findPartialGroups(cached.data, tabConfig.partialCol);
      if (groups.length === 0) continue;

      const SKIP_MERGE = new Set(tabConfig.noMerge);
      const maxCol = Math.max((cached.data[0] || []).length, tabConfig.partialCol + 1);

      // For each group, check if all expected merges exist
      const needsMerge = [];
      for (const group of groups) {
        // Check if col 1 (a non-skipped col) is already merged across this range
        const alreadyMerged = existingMerges.some(m =>
          m.startRowIndex === group.start &&
          m.endRowIndex === group.end &&
          m.startColumnIndex === 1
        );
        if (!alreadyMerged) {
          needsMerge.push(group);
        }
      }

      if (needsMerge.length === 0) continue;

      // Unmerge everything in the affected row ranges first (safe — idempotent)
      const unmergeRequests = [];
      for (const group of needsMerge) {
        const affectedMerges = existingMerges.filter(m =>
          m.startRowIndex >= group.start && m.endRowIndex <= group.end
        );
        affectedMerges.forEach(m => unmergeRequests.push({ unmergeCells: { range: m } }));
      }

      // Build merge requests
      const mergeRequests = [];
      for (const group of needsMerge) {
        for (let col = 0; col < maxCol; col++) {
          if (SKIP_MERGE.has(col)) continue;
          mergeRequests.push({
            mergeCells: {
              range: { sheetId, startRowIndex: group.start, endRowIndex: group.end, startColumnIndex: col, endColumnIndex: col + 1 },
              mergeType: 'MERGE_COLUMNS'
            }
          });
        }
      }

      const allRequests = [...unmergeRequests, ...mergeRequests];
      if (allRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: { requests: allRequests }
        });
        console.log(`Auto-merge: fixed ${needsMerge.length} group(s) in ${tabName}`);
      }
    }
  } catch (err) {
    // Don't spam logs — this is best-effort
    if (!err.message.includes('Quota exceeded')) {
      console.error('Auto-merge check failed:', err.message);
    }
  } finally {
    running = false;
  }
}

module.exports = { checkAndMerge };
