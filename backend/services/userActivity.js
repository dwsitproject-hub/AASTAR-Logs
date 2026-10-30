'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const geoip = require('geoip-lite');
const nodemailer = require('nodemailer');
const { buildSecurityAuditAttachment } = require('./securityAuditWorkbook');
const { SESSION_COOKIE_NAME, sessionFingerprint } = require('./sessionCookie');

const SINGAPORE_TIME_ZONE = 'Asia/Singapore';
const DEFAULT_RECIPIENT = 'matthew.chiu@kpn-corp.com';
const DEFAULT_DB_PATH = path.join(__dirname, '../data/user_activity.db');
const FLUSH_INTERVAL_MS = 60 * 1000;
const REPORT_CHECK_INTERVAL_MS = 60 * 1000;
const ACTIVITY_BUCKET_MS = 15 * 60 * 1000;

const sgDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SINGAPORE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const sgClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SINGAPORE_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const sgDisplayFormatter = new Intl.DateTimeFormat('en-SG', {
  timeZone: SINGAPORE_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const sgTimeFormatter = new Intl.DateTimeFormat('en-SG', {
  timeZone: SINGAPORE_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const sgDateTimeFormatter = new Intl.DateTimeFormat('en-SG', {
  timeZone: SINGAPORE_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const countryNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function formatterParts(formatter, value) {
  return Object.fromEntries(formatter.formatToParts(value)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
}

function singaporeDate(value = new Date()) {
  const parts = formatterParts(sgDateFormatter, value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function singaporeClock(value = new Date()) {
  const parts = formatterParts(sgClockFormatter, value);
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

function previousSingaporeDate(value = new Date()) {
  return singaporeDate(new Date(value.getTime() - 24 * 60 * 60 * 1000));
}

function activityBucket(value = new Date()) {
  return new Date(Math.floor(value.getTime() / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS).toISOString();
}

function singaporeBoundary(value, hour) {
  const parts = formatterParts(sgDateFormatter, value);
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour - 8, 0, 0, 0));
}

function latestScheduledWindow(value = new Date()) {
  const clock = singaporeClock(value);
  let endAt;
  if (clock.hour >= 19) endAt = singaporeBoundary(value, 19);
  else if (clock.hour >= 7) endAt = singaporeBoundary(value, 7);
  else endAt = singaporeBoundary(new Date(value.getTime() - 24 * 60 * 60 * 1000), 19);
  return { startAt: new Date(endAt.getTime() - 12 * 60 * 60 * 1000), endAt };
}

function currentShiftWindow(value = new Date()) {
  const clock = singaporeClock(value);
  let startAt;
  if (clock.hour >= 19) startAt = singaporeBoundary(value, 19);
  else if (clock.hour >= 7) startAt = singaporeBoundary(value, 7);
  else startAt = singaporeBoundary(new Date(value.getTime() - 24 * 60 * 60 * 1000), 19);
  return { startAt, endAt: value };
}

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip || 'Unknown';
}

function requestIp(request) {
  return normalizeIp(request?.ip
    || request?.headers?.['x-forwarded-for']
    || request?.socket?.remoteAddress);
}

function safePath(request) {
  const raw = String(request?.originalUrl || request?.url || request?.path || '');
  return raw.split('?')[0].slice(0, 240) || '/';
}

function credentialAuditMetadata(secret, hmacKey = process.env.PASSWORD_AUDIT_HMAC_KEY || '') {
  if (typeof secret !== 'string' || !secret.length) {
    return {
      credentialLength: 0,
      credentialPattern: '',
      credentialFingerprint: '',
      credentialFamilyFingerprint: '',
    };
  }
  const characters = [...secret];
  const classFor = character => {
    if (/[a-z]/.test(character)) return 'L';
    if (/[A-Z]/.test(character)) return 'U';
    if (/\d/.test(character)) return 'D';
    if (/\s/.test(character)) return 'W';
    if (/[^\x00-\x7F]/.test(character)) return 'N';
    return 'S';
  };
  const runs = [];
  for (const character of characters) {
    const type = classFor(character);
    const previous = runs.at(-1);
    if (previous?.type === type) previous.count += 1;
    else runs.push({ type, count: 1 });
  }
  const traits = [];
  if (/(.)\1\1/u.test(secret)) traits.push('repeat');
  if (/(?:012|123|234|345|456|567|678|789|987|876|765|654|543|432|321|210)/.test(secret)) traits.push('digit-sequence');
  if (/(?:abc|bcd|cde|def|qwe|wer|ert|asd|sdf|zxc|xcv)/i.test(secret)) traits.push('letter-sequence');
  if (/(?:password|admin|qwerty|letmein|welcome)/i.test(secret)) traits.push('common-term');
  const pattern = `${runs.map(run => `${run.type}${run.count}`).join('-')}${traits.length ? `;${traits.join(',')}` : ''}`;
  const fingerprint = hmacKey
    ? crypto.createHmac('sha256', hmacKey).update(secret, 'utf8').digest('hex').slice(0, 32)
    : '';
  const family = secret.normalize('NFKC').toLowerCase()
    .replace(/\d/g, '#')
    .replace(/[^a-z#\s]/g, '!')
    .replace(/\s/g, '_');
  const familyFingerprint = hmacKey
    ? crypto.createHmac('sha256', hmacKey).update(`family:${family}`, 'utf8').digest('hex').slice(0, 32)
    : '';
  return {
    credentialLength: Math.min(characters.length, 256),
    credentialPattern: pattern.slice(0, 120),
    credentialFingerprint: fingerprint,
    credentialFamilyFingerprint: familyFingerprint,
  };
}

function requestActionMetadata(request) {
  const body = request?.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body
    : {};
  const sensitiveKey = /password|credential|token|secret|authorization|cookie/i;
  const changedFields = Object.keys(body)
    .filter(key => !sensitiveKey.test(key))
    .slice(0, 40)
    .join(', ');
  const references = [];
  const candidates = { ...(request?.params || {}), ...body };
  for (const [key, value] of Object.entries(candidates)) {
    if (sensitiveKey.test(key)) continue;
    if (!/(^id$|_id$|^id_|vsl|vessel|contract|row|index|record|config|sheet|tab)/i.test(key)) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    const cleanValue = String(value).replace(/[\r\n|]/g, ' ').slice(0, 80);
    references.push(`${key}=${cleanValue}`);
    if (references.length >= 12) break;
  }
  return {
    changedFields: changedFields.slice(0, 500),
    targetReference: references.join(' | ').slice(0, 1000),
  };
}

function describeDevice(userAgent) {
  const ua = String(userAgent || 'Unknown');
  let browser = 'Other browser';
  let platform = 'Unknown device';
  if (/Edg\//i.test(ua)) browser = 'Microsoft Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Google Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Mozilla Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Safari';
  if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = 'macOS';
  else if (/Linux/i.test(ua)) platform = 'Linux';
  return `${browser} / ${platform}`;
}

function defaultGeoLookup(ip) {
  if (ip === 'Unknown' || ip === '127.0.0.1' || ip.startsWith('10.') || ip.startsWith('192.168.')) return null;
  const match = geoip.lookup(ip);
  if (!match) return null;
  const countryCode = String(match.country || '');
  return {
    countryCode,
    country: countryNames && countryCode ? countryNames.of(countryCode) || countryCode : countryCode,
    region: String(match.region || ''),
    city: String(match.city || ''),
  };
}

function sessionIdFor(user, ip, userAgent) {
  if (user?.jti) return String(user.jti);
  return crypto.createHash('sha256')
    .update(`${user?.id || ''}|${user?.iat || ''}|${ip}|${userAgent}`)
    .digest('hex');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function formatLocation(row) {
  const location = [row.city, row.region, row.country].filter(Boolean).join(', ');
  return location || row.country_code || 'Unknown';
}

function formatReportTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : sgTimeFormatter.format(parsed);
}

function reportDateLabel(activityDate) {
  const parsed = new Date(`${activityDate}T12:00:00+08:00`);
  return Number.isNaN(parsed.getTime()) ? activityDate : sgDisplayFormatter.format(parsed);
}

function reportPeriodLabel(startAt, endAt) {
  return `${sgDateTimeFormatter.format(startAt)} to ${sgDateTimeFormatter.format(endAt)}`;
}

function mergeRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = [row.username, row.ip_address, row.device].join('|');
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...row });
      continue;
    }
    existing.first_seen_at = existing.first_seen_at < row.first_seen_at ? existing.first_seen_at : row.first_seen_at;
    existing.last_seen_at = existing.last_seen_at > row.last_seen_at ? existing.last_seen_at : row.last_seen_at;
    existing.last_path = row.last_seen_at >= existing.last_seen_at ? row.last_path : existing.last_path;
    existing.request_count += row.request_count;
    existing.login_count += row.login_count;
  }
  return [...grouped.values()].sort((left, right) => left.username.localeCompare(right.username)
    || left.first_seen_at.localeCompare(right.first_seen_at));
}

function buildReportContent(summary) {
  const rows = mergeRows(summary.rows);
  const uniqueUsers = new Set(rows.map(row => row.username)).size;
  const requests = rows.reduce((total, row) => total + row.request_count, 0);
  const logins = rows.reduce((total, row) => total + row.login_count, 0);
  const authenticationEvents = summary.authEvents?.length || 0;
  const pageVisits = summary.pageVisits?.length || 0;
  const userActions = summary.userActions?.length || 0;
  const sessionCookieEvents = summary.sessionCookieEvents?.length || 0;
  const dateLabel = summary.windowStart && summary.windowEnd
    ? reportPeriodLabel(new Date(summary.windowStart), new Date(summary.windowEnd))
    : reportDateLabel(summary.activityDate);
  const tableRows = rows.length ? rows.map(row => `
    <tr>
      <td>${escapeHtml(row.username)}</td>
      <td>${escapeHtml(row.ip_address)}</td>
      <td>${escapeHtml(formatLocation(row))}</td>
      <td>${escapeHtml(row.device)}</td>
      <td>${escapeHtml(formatReportTime(row.first_seen_at))}</td>
      <td>${escapeHtml(formatReportTime(row.last_seen_at))}</td>
      <td style="text-align:right">${row.login_count.toLocaleString()}</td>
      <td style="text-align:right">${row.request_count.toLocaleString()}</td>
    </tr>`).join('') : '<tr><td colspan="8" style="padding:18px;text-align:center;color:#68757b">No authenticated ERP activity recorded.</td></tr>';

  const failedRows = summary.failedLogins.length ? summary.failedLogins.slice(0, 50).map(row => `
    <tr>
      <td>${escapeHtml(formatReportTime(row.occurred_at))}</td>
      <td>${escapeHtml(row.username || 'Blank')}</td>
      <td>${escapeHtml(row.ip_address)}</td>
      <td>${escapeHtml(formatLocation(row))}</td>
      <td>${escapeHtml(row.device)}</td>
    </tr>`).join('') : '<tr><td colspan="5" style="padding:14px;text-align:center;color:#68757b">No failed login attempts.</td></tr>';

  const html = `<!doctype html><html><body style="font-family:Calibri,Arial,sans-serif;color:#17252b;margin:0;padding:24px;background:#f3f5f6">
    <div style="max-width:1100px;margin:0 auto;background:#fff;border:1px solid #d8dfe2;padding:24px">
      <p style="margin:0 0 4px;color:#176c60;font-size:12px;font-weight:700">AASTAR ERP</p>
      <h1 style="margin:0;font-size:22px">User Activity</h1>
      <p style="margin:5px 0 22px;color:#66767d">${escapeHtml(dateLabel)} · Singapore time</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px">
        <div style="border:1px solid #d8dfe2;padding:10px 14px"><b>${uniqueUsers}</b><br><span style="color:#66767d">Users</span></div>
        <div style="border:1px solid #d8dfe2;padding:10px 14px"><b>${logins}</b><br><span style="color:#66767d">Logins</span></div>
        <div style="border:1px solid #d8dfe2;padding:10px 14px"><b>${requests}</b><br><span style="color:#66767d">API requests</span></div>
        <div style="border:1px solid #d8dfe2;padding:10px 14px"><b>${summary.failedLogins.length}</b><br><span style="color:#66767d">Failed logins</span></div>
        <div style="border:1px solid #d8dfe2;padding:10px 14px"><b>${authenticationEvents}</b><br><span style="color:#66767d">Authentication events</span></div>
        <div style="border:1px solid #d8dfe2;padding:10px 14px"><b>${pageVisits}</b><br><span style="color:#66767d">Public page visits</span></div>
        <div style="border:1px solid #d8dfe2;padding:10px 14px"><b>${userActions}</b><br><span style="color:#66767d">ERP write actions</span></div>
        <div style="border:1px solid #d8dfe2;padding:10px 14px"><b>${sessionCookieEvents}</b><br><span style="color:#66767d">Session cookie events</span></div>
      </div>
      <h2 style="font-size:15px;margin:0 0 7px">Authenticated Activity</h2>
      <table style="border-collapse:collapse;width:100%;font-size:12px"><thead><tr style="background:#d1d4d5">
        <th style="padding:7px;text-align:left">User</th><th style="padding:7px;text-align:left">IP</th><th style="padding:7px;text-align:left">Approx. location</th>
        <th style="padding:7px;text-align:left">Device</th><th style="padding:7px;text-align:left">First seen</th><th style="padding:7px;text-align:left">Last active</th>
        <th style="padding:7px;text-align:right">Logins</th><th style="padding:7px;text-align:right">Requests</th>
      </tr></thead><tbody>${tableRows}</tbody></table>
      <h2 style="font-size:15px;margin:24px 0 7px">Failed Login Attempts</h2>
      <table style="border-collapse:collapse;width:100%;font-size:12px"><thead><tr style="background:#d1d4d5">
        <th style="padding:7px;text-align:left">Time</th><th style="padding:7px;text-align:left">Username entered</th><th style="padding:7px;text-align:left">IP</th>
        <th style="padding:7px;text-align:left">Approx. location</th><th style="padding:7px;text-align:left">Device</th>
      </tr></thead><tbody>${failedRows}</tbody></table>
      <p style="margin:22px 0 0;color:#7a878c;font-size:11px">A detailed XLSX security audit is attached. Passwords, Google tokens and session tokens are never retained. Locations are approximate IP-based results and may be affected by VPNs, mobile networks or corporate gateways.</p>
    </div></body></html>`;

  const textRows = rows.length ? rows.map(row => [
    row.username, row.ip_address, formatLocation(row), row.device,
    formatReportTime(row.first_seen_at), formatReportTime(row.last_seen_at),
    `${row.login_count} login(s)`, `${row.request_count} request(s)`,
  ].join(' | ')).join('\n') : 'No authenticated ERP activity recorded.';
  const failedText = summary.failedLogins.length ? summary.failedLogins.map(row => [
    formatReportTime(row.occurred_at), row.username || 'Blank', row.ip_address, formatLocation(row), row.device,
  ].join(' | ')).join('\n') : 'No failed login attempts.';

  return {
    subject: `AASTAR ERP user activity - ${dateLabel}`,
    html,
    text: `AASTAR ERP User Activity\n${dateLabel} (Singapore time)\n\nUsers: ${uniqueUsers}\nLogins: ${logins}\nAPI requests: ${requests}\nFailed logins: ${summary.failedLogins.length}\nAuthentication events: ${authenticationEvents}\nPublic page visits: ${pageVisits}\nERP write actions: ${userActions}\nSession cookie events: ${sessionCookieEvents}\n\nA detailed XLSX security audit is attached. Raw passwords, cookies and tokens are never retained.\n\nAUTHENTICATED ACTIVITY\n${textRows}\n\nFAILED LOGIN ATTEMPTS\n${failedText}\n`,
  };
}

class UserActivityStore {
  constructor({ databasePath = process.env.USER_ACTIVITY_DB_PATH || DEFAULT_DB_PATH, geoLookup = defaultGeoLookup } = {}) {
    this.databasePath = path.resolve(databasePath);
    this.geoLookup = geoLookup;
    this.db = null;
    this.pending = new Map();
    this.locationCache = new Map();
  }

  getDb() {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new Database(this.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_user_activity (
        activity_date TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id INTEGER,
        username TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        country_code TEXT,
        country TEXT,
        region TEXT,
        city TEXT,
        user_agent TEXT,
        device TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_path TEXT,
        request_count INTEGER NOT NULL DEFAULT 0,
        login_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (activity_date, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_daily_user_activity_date
        ON daily_user_activity (activity_date, username);
      CREATE TABLE IF NOT EXISTS activity_time_buckets (
        bucket_start TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id INTEGER,
        username TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        country_code TEXT,
        country TEXT,
        region TEXT,
        city TEXT,
        user_agent TEXT,
        device TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_path TEXT,
        request_count INTEGER NOT NULL DEFAULT 0,
        login_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket_start, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_time_buckets_window
        ON activity_time_buckets (bucket_start, username);
      CREATE TABLE IF NOT EXISTS failed_login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_date TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        username TEXT,
        ip_address TEXT NOT NULL,
        country_code TEXT,
        country TEXT,
        region TEXT,
        city TEXT,
        user_agent TEXT,
        device TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_date
        ON failed_login_attempts (activity_date, occurred_at);
      CREATE TABLE IF NOT EXISTS authentication_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_date TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        email TEXT,
        auth_method TEXT NOT NULL,
        result TEXT NOT NULL,
        reason TEXT,
        credential_supplied INTEGER NOT NULL DEFAULT 0,
        credential_length INTEGER NOT NULL DEFAULT 0,
        credential_pattern TEXT,
        credential_fingerprint TEXT,
        credential_family_fingerprint TEXT,
        ip_address TEXT NOT NULL,
        country_code TEXT,
        country TEXT,
        region TEXT,
        city TEXT,
        user_agent TEXT,
        device TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_authentication_events_time
        ON authentication_events (occurred_at, auth_method, result);
      CREATE TABLE IF NOT EXISTS page_visit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_date TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        page TEXT NOT NULL,
        path TEXT NOT NULL,
        referrer TEXT,
        ip_address TEXT NOT NULL,
        country_code TEXT,
        country TEXT,
        region TEXT,
        city TEXT,
        user_agent TEXT,
        device TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_page_visit_events_time
        ON page_visit_events (occurred_at, page);
      CREATE TABLE IF NOT EXISTS user_action_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_date TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        user_id INTEGER,
        username TEXT NOT NULL,
        email TEXT,
        session_id TEXT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        changed_fields TEXT,
        target_reference TEXT,
        ip_address TEXT NOT NULL,
        country_code TEXT,
        country TEXT,
        region TEXT,
        city TEXT,
        user_agent TEXT,
        device TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_user_action_events_time
        ON user_action_events (occurred_at, username);
      CREATE TABLE IF NOT EXISTS session_cookie_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_date TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        email TEXT,
        event_type TEXT NOT NULL,
        session_fingerprint TEXT,
        expires_at TEXT,
        auth_method TEXT,
        transport TEXT,
        cookie_name TEXT NOT NULL,
        secure INTEGER NOT NULL DEFAULT 1,
        http_only INTEGER NOT NULL DEFAULT 1,
        same_site TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        country_code TEXT,
        country TEXT,
        region TEXT,
        city TEXT,
        user_agent TEXT,
        device TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_cookie_events_time
        ON session_cookie_events (occurred_at, event_type);
      CREATE TABLE IF NOT EXISTS report_runs (
        activity_date TEXT PRIMARY KEY,
        recipient TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        sent_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS periodic_report_runs (
        window_end TEXT PRIMARY KEY,
        window_start TEXT NOT NULL,
        recipient TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        sent_at TEXT,
        error TEXT
      );
      INSERT OR IGNORE INTO activity_time_buckets (
        bucket_start, session_id, user_id, username, ip_address, country_code,
        country, region, city, user_agent, device, first_seen_at, last_seen_at,
        last_path, request_count, login_count
      )
      SELECT
        substr(first_seen_at, 1, 14)
          || printf('%02d', (CAST(substr(first_seen_at, 15, 2) AS INTEGER) / 15) * 15)
          || ':00.000Z',
        session_id, user_id, username, ip_address, country_code,
        country, region, city, user_agent, device, first_seen_at, last_seen_at,
        last_path, request_count, login_count
      FROM daily_user_activity;
    `);
    const authColumns = new Set(this.db.prepare('PRAGMA table_info(authentication_events)').all().map(column => column.name));
    const additions = [
      ['credential_length', 'INTEGER NOT NULL DEFAULT 0'],
      ['credential_pattern', 'TEXT'],
      ['credential_fingerprint', 'TEXT'],
      ['credential_family_fingerprint', 'TEXT'],
    ];
    for (const [name, definition] of additions) {
      if (!authColumns.has(name)) this.db.exec(`ALTER TABLE authentication_events ADD COLUMN ${name} ${definition}`);
    }
    return this.db;
  }

  locationFor(ip) {
    if (this.locationCache.has(ip)) return this.locationCache.get(ip);
    let location = null;
    try { location = this.geoLookup(ip); } catch {}
    const normalized = {
      countryCode: String(location?.countryCode || location?.country || ''),
      country: String(location?.countryName || location?.country || ''),
      region: String(location?.region || ''),
      city: String(location?.city || ''),
    };
    this.locationCache.set(ip, normalized);
    return normalized;
  }

  recordActivity({ user, ip, userAgent = '', path: requestPath = '/', login = false, at = new Date() }) {
    if (!user?.username) return;
    const normalizedIp = normalizeIp(ip);
    const normalizedAgent = String(userAgent || '').slice(0, 500);
    const activityDate = singaporeDate(at);
    const bucketStart = activityBucket(at);
    const sessionId = sessionIdFor(user, normalizedIp, normalizedAgent);
    const key = `${bucketStart}:${sessionId}`;
    const timestamp = at.toISOString();
    const location = this.locationFor(normalizedIp);
    const existing = this.pending.get(key);
    const next = existing || {
      activityDate,
      bucketStart,
      sessionId,
      userId: Number(user.id) || null,
      username: String(user.username).slice(0, 120),
      ipAddress: normalizedIp,
      countryCode: location.countryCode,
      country: location.country,
      region: location.region,
      city: location.city,
      userAgent: normalizedAgent,
      device: describeDevice(normalizedAgent),
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      lastPath: String(requestPath || '/').slice(0, 240),
      requestCount: 0,
      loginCount: 0,
    };
    next.lastSeenAt = timestamp;
    next.lastPath = String(requestPath || '/').slice(0, 240);
    next.requestCount += 1;
    if (login) next.loginCount += 1;
    this.pending.set(key, next);
  }

  recordFailedLogin({ username, ip, userAgent = '', at = new Date() }) {
    const normalizedIp = normalizeIp(ip);
    const location = this.locationFor(normalizedIp);
    this.getDb().prepare(`
      INSERT INTO failed_login_attempts (
        activity_date, occurred_at, username, ip_address, country_code, country,
        region, city, user_agent, device
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      singaporeDate(at), at.toISOString(), String(username || '').slice(0, 120), normalizedIp,
      location.countryCode, location.country, location.region, location.city,
      String(userAgent || '').slice(0, 500), describeDevice(userAgent),
    );
  }

  recordAuthenticationEvent({
    userId = null,
    username = '',
    email = '',
    authMethod,
    result,
    reason = '',
    credentialSupplied = false,
    credentialLength = 0,
    credentialPattern = '',
    credentialFingerprint = '',
    credentialFamilyFingerprint = '',
    ip,
    userAgent = '',
    at = new Date(),
  }) {
    const normalizedIp = normalizeIp(ip);
    const location = this.locationFor(normalizedIp);
    this.getDb().prepare(`
      INSERT INTO authentication_events (
        activity_date, occurred_at, user_id, username, email, auth_method,
        result, reason, credential_supplied, credential_length,
        credential_pattern, credential_fingerprint, credential_family_fingerprint,
        ip_address, country_code,
        country, region, city, user_agent, device
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      singaporeDate(at),
      at.toISOString(),
      Number(userId) || null,
      String(username || '').slice(0, 120),
      String(email || '').slice(0, 254),
      String(authMethod || 'unknown').slice(0, 30),
      String(result || 'unknown').slice(0, 30),
      String(reason || '').slice(0, 120),
      credentialSupplied ? 1 : 0,
      Math.max(0, Math.min(Number(credentialLength) || 0, 256)),
      String(credentialPattern || '').slice(0, 120),
      String(credentialFingerprint || '').slice(0, 64),
      String(credentialFamilyFingerprint || '').slice(0, 64),
      normalizedIp,
      location.countryCode,
      location.country,
      location.region,
      location.city,
      String(userAgent || '').slice(0, 500),
      describeDevice(userAgent),
    );
  }

  recordPageVisit({ page, path: requestPath = '/', referrer = '', ip, userAgent = '', at = new Date() }) {
    const normalizedIp = normalizeIp(ip);
    const location = this.locationFor(normalizedIp);
    this.getDb().prepare(`
      INSERT INTO page_visit_events (
        activity_date, occurred_at, page, path, referrer, ip_address,
        country_code, country, region, city, user_agent, device
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      singaporeDate(at), at.toISOString(), String(page || '').slice(0, 30),
      String(requestPath || '/').slice(0, 240), String(referrer || '').slice(0, 500),
      normalizedIp, location.countryCode, location.country, location.region, location.city,
      String(userAgent || '').slice(0, 500), describeDevice(userAgent),
    );
  }

  recordUserAction({
    user, ip, userAgent = '', method, path: requestPath = '/', statusCode,
    durationMs, changedFields = '', targetReference = '', at = new Date(), completedAt = new Date(),
  }) {
    if (!user?.username) return;
    const normalizedIp = normalizeIp(ip);
    const normalizedAgent = String(userAgent || '').slice(0, 500);
    const location = this.locationFor(normalizedIp);
    this.getDb().prepare(`
      INSERT INTO user_action_events (
        activity_date, occurred_at, completed_at, user_id, username, email,
        session_id, method, path, status_code, duration_ms, changed_fields,
        target_reference, ip_address, country_code, country, region, city,
        user_agent, device
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      singaporeDate(at), at.toISOString(), completedAt.toISOString(), Number(user.id) || null,
      String(user.username).slice(0, 120), String(user.email || '').slice(0, 254),
      sessionIdFor(user, normalizedIp, normalizedAgent), String(method || '').slice(0, 12),
      String(requestPath || '/').slice(0, 240), Number(statusCode) || 0,
      Math.max(0, Math.min(Number(durationMs) || 0, 24 * 60 * 60 * 1000)),
      String(changedFields || '').slice(0, 500), String(targetReference || '').slice(0, 1000),
      normalizedIp, location.countryCode, location.country, location.region, location.city,
      normalizedAgent, describeDevice(normalizedAgent),
    );
  }

  recordSessionCookieEvent({
    user = null, token = '', eventType, expiresAt = '', authMethod = '', transport = 'cookie',
    ip, userAgent = '', at = new Date(),
  }) {
    const normalizedIp = normalizeIp(ip);
    const location = this.locationFor(normalizedIp);
    this.getDb().prepare(`
      INSERT INTO session_cookie_events (
        activity_date, occurred_at, user_id, username, email, event_type,
        session_fingerprint, expires_at, auth_method, transport, cookie_name,
        secure, http_only, same_site, ip_address, country_code, country,
        region, city, user_agent, device
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      singaporeDate(at), at.toISOString(), Number(user?.id) || null,
      String(user?.username || '').slice(0, 120), String(user?.email || '').slice(0, 254),
      String(eventType || 'unknown').slice(0, 40), sessionFingerprint(token),
      expiresAt ? String(expiresAt).slice(0, 40) : '', String(authMethod || '').slice(0, 30),
      String(transport || 'cookie').slice(0, 20), SESSION_COOKIE_NAME,
      1, 1, 'None', normalizedIp, location.countryCode, location.country,
      location.region, location.city, String(userAgent || '').slice(0, 500), describeDevice(userAgent),
    );
  }

  flush() {
    if (!this.pending.size) return 0;
    const entries = [...this.pending.values()];
    this.pending.clear();
    const dailyStatement = this.getDb().prepare(`
      INSERT INTO daily_user_activity (
        activity_date, session_id, user_id, username, ip_address, country_code,
        country, region, city, user_agent, device, first_seen_at, last_seen_at,
        last_path, request_count, login_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_date, session_id) DO UPDATE SET
        username = excluded.username,
        ip_address = excluded.ip_address,
        country_code = excluded.country_code,
        country = excluded.country,
        region = excluded.region,
        city = excluded.city,
        user_agent = excluded.user_agent,
        device = excluded.device,
        last_seen_at = MAX(daily_user_activity.last_seen_at, excluded.last_seen_at),
        last_path = CASE WHEN excluded.last_seen_at >= daily_user_activity.last_seen_at THEN excluded.last_path ELSE daily_user_activity.last_path END,
        request_count = daily_user_activity.request_count + excluded.request_count,
        login_count = daily_user_activity.login_count + excluded.login_count
    `);
    const bucketStatement = this.getDb().prepare(`
      INSERT INTO activity_time_buckets (
        bucket_start, session_id, user_id, username, ip_address, country_code,
        country, region, city, user_agent, device, first_seen_at, last_seen_at,
        last_path, request_count, login_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucket_start, session_id) DO UPDATE SET
        username = excluded.username,
        ip_address = excluded.ip_address,
        country_code = excluded.country_code,
        country = excluded.country,
        region = excluded.region,
        city = excluded.city,
        user_agent = excluded.user_agent,
        device = excluded.device,
        first_seen_at = MIN(activity_time_buckets.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(activity_time_buckets.last_seen_at, excluded.last_seen_at),
        last_path = CASE WHEN excluded.last_seen_at >= activity_time_buckets.last_seen_at THEN excluded.last_path ELSE activity_time_buckets.last_path END,
        request_count = activity_time_buckets.request_count + excluded.request_count,
        login_count = activity_time_buckets.login_count + excluded.login_count
    `);
    const write = this.getDb().transaction(rows => {
      for (const row of rows) {
        dailyStatement.run(
          row.activityDate, row.sessionId, row.userId, row.username, row.ipAddress,
          row.countryCode, row.country, row.region, row.city, row.userAgent, row.device,
          row.firstSeenAt, row.lastSeenAt, row.lastPath, row.requestCount, row.loginCount,
        );
        bucketStatement.run(
          row.bucketStart, row.sessionId, row.userId, row.username, row.ipAddress,
          row.countryCode, row.country, row.region, row.city, row.userAgent, row.device,
          row.firstSeenAt, row.lastSeenAt, row.lastPath, row.requestCount, row.loginCount,
        );
      }
    });
    try {
      write(entries);
      return entries.length;
    } catch (error) {
      for (const entry of entries) {
        const key = `${entry.bucketStart}:${entry.sessionId}`;
        const pending = this.pending.get(key);
        if (!pending) this.pending.set(key, entry);
        else {
          pending.requestCount += entry.requestCount;
          pending.loginCount += entry.loginCount;
          if (entry.lastSeenAt > pending.lastSeenAt) {
            pending.lastSeenAt = entry.lastSeenAt;
            pending.lastPath = entry.lastPath;
          }
        }
      }
      throw error;
    }
  }

  summary(activityDate) {
    this.flush();
    const db = this.getDb();
    return {
      activityDate,
      rows: db.prepare('SELECT * FROM daily_user_activity WHERE activity_date = ? ORDER BY username, first_seen_at').all(activityDate),
      failedLogins: db.prepare('SELECT * FROM failed_login_attempts WHERE activity_date = ? ORDER BY occurred_at').all(activityDate),
      authEvents: db.prepare('SELECT * FROM authentication_events WHERE activity_date = ? ORDER BY occurred_at').all(activityDate),
      pageVisits: db.prepare('SELECT * FROM page_visit_events WHERE activity_date = ? ORDER BY occurred_at').all(activityDate),
      userActions: db.prepare('SELECT * FROM user_action_events WHERE activity_date = ? ORDER BY occurred_at').all(activityDate),
      sessionCookieEvents: db.prepare('SELECT * FROM session_cookie_events WHERE activity_date = ? ORDER BY occurred_at').all(activityDate),
    };
  }

  periodSummary(startAt, endAt) {
    this.flush();
    const db = this.getDb();
    const windowStart = startAt.toISOString();
    const windowEnd = endAt.toISOString();
    return {
      windowStart,
      windowEnd,
      rows: db.prepare(`
        SELECT * FROM activity_time_buckets
        WHERE bucket_start >= ? AND bucket_start < ?
        ORDER BY username, first_seen_at
      `).all(activityBucket(startAt), windowEnd),
      failedLogins: db.prepare(`
        SELECT * FROM failed_login_attempts
        WHERE occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at
      `).all(windowStart, windowEnd),
      authEvents: db.prepare(`
        SELECT * FROM authentication_events
        WHERE occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at
      `).all(windowStart, windowEnd),
      pageVisits: db.prepare(`
        SELECT * FROM page_visit_events
        WHERE occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at
      `).all(windowStart, windowEnd),
      userActions: db.prepare(`
        SELECT * FROM user_action_events
        WHERE occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at
      `).all(windowStart, windowEnd),
      sessionCookieEvents: db.prepare(`
        SELECT * FROM session_cookie_events
        WHERE occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at
      `).all(windowStart, windowEnd),
    };
  }

  claimReport(activityDate, recipient, now = new Date()) {
    const db = this.getDb();
    const existing = db.prepare('SELECT * FROM report_runs WHERE activity_date = ?').get(activityDate);
    if (existing?.status === 'sent') return false;
    if (existing?.status === 'sending' && Date.parse(existing.started_at) > now.getTime() - 30 * 60 * 1000) return false;
    if (existing?.status === 'failed' && Date.parse(existing.started_at) > now.getTime() - 15 * 60 * 1000) return false;
    db.prepare(`
      INSERT INTO report_runs (activity_date, recipient, status, started_at, sent_at, error)
      VALUES (?, ?, 'sending', ?, NULL, NULL)
      ON CONFLICT(activity_date) DO UPDATE SET
        recipient = excluded.recipient,
        status = 'sending',
        started_at = excluded.started_at,
        sent_at = NULL,
        error = NULL
    `).run(activityDate, recipient, now.toISOString());
    return true;
  }

  markReport(activityDate, status, error = null, now = new Date()) {
    this.getDb().prepare(`
      UPDATE report_runs SET status = ?, sent_at = ?, error = ? WHERE activity_date = ?
    `).run(status, status === 'sent' ? now.toISOString() : null, error ? String(error).slice(0, 2000) : null, activityDate);
  }

  claimPeriodicReport(startAt, endAt, recipient, now = new Date()) {
    const windowStart = startAt.toISOString();
    const windowEnd = endAt.toISOString();
    const db = this.getDb();
    const existing = db.prepare('SELECT * FROM periodic_report_runs WHERE window_end = ?').get(windowEnd);
    if (existing?.status === 'sent') return false;
    if (existing?.status === 'sending' && Date.parse(existing.started_at) > now.getTime() - 30 * 60 * 1000) return false;
    if (existing?.status === 'failed' && Date.parse(existing.started_at) > now.getTime() - 15 * 60 * 1000) return false;
    db.prepare(`
      INSERT INTO periodic_report_runs (window_end, window_start, recipient, status, started_at, sent_at, error)
      VALUES (?, ?, ?, 'sending', ?, NULL, NULL)
      ON CONFLICT(window_end) DO UPDATE SET
        window_start = excluded.window_start,
        recipient = excluded.recipient,
        status = 'sending',
        started_at = excluded.started_at,
        sent_at = NULL,
        error = NULL
    `).run(windowEnd, windowStart, recipient, now.toISOString());
    return true;
  }

  markPeriodicReport(endAt, status, error = null, now = new Date()) {
    this.getDb().prepare(`
      UPDATE periodic_report_runs SET status = ?, sent_at = ?, error = ? WHERE window_end = ?
    `).run(status, status === 'sent' ? now.toISOString() : null, error ? String(error).slice(0, 2000) : null, endAt.toISOString());
  }

  purge(retentionDays, now = new Date()) {
    const cutoff = singaporeDate(new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000));
    const db = this.getDb();
    const purge = db.transaction(() => {
      db.prepare('DELETE FROM daily_user_activity WHERE activity_date < ?').run(cutoff);
      db.prepare('DELETE FROM failed_login_attempts WHERE activity_date < ?').run(cutoff);
      db.prepare('DELETE FROM authentication_events WHERE activity_date < ?').run(cutoff);
      db.prepare('DELETE FROM page_visit_events WHERE activity_date < ?').run(cutoff);
      db.prepare('DELETE FROM user_action_events WHERE activity_date < ?').run(cutoff);
      db.prepare('DELETE FROM session_cookie_events WHERE activity_date < ?').run(cutoff);
      db.prepare('DELETE FROM report_runs WHERE activity_date < ?').run(cutoff);
      db.prepare('DELETE FROM activity_time_buckets WHERE bucket_start < ?').run(`${cutoff}T00:00:00.000Z`);
      db.prepare('DELETE FROM periodic_report_runs WHERE window_end < ?').run(`${cutoff}T00:00:00.000Z`);
    });
    purge();
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }
}

let singleton = null;
let flushTimer = null;
let reportTimer = null;
let warnedAboutMail = false;

function getStore() {
  if (!singleton) singleton = new UserActivityStore();
  return singleton;
}

function activityFromRequest(user, request, { login = false } = {}) {
  try {
    getStore().recordActivity({
      user,
      ip: requestIp(request),
      userAgent: request?.headers?.['user-agent'] || '',
      path: safePath(request),
      login,
    });
  } catch (error) {
    console.error('User activity record failed:', error.message);
  }
}

function recordAuthenticatedRequest(request, response = request?.res) {
  activityFromRequest(request.user, request);
  const method = String(request?.method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !response?.once) return;
  const startedAt = new Date();
  const metadata = requestActionMetadata(request);
  response.once('finish', () => {
    const completedAt = new Date();
    try {
      getStore().recordUserAction({
        user: request.user,
        ip: requestIp(request),
        userAgent: request?.headers?.['user-agent'] || '',
        method,
        path: safePath(request),
        statusCode: response.statusCode,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        ...metadata,
        at: startedAt,
        completedAt,
      });
    } catch (error) {
      console.error('User action record failed:', error.message);
    }
  });
}

function recordPageVisit(request, event) {
  try {
    getStore().recordPageVisit({
      ...event,
      ip: requestIp(request),
      userAgent: request?.headers?.['user-agent'] || '',
    });
  } catch (error) {
    console.error('Page visit record failed:', error.message);
  }
}

function recordSessionCookieEvent(request, event) {
  try {
    getStore().recordSessionCookieEvent({
      ...event,
      ip: requestIp(request),
      userAgent: request?.headers?.['user-agent'] || '',
    });
  } catch (error) {
    console.error('Session cookie event record failed:', error.message);
  }
}

function recordLoginSuccess(user, request) {
  activityFromRequest(user, request, { login: true });
}

function recordRealtimeConnection(user, request) {
  activityFromRequest(user, request);
}

function recordFailedLogin(request, username) {
  try {
    getStore().recordFailedLogin({
      username,
      ip: requestIp(request),
      userAgent: request?.headers?.['user-agent'] || '',
    });
  } catch (error) {
    console.error('Failed login activity record failed:', error.message);
  }
}

function recordAuthenticationEvent(request, event) {
  try {
    getStore().recordAuthenticationEvent({
      ...event,
      ip: requestIp(request),
      userAgent: request?.headers?.['user-agent'] || '',
    });
  } catch (error) {
    console.error('Authentication event record failed:', error.message);
  }
}

function mailConfig() {
  const recipient = process.env.USER_ACTIVITY_REPORT_TO || DEFAULT_RECIPIENT;
  const smtpUrl = process.env.SMTP_URL || '';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  if (!smtpUrl && (!user || !pass)) return { configured: false, recipient };
  return {
    configured: true,
    recipient,
    from: process.env.SMTP_FROM || user,
    transport: smtpUrl || {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false',
      auth: { user, pass },
    },
  };
}

async function sendDailyReport(activityDate, { force = false, transporter = null } = {}) {
  const config = mailConfig();
  if (!config.configured && !transporter) throw new Error('SMTP is not configured');
  const store = getStore();
  if (!force && !store.claimReport(activityDate, config.recipient)) return { skipped: true, activityDate };
  if (force) store.claimReport(activityDate, config.recipient);
  const summary = store.summary(activityDate);
  const content = buildReportContent(summary);
  const mailer = transporter || nodemailer.createTransport(config.transport);
  try {
    const auditAttachment = await buildSecurityAuditAttachment(summary);
    const info = await mailer.sendMail({
      from: config.from,
      to: config.recipient,
      subject: content.subject,
      text: content.text,
      html: content.html,
      attachments: [auditAttachment],
    });
    store.markReport(activityDate, 'sent');
    store.purge(Math.max(7, Number(process.env.USER_ACTIVITY_RETENTION_DAYS || 90)));
    console.log(`User activity report sent for ${activityDate} to ${config.recipient}`);
    return { sent: true, activityDate, recipient: config.recipient, messageId: info.messageId };
  } catch (error) {
    store.markReport(activityDate, 'failed', error.message);
    throw error;
  }
}

async function sendShiftReport({ startAt, endAt, scheduled = true, transporter = null } = {}) {
  const config = mailConfig();
  if (!config.configured && !transporter) throw new Error('SMTP is not configured');
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime()) || !(endAt instanceof Date) || Number.isNaN(endAt.getTime())) {
    throw new Error('Valid report window is required');
  }
  if (endAt <= startAt) throw new Error('Report window end must be after its start');
  const store = getStore();
  if (scheduled && !store.claimPeriodicReport(startAt, endAt, config.recipient)) {
    return { skipped: true, windowStart: startAt.toISOString(), windowEnd: endAt.toISOString() };
  }
  const summary = store.periodSummary(startAt, endAt);
  const content = buildReportContent(summary);
  const mailer = transporter || nodemailer.createTransport(config.transport);
  try {
    const auditAttachment = await buildSecurityAuditAttachment(summary);
    const info = await mailer.sendMail({
      from: config.from,
      to: config.recipient,
      subject: content.subject,
      text: content.text,
      html: content.html,
      attachments: [auditAttachment],
    });
    if (scheduled) store.markPeriodicReport(endAt, 'sent');
    store.purge(Math.max(7, Number(process.env.USER_ACTIVITY_RETENTION_DAYS || 90)));
    console.log(`User activity report sent for ${summary.windowStart} to ${summary.windowEnd} to ${config.recipient}`);
    return {
      sent: true,
      windowStart: summary.windowStart,
      windowEnd: summary.windowEnd,
      recipient: config.recipient,
      messageId: info.messageId,
    };
  } catch (error) {
    if (scheduled) store.markPeriodicReport(endAt, 'failed', error.message);
    throw error;
  }
}

async function maybeSendScheduledReport(now = new Date()) {
  const config = mailConfig();
  if (!config.configured) {
    if (!warnedAboutMail) {
      warnedAboutMail = true;
      console.warn('User activity logging enabled; scheduled email disabled until SMTP_USER/SMTP_PASS or SMTP_URL is configured.');
    }
    return { skipped: true, reason: 'smtp-not-configured' };
  }
  const window = latestScheduledWindow(now);
  return sendShiftReport({ ...window, scheduled: true });
}

function startUserActivity() {
  getStore().getDb();
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      try { getStore().flush(); } catch (error) { console.error('User activity flush failed:', error.message); }
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
  if (!reportTimer) {
    const runReport = () => maybeSendScheduledReport().catch(error => console.error('User activity report failed:', error.message));
    setTimeout(runReport, 10000).unref?.();
    reportTimer = setInterval(runReport, REPORT_CHECK_INTERVAL_MS);
    reportTimer.unref?.();
  }
  console.log(`User activity logging started (${getStore().databasePath})`);
}

function stopUserActivity() {
  if (flushTimer) clearInterval(flushTimer);
  if (reportTimer) clearInterval(reportTimer);
  flushTimer = null;
  reportTimer = null;
  if (singleton) {
    try { singleton.flush(); } catch {}
    singleton.close();
  }
  singleton = null;
}

module.exports = {
  UserActivityStore,
  activityBucket,
  buildReportContent,
  credentialAuditMetadata,
  currentShiftWindow,
  describeDevice,
  latestScheduledWindow,
  maybeSendScheduledReport,
  normalizeIp,
  previousSingaporeDate,
  recordAuthenticatedRequest,
  recordAuthenticationEvent,
  recordFailedLogin,
  recordLoginSuccess,
  recordPageVisit,
  recordRealtimeConnection,
  recordSessionCookieEvent,
  requestIp,
  requestActionMetadata,
  sendDailyReport,
  sendShiftReport,
  singaporeDate,
  startUserActivity,
  stopUserActivity,
};
