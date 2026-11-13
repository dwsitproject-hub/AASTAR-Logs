'use strict';

// Admin -> Sheets Config: the spreadsheets the ERP syncs, and their connection settings.
const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  checkSpreadsheetSource,
  listSpreadsheetSources,
  updateSpreadsheetSource,
} = require('../services/spreadsheetSources');
const { refreshBulkDatabases } = require('../services/bulkDataSync');

const router = express.Router();

function sendError(res, error) {
  if (!error.statusCode) {
    console.error('Spreadsheet source request failed:', error);
    return res.status(500).json({ error: 'Spreadsheet settings could not be processed' });
  }
  return res.status(error.statusCode).json({ error: error.message, code: error.code, result: error.result });
}

router.get('/', requireAuth, requireAdmin, (req, res) => {
  res.json(listSpreadsheetSources(getDb()));
});

router.post('/:key/check', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await checkSpreadsheetSource(req.params.key, req.body));
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/:key', requireAuth, requireAdmin, async (req, res) => {
  try {
    const actor = req.user.email || req.user.username;
    const result = await updateSpreadsheetSource(getDb(), req.params.key, req.body, actor);
    console.log(`Spreadsheet source ${req.params.key} updated by ${actor}`);
    // Pull from the new settings now instead of waiting for the next cycle.
    refreshBulkDatabases().catch(error => console.error('Refresh after spreadsheet change failed:', error.message));
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
