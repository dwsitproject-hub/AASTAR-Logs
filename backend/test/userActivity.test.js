'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  UserActivityStore,
  buildReportContent,
  credentialAuditMetadata,
  currentShiftWindow,
  describeDevice,
  latestScheduledWindow,
  normalizeIp,
  previousSingaporeDate,
  requestActionMetadata,
  singaporeDate,
} = require('../services/userActivity');

process.env.SESSION_AUDIT_HMAC_KEY ||= 'test-session-audit-hmac-key';

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-user-activity-'));
  const store = new UserActivityStore({
    databasePath: path.join(directory, 'activity.db'),
    geoLookup: () => ({ countryCode: 'SG', country: 'Singapore', region: '01', city: 'Singapore' }),
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

test('IP, device and Singapore date helpers normalize report values', () => {
  assert.equal(normalizeIp('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(normalizeIp('203.0.113.5, 127.0.0.1'), '203.0.113.5');
  assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0'), 'Google Chrome / Windows');
  const instant = new Date('2026-08-25T16:30:00.000Z');
  assert.equal(singaporeDate(instant), '2026-08-26');
  assert.equal(previousSingaporeDate(instant), '2026-08-25');
});

test('password audit metadata correlates attempts without retaining the secret', () => {
  const first = credentialAuditMetadata('Attack123!', 'test-audit-key');
  const repeated = credentialAuditMetadata('Attack123!', 'test-audit-key');
  const different = credentialAuditMetadata('Other123!', 'test-audit-key');
  const familyVariant = credentialAuditMetadata('attack456?', 'test-audit-key');
  assert.equal(first.credentialLength, 10);
  assert.equal(first.credentialPattern, 'U1-L5-D3-S1;digit-sequence');
  assert.equal(first.credentialFingerprint, repeated.credentialFingerprint);
  assert.notEqual(first.credentialFingerprint, different.credentialFingerprint);
  assert.equal(first.credentialFamilyFingerprint, familyVariant.credentialFamilyFingerprint);
  assert.doesNotMatch(JSON.stringify(first), /Attack123!/);
});

test('user action metadata keeps field names and identifiers but excludes secrets', () => {
  const metadata = requestActionMetadata({
    params: { id: 'vessel-7' },
    body: {
      eta: '2026-09-01',
      remarks: 'Ready',
      password: 'must-not-appear',
      access_token: 'must-not-appear-either',
      contract_id: 'APS-123',
    },
  });
  assert.equal(metadata.changedFields, 'eta, remarks, contract_id');
  assert.match(metadata.targetReference, /id=vessel-7/);
  assert.match(metadata.targetReference, /contract_id=APS-123/);
  assert.doesNotMatch(JSON.stringify(metadata), /must-not-appear/);
});

test('scheduled reports use fixed 19:00-07:00 and 07:00-19:00 Singapore windows', () => {
  const morning = latestScheduledWindow(new Date('2026-08-25T23:00:00.000Z'));
  assert.equal(morning.startAt.toISOString(), '2026-08-25T11:00:00.000Z');
  assert.equal(morning.endAt.toISOString(), '2026-08-25T23:00:00.000Z');

  const evening = latestScheduledWindow(new Date('2026-08-26T11:00:00.000Z'));
  assert.equal(evening.startAt.toISOString(), '2026-08-25T23:00:00.000Z');
  assert.equal(evening.endAt.toISOString(), '2026-08-26T11:00:00.000Z');

  const current = currentShiftWindow(new Date('2026-08-26T03:30:00.000Z'));
  assert.equal(current.startAt.toISOString(), '2026-08-25T23:00:00.000Z');
  assert.equal(current.endAt.toISOString(), '2026-08-26T03:30:00.000Z');
});

test('activity is aggregated by session and Singapore calendar day', t => {
  const store = temporaryStore(t);
  const user = { id: 7, username: 'Matthew', jti: 'session-1' };
  store.recordActivity({
    user,
    ip: '203.0.113.5',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
    path: '/api/auth/login',
    login: true,
    at: new Date('2026-08-25T01:00:00.000Z'),
  });
  store.recordActivity({
    user,
    ip: '203.0.113.5',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
    path: '/api/sheets/export-summary',
    at: new Date('2026-08-25T01:03:00.000Z'),
  });
  store.recordFailedLogin({
    username: 'Matthew',
    ip: '203.0.113.5',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
    at: new Date('2026-08-25T01:05:00.000Z'),
  });
  store.recordAuthenticationEvent({
    userId: 7,
    username: 'Matthew',
    email: 'matthew.chiu@kpn-corp.com',
    authMethod: 'google',
    result: 'success',
    reason: 'authenticated',
    credentialSupplied: true,
    ip: '203.0.113.5',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
    at: new Date('2026-08-25T01:01:00.000Z'),
  });
  store.recordPageVisit({
    page: 'login', path: '/login', referrer: 'https://example.test/',
    ip: '203.0.113.5', userAgent: 'Test agent',
    at: new Date('2026-08-25T01:02:00.000Z'),
  });
  store.recordUserAction({
    user: { ...user, email: 'matthew.chiu@kpn-corp.com' },
    ip: '203.0.113.5', userAgent: 'Test agent', method: 'PATCH',
    path: '/api/sheets/vessel/7', statusCode: 200, durationMs: 18,
    changedFields: 'eta, remarks', targetReference: 'id=7',
    at: new Date('2026-08-25T01:04:00.000Z'),
    completedAt: new Date('2026-08-25T01:04:00.018Z'),
  });
  store.recordSessionCookieEvent({
    user: { ...user, email: 'matthew.chiu@kpn-corp.com' },
    token: 'test.session.token', eventType: 'issued',
    expiresAt: '2026-08-25T09:00:00.000Z', authMethod: 'google', transport: 'cookie',
    ip: '203.0.113.5', userAgent: 'Test agent',
    at: new Date('2026-08-25T01:06:00.000Z'),
  });

  const summary = store.summary('2026-08-25');
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0].username, 'Matthew');
  assert.equal(summary.rows[0].city, 'Singapore');
  assert.equal(summary.rows[0].request_count, 2);
  assert.equal(summary.rows[0].login_count, 1);
  assert.equal(summary.rows[0].last_path, '/api/sheets/export-summary');
  assert.equal(summary.failedLogins.length, 1);
  assert.equal(summary.authEvents.length, 1);
  assert.equal(summary.authEvents[0].auth_method, 'google');
  assert.equal(summary.authEvents[0].credential_supplied, 1);
  assert.equal(Object.hasOwn(summary.authEvents[0], 'credential'), false);
  assert.equal(summary.pageVisits.length, 1);
  assert.equal(summary.pageVisits[0].page, 'login');
  assert.equal(summary.userActions.length, 1);
  assert.equal(summary.userActions[0].changed_fields, 'eta, remarks');
  assert.equal(summary.userActions[0].status_code, 200);
  assert.equal(summary.sessionCookieEvents.length, 1);
  assert.equal(summary.sessionCookieEvents[0].event_type, 'issued');
  assert.equal(summary.sessionCookieEvents[0].session_fingerprint.length, 32);
  assert.equal(Object.hasOwn(summary.sessionCookieEvents[0], 'token'), false);
});

test('daily email content includes activity totals and escapes user data', t => {
  const store = temporaryStore(t);
  store.recordActivity({
    user: { id: 8, username: '<Admin>', jti: 'session-2' },
    ip: '203.0.113.8',
    userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15',
    path: '/api/users',
    login: true,
    at: new Date('2026-08-25T02:00:00.000Z'),
  });
  const content = buildReportContent(store.summary('2026-08-25'));
  assert.match(content.subject, /25 Aug 2026/);
  assert.match(content.text, /Users: 1/);
  assert.match(content.text, /Logins: 1/);
  assert.match(content.html, /&lt;Admin&gt;/);
  assert.doesNotMatch(content.html, /<Admin>/);
});

test('period summary includes only activity inside the selected shift', t => {
  const store = temporaryStore(t);
  const user = { id: 7, username: 'Matthew', jti: 'shift-session' };
  const record = at => store.recordActivity({
    user,
    ip: '203.0.113.5',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
    path: '/api/sheets/export-summary',
    at: new Date(at),
  });

  record('2026-08-25T10:55:00.000Z');
  record('2026-08-25T11:05:00.000Z');
  record('2026-08-25T22:55:00.000Z');
  record('2026-08-25T23:05:00.000Z');

  const summary = store.periodSummary(
    new Date('2026-08-25T11:00:00.000Z'),
    new Date('2026-08-25T23:00:00.000Z'),
  );
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows.reduce((total, row) => total + row.request_count, 0), 2);
  assert.equal(summary.windowStart, '2026-08-25T11:00:00.000Z');
  assert.equal(summary.windowEnd, '2026-08-25T23:00:00.000Z');
});

test('report claims prevent duplicate daily delivery', t => {
  const store = temporaryStore(t);
  assert.equal(store.claimReport('2026-08-25', 'matthew.chiu@kpn-corp.com'), true);
  store.markReport('2026-08-25', 'sent');
  assert.equal(store.claimReport('2026-08-25', 'matthew.chiu@kpn-corp.com'), false);
});

test('periodic report claims prevent duplicate shift delivery', t => {
  const store = temporaryStore(t);
  const startAt = new Date('2026-08-25T11:00:00.000Z');
  const endAt = new Date('2026-08-25T23:00:00.000Z');
  assert.equal(store.claimPeriodicReport(startAt, endAt, 'matthew.chiu@kpn-corp.com'), true);
  store.markPeriodicReport(endAt, 'sent');
  assert.equal(store.claimPeriodicReport(startAt, endAt, 'matthew.chiu@kpn-corp.com'), false);
});
