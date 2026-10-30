const express = require('express');
const { getDb } = require('../db/database');
const { hasPageAccess, requireAuth, requireAdmin } = require('../middleware/auth');
const { getCached, fetchSheet, writeSheet, writeSheetSync, appendSheet, deleteRow, refreshAllCaches } = require('../services/sheetsCache');
const {
  buildExportSummaryFromDatabases,
  buildExportSummaryTotalFromDatabases,
  buildVesselSchedule,
  loadExportSummaryDatabases,
} = require('../services/exportSummary');
const { buildContractDashboardFromDatabases } = require('../services/contractDashboard');
const { buildVesselContractFromDatabases, listPendingVesselContracts } = require('../services/vesselContract');
const { loadAbvOptions } = require('../services/abvOptions');
const {
  buildVesselList,
  loadVesselDatabase,
  updateVesselDatabase,
  nextVslId,
  displayToIso,
  colToA1,
  normalizeDemmRate,
  PORT_COL_BASE,
  PORT_COL_STRIDE,
  PORT_OFF,
} = require('../services/vesselUpdate');
const { buildVesselStatusFromDatabase } = require('../services/vesselStatus');
const { buildVesselMap } = require('../vesselMap');
const { buildLiveVessels } = require('../services/liveVessels');
const { buildExportPlanningFromDatabase } = require('../services/exportPlanning');
const { buildWeeklyOpsMeetingFromDatabases } = require('../services/weeklyOpsMeeting');
const { TAB_CONFIGS, buildRows: buildMatchingRows } = require('../services/matchingSales');
const { getVesselMatchingData, saveVesselMatching, addVesselMatchingPartial, removeVesselMatchingPartial, saveVesselMatchingPartialQty, reconcileVesselMatchingSlots } = require('../services/vesselMatching');
const { listActiveContractLinks, unlinkActiveContract } = require('../services/contractUnlink');
const { getQueueStats, flushOnce } = require('../services/writeQueue');
const stockSummary = require('../services/stockSummary');
const {
  DATA_DATABASES,
  refreshBulkDatabases,
  writeSourceCells,
  writeSourceRange,
  readSourceRange,
  deleteSourceRow,
} = require('../services/bulkDataSync');
const { broadcastDataUpdated } = require('../services/realtime');
const { runSheetMutation } = require('../services/sheetMutations');

const router = express.Router();

// Retired legacy write paths. They sit on the indexed sheet cache and write
// queue, which server.js no longer starts, so they answered "saved" without ever
// writing (or edited a real sheet from an empty cache). No page calls them.
function retiredWrite(_req, res) {
  res.status(410).json({ error: 'This write path has been retired. Use the Vessel Update or Vessel Matching pages.' });
}
router.put('/data/:configId', requireAuth, retiredWrite);
router.post('/data/:configId/append', requireAuth, retiredWrite);
router.post('/queue/flush', requireAuth, requireAdmin, retiredWrite);
router.post('/matching-sales/save', requireAuth, retiredWrite);
router.post('/matching-sales/add-partial', requireAuth, retiredWrite);
router.post('/matching-sales/remove-partial', requireAuth, retiredWrite);

// Interactive sheet writes run one at a time; see services/sheetMutations.js.
function serialized(handler) {
  return async (req, res) => {
    try {
      await runSheetMutation(() => handler(req, res));
    } catch (err) {
      if (res.headersSent) {
        console.error('Sheet mutation failed after responding:', err?.message || err);
        return;
      }
      if (err?.code === 'SHEET_BUSY') return res.status(409).json({ code: err.code, error: err.message });
      sendInternalError(res, 500, 'Sheet change failed', err);
    }
  };
}

// Raw department feeds require a whole-department grant. Page endpoints use
// exact tab paths so one Logistics/Operations tab cannot expose another.
function canAccessDept(user, dept) {
  if (user.is_admin) return true;
  return (user.permissions || []).includes(dept);
}

function canAccessAnyPage(user, ...pagePaths) {
  return pagePaths.some(pagePath => hasPageAccess(user, pagePath));
}

function sendInternalError(res, status, publicMessage, error, extra = {}) {
  console.error(`${publicMessage}:`, error?.message || error);
  return res.status(status).json({ error: publicMessage, ...extra });
}

function sendOperationError(res, error, publicMessage, extra = {}) {
  const status = Number(error?.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: error.message, ...extra });
  }
  return sendInternalError(res, 500, publicMessage, error, extra);
}

function parseCsvParam(value) {
  if (!value) return [];
  return value.toString().split(',').map(v => v.trim()).filter(Boolean);
}

function contractDashboardFilterOptions(vessels) {
  const entities = {};
  const cargoes = {};
  const loadports = {};
  const discharges = {};
  const statuses = {};
  vessels.forEach(v => {
    if (v.entity) entities[v.entity] = true;
    if (v.status) statuses[v.status] = true;
    v.loadports?.forEach(lp => { if (lp.loadport) loadports[lp.loadport] = true; });
    v.dischargePorts?.forEach(dp => { if (dp.port) discharges[dp.port] = true; });
    v.purchases.concat(v.sales).forEach(c => { if (c.cargo) cargoes[c.cargo] = true; });
  });
  return {
    entities: Object.keys(entities).sort(),
    cargoes: Object.keys(cargoes).sort(),
    loadports: Object.keys(loadports).sort(),
    discharges: Object.keys(discharges).sort(),
    statuses: Object.keys(statuses).sort()
  };
}

function vesselMatchesContractDashboardFilters(v, query) {
  const q = str(query.q).toLowerCase();
  const entities = new Set(parseCsvParam(query.entities));
  const cargoes = new Set(parseCsvParam(query.cargoes));
  const loadports = new Set(parseCsvParam(query.loadports));
  const discharges = new Set(parseCsvParam(query.discharges));
  const statuses = new Set(parseCsvParam(query.statuses));
  const pendingOnly = query.pending === '1' || query.pending === 'true';

  if (pendingOnly && !(v.balanceLines?.length > 0)) return false;
  if (statuses.size && !statuses.has(str(v.status))) return false;
  if (entities.size && !entities.has(str(v.entity))) return false;
  if (cargoes.size && !v.purchases.concat(v.sales).some(c => cargoes.has(str(c.cargo)))) return false;
  if (loadports.size && !v.loadports?.some(lp => loadports.has(str(lp.loadport)))) return false;
  if (discharges.size && !v.dischargePorts?.some(dp => discharges.has(str(dp.port)))) return false;

  if (!q) return true;
  if (str(v.vessel).toLowerCase().includes(q)) return true;
  if (str(v.vslId).toLowerCase().includes(q)) return true;
  if (str(v.entity).toLowerCase().includes(q)) return true;
  if (v.loadports?.some(lp => str(lp.loadport).toLowerCase().includes(q))) return true;
  if (v.dischargePorts?.some(dp => str(dp.port).toLowerCase().includes(q))) return true;
  return v.purchases.concat(v.sales).some(c =>
    str(c.contractNo).toLowerCase().includes(q) ||
    str(c.counterparty).toLowerCase().includes(q) ||
    str(c.cargo).toLowerCase().includes(q)
  );
}

function summarizeContractDashboardVessel(v) {
  return {
    ...v,
    purchaseCount: v.purchases?.length || 0,
    salesCount: v.sales?.length || 0,
    purchases: [],
    sales: []
  };
}

// Get all sheet configs
router.get('/config', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const configs = db.prepare('SELECT * FROM sheets_config').all();
  res.json(configs);
});

// Add sheet config
router.post('/config', requireAuth, requireAdmin, (req, res) => {
  const { sheet_id, sheet_name, tab_name, department, service_account_index, range } = req.body;
  if (!sheet_id || !sheet_name || !tab_name || !department) {
    return res.status(400).json({ error: 'sheet_id, sheet_name, tab_name, department required' });
  }
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO sheets_config (sheet_id, sheet_name, tab_name, department, service_account_index, range) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sheet_id, sheet_name, tab_name, department, service_account_index || 0, range || null);
  res.status(201).json({ id: result.lastInsertRowid });
});

// Delete sheet config
router.delete('/config/:id', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM sheets_config WHERE id = ?').run(req.params.id);
  res.json({ message: 'Config deleted' });
});

// Force cache refresh
router.post('/refresh', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await refreshBulkDatabases();
    res.json({ message: 'Bulk databases refreshed', result });
  } catch (err) {
    sendInternalError(res, 502, 'Bulk databases could not be refreshed', err);
  }
});

// Get cached data for a department
router.get('/data/:department', requireAuth, (req, res) => {
  const { department } = req.params;
  const user = req.user;

  if (!canAccessDept(user, department)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const db = getDb();
  const configs = db.prepare('SELECT * FROM sheets_config WHERE department = ?').all(department);
  const result = configs.map(config => {
    const cached = getCached(config.sheet_id, config.tab_name);
    return {
      id: config.id,
      sheet_name: config.sheet_name,
      tab_name: config.tab_name,
      department: config.department,
      data: cached ? cached.data : [],
      updatedAt: cached ? cached.updatedAt : null
    };
  });

  res.json(result);
});

// Write data to a sheet (queued, returns immediately)
router.put('/data/:configId', requireAuth, (req, res) => {
  const db = getDb();
  const config = db.prepare('SELECT * FROM sheets_config WHERE id = ?').get(req.params.configId);
  if (!config) return res.status(404).json({ error: 'Sheet config not found' });

  const { department } = config;
  if (!canAccessDept(req.user, department)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { range, values } = req.body;
  if (!range || !values) return res.status(400).json({ error: 'range and values required' });

  try {
    writeSheet(config.sheet_id, config.tab_name, range, values, config.service_account_index);
    broadcastDataUpdated({
      department,
      resource: 'sheet',
      action: 'queued-write',
      configId: Number(req.params.configId),
      tab: config.tab_name,
    });
    res.json({ message: 'Write queued', queued: true });
  } catch (err) {
    sendInternalError(res, 500, 'Sheet write could not be queued', err);
  }
});

// Force flush the write queue (admin)
router.post('/queue/flush', requireAuth, requireAdmin, async (req, res) => {
  await flushOnce();
  res.json({ message: 'Flush triggered', stats: getQueueStats() });
});

// Queue stats (admin)
router.get('/queue/stats', requireAuth, requireAdmin, (req, res) => {
  res.json(getQueueStats());
});

// Append row to a sheet
router.post('/data/:configId/append', requireAuth, async (req, res) => {
  const db = getDb();
  const config = db.prepare('SELECT * FROM sheets_config WHERE id = ?').get(req.params.configId);
  if (!config) return res.status(404).json({ error: 'Sheet config not found' });

  const { department } = config;
  if (!canAccessDept(req.user, department)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { values } = req.body;
  if (!values) return res.status(400).json({ error: 'values required' });

  try {
    await appendSheet(config.sheet_id, config.tab_name, values, config.service_account_index);
    broadcastDataUpdated({
      department,
      resource: 'sheet',
      action: 'append',
      configId: Number(req.params.configId),
      tab: config.tab_name,
    });
    res.json({ message: 'Row appended successfully' });
  } catch (err) {
    sendInternalError(res, 500, 'Sheet row could not be appended', err);
  }
});

// Export Summary aggregated view (port of the Apps Script dashboard)
router.get('/export-summary', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/export-summary')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(buildExportSummaryFromDatabases());
  } catch (err) {
    sendInternalError(res, 503, 'Export Summary data is temporarily unavailable', err);
  }
});

router.get('/export-summary-total', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/export-summary-total')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(buildExportSummaryTotalFromDatabases());
  } catch (err) {
    sendInternalError(res, 503, 'Export Summary Total data is temporarily unavailable', err);
  }
});

// Contract Dashboard aggregated view (port of Dashboard.gs)
router.get('/contract-dashboard', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/operations/contract-dashboard')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  let result;
  try {
    result = buildContractDashboardFromDatabases();
  } catch (err) {
    return sendInternalError(res, 503, 'Contract Dashboard data is temporarily unavailable', err);
  }
  const updatedAt = result.updatedAt;

  if (req.query.details === '1') {
    const vslId = str(req.query.vslId);
    const vessel = result.vessels.find(v => str(v.vslId) === vslId);
    if (!vessel) return res.status(404).json({ error: 'Vessel not found' });
    return res.json({
      vslId: vessel.vslId,
      purchases: vessel.purchases,
      sales: vessel.sales,
      updatedAt
    });
  }

  const filterOptions = contractDashboardFilterOptions(result.vessels);
  const filteredVessels = result.vessels.filter(v => vesselMatchesContractDashboardFilters(v, req.query));
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 80, 20), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const page = filteredVessels.slice(offset, offset + limit).map(summarizeContractDashboardVessel);

  res.json({
    ...result,
    vessels: page,
    filterOptions,
    updatedAt,
    pagination: {
      offset,
      limit,
      total: filteredVessels.length,
      nextOffset: offset + page.length < filteredVessels.length ? offset + page.length : null,
      hasMore: offset + page.length < filteredVessels.length
    },
    counts: { ...result.counts, shown: page.length, filtered: filteredVessels.length }
  });
});

// Vessel Contract — one-table view of vessel/loadport/cargo and linked contracts
router.get('/vessel-contract/pending', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/operations/vessel-contract', '/logistics/vessel-contract')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(listPendingVesselContracts({
      q: req.query.q,
      offset: req.query.offset,
      limit: req.query.limit
    }));
  } catch (err) {
    sendInternalError(res, 503, 'Pending vessel contracts are temporarily unavailable', err);
  }
});

router.get('/contract-unlink', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/contract-unlink')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(listActiveContractLinks({ q: req.query.q, offset: req.query.offset, limit: req.query.limit }));
  } catch (err) {
    sendInternalError(res, 503, 'Active contract links are temporarily unavailable', err);
  }
});

router.post('/contract-unlink', requireAuth, serialized(async (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/contract-unlink')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const result = await unlinkActiveContract(req.body || {});
    broadcastDataUpdated({ department: 'logistics', resource: 'contract-unlink', action: 'unlink' });
    res.json(result);
  } catch (err) {
    sendOperationError(res, err, 'Contract could not be unlinked');
  }
}));

// Weekly Operations presentation view backed by GR/POME, Vessel DB and TPG DB12-DB14.
router.get('/weekly-ops-meeting', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/operations/tpg-gr-weekly-ops')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(buildWeeklyOpsMeetingFromDatabases());
  } catch (err) {
    sendInternalError(res, 503, 'Weekly Operations data is temporarily unavailable', err);
  }
});

router.get('/vessel-contract', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/operations/vessel-contract', '/logistics/vessel-contract', '/logistics/vessel-status')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(buildVesselContractFromDatabases());
  } catch (err) {
    sendInternalError(res, 503, 'Vessel Contract data is temporarily unavailable', err);
  }
});

// Commercial Open Shipments — the same DB1-DB5 to DB6 matching result as
// Vessel Contract, exposed through a Commercial-permitted read-only route.
router.get('/open-shipments', requireAuth, (req, res) => {
  const canRead = canAccessAnyPage(req.user, '/commercial/open-shipments');
  if (!canRead) return res.status(403).json({ error: 'Access denied' });
  try {
    res.json(buildVesselContractFromDatabases());
  } catch (err) {
    sendInternalError(res, 503, 'Open Shipments data is temporarily unavailable', err);
  }
});

// Export Planning - shared DB6 vessel/loadport coordination view for
// Chartering and Logistics, with department-specific frontend presentations.
router.get('/export-planning', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/chartering/export-planning', '/logistics/export-planning')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(buildExportPlanningFromDatabase());
  } catch (err) {
    sendInternalError(res, 503, 'Export Planning data is temporarily unavailable', err);
  }
});

// Vessel Daily-Edit Dashboard - list
router.get('/vessel-update', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-update', '/logistics/demurrage')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { rows, updatedAt } = loadVesselDatabase();
    const statusFilter = (req.query.status || 'open').toString();
    const query = (req.query.q || '').toString();
    const result = buildVesselList(rows, { statusFilter, query });
    let abv = { ports: result.options?.ports || [], cargoes: result.options?.cargos || [] };
    try {
      abv = loadAbvOptions();
    } catch (abvError) {
      console.error('ABV dropdown database is not available:', abvError.message);
    }
    result.options = {
      ...(result.options || {}),
      abvPorts: abv.ports,
      abvCargoes: abv.cargoes,
    };
    res.json({ ...result, updatedAt });
  } catch (err) {
    sendInternalError(res, 503, 'Vessel data is temporarily unavailable', err);
  }
});

// Vessel Daily-Edit - save one batch to the source sheet and DB6.
router.post('/vessel-update/save', requireAuth, serialized(async (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-update')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { updates, expected_ids, slot_remaps = [] } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) return res.status(400).json({ error: 'updates required' });

  const definition = DATA_DATABASES.find(source => source.name === 'DB6');
  if (!definition) return res.status(503).json({ error: 'DB6 source is not configured' });

  // Verify row positions against the current DB6 snapshot before writing.
  const { rows } = loadVesselDatabase();
  const skipped = [];
  const validUpdates = [];
  for (const u of updates) {
    if (!Number.isInteger(u.row) || u.row < 2 || !Number.isInteger(u.col) || u.col < 0) {
      skipped.push({ row: u.row, reason: 'invalid row or column' });
      continue;
    }
    const rowIdx = u.row - 1; // 1-based to 0-based
    const expected = expected_ids ? expected_ids[u.row] : null;
    const actual = rows[rowIdx] ? str(rows[rowIdx][0]) : '';
    if (expected && expected !== actual) {
      skipped.push({ row: u.row, expected, actual });
      continue;
    }
    validUpdates.push(u);
  }

  // Re-check row identity against the live sheet: the DB6 snapshot can predate
  // another user's create/delete, which would shift row numbers under us.
  if (validUpdates.length) {
    let liveIds;
    try {
      liveIds = await readSourceRange(definition, 'A1:A');
    } catch (err) {
      return sendInternalError(res, 502, 'Vessel sheet could not be read', err, { skipped });
    }
    for (let index = validUpdates.length - 1; index >= 0; index--) {
      const u = validUpdates[index];
      const cachedId = rows[u.row - 1] ? str(rows[u.row - 1][0]) : '';
      const liveId = str(liveIds[u.row - 1]?.[0]);
      if (cachedId !== liveId) {
        skipped.push({ row: u.row, expected: cachedId, actual: liveId });
        validUpdates.splice(index, 1);
      }
    }
  }

  // Convert date isos to readable values before writing both sources.
  for (const u of validUpdates) {
    let value = u.value;
    if (u.date && value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      // store as readable date string
      const [y, m, d] = value.split('-').map(Number);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      value = `${d} ${months[m-1]} ${y}`;
    }
    // Store demmurage rate as a plain number in column O.
    if (u.col === 14 && value !== '' && value != null) {
      value = normalizeDemmRate(value);
    }
    u.value = value;
  }
  if (!validUpdates.length) return res.json({ saved: 0, skipped });

  // Evaluate the completed row after every staged update. A full port block can
  // move to another rotation without losing its VSL ID; only slots that end up
  // non-load or empty have their contract assignments released.
  const updatesByRow = new Map();
  for (const update of validUpdates) {
    if (!updatesByRow.has(update.row)) updatesByRow.set(update.row, []);
    updatesByRow.get(update.row).push(update);
  }
  const slotsToClear = new Set();
  const slotIdsByRow = new Map();
  const changedRows = new Set();
  for (const [sheetRow, rowUpdates] of updatesByRow) {
    const original = rows[sheetRow - 1] || [];
    const finalRow = [...original];
    rowUpdates.forEach(update => { finalRow[update.col] = update.value; });
    if (rowUpdates.some(update => str(original[update.col]) !== str(update.value))) changedRows.add(sheetRow);
    slotIdsByRow.set(sheetRow, new Set(Array.from({ length: 10 }, (_, portIndex) => {
      const base = PORT_COL_BASE + portIndex * PORT_COL_STRIDE;
      return str(original[base + PORT_OFF.vslid]).trim();
    }).filter(Boolean)));
    const touchedPorts = new Set(rowUpdates.map(update => {
      const relative = update.col - (PORT_COL_BASE + PORT_OFF.vslid);
      return relative >= 0 ? Math.floor(relative / PORT_COL_STRIDE) : -1;
    }).filter(index => index >= 0 && index < 10));
    for (const portIndex of touchedPorts) {
      const base = PORT_COL_BASE + portIndex * PORT_COL_STRIDE;
      const vslId = str(finalRow[base + PORT_OFF.vslid]).trim();
      const portName = str(finalRow[base + PORT_OFF.port_name]).trim();
      const statusLd = str(finalRow[base + PORT_OFF.status_ld]).trim().toLowerCase();
      if (vslId && (!portName || statusLd !== 'load')) slotsToClear.add(vslId);
    }
  }
  const validRemaps = Array.isArray(slot_remaps) ? slot_remaps.filter(item => {
    const row = Number(item?.row);
    const ids = slotIdsByRow.get(row);
    return Number.isInteger(row) && changedRows.has(row) && ids?.has(str(item?.from).trim()) && ids?.has(str(item?.to).trim()) && str(item.from).trim() !== str(item.to).trim();
  }).map(item => ({ from: str(item.from).trim(), to: str(item.to).trim() })) : [];

  try {
    await writeSourceCells(definition, validUpdates.map(u => ({
      range: `${colToA1(u.col)}${u.row}`,
      value: u.value,
    })));
    const saved = updateVesselDatabase(validUpdates);
    const matching = await reconcileVesselMatchingSlots({ remaps: validRemaps, clearVslIds: [...slotsToClear] });
    broadcastDataUpdated({
      department: 'logistics',
      resource: 'vessel-update',
      action: 'save',
      rows: [...new Set(validUpdates.map(update => update.row))],
    });
    if (matching.cleared || matching.remapped) {
      broadcastDataUpdated({
        department: 'logistics',
        resource: 'vessel-matching',
        action: 'reconcile-port-slots',
        cleared: matching.cleared,
        remapped: matching.remapped,
      });
    }
    setTimeout(() => refreshBulkDatabases().catch(err => console.error('Post-edit DB6 refresh failed:', err.message)), 500);
    res.json({ saved, skipped, clearedMatches: matching.cleared, remappedMatches: matching.remapped, source: 'sheet+DB6+DB10' });
  } catch (err) {
    sendInternalError(res, 502, 'Vessel update write failed', err, { skipped });
  }
}));

// Vessel Daily-Edit - create a new entry (single sparse append row)
// Body shape:
//   {
//     vessel: { charterer, entity, vessel, voyage, imo, mmsi, status, ops, demm_rate, laytime_rate, laytime_starts, remarks, nominated },
//     ports: [ { port_name, status_ld, shipper, port_entity, qty, l_cargo, status_oc, laycan, cr, eta, etb, etc } x10 ]
//   }
// Writes the supported vessel and per-port fields while leaving each port's
// fixed VSL-ID formula column untouched. Col A is written as the stable vessel ID.
router.post('/vessel-update/create', requireAuth, serialized(async (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-update')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { vessel = {}, ports = [] } = req.body || {};
  const definition = DATA_DATABASES.find(source => source.name === 'DB6');
  if (!definition) return res.status(503).json({ error: 'DB6 source is not configured' });
  // Read IDs (A) and vessel names (E) live, inside the mutation queue, so two
  // creates never get the same VSL ID or target row from a stale DB6 snapshot.
  let data;
  try {
    data = await readSourceRange(definition, 'A1:E');
  } catch (err) {
    return sendInternalError(res, 503, 'Vessel data is temporarily unavailable', err);
  }

  // Auto-generate vsl_id by scanning existing data
  const newVslId = nextVslId(data);

  // Build a sparse row wide enough for all ten 16-column port blocks.
  const row = new Array(220).fill('');
  row[0] = newVslId;                                            // A: vsl_id
  // Vessel-level columns. Column B is Charterer in the current DB6 schema.
  if (vessel.charterer) row[1]  = vessel.charterer;             // B
  if (vessel.entity)    row[2]  = vessel.entity;                // C
  if (vessel.vessel)    row[4]  = vessel.vessel;                // E
  if (vessel.voyage)    row[5]  = vessel.voyage;                // F
  if (vessel.imo)       row[7]  = vessel.imo;                   // H
  if (vessel.mmsi)      row[8]  = vessel.mmsi;                  // I
  if (vessel.status)    row[9]  = vessel.status;                // J
  if (vessel.ops)       row[10] = vessel.ops;                   // K
  if (vessel.demm_rate !== '' && vessel.demm_rate != null) {
    row[14] = normalizeDemmRate(vessel.demm_rate);              // O
  }
  if (vessel.laytime_rate)   row[15] = vessel.laytime_rate;     // P
  if (vessel.laytime_starts) row[16] = vessel.laytime_starts;   // Q
  if (vessel.remarks)   row[17] = vessel.remarks;               // R
  if (vessel.nominated !== undefined) {
    row[18] = vessel.nominated === true || vessel.nominated === 'TRUE' ? 'TRUE' : 'FALSE'; // S
  }

  // Per-port: write editable cells only; the fixed VSL-ID formula column remains untouched.
  const PORT_BASE = 20, PORT_STRIDE = 16;
  const PORT_FIELD_OFFSET = {
    port_name: 0, status_ld: 1, shipper: 2, port_entity: 3, qty: 4, l_cargo: 5,
    status_oc: 6, laycan: 7, cr: 8, eta: 9, eta_time: 10, etb: 11, etb_time: 12, etc: 13, etc_time: 14
  };
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const isoToDDMmm = (s) => {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || '';
    const [y, m, d] = s.split('-').map(Number);
    return `${d} ${MONTHS[m-1]} ${y}`;
  };

  for (let i = 0; i < Math.min(10, ports.length); i++) {
    const p = ports[i] || {};
    const base = PORT_BASE + i * PORT_STRIDE;
    for (const [field, off] of Object.entries(PORT_FIELD_OFFSET)) {
      let v = p[field];
      if (v == null || v === '') continue;
      if (['cr','eta','etb','etc'].includes(field)) v = isoToDDMmm(v);
      row[base + off] = v;
    }
  }

  // Trim trailing empties for cleanliness
  let lastNonEmpty = -1;
  for (let i = row.length - 1; i >= 0; i--) {
    if (row[i] !== '') { lastNonEmpty = i; break; }
  }
  const trimmed = row.slice(0, lastNonEmpty + 1);

  try {
    // Find first available row: scan the formatted cache for the largest row index
    // where col E (Vessel name) is non-empty. Arrayformula in col A doesn't produce
    // vessel names, so col E gives a reliable "last real entry" bound.
    let lastRealRow = 1; // header is row 1
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      if (r && str(r[4]).trim()) {
        if ((i + 1) > lastRealRow) lastRealRow = i + 1;
      }
    }
    const targetRow = lastRealRow + 1;
    const lastColA1 = colToA1(trimmed.length - 1);
    const targetRange = `A${targetRow}:${lastColA1}${targetRow}`;
    await writeSourceRange(definition, targetRange, [trimmed]);
    const refreshed = await refreshBulkDatabases();
    if (refreshed.skipped) {
      setTimeout(() => refreshBulkDatabases().catch(err => console.error('Post-create DB6 refresh failed:', err.message)), 500);
    }
    broadcastDataUpdated({
      department: 'logistics',
      resource: 'vessel-update',
      action: 'create',
      vslId: newVslId,
      row: targetRow,
    });
    res.json({ ok: true, vsl_id: newVslId, row: targetRow, source: 'sheet+DB6' });
  } catch (err) {
    sendInternalError(res, 500, 'Vessel entry could not be created', err);
  }
}));

// Vessel Daily-Edit - delete an entire row by row number (with vsl_id sanity check)
router.post('/vessel-update/delete', requireAuth, serialized(async (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-update')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { row, vsl_id } = req.body || {};
  if (!row || !Number.isInteger(row) || row < 2) return res.status(400).json({ error: 'Invalid row' });

  const definition = DATA_DATABASES.find(source => source.name === 'DB6');
  if (!definition) return res.status(503).json({ error: 'DB6 source is not configured' });

  // Verify row hasn't shifted
  let data;
  try {
    data = loadVesselDatabase().rows;
  } catch (err) {
    return sendInternalError(res, 503, 'Vessel data is temporarily unavailable', err);
  }
  const rowIdx = row - 1;
  const actualVslId = data[rowIdx] ? str(data[rowIdx][0]) : '';
  if (vsl_id && actualVslId !== vsl_id) {
    return res.status(409).json({ error: `Row has shifted (expected ${vsl_id}, found ${actualVslId})` });
  }
  // Confirm against the live sheet too: deleting by row number must never hit a
  // row that moved since the last sync.
  try {
    const live = (await readSourceRange(definition, `A${row}:E${row}`))[0] || [];
    const cachedRow = data[rowIdx] || [];
    if (str(live[0]) !== actualVslId || str(live[4]).trim() !== str(cachedRow[4]).trim()) {
      return res.status(409).json({ error: 'This row changed in the sheet. Refresh and try again.' });
    }
  } catch (err) {
    return sendInternalError(res, 502, 'Vessel sheet could not be read', err);
  }

  try {
    await deleteSourceRow(definition, row);
    const refreshed = await refreshBulkDatabases();
    if (refreshed.skipped) {
      setTimeout(() => refreshBulkDatabases().catch(err => console.error('Post-delete DB6 refresh failed:', err.message)), 500);
    }
    broadcastDataUpdated({
      department: 'logistics',
      resource: 'vessel-update',
      action: 'delete',
      vslId: vsl_id || actualVslId,
      row,
    });
    res.json({ ok: true, source: 'sheet+DB6' });
  } catch (err) {
    sendInternalError(res, 500, 'Vessel entry could not be deleted', err);
  }
}));

function str(v) { return v == null ? '' : v.toString(); }

// Vessel Status — Daily ETA update for incoming export vessels (logistics)
router.get('/vessel-status', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-status')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(buildVesselStatusFromDatabase());
  } catch (err) {
    sendInternalError(res, 503, 'Vessel Status data is temporarily unavailable', err);
  }
});

// Vessel Map uses DB6 for the searchable open-vessel sidebar. VesselFinder
// resolves the live AIS position by IMO/MMSI when DB6 coordinates are blank.
router.get('/vessel-map', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-map')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { rows, updatedAt } = loadVesselDatabase();
    res.json({ ...buildVesselMap(rows), updatedAt });
  } catch (err) {
    sendInternalError(res, 503, 'Vessel Map data is temporarily unavailable', err);
  }
});

// Live Vessels combines the DB6 voyage board with sanitized server-side
// AISStream positions. The AISStream credential never leaves the backend.
router.get('/live-vessels', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/live-vessels')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(buildLiveVessels());
  } catch (err) {
    sendInternalError(res, 503, 'Live Vessels data is temporarily unavailable', err);
  }
});

// KPN Export uses the same DB6 projection as Vessel Status with a configurable
// Commercial presentation on the frontend.
router.get('/kpn-export', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/commercial/kpn-export')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(buildVesselStatusFromDatabase());
  } catch (err) {
    sendInternalError(res, 503, 'KPN Export data is temporarily unavailable', err);
  }
});

// Stock Summary — DB9 is populated by the shared bulk sync from the Monthly tab.
router.get('/stock-summary', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/stock-summary')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const payload = stockSummary.getCached();

  // Augment with vessel ETAs pulled from the DB6 vessel database.
  // Filter window = the date range of the stock data.
  let vessels = [];
  try {
    if (payload.ports.length && payload.ports[0].dates.length) {
      const startIso = payload.ports[0].dates[0];
      const endIso = payload.ports[0].dates[payload.ports[0].dates.length - 1];
      const { mainData } = loadExportSummaryDatabases();
      vessels = buildVesselSchedule(mainData, startIso, endIso);
    }
  } catch (err) {
    console.error('Stock Summary vessel overlay failed:', err.message);
  }

  res.json({ ...payload, vessels });
});

// ==================== MATCHING SALES/PURCHASE (multi-tab) ====================

const VALID_MATCHING_TABS = Object.keys(TAB_CONFIGS);

// Database-backed Vessel Matching. DB1-DB5 provide contract rows and DB6
// provides the vessel/loadport slots; source writes still go through the
// configured service account and update SQLite immediately.
router.get('/vessel-matching', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-matching')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(getVesselMatchingData());
  } catch (err) {
    sendInternalError(res, 503, 'Vessel Matching data is temporarily unavailable', err);
  }
});

router.post('/vessel-matching/save', requireAuth, serialized(async (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-matching')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const result = await saveVesselMatching(req.body || {});
    broadcastDataUpdated({ department: 'logistics', resource: 'vessel-matching', action: 'save' });
    res.json(result);
  } catch (err) {
    sendOperationError(res, err, 'Vessel match could not be saved');
  }
}));

router.post('/vessel-matching/add-partial', requireAuth, serialized(async (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-matching')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const result = await addVesselMatchingPartial(req.body || {});
    broadcastDataUpdated({ department: 'logistics', resource: 'vessel-matching', action: 'add-partial' });
    res.json(result);
  } catch (err) {
    console.error('Vessel Matching partial insert failed:', {
      tab: req.body?.tab,
      row: req.body?.row,
      error: err.message,
    });
    sendOperationError(res, err, 'Partial shipment could not be added');
  }
}));

router.post('/vessel-matching/remove-partial', requireAuth, serialized(async (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-matching')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const result = await removeVesselMatchingPartial(req.body || {});
    broadcastDataUpdated({ department: 'logistics', resource: 'vessel-matching', action: 'remove-partial' });
    res.json(result);
  } catch (err) {
    sendOperationError(res, err, 'Partial shipment could not be removed');
  }
}));

router.post('/vessel-matching/save-partial-qty', requireAuth, serialized(async (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-matching')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const result = await saveVesselMatchingPartialQty(req.body || {});
    broadcastDataUpdated({ department: 'logistics', resource: 'vessel-matching', action: 'partial-qty' });
    res.json(result);
  } catch (err) {
    sendOperationError(res, err, 'Partial quantity could not be saved', { available: err.available });
  }
}));

// GET matching-sales data — accepts ?tab=AASTAR SALES (default) | AASTAR PURCHASE | KIMARA SALES | KIMARA PURCHASE
router.get('/matching-sales', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-matching')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const tabName = (req.query.tab || 'AASTAR SALES').toString();
  const tabConfig = TAB_CONFIGS[tabName];
  if (!tabConfig) return res.status(400).json({ error: `Invalid tab. Valid: ${VALID_MATCHING_TABS.join(', ')}` });

  const db = getDb();
  const cfg = db.prepare('SELECT * FROM sheets_config WHERE sheet_name=? AND tab_name=?').get('Matching Sales', tabName);
  if (!cfg) return res.status(404).json({ error: `No config for tab: ${tabName}` });

  const cached = getCached(cfg.sheet_id, cfg.tab_name, true);
  const data = cached ? cached.data : [];
  const result = buildMatchingRows(data, tabConfig);
  res.json({ ...result, tabConfig, updatedAt: cached ? cached.updatedAt : null });
});

// POST matching-sales/save — save edits (queued writes)
router.post('/matching-sales/save', requireAuth, (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-matching')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { updates, expected_refs, tab } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) return res.status(400).json({ error: 'updates required' });
  const tabName = tab || 'AASTAR SALES';
  if (!TAB_CONFIGS[tabName]) return res.status(400).json({ error: 'Invalid tab' });

  const db = getDb();
  const cfg = db.prepare('SELECT * FROM sheets_config WHERE sheet_name=? AND tab_name=?').get('Matching Sales', tabName);
  if (!cfg) return res.status(404).json({ error: 'No config for tab: ' + tabName });

  const cached = getCached(cfg.sheet_id, cfg.tab_name, true);
  const data = cached ? cached.data : [];
  const skipped = [];
  const validUpdates = [];

  for (const u of updates) {
    const rowIdx = u.row - 1;
    const expected = expected_refs ? expected_refs[u.row] : null;
    const actual = data[rowIdx] ? str(data[rowIdx][0]) : '';
    if (expected && expected !== actual) {
      skipped.push({ row: u.row, expected, actual });
      continue;
    }
    validUpdates.push(u);
  }

  let saved = 0;
  for (const u of validUpdates) {
    const a1col = colToA1(u.col);
    const range = `${a1col}${u.row}`;
    writeSheet(cfg.sheet_id, cfg.tab_name, range, [[u.value]], cfg.service_account_index);
    saved++;
  }
  broadcastDataUpdated({ department: 'logistics', resource: 'matching-sales', action: 'save', tab: tabName });
  res.json({ saved, skipped });
});

// POST matching-sales/add-partial — mark a contract as partial shipment
// Inserts a new row below the given row and merges all cells EXCEPT A, AK, AR, AS
// (those stay independent per partial row). Sets AS="PARTIAL" on both rows.
router.post('/matching-sales/add-partial', requireAuth, async (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-matching')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { afterRow, ref, tab } = req.body;
  if (!afterRow || !Number.isInteger(afterRow) || afterRow < 2) return res.status(400).json({ error: 'Invalid row' });
  const tabName = tab || 'AASTAR SALES';
  const tabConfig = TAB_CONFIGS[tabName];
  if (!tabConfig) return res.status(400).json({ error: 'Invalid tab' });

  const db = getDb();
  const cfg = db.prepare('SELECT * FROM sheets_config WHERE sheet_name=? AND tab_name=?').get('Matching Sales', tabName);
  if (!cfg) return res.status(404).json({ error: 'No config for tab: ' + tabName });

  // Validate row hasn't shifted
  const cached = getCached(cfg.sheet_id, cfg.tab_name, true);
  const data = cached ? cached.data : [];
  const rowIdx = afterRow - 1;
  const actualRef = data[rowIdx] ? str(data[rowIdx][0]) : '';
  if (ref && actualRef !== ref) return res.status(409).json({ error: `Row shifted (expected ${ref}, found ${actualRef})` });

  const parentRow = data[rowIdx] || [];

  try {
    const { google } = require('googleapis');
    const path = require('path');
    const fs = require('fs');
    const keysDir = process.env.SERVICE_ACCOUNTS_DIR || path.join(__dirname, '../service-accounts');
    const files = fs.readdirSync(keysDir).filter(f => f.endsWith('.json') && f !== 'kpnstock.json').sort();
    const key = JSON.parse(fs.readFileSync(path.join(keysDir, files[cfg.service_account_index]), 'utf8'));
    const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });

    // Get tab's numeric sheetId
    const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheet_id, fields: 'sheets(properties(sheetId,title))' });
    const tab = (meta.data.sheets || []).find(s => s.properties.title === cfg.tab_name);
    if (!tab) throw new Error(`Tab not found: ${cfg.tab_name}`);
    const sheetId = tab.properties.sheetId;

    // Find the full group: walk up/down from afterRow to find all contiguous partial rows
    const pCol = tabConfig.partialCol;
    let groupStart = rowIdx; // 0-based index of afterRow
    while (groupStart > 0 && str(data[groupStart - 1]?.[pCol]).toUpperCase() === 'PARTIAL') {
      groupStart--;
    }
    // The parent might not have PARTIAL yet (first time adding) — include it
    if (groupStart === rowIdx) groupStart = rowIdx; // parent is this row
    let groupEnd = rowIdx; // inclusive
    for (let i = rowIdx + 1; i < data.length; i++) {
      if (str(data[i]?.[pCol]).toUpperCase() === 'PARTIAL') groupEnd = i;
      else break;
    }

    // Unmerge any existing merges spanning the group BEFORE inserting
    const fullMeta = await sheets.spreadsheets.get({
      spreadsheetId: cfg.sheet_id,
      fields: 'sheets(properties(sheetId,title),merges)'
    });
    const fullTab = (fullMeta.data.sheets || []).find(s => s.properties.sheetId === sheetId);
    const existingMerges = (fullTab?.merges || []).filter(m =>
      m.startRowIndex >= groupStart && m.endRowIndex <= groupEnd + 1
    );
    if (existingMerges.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: cfg.sheet_id,
        requestBody: { requests: existingMerges.map(m => ({ unmergeCells: { range: m } })) }
      });
    }

    // Insert a blank row below afterRow
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: cfg.sheet_id,
      requestBody: {
        requests: [{
          insertDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: afterRow, endIndex: afterRow + 1 },
            inheritFromBefore: true
          }
        }]
      }
    });

    // Build the new row
    const newRow = [...parentRow];
    const partialCol = tabConfig.partialCol;
    while (newRow.length <= partialCol) newRow.push('');
    for (const col of tabConfig.noMerge) {
      if (col === partialCol) continue;
      if (col < newRow.length) newRow[col] = '';
    }
    newRow[partialCol] = 'PARTIAL';

    // Mark parent as PARTIAL
    const parentAsRange = `${cfg.tab_name}!${colToA1(partialCol)}${afterRow}`;
    await writeSheetSync(cfg.sheet_id, parentAsRange, [['PARTIAL']], cfg.service_account_index);

    // Write the new row
    const targetRow = afterRow + 1;
    const lastCol = colToA1(newRow.length - 1);
    await writeSheetSync(cfg.sheet_id, `${cfg.tab_name}!A${targetRow}:${lastCol}${targetRow}`, [newRow], cfg.service_account_index);

    // Re-merge the entire group (now includes the new row)
    // After insertion: groupStart stays the same, but groupEnd shifted +1, plus we added 1 row
    const mergeStart = groupStart; // 0-based
    const mergeEnd = groupEnd + 2;  // +1 for the new row, +1 to make exclusive

    const SKIP_MERGE = new Set(tabConfig.noMerge);
    const mergeRequests = [];
    for (let col = 0; col < newRow.length; col++) {
      if (SKIP_MERGE.has(col)) continue;
      mergeRequests.push({
        mergeCells: {
          range: { sheetId, startRowIndex: mergeStart, endRowIndex: mergeEnd, startColumnIndex: col, endColumnIndex: col + 1 },
          mergeType: 'MERGE_COLUMNS'
        }
      });
    }
    if (mergeRequests.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: cfg.sheet_id,
        requestBody: { requests: mergeRequests }
      });
    }

    setTimeout(() => {
      refreshAllCaches().catch(() => {});
      refreshBulkDatabases().catch(() => {});
    }, 500);
    broadcastDataUpdated({ department: 'logistics', resource: 'matching-sales', action: 'add-partial', tab: tabName });
    res.json({ ok: true, newRow: targetRow });
  } catch (err) {
    sendInternalError(res, 500, 'Partial shipment could not be added', err);
  }
});

// POST matching-sales/remove-partial — unmerge and delete the last partial row of a group
router.post('/matching-sales/remove-partial', requireAuth, async (req, res) => {
  if (!canAccessAnyPage(req.user, '/logistics/vessel-matching')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { row, ref, tab } = req.body;
  if (!row || !Number.isInteger(row) || row < 2) return res.status(400).json({ error: 'Invalid row' });
  const tabName = tab || 'AASTAR SALES';
  const tabConfig = TAB_CONFIGS[tabName];
  if (!tabConfig) return res.status(400).json({ error: 'Invalid tab' });

  const db = getDb();
  const cfg = db.prepare('SELECT * FROM sheets_config WHERE sheet_name=? AND tab_name=?').get('Matching Sales', tabName);
  if (!cfg) return res.status(404).json({ error: 'No config for tab: ' + tabName });

  const cached = getCached(cfg.sheet_id, cfg.tab_name, true);
  const data = cached ? cached.data : [];
  const rowIdx = row - 1;

  // Validate the row exists
  const actualRef = data[rowIdx] ? str(data[rowIdx][0]) : '';
  if (ref && actualRef && ref !== actualRef) return res.status(409).json({ error: `Row shifted (expected ${ref}, found ${actualRef})` });

  try {
    const { google } = require('googleapis');
    const path = require('path');
    const fs = require('fs');
    const keysDir = process.env.SERVICE_ACCOUNTS_DIR || path.join(__dirname, '../service-accounts');
    const files = fs.readdirSync(keysDir).filter(f => f.endsWith('.json') && f !== 'kpnstock.json').sort();
    const key = JSON.parse(fs.readFileSync(path.join(keysDir, files[cfg.service_account_index]), 'utf8'));
    const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });

    // Get tab's numeric sheetId
    const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheet_id, fields: 'sheets(properties(sheetId,title))' });
    const tab = (meta.data.sheets || []).find(s => s.properties.title === cfg.tab_name);
    if (!tab) throw new Error(`Tab not found: ${cfg.tab_name}`);
    const sheetId = tab.properties.sheetId;

    // Unmerge all cells that span this row (startRowIndex..endRowIndex covering rowIdx)
    // We find merged ranges via spreadsheets.get and unmerge the ones touching this row.
    const fullMeta = await sheets.spreadsheets.get({
      spreadsheetId: cfg.sheet_id,
      fields: 'sheets(properties(sheetId,title),merges)'
    });
    const fullTab = (fullMeta.data.sheets || []).find(s => s.properties.sheetId === sheetId);
    const merges = fullTab?.merges || [];
    const unmergesToDo = merges.filter(m =>
      m.startRowIndex <= rowIdx && m.endRowIndex > rowIdx
    );

    if (unmergesToDo.length > 0) {
      const unmergeRequests = unmergesToDo.map(m => ({
        unmergeCells: { range: m }
      }));
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: cfg.sheet_id,
        requestBody: { requests: unmergeRequests }
      });
    }

    // Delete the row
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: cfg.sheet_id,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: rowIdx, endIndex: rowIdx + 1 }
          }
        }]
      }
    });

    // After deletion, find the contiguous group of partial rows around where the deleted
    // row was. Walk up from rowIdx to find the group start (first non-PARTIAL row above
    // is the parent), then walk down to find the end.
    // Note: after deletion, indices shift. We work on the pre-deletion data but adjust.

    // Find group start: walk backwards from rowIdx-1 looking for consecutive PARTIAL rows.
    // The parent is the first row ABOVE that doesn't have PARTIAL or is part of the same group.
    const pCol = tabConfig.partialCol;
    let groupStartIdx = rowIdx - 1; // the row above the deleted one (potential parent)
    // Walk further up if the row above is also PARTIAL (we might be deleting a middle row)
    while (groupStartIdx > 0 && str(data[groupStartIdx - 1]?.[pCol]).toUpperCase() === 'PARTIAL') {
      groupStartIdx--;
    }
    // groupStartIdx is now the parent (may or may not have PARTIAL on it)

    // Find group end: walk forward from rowIdx+1 looking for PARTIAL rows (skip the deleted row)
    let groupEndIdx = groupStartIdx; // at minimum, group is just the parent
    for (let i = groupStartIdx + 1; i < data.length; i++) {
      if (i === rowIdx) continue; // this row is being deleted
      if (str(data[i]?.[pCol]).toUpperCase() === 'PARTIAL') {
        groupEndIdx = i;
      } else {
        break;
      }
    }

    // Count remaining rows in group (excluding the deleted one)
    const remainingGroupRows = [];
    for (let i = groupStartIdx; i <= groupEndIdx; i++) {
      if (i === rowIdx) continue;
      remainingGroupRows.push(i > rowIdx ? i - 1 : i); // adjust for deletion
    }

    if (remainingGroupRows.length <= 1) {
      // Only parent remains — clear its PARTIAL flag
      const parentSheetRow = remainingGroupRows[0] + 1; // 1-based
      const parentAsRange = `${cfg.tab_name}!${colToA1(pCol)}${parentSheetRow}`;
      await writeSheetSync(cfg.sheet_id, parentAsRange, [['']], cfg.service_account_index);
    } else {
      // Multiple rows remain — re-merge them
      const startRowAdjusted = Math.min(...remainingGroupRows); // 0-based after deletion
      const endRowAdjusted = Math.max(...remainingGroupRows) + 1; // exclusive

      const SKIP_MERGE = new Set(tabConfig.noMerge);
      const reMergeRequests = [];
      const parentData = data[groupStartIdx] || [];
      const maxCol = Math.max(parentData.length, pCol + 1);
      for (let col = 0; col < maxCol; col++) {
        if (SKIP_MERGE.has(col)) continue;
        reMergeRequests.push({
          mergeCells: {
            range: { sheetId, startRowIndex: startRowAdjusted, endRowIndex: endRowAdjusted, startColumnIndex: col, endColumnIndex: col + 1 },
            mergeType: 'MERGE_COLUMNS'
          }
        });
      }
      if (reMergeRequests.length) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: cfg.sheet_id,
          requestBody: { requests: reMergeRequests }
        });
      }
    }

    setTimeout(() => {
      refreshAllCaches().catch(() => {});
      refreshBulkDatabases().catch(() => {});
    }, 500);
    broadcastDataUpdated({ department: 'logistics', resource: 'matching-sales', action: 'remove-partial', tab: tabName });
    res.json({ ok: true });
  } catch (err) {
    sendInternalError(res, 500, 'Partial shipment could not be removed', err);
  }
});

module.exports = router;
