'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildSecurityAuditAttachment, safeCell } = require('../services/securityAuditWorkbook');

test('security audit workbook contains detailed forensic data without raw credentials', async () => {
  const summary = {
    windowStart: '2026-08-28T23:00:00.000Z',
    windowEnd: '2026-08-29T11:00:00.000Z',
    authEvents: [{
      occurred_at: '2026-08-29T01:15:00.000Z',
      user_id: 2,
      username: '=UNSAFE()',
      email: 'matthew.chiu@kpn-corp.com',
      auth_method: 'password',
      result: 'failure',
      reason: 'password-login-disabled',
      credential_supplied: 1,
      credential_length: 12,
      credential_pattern: 'U1-L5-D3-S1;digit-sequence',
      credential_fingerprint: 'ab12cd34ef56',
      credential_family_fingerprint: 'family12ab34cd',
      ip_address: '203.0.113.5',
      country: 'Singapore',
      city: 'Singapore',
      device: 'Google Chrome / Windows',
      user_agent: 'Test agent',
    }],
    sessionCookieEvents: [{
      occurred_at: '2026-08-29T01:16:00.000Z', user_id: 2, username: 'Matthew',
      email: 'matthew.chiu@kpn-corp.com', event_type: 'issued',
      session_fingerprint: 'session12ab34cd', expires_at: '2026-08-29T09:16:00.000Z',
      auth_method: 'google', transport: 'cookie', cookie_name: '__Host-erp_session',
      secure: 1, http_only: 1, same_site: 'None', ip_address: '203.0.113.5',
      country: 'Singapore', device: 'Google Chrome / Windows', user_agent: 'Test agent',
    }],
    pageVisits: [{
      occurred_at: '2026-08-29T01:10:00.000Z', page: 'login', path: '/login',
      referrer: 'https://example.test/', ip_address: '203.0.113.5', country: 'Singapore',
      device: 'Google Chrome / Windows', user_agent: 'Test agent',
    }, {
      occurred_at: '2026-08-29T01:11:00.000Z', page: 'dummy', path: '/atlas/royal-continent',
      referrer: '/login', ip_address: '203.0.113.8', country: 'Brazil',
      device: 'Other browser / Linux', user_agent: 'Attack agent',
    }],
    rows: [],
    userActions: [{
      occurred_at: '2026-08-29T02:00:00.000Z', completed_at: '2026-08-29T02:00:00.025Z',
      user_id: 2, username: 'Matthew', email: 'matthew.chiu@kpn-corp.com', session_id: 'session-1',
      method: 'PATCH', path: '/api/sheets/vessel/7', status_code: 200, duration_ms: 25,
      changed_fields: 'eta, remarks', target_reference: 'id=7', ip_address: '203.0.113.5',
      country: 'Singapore', device: 'Google Chrome / Windows', user_agent: 'Test agent',
    }],
    failedLogins: [],
  };

  const attachment = await buildSecurityAuditAttachment(summary);
  assert.match(attachment.filename, /^aastar-security-audit-.*\.xlsx$/);
  assert.equal(attachment.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(attachment.content);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), [
    'Authentication Events',
    'Session Cookies',
    'Login Page Visits',
    'Dummy Page Visits',
    'ERP Presence',
    'User Actions',
    'Failed Login Archive',
  ]);

  const events = workbook.getWorksheet('Authentication Events');
  assert.equal(events.getRow(2).getCell(3).value, "'=UNSAFE()");
  assert.equal(events.getRow(2).getCell(5).value, 'password');
  assert.equal(events.getRow(2).getCell(8).value, 'Supplied (not retained)');
  assert.equal(events.getRow(2).getCell(10).value, 'U1-L5-D3-S1;digit-sequence');
  assert.equal(events.getRow(2).getCell(11).value, 'ab12cd34ef56');
  assert.equal(events.getRow(2).getCell(12).value, 'family12ab34cd');
  assert.equal(workbook.getWorksheet('Login Page Visits').rowCount, 2);
  const cookies = workbook.getWorksheet('Session Cookies');
  assert.equal(cookies.getRow(2).getCell(3).value, 'issued');
  assert.equal(cookies.getRow(2).getCell(7).value, 'session12ab34cd');
  assert.equal(cookies.getRow(2).getCell(12).value, 'Yes');
  assert.equal(cookies.getRow(2).getCell(13).value, 'Yes');
  assert.equal(workbook.getWorksheet('Dummy Page Visits').rowCount, 2);
  assert.equal(workbook.getWorksheet('User Actions').getRow(2).getCell(10).value, 'eta, remarks');
});

test('spreadsheet cells neutralize formula-like submitted values', () => {
  assert.equal(safeCell('+cmd'), "'+cmd");
  assert.equal(safeCell('-1+2'), "'-1+2");
  assert.equal(safeCell('@user'), "'@user");
  assert.equal(safeCell('normal'), 'normal');
});
