'use strict';

const ExcelJS = require('exceljs');

const SINGAPORE_TIME_ZONE = 'Asia/Singapore';
const dateTimeFormatter = new Intl.DateTimeFormat('en-SG', {
  timeZone: SINGAPORE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function safeCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function localDateTime(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? safeCell(value) : dateTimeFormatter.format(parsed);
}

function locationFor(row) {
  return [row.city, row.region, row.country].filter(Boolean).join(', ') || row.country_code || 'Unknown';
}

function applySheetStyle(sheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(sheet.columnCount).letter}1` };
  const header = sheet.getRow(1);
  header.height = 22;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF315B55' } };
  header.alignment = { vertical: 'middle' };
  for (const row of sheet.getRows(2, Math.max(0, sheet.rowCount - 1)) || []) {
    row.alignment = { vertical: 'top', wrapText: true };
    row.eachCell(cell => {
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9E0DE' } } };
    });
  }
}

function addAuthenticationEvents(workbook, events) {
  const sheet = workbook.addWorksheet('Authentication Events');
  sheet.columns = [
    { header: 'Singapore Date & Time', key: 'singapore_time', width: 23 },
    { header: 'UTC Timestamp', key: 'utc_time', width: 26 },
    { header: 'Username Submitted', key: 'username', width: 30 },
    { header: 'Verified Google Email', key: 'email', width: 34 },
    { header: 'Authentication Method', key: 'method', width: 22 },
    { header: 'Result', key: 'result', width: 16 },
    { header: 'Reason', key: 'reason', width: 28 },
    { header: 'Credential Input', key: 'credential', width: 24 },
    { header: 'Password Length', key: 'credential_length', width: 16 },
    { header: 'Password Pattern', key: 'credential_pattern', width: 28 },
    { header: 'Password Fingerprint (HMAC)', key: 'credential_fingerprint', width: 36 },
    { header: 'Password Family Fingerprint (HMAC)', key: 'credential_family_fingerprint', width: 42 },
    { header: 'User ID', key: 'user_id', width: 12 },
    { header: 'IP Address', key: 'ip', width: 20 },
    { header: 'Approximate Location', key: 'location', width: 32 },
    { header: 'Device', key: 'device', width: 28 },
    { header: 'User Agent', key: 'user_agent', width: 55 },
  ];
  for (const event of events) {
    sheet.addRow({
      singapore_time: localDateTime(event.occurred_at),
      utc_time: safeCell(event.occurred_at),
      username: safeCell(event.username),
      email: safeCell(event.email),
      method: safeCell(event.auth_method),
      result: safeCell(event.result),
      reason: safeCell(event.reason),
      credential: event.credential_supplied ? 'Supplied (not retained)' : 'Missing',
      credential_length: event.auth_method === 'password' ? Number(event.credential_length || 0) : '',
      credential_pattern: event.auth_method === 'password' ? safeCell(event.credential_pattern) : '',
      credential_fingerprint: event.auth_method === 'password' ? safeCell(event.credential_fingerprint) : '',
      credential_family_fingerprint: event.auth_method === 'password' ? safeCell(event.credential_family_fingerprint) : '',
      user_id: event.user_id || '',
      ip: safeCell(event.ip_address),
      location: safeCell(locationFor(event)),
      device: safeCell(event.device),
      user_agent: safeCell(event.user_agent),
    });
  }
  applySheetStyle(sheet);
}

function addSessionCookieEvents(workbook, events) {
  const sheet = workbook.addWorksheet('Session Cookies');
  sheet.columns = [
    { header: 'Singapore Date & Time', key: 'singapore_time', width: 23 },
    { header: 'UTC Timestamp', key: 'utc_time', width: 26 },
    { header: 'Event', key: 'event_type', width: 18 },
    { header: 'Username', key: 'username', width: 28 },
    { header: 'Verified Email', key: 'email', width: 34 },
    { header: 'User ID', key: 'user_id', width: 12 },
    { header: 'Session Fingerprint (HMAC)', key: 'session_fingerprint', width: 36 },
    { header: 'Expires At (Singapore)', key: 'expires_at', width: 23 },
    { header: 'Authentication Method', key: 'auth_method', width: 22 },
    { header: 'Transport', key: 'transport', width: 14 },
    { header: 'Cookie Name', key: 'cookie_name', width: 28 },
    { header: 'Secure', key: 'secure', width: 12 },
    { header: 'HttpOnly', key: 'http_only', width: 12 },
    { header: 'SameSite', key: 'same_site', width: 12 },
    { header: 'IP Address', key: 'ip', width: 20 },
    { header: 'Approximate Location', key: 'location', width: 32 },
    { header: 'Device', key: 'device', width: 28 },
    { header: 'User Agent', key: 'user_agent', width: 55 },
  ];
  for (const event of events) {
    sheet.addRow({
      singapore_time: localDateTime(event.occurred_at),
      utc_time: safeCell(event.occurred_at),
      event_type: safeCell(event.event_type),
      username: safeCell(event.username),
      email: safeCell(event.email),
      user_id: event.user_id || '',
      session_fingerprint: safeCell(event.session_fingerprint),
      expires_at: localDateTime(event.expires_at),
      auth_method: safeCell(event.auth_method),
      transport: safeCell(event.transport),
      cookie_name: safeCell(event.cookie_name),
      secure: event.secure ? 'Yes' : 'No',
      http_only: event.http_only ? 'Yes' : 'No',
      same_site: safeCell(event.same_site),
      ip: safeCell(event.ip_address),
      location: safeCell(locationFor(event)),
      device: safeCell(event.device),
      user_agent: safeCell(event.user_agent),
    });
  }
  applySheetStyle(sheet);
}

function addPageVisits(workbook, rows, page, sheetName) {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = [
    { header: 'Singapore Date & Time', key: 'singapore_time', width: 23 },
    { header: 'UTC Timestamp', key: 'utc_time', width: 26 },
    { header: 'Page', key: 'page', width: 14 },
    { header: 'Path', key: 'path', width: 34 },
    { header: 'Referrer', key: 'referrer', width: 48 },
    { header: 'IP Address', key: 'ip', width: 20 },
    { header: 'Approximate Location', key: 'location', width: 32 },
    { header: 'Device', key: 'device', width: 28 },
    { header: 'User Agent', key: 'user_agent', width: 55 },
  ];
  for (const row of rows.filter(entry => entry.page === page)) {
    sheet.addRow({
      singapore_time: localDateTime(row.occurred_at),
      utc_time: safeCell(row.occurred_at),
      page: safeCell(row.page),
      path: safeCell(row.path),
      referrer: safeCell(row.referrer),
      ip: safeCell(row.ip_address),
      location: safeCell(locationFor(row)),
      device: safeCell(row.device),
      user_agent: safeCell(row.user_agent),
    });
  }
  applySheetStyle(sheet);
}

function addAuthenticatedActivity(workbook, rows) {
  const sheet = workbook.addWorksheet('ERP Presence');
  sheet.columns = [
    { header: 'Username', key: 'username', width: 28 },
    { header: 'User ID', key: 'user_id', width: 12 },
    { header: 'First Seen (Singapore)', key: 'first_seen', width: 23 },
    { header: 'Last Active (Singapore)', key: 'last_seen', width: 23 },
    { header: 'IP Address', key: 'ip', width: 20 },
    { header: 'Approximate Location', key: 'location', width: 32 },
    { header: 'Device', key: 'device', width: 28 },
    { header: 'Login Count', key: 'login_count', width: 14 },
    { header: 'API Request Count', key: 'request_count', width: 18 },
    { header: 'Last API Path', key: 'last_path', width: 42 },
    { header: 'Session ID', key: 'session_id', width: 40 },
    { header: 'User Agent', key: 'user_agent', width: 55 },
  ];
  for (const row of rows) {
    sheet.addRow({
      username: safeCell(row.username),
      user_id: row.user_id || '',
      first_seen: localDateTime(row.first_seen_at),
      last_seen: localDateTime(row.last_seen_at),
      ip: safeCell(row.ip_address),
      location: safeCell(locationFor(row)),
      device: safeCell(row.device),
      login_count: Number(row.login_count || 0),
      request_count: Number(row.request_count || 0),
      last_path: safeCell(row.last_path),
      session_id: safeCell(row.session_id),
      user_agent: safeCell(row.user_agent),
    });
  }
  applySheetStyle(sheet);
}

function addUserActions(workbook, rows) {
  const sheet = workbook.addWorksheet('User Actions');
  sheet.columns = [
    { header: 'Started (Singapore)', key: 'started_at', width: 23 },
    { header: 'Completed (Singapore)', key: 'completed_at', width: 23 },
    { header: 'Username', key: 'username', width: 28 },
    { header: 'Verified Email', key: 'email', width: 34 },
    { header: 'User ID', key: 'user_id', width: 12 },
    { header: 'Method', key: 'method', width: 12 },
    { header: 'API Path', key: 'path', width: 44 },
    { header: 'Status', key: 'status_code', width: 12 },
    { header: 'Duration (ms)', key: 'duration_ms', width: 16 },
    { header: 'Changed Field Names', key: 'changed_fields', width: 48 },
    { header: 'Record References', key: 'target_reference', width: 52 },
    { header: 'IP Address', key: 'ip', width: 20 },
    { header: 'Approximate Location', key: 'location', width: 32 },
    { header: 'Device', key: 'device', width: 28 },
    { header: 'Session ID', key: 'session_id', width: 40 },
    { header: 'User Agent', key: 'user_agent', width: 55 },
  ];
  for (const row of rows) {
    sheet.addRow({
      started_at: localDateTime(row.occurred_at),
      completed_at: localDateTime(row.completed_at),
      username: safeCell(row.username),
      email: safeCell(row.email),
      user_id: row.user_id || '',
      method: safeCell(row.method),
      path: safeCell(row.path),
      status_code: Number(row.status_code || 0),
      duration_ms: Number(row.duration_ms || 0),
      changed_fields: safeCell(row.changed_fields),
      target_reference: safeCell(row.target_reference),
      ip: safeCell(row.ip_address),
      location: safeCell(locationFor(row)),
      device: safeCell(row.device),
      session_id: safeCell(row.session_id),
      user_agent: safeCell(row.user_agent),
    });
  }
  applySheetStyle(sheet);
}

function addFailedLoginArchive(workbook, rows) {
  const sheet = workbook.addWorksheet('Failed Login Archive');
  sheet.columns = [
    { header: 'Singapore Date & Time', key: 'singapore_time', width: 23 },
    { header: 'UTC Timestamp', key: 'utc_time', width: 26 },
    { header: 'Username Submitted', key: 'username', width: 34 },
    { header: 'IP Address', key: 'ip', width: 20 },
    { header: 'Approximate Location', key: 'location', width: 32 },
    { header: 'Device', key: 'device', width: 28 },
    { header: 'User Agent', key: 'user_agent', width: 55 },
  ];
  for (const row of rows) {
    sheet.addRow({
      singapore_time: localDateTime(row.occurred_at),
      utc_time: safeCell(row.occurred_at),
      username: safeCell(row.username),
      ip: safeCell(row.ip_address),
      location: safeCell(locationFor(row)),
      device: safeCell(row.device),
      user_agent: safeCell(row.user_agent),
    });
  }
  applySheetStyle(sheet);
}

function reportFilename(summary) {
  const source = summary.windowEnd || summary.activityDate || new Date().toISOString();
  const date = String(source).slice(0, 10).replace(/[^0-9-]/g, '') || 'report';
  const shift = summary.windowEnd ? String(summary.windowEnd).slice(11, 16).replace(':', '') : 'daily';
  return `aastar-security-audit-${date}-${shift}.xlsx`;
}

async function buildSecurityAuditAttachment(summary) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AASTAR ERP';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = 'Authentication and user activity security audit';
  workbook.description = 'Raw credentials and tokens are never retained. Password attempts use non-reversible keyed fingerprints for correlation.';

  addAuthenticationEvents(workbook, summary.authEvents || []);
  addSessionCookieEvents(workbook, summary.sessionCookieEvents || []);
  addPageVisits(workbook, summary.pageVisits || [], 'login', 'Login Page Visits');
  addPageVisits(workbook, summary.pageVisits || [], 'dummy', 'Dummy Page Visits');
  addAuthenticatedActivity(workbook, summary.rows || []);
  addUserActions(workbook, summary.userActions || []);
  addFailedLoginArchive(workbook, summary.failedLogins || []);

  return {
    filename: reportFilename(summary),
    content: Buffer.from(await workbook.xlsx.writeBuffer()),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

module.exports = { buildSecurityAuditAttachment, safeCell };
