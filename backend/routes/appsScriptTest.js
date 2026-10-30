const crypto = require('node:crypto');
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const sync = require('../services/appsScriptSheetSync');

const router = express.Router();

function timingSafeMatch(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sendValidationError(res, error) {
  const badRequest = /Cell value|sheet column|sheet row|No cell changes|Unexpected spreadsheet|Insert anchor|anchor row|Row move|row movement|pending Sheet changes|both rows|moved onto itself/i
    .test(error.message);
  if (badRequest) return res.status(400).json({ error: error.message });
  console.error('Apps Script synchronization request failed:', error.message);
  return res.status(500).json({ error: 'Sheet synchronization request failed' });
}

// Apps Script cannot carry an ERP user JWT, so inbound events use the bridge
// secret. Keep this route before the user-authenticated admin routes below.
router.post('/events', (req, res) => {
  const expected = String(process.env.APPS_SCRIPT_TEST_SECRET || '');
  const provided = String(req.body?.secret || '');
  if (!expected || !provided || !timingSafeMatch(expected, provided)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { secret: _secret, ...event } = req.body || {};
    sync.ingestEvent(event);
    return res.status(204).end();
  } catch (error) {
    return sendValidationError(res, error);
  }
});

router.use(requireAuth, requireAdmin);

router.get('/rows', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json(await sync.ensureReady());
  } catch (error) {
    return res.status(502).json({ error: 'Could not load the synchronized sheet' });
  }
});

router.post('/cells', (req, res) => {
  try {
    const result = sync.queueCellUpdates({
      recordId: String(req.body?.recordId || ''),
      rowNumber: Number(req.body?.row),
      changes: req.body?.changes,
    });
    return res.status(202).json({ ok: true, ...result });
  } catch (error) {
    return sendValidationError(res, error);
  }
});

// Compatibility endpoint for older test-tab builds.
router.post('/cell', (req, res) => {
  try {
    const result = sync.queueCellUpdates({
      recordId: String(req.body?.recordId || ''),
      rowNumber: Number(req.body?.row),
      changes: [{ column: req.body?.column, value: req.body?.value }],
    });
    return res.status(202).json({ ok: true, ...result });
  } catch (error) {
    return sendValidationError(res, error);
  }
});

router.post('/rows', (req, res) => {
  if (!Array.isArray(req.body?.values) || req.body.values.length > sync.DATA_COLUMNS) {
    return res.status(400).json({ error: `Expected up to ${sync.DATA_COLUMNS} cell values` });
  }
  try {
    const afterRecordId = String(req.body?.afterRecordId || '').trim();
    const afterRowNumber = Number(req.body?.afterRow);
    const result = afterRecordId || (Number.isInteger(afterRowNumber) && afterRowNumber >= 2)
      ? sync.queueInsert(req.body.values, { afterRecordId, afterRowNumber })
      : sync.queueAppend(req.body.values);
    return res.status(202).json({ ok: true, ...result });
  } catch (error) {
    return sendValidationError(res, error);
  }
});

router.post('/rows/reorder', (req, res) => {
  try {
    const result = sync.queueMove({
      recordId: req.body?.recordId,
      targetRecordId: req.body?.targetRecordId,
      position: req.body?.position,
    });
    return res.status(result.queued ? 202 : 200).json({ ok: true, ...result });
  } catch (error) {
    return sendValidationError(res, error);
  }
});

router.post('/reconcile', async (req, res) => {
  try {
    const result = await sync.reconcile();
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(502).json({ error: 'Sheet reconciliation failed' });
  }
});

module.exports = router;
