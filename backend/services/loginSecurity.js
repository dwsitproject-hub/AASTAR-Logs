'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const Database = require('better-sqlite3');
const { normalizeIp, requestIp } = require('./userActivity');

const DEFAULT_DB_PATH = path.join(__dirname, '../data/login_security.db');
const DEFAULT_ACTIVITY_DB_PATH = path.join(__dirname, '../data/user_activity.db');
const DEFAULT_FAILURE_LIMIT = 4;

class LoginSecurityStore {
  constructor({
    databasePath = process.env.LOGIN_SECURITY_DB_PATH || DEFAULT_DB_PATH,
    activityDatabasePath = process.env.USER_ACTIVITY_DB_PATH || DEFAULT_ACTIVITY_DB_PATH,
    failureLimit = Number(process.env.LOGIN_FAILURE_LIMIT || DEFAULT_FAILURE_LIMIT),
  } = {}) {
    this.databasePath = databasePath;
    this.activityDatabasePath = activityDatabasePath;
    this.failureLimit = Math.max(1, Number(failureLimit) || DEFAULT_FAILURE_LIMIT);
    this.db = null;
  }

  getDb() {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new Database(this.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS login_ip_security (
        ip_address TEXT PRIMARY KEY,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        first_failed_at TEXT,
        last_failed_at TEXT,
        last_username TEXT,
        is_blocked INTEGER NOT NULL DEFAULT 0,
        blocked_at TEXT,
        blocked_reason TEXT,
        unlocked_at TEXT,
        unlocked_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_login_ip_security_blocked
        ON login_ip_security (is_blocked, blocked_at DESC);
      CREATE TABLE IF NOT EXISTS login_ip_allowlist (
        ip_address TEXT PRIMARY KEY,
        label TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
    `);
    this.importHistoricalFailures();
    return this.db;
  }

  importHistoricalFailures() {
    if (!this.activityDatabasePath || !fs.existsSync(this.activityDatabasePath)) return 0;
    let activityDb;
    try {
      activityDb = new Database(this.activityDatabasePath, { readonly: true, fileMustExist: true });
      const rows = activityDb.prepare(`
        SELECT
          ip_address,
          COUNT(*) AS failed_attempts,
          MIN(occurred_at) AS first_failed_at,
          MAX(occurred_at) AS last_failed_at,
          MAX(username) AS last_username
        FROM failed_login_attempts
        WHERE ip_address IS NOT NULL AND TRIM(ip_address) <> ''
        GROUP BY ip_address
        HAVING COUNT(*) >= ?
      `).all(this.failureLimit);
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO login_ip_security (
          ip_address, failed_attempts, first_failed_at, last_failed_at,
          last_username, is_blocked, blocked_at, blocked_reason
        ) VALUES (?, ?, ?, ?, ?, 1, ?, 'historical-login-failures')
      `);
      const transaction = this.db.transaction(items => {
        for (const row of items) {
          const ip = normalizeIp(row.ip_address);
          if (ip === 'Unknown' || this.isAllowlisted(ip)) continue;
          insert.run(
            ip,
            Number(row.failed_attempts) || this.failureLimit,
            row.first_failed_at,
            row.last_failed_at,
            String(row.last_username || '').slice(0, 120),
            row.last_failed_at,
          );
        }
      });
      transaction(rows);
      return rows.length;
    } catch (error) {
      console.error('Historical login security import skipped:', error.message);
      return 0;
    } finally {
      activityDb?.close();
    }
  }

  status(ipAddress) {
    const ip = normalizeIp(ipAddress);
    if (ip === 'Unknown') return { ipAddress: ip, failedAttempts: 0, isBlocked: false, isAllowlisted: false };
    const allowlisted = this.getDb().prepare('SELECT label FROM login_ip_allowlist WHERE ip_address = ?').get(ip);
    if (allowlisted) {
      return {
        ipAddress: ip,
        failedAttempts: 0,
        isBlocked: false,
        isAllowlisted: true,
        label: allowlisted.label || null,
      };
    }
    const row = this.getDb().prepare('SELECT * FROM login_ip_security WHERE ip_address = ?').get(ip);
    return {
      ipAddress: ip,
      failedAttempts: Number(row?.failed_attempts || 0),
      isBlocked: row?.is_blocked === 1,
      isAllowlisted: false,
      blockedAt: row?.blocked_at || null,
      reason: row?.blocked_reason || null,
    };
  }

  isAllowlisted(ipAddress) {
    const ip = normalizeIp(ipAddress);
    if (ip === 'Unknown') return false;
    return Boolean(this.getDb().prepare('SELECT 1 FROM login_ip_allowlist WHERE ip_address = ?').get(ip));
  }

  recordFailure(ipAddress, username, reason = 'invalid-credentials', at = new Date()) {
    const ip = normalizeIp(ipAddress);
    if (ip === 'Unknown') return this.status(ip);
    if (this.isAllowlisted(ip)) return this.status(ip);
    const timestamp = at.toISOString();
    const safeUsername = String(username || '').slice(0, 120);
    const update = this.getDb().transaction(() => {
      const current = this.db.prepare('SELECT * FROM login_ip_security WHERE ip_address = ?').get(ip);
      if (current?.is_blocked === 1) return;
      const attempts = Number(current?.failed_attempts || 0) + 1;
      const shouldBlock = attempts >= this.failureLimit;
      this.db.prepare(`
        INSERT INTO login_ip_security (
          ip_address, failed_attempts, first_failed_at, last_failed_at,
          last_username, is_blocked, blocked_at, blocked_reason,
          unlocked_at, unlocked_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(ip_address) DO UPDATE SET
          failed_attempts = excluded.failed_attempts,
          first_failed_at = COALESCE(login_ip_security.first_failed_at, excluded.first_failed_at),
          last_failed_at = excluded.last_failed_at,
          last_username = excluded.last_username,
          is_blocked = excluded.is_blocked,
          blocked_at = excluded.blocked_at,
          blocked_reason = excluded.blocked_reason,
          unlocked_at = NULL,
          unlocked_by = NULL
      `).run(
        ip, attempts, timestamp, timestamp, safeUsername,
        shouldBlock ? 1 : 0,
        shouldBlock ? timestamp : null,
        shouldBlock ? String(reason || 'invalid-credentials').slice(0, 120) : null,
      );
    });
    update();
    return this.status(ip);
  }

  recordSuccess(ipAddress) {
    const ip = normalizeIp(ipAddress);
    if (ip === 'Unknown') return;
    this.getDb().prepare(`
      UPDATE login_ip_security
      SET failed_attempts = 0,
          first_failed_at = NULL,
          last_failed_at = NULL,
          last_username = NULL
      WHERE ip_address = ? AND is_blocked = 0
    `).run(ip);
  }

  listBlocked() {
    return this.getDb().prepare(`
      SELECT
        ip_address, failed_attempts, first_failed_at, last_failed_at,
        last_username, blocked_at, blocked_reason
      FROM login_ip_security
      WHERE is_blocked = 1
        AND NOT EXISTS (
          SELECT 1 FROM login_ip_allowlist
          WHERE login_ip_allowlist.ip_address = login_ip_security.ip_address
        )
      ORDER BY blocked_at DESC, ip_address
    `).all().map(row => ({
      ip_address: row.ip_address,
      failed_attempts: Number(row.failed_attempts || 0),
      first_failed_at: row.first_failed_at,
      last_failed_at: row.last_failed_at,
      last_username: row.last_username,
      blocked_at: row.blocked_at,
      blocked_reason: row.blocked_reason,
    }));
  }

  unlock(ipAddress, username, at = new Date()) {
    const ip = normalizeIp(ipAddress);
    if (ip === 'Unknown') return false;
    const result = this.getDb().prepare(`
      UPDATE login_ip_security
      SET failed_attempts = 0,
          first_failed_at = NULL,
          last_failed_at = NULL,
          last_username = NULL,
          is_blocked = 0,
          blocked_at = NULL,
          blocked_reason = NULL,
          unlocked_at = ?,
          unlocked_by = ?
      WHERE ip_address = ? AND is_blocked = 1
    `).run(at.toISOString(), String(username || '').slice(0, 120), ip);
    return result.changes > 0;
  }

  listAllowlisted() {
    return this.getDb().prepare(`
      SELECT ip_address, label, created_at, created_by
      FROM login_ip_allowlist
      ORDER BY created_at DESC, ip_address
    `).all();
  }

  allowlist(ipAddress, label, username, at = new Date()) {
    const ip = normalizeIp(ipAddress);
    if (!isIP(ip)) return null;
    const timestamp = at.toISOString();
    const safeLabel = String(label || '').trim().slice(0, 120) || null;
    const safeUsername = String(username || '').trim().slice(0, 120) || 'Matthew';
    this.getDb().transaction(() => {
      this.db.prepare(`
        INSERT INTO login_ip_allowlist (ip_address, label, created_at, created_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(ip_address) DO UPDATE SET
          label = excluded.label,
          created_at = excluded.created_at,
          created_by = excluded.created_by
      `).run(ip, safeLabel, timestamp, safeUsername);
      this.db.prepare('DELETE FROM login_ip_security WHERE ip_address = ?').run(ip);
    })();
    return this.getDb().prepare(`
      SELECT ip_address, label, created_at, created_by
      FROM login_ip_allowlist WHERE ip_address = ?
    `).get(ip);
  }

  removeAllowlist(ipAddress) {
    const ip = normalizeIp(ipAddress);
    if (!isIP(ip)) return false;
    return this.getDb().prepare('DELETE FROM login_ip_allowlist WHERE ip_address = ?').run(ip).changes > 0;
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

let singleton;

function getLoginSecurityStore() {
  if (!singleton) singleton = new LoginSecurityStore();
  singleton.getDb();
  return singleton;
}

function securityStatusForRequest(request) {
  return getLoginSecurityStore().status(requestIp(request));
}

module.exports = {
  DEFAULT_FAILURE_LIMIT,
  LoginSecurityStore,
  getLoginSecurityStore,
  securityStatusForRequest,
};
