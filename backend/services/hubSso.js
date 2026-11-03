'use strict';

// DWS Hub single sign-on (strict OIDC contract): authorization code + PKCE S256,
// ID token verified against the Hub JWKS. The Hub only proves who the user is;
// ERP access (approval, pages, admin role) stays in the local users table.

const crypto = require('node:crypto');
const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/config');
const { SECURE_COOKIES } = require('./sessionCookie');

const TRANSACTION_COOKIE_NAME = SECURE_COOKIES ? '__Host-erp_sso' : 'erp_sso';
const TRANSACTION_MAX_AGE_SECONDS = 10 * 60;
// Marks a Hub-launched callback that was restarted as a normal sign-in, so a
// second unknown callback right after it is an error instead of a loop.
const LAUNCH_RESTART_COOKIE_NAME = SECURE_COOKIES ? '__Host-erp_sso_launch' : 'erp_sso_launch';
const LAUNCH_RESTART_MAX_AGE_SECONDS = 2 * 60;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10 * 1000;
const ID_TOKEN_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function listFromEnv(value) {
  return String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
}

function hubSsoConfig(env = process.env) {
  const hubUrl = trimSlash(env.DWS_HUB_URL);
  const clientId = String(env.DWS_HUB_CLIENT_ID || '').trim();
  const redirectUri = String(env.DWS_HUB_REDIRECT_URI || '').trim();
  const switchedOff = ['0', 'false', 'off'].includes(String(env.DWS_HUB_SSO_ENABLED || '').trim().toLowerCase());
  return {
    enabled: Boolean(!switchedOff && hubUrl && clientId && redirectUri),
    hubUrl,
    clientId,
    redirectUri,
    scope: String(env.DWS_HUB_SCOPE || 'openid profile email').trim(),
    allowedEmailDomains: listFromEnv(env.DWS_HUB_ALLOWED_EMAIL_DOMAINS),
  };
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

// Only same-site application paths may be used as the post-login destination.
function safeNextPath(value) {
  const next = typeof value === 'string' ? value.trim().slice(0, 500) : '';
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/dashboard';
  if (next === '/login' || next.startsWith('/api/') || next.startsWith('/atlas/')) return '/dashboard';
  if (/[\r\n]/.test(next)) return '/dashboard';
  return next;
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function transactionCookieOptions(maxAge = TRANSACTION_MAX_AGE_SECONDS) {
  // Lax: the callback is a top-level GET navigation coming back from the Hub.
  return { httpOnly: true, secure: SECURE_COOKIES, sameSite: 'lax', path: '/', maxAge };
}

// A callback with a code but no sign-in started here is a launch from the Hub
// tile. Its code cannot be redeemed safely (the verifier is not ours), so the
// app starts its own sign-in once; the Hub session makes that invisible.
// Only when no sign-in was started in this browser: a pending sign-in whose state
// does not match is an attack or a mix-up, never a launch.
function launchRestartAllowed(request) {
  try {
    const cookies = cookie.parse(String(request?.headers?.cookie || ''));
    return !cookies[LAUNCH_RESTART_COOKIE_NAME] && !cookies[TRANSACTION_COOKIE_NAME];
  } catch {
    return false;
  }
}

function markLaunchRestart(response) {
  response.append('Set-Cookie', cookie.serialize(LAUNCH_RESTART_COOKIE_NAME, '1', transactionCookieOptions(LAUNCH_RESTART_MAX_AGE_SECONDS)));
}

function startTransaction(response, nextPath) {
  const state = base64Url(crypto.randomBytes(32));
  const nonce = base64Url(crypto.randomBytes(32));
  const pkce = createPkcePair();
  const sealed = jwt.sign(
    { typ: 'erp-sso-tx', state, nonce, verifier: pkce.verifier, next: safeNextPath(nextPath) },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: TRANSACTION_MAX_AGE_SECONDS },
  );
  response.append('Set-Cookie', cookie.serialize(TRANSACTION_COOKIE_NAME, sealed, transactionCookieOptions()));
  return { state, nonce, challenge: pkce.challenge };
}

function clearTransaction(response) {
  response.append('Set-Cookie', cookie.serialize(TRANSACTION_COOKIE_NAME, '', {
    ...transactionCookieOptions(0),
    expires: new Date(0),
  }));
}

// Returns the stored transaction when the callback state matches it, otherwise null.
function readTransaction(request, returnedState) {
  let sealed;
  try {
    sealed = cookie.parse(String(request?.headers?.cookie || ''))[TRANSACTION_COOKIE_NAME];
  } catch {
    return null;
  }
  if (typeof sealed !== 'string' || !sealed || sealed.length > 4096) return null;
  let transaction;
  try {
    transaction = jwt.verify(sealed, jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  if (transaction?.typ !== 'erp-sso-tx' || !constantTimeEqual(transaction.state, returnedState)) return null;
  return transaction;
}

function hubError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (error) {
    throw hubError('HUB_UNREACHABLE', `DWS Hub could not be reached (${error.cause?.code || error.name})`, error);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {}
  return { status: response.status, ok: response.ok, body };
}

function createHubSsoClient(config = hubSsoConfig(), { loadJose = () => import('jose') } = {}) {
  let discovery = null;
  let discoveryLoadedAt = 0;
  let jwks = null;
  let jwksUri = '';

  async function getDiscovery() {
    if (discovery && Date.now() - discoveryLoadedAt < DISCOVERY_TTL_MS) return discovery;
    const url = `${config.hubUrl}/api/sso/.well-known/openid-configuration`;
    const { ok, status, body } = await fetchJson(url, { headers: { accept: 'application/json' } });
    if (!ok || !body?.issuer || !body?.authorization_endpoint || !body?.token_endpoint) {
      throw hubError('HUB_DISCOVERY_FAILED', `DWS Hub discovery failed with status ${status}`);
    }
    discovery = {
      issuer: String(body.issuer),
      authorizationEndpoint: String(body.authorization_endpoint),
      tokenEndpoint: String(body.token_endpoint),
      jwksUri: String(body.jwks_uri || `${config.hubUrl}/api/sso/jwks`),
    };
    discoveryLoadedAt = Date.now();
    return discovery;
  }

  async function getJwks(uri) {
    if (!jwks || jwksUri !== uri) {
      const { createRemoteJWKSet } = await loadJose();
      // jose refetches when an unknown kid appears, so key rotation needs no restart.
      jwks = createRemoteJWKSet(new URL(uri), { timeoutDuration: HTTP_TIMEOUT_MS, cooldownDuration: 30 * 1000 });
      jwksUri = uri;
    }
    return jwks;
  }

  async function authorizationUrl({ state, nonce, challenge }) {
    const { authorizationEndpoint } = await getDiscovery();
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scope,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async function exchangeCode({ code, verifier }) {
    const { tokenEndpoint } = await getDiscovery();
    const { ok, status, body } = await fetchJson(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        code_verifier: verifier,
      }),
    });
    if (!ok || typeof body?.id_token !== 'string') {
      const reason = typeof body?.error === 'string' ? body.error.slice(0, 60) : `status-${status}`;
      throw hubError('HUB_TOKEN_REJECTED', `DWS Hub token exchange failed: ${reason}`);
    }
    return body.id_token;
  }

  async function verifyIdToken(idToken, { nonce } = {}) {
    const hub = await getDiscovery();
    const { jwtVerify } = await loadJose();
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, await getJwks(hub.jwksUri), {
        issuer: hub.issuer,
        audience: config.clientId,
        algorithms: ID_TOKEN_ALGORITHMS,
        requiredClaims: ['sub', 'exp'],
        clockTolerance: 15,
      }));
    } catch (error) {
      throw hubError('HUB_TOKEN_INVALID', `DWS Hub ID token rejected: ${error.code || error.message}`, error);
    }
    if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
      throw hubError('HUB_TOKEN_INVALID', 'DWS Hub ID token has no subject');
    }
    // The Hub contract lists nonce as optional; when it is echoed it must match.
    if (payload.nonce !== undefined && !constantTimeEqual(payload.nonce, nonce)) {
      throw hubError('HUB_TOKEN_INVALID', 'DWS Hub ID token nonce mismatch');
    }
    return payload;
  }

  return { config, authorizationUrl, exchangeCode, verifyIdToken, getDiscovery };
}

function isAllowedHubEmail(email, allowedDomains) {
  if (!allowedDomains.length) return true;
  const domain = String(email || '').split('@')[1] || '';
  return allowedDomains.includes(domain.toLowerCase());
}

// Links a Hub identity to an ERP user. `sub` is the canonical key; email is only
// used once, to link an existing ERP account the first time it signs in via the Hub.
function provisionHubUser(db, { subject, email }) {
  let user = db.prepare('SELECT * FROM users WHERE hub_sub = ?').get(subject);
  if (!user && email) user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);

  if (!user) {
    if (!email) return { created: false, conflict: true, user: null };
    let result;
    try {
      result = db.prepare(`
        INSERT INTO users (
          username, email, hub_sub, password, is_admin, is_approved,
          permissions, tab_permissions, auth_version
        ) VALUES (?, ?, ?, NULL, 0, 0, '[]', '[]', 1)
      `).run(email, email, subject);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { created: false, conflict: true, user: null };
      throw error;
    }
    return {
      created: true,
      conflict: false,
      user: db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid),
    };
  }

  if (user.hub_sub && user.hub_sub !== subject) return { created: false, conflict: true, user: null };
  if (!user.hub_sub) {
    db.prepare('UPDATE users SET hub_sub = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(subject, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  return { created: false, conflict: false, user };
}

let sharedClient = null;
function getHubSsoClient() {
  if (!sharedClient) sharedClient = createHubSsoClient();
  return sharedClient;
}

module.exports = {
  LAUNCH_RESTART_COOKIE_NAME,
  TRANSACTION_COOKIE_NAME,
  clearTransaction,
  createHubSsoClient,
  createPkcePair,
  getHubSsoClient,
  hubSsoConfig,
  isAllowedHubEmail,
  launchRestartAllowed,
  markLaunchRestart,
  provisionHubUser,
  readTransaction,
  safeNextPath,
  startTransaction,
};
