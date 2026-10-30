'use strict';

const { buildContractDashboardFromDatabases } = require('./contractDashboard');
const { buildVesselContractFromDatabases } = require('./vesselContract');
const { buildVesselStatusFromDatabase } = require('./vesselStatus');
const { buildExportSummaryFromDatabases } = require('./exportSummary');
const { loadVesselDatabase, buildVesselList } = require('./vesselUpdate');

let running = false;
let lastStartedAt = 0;
const MIN_INTERVAL_MS = 60 * 1000;

function preloadDashboards(reason = 'unknown') {
  const now = Date.now();
  if (running || now - lastStartedAt < MIN_INTERVAL_MS) return false;

  running = true;
  lastStartedAt = now;
  const tasks = [
    ['contract-dashboard', () => buildContractDashboardFromDatabases()],
    ['vessel-contract', () => buildVesselContractFromDatabases()],
    ['vessel-status', () => buildVesselStatusFromDatabase()],
    ['export-summary', () => buildExportSummaryFromDatabases()],
    ['vessel-update', () => {
      const snapshot = loadVesselDatabase();
      return buildVesselList(snapshot.rows, { statusFilter: 'open', query: '' });
    }],
  ];

  // Yield between each CPU-heavy build so login and health requests remain responsive.
  const run = (index) => {
    if (index >= tasks.length) {
      running = false;
      console.log(`Dashboard preload complete (${reason})`);
      return;
    }
    setImmediate(() => {
      const [name, task] = tasks[index];
      try {
        task();
      } catch (err) {
        console.error(`Dashboard preload failed for ${name}:`, err.message);
      }
      setTimeout(() => run(index + 1), 25);
    });
  };

  run(0);
  return true;
}

module.exports = { preloadDashboards };
