'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('page authorization does not treat one department tab as every tab', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-page-auth-'));
  process.env.DB_PATH = path.join(directory, 'erp.db');
  process.env.USER_ACTIVITY_DB_PATH = path.join(directory, 'activity.db');

  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { initDb, getDb } = require('../db/database');
  const { jwtSecret } = require('../config/config');
  const { hasPageAccess } = require('../middleware/auth');
  const sheetsRoutes = require('../routes/sheets');
  const { stopUserActivity } = require('../services/userActivity');

  initDb();
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO users (
      username, email, password, is_admin, is_approved,
      permissions, tab_permissions, auth_version
    ) VALUES (?, ?, NULL, 0, 1, '[]', ?, 1)
  `).run('Restricted User', 'restricted@kpn-corp.com', '["/logistics/vessel-status"]');
  const userId = Number(result.lastInsertRowid);
  const restrictedUser = {
    is_admin: false,
    permissions: [],
    tab_permissions: ['/logistics/vessel-status'],
  };
  assert.equal(hasPageAccess(restrictedUser, '/logistics/vessel-status'), true);
  assert.equal(hasPageAccess(restrictedUser, '/logistics/vessel-update'), false);
  assert.equal(hasPageAccess({ ...restrictedUser, permissions: ['logistics'] }, '/logistics/vessel-update'), true);

  const token = jwt.sign({ id: userId, auth_version: 1, jti: 'page-auth-test' }, jwtSecret, { algorithm: 'HS256', expiresIn: '5m' });
  const app = express();
  app.use(express.json());
  app.use('/api/sheets', sheetsRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    stopUserActivity();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const headers = { authorization: `Bearer ${token}` };
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const hiddenPages = [
    '/api/sheets/export-summary',
    '/api/sheets/export-summary-total',
    '/api/sheets/contract-dashboard',
    '/api/sheets/vessel-contract/pending',
    '/api/sheets/weekly-ops-meeting',
    '/api/sheets/open-shipments',
    '/api/sheets/export-planning',
    '/api/sheets/vessel-update',
    '/api/sheets/stock-summary',
    '/api/sheets/vessel-matching',
    '/api/sheets/matching-sales',
  ];
  for (const page of hiddenPages) {
    const response = await fetch(`${baseUrl}${page}`, { headers });
    assert.equal(response.status, 403, `${page} must reject unrelated tab access`);
  }
  const rawDepartment = await fetch(`${baseUrl}/api/sheets/data/logistics`, { headers });
  assert.equal(rawDepartment.status, 403);

  const forged = jwt.sign({ id: userId, auth_version: 1 }, '', { algorithm: 'none' });
  const forgedResponse = await fetch(`${baseUrl}/api/sheets/vessel-status`, {
    headers: { authorization: `Bearer ${forged}` },
  });
  assert.equal(forgedResponse.status, 401);

  const malformedHeader = await fetch(`${baseUrl}/api/sheets/vessel-status`, {
    headers: { authorization: `Bearer ${token} trailing-data` },
  });
  assert.equal(malformedHeader.status, 401);
});
