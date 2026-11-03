const express = require('express');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { getDb } = require('../db/database');
const { requireAuth, requireMatthew } = require('../middleware/auth');
const { jwtSecret, jwtExpiry } = require('../config/config');
const { preloadDashboards } = require('../services/dashboardPreload');
const { getLoginSecurityStore } = require('../services/loginSecurity');
const { showRealLogin, sendLoginDenied } = require('../services/loginPresentation');
const {
  REMEMBER_SESSION_MAX_AGE_SECONDS,
  clearSessionCookie,
  setSessionCookie,
} = require('../services/sessionCookie');
const {
  isAllowedGoogleIdentity,
  parseJsonList,
  provisionGoogleUser,
} = require('../services/googleAccountAccess');
const {
  clearTransaction,
  getHubSsoClient,
  isAllowedHubEmail,
  launchRestartAllowed,
  markLaunchRestart,
  provisionHubUser,
  readTransaction,
  startTransaction,
} = require('../services/hubSso');
const { findLocalDevUser, localDevLoginEmail } = require('../services/localDevLogin');
const {
  currentShiftWindow,
  credentialAuditMetadata,
  latestScheduledWindow,
  recordAuthenticationEvent,
  recordFailedLogin,
  recordLoginSuccess,
  recordPageVisit,
  recordSessionCookieEvent,
  normalizeIp,
  requestIp,
  sendShiftReport,
} = require('../services/userActivity');

const router = express.Router();
const DECOY_PATH = '/atlas/royal-continent';
const GOOGLE_ALLOWED_DOMAIN = String(process.env.GOOGLE_ALLOWED_DOMAIN || 'kpn-corp.com').trim().toLowerCase();
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const HUB_SESSION_REMEMBER = ['1', 'true', 'on'].includes(String(process.env.DWS_HUB_SESSION_REMEMBER || '').trim().toLowerCase());
// Throws (and stops the server) if it is set together with NODE_ENV=production.
const LOCAL_DEV_LOGIN_EMAIL = localDevLoginEmail();
if (LOCAL_DEV_LOGIN_EMAIL) console.warn(`Local dev sign-in is ENABLED for ${LOCAL_DEV_LOGIN_EMAIL}. Never use this outside a local stack.`);
let manualActivityReportInFlight = false;

function safeString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function safeSecret(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || null,
    hub_sub: user.hub_sub || null,
    is_admin: user.is_admin === 1,
    is_approved: user.is_approved === 1,
    permissions: parseJsonList(user.permissions),
    tab_permissions: parseJsonList(user.tab_permissions),
  };
}

function issueSession(user, req, res, authMethod, remember = false) {
  const session = startSession(user, req, res, authMethod, remember);
  res.json({ user: session.user, csrfToken: session.csrfToken });
  recordLoginSuccess(session.tokenUser, req);
  preloadDashboards('login');
}

// Sets the session cookie and records the audit events; the caller sends the response.
function startSession(user, req, res, authMethod, remember = false) {
  const sessionId = crypto.randomUUID();
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const visibleUser = publicUser(user);
  const tokenUser = {
    ...visibleUser,
    auth_version: Number(user.auth_version || 1),
    jti: sessionId,
    csrf: csrfToken,
  };
  const maxAgeSeconds = remember ? REMEMBER_SESSION_MAX_AGE_SECONDS : null;
  const token = jwt.sign(tokenUser, jwtSecret, {
    algorithm: 'HS256',
    expiresIn: maxAgeSeconds || jwtExpiry,
  });
  const tokenClaims = jwt.decode(token);
  setSessionCookie(res, token, maxAgeSeconds || undefined);
  getLoginSecurityStore().recordSuccess(requestIp(req));
  recordAuthenticationEvent(req, {
    userId: user.id,
    username: user.username,
    email: user.email || '',
    authMethod,
    result: 'success',
    reason: 'authenticated',
    credentialSupplied: true,
  });
  recordSessionCookieEvent(req, {
    user: tokenUser,
    token,
    eventType: 'issued',
    expiresAt: tokenClaims?.exp ? new Date(tokenClaims.exp * 1000).toISOString() : '',
    authMethod,
    transport: 'cookie',
  });
  return { user: visibleUser, csrfToken, tokenUser };
}

function recordRejectedLogin(req, {
  username = '',
  email = '',
  authMethod,
  reason,
  credentialSupplied,
  result = '',
  ...credentialAudit
}) {
  recordFailedLogin(req, username || email);
  const status = getLoginSecurityStore().recordFailure(requestIp(req), username || email, reason);
  recordAuthenticationEvent(req, {
    username,
    email,
    authMethod,
    result: result || (status.isBlocked ? 'blocked' : 'failure'),
    reason,
    credentialSupplied,
    ...credentialAudit,
  });
  return status;
}

router.get('/access-status', (req, res) => {
  const status = getLoginSecurityStore().status(requestIp(req));
  if (status.isBlocked) {
    clearSessionCookie(res);
    if (!showRealLogin(req)) return sendLoginDenied(req, res);
  }
  res.json({
    decoy: false,
    google: {
      enabled: Boolean(GOOGLE_CLIENT_ID),
      clientId: GOOGLE_CLIENT_ID || null,
    },
    hubSso: {
      enabled: getHubSsoClient().config.enabled,
    },
    devLogin: LOCAL_DEV_LOGIN_EMAIL ? { enabled: true, email: LOCAL_DEV_LOGIN_EMAIL } : { enabled: false },
  });
});

// Local stacks only (see services/localDevLogin.js): signs in the one seeded account.
router.post('/dev-login', (req, res) => {
  if (!LOCAL_DEV_LOGIN_EMAIL) return res.status(404).json({ error: 'Not found' });
  const user = findLocalDevUser(getDb(), LOCAL_DEV_LOGIN_EMAIL);
  if (!user || user.is_approved !== 1) {
    return res.status(403).json({
      code: 'ACCOUNT_PENDING',
      error: `No approved account for ${LOCAL_DEV_LOGIN_EMAIL}. Run: npm run seed:admin -- ${LOCAL_DEV_LOGIN_EMAIL}`,
    });
  }
  issueSession(user, req, res, 'local-dev', false);
});

// Used by Nginx auth_request before it serves an ERP document route. The
// response intentionally contains no security details.
router.get('/gate', (req, res) => {
  if (getLoginSecurityStore().status(requestIp(req)).isBlocked && !showRealLogin(req)) {
    return res.status(403).end();
  }
  return res.status(204).end();
});

router.post('/page-visit', (req, res) => {
  const page = safeString(req.body?.page, 30);
  if (!['login', 'dummy'].includes(page)) return res.status(400).json({ error: 'Invalid page' });
  recordPageVisit(req, {
    page,
    path: page === 'dummy' ? DECOY_PATH : '/login',
    referrer: safeString(req.body?.referrer, 500),
  });
  return res.status(204).end();
});

router.post('/login', (req, res) => {
  const security = getLoginSecurityStore();
  const username = safeString(req.body?.username, 120);
  const password = safeSecret(req.body?.password, 256);
  const credentialAudit = credentialAuditMetadata(password);
  if (security.status(requestIp(req)).isBlocked) {
    recordAuthenticationEvent(req, {
      username,
      authMethod: 'password',
      result: 'blocked',
      reason: 'ip-blocked',
      credentialSupplied: Boolean(password),
      ...credentialAudit,
    });
    return sendLoginDenied(req, res);
  }
  const status = recordRejectedLogin(req, {
    username,
    authMethod: 'password',
    reason: 'password-login-disabled',
    credentialSupplied: Boolean(password),
    ...credentialAudit,
  });
  if (status.isBlocked) return sendLoginDenied(req, res);
  return res.status(401).json({ error: 'Invalid credentials' });
});

router.post('/google', async (req, res) => {
  const security = getLoginSecurityStore();
  const credential = safeString(req.body?.credential, 8192);
  const remember = req.body?.remember === true;
  if (security.status(requestIp(req)).isBlocked) {
    recordAuthenticationEvent(req, {
      username: 'Google sign-in',
      authMethod: 'google',
      result: 'blocked',
      reason: 'ip-blocked',
      credentialSupplied: Boolean(credential),
    });
    return sendLoginDenied(req, res);
  }
  if (!googleClient) {
    recordAuthenticationEvent(req, {
      username: 'Google sign-in',
      authMethod: 'google',
      result: 'failure',
      reason: 'google-not-configured',
      credentialSupplied: Boolean(credential),
    });
    return res.status(503).json({ error: 'Google sign-in is not configured' });
  }
  if (!credential) {
    const status = recordRejectedLogin(req, {
      username: 'Google sign-in',
      authMethod: 'google',
      reason: 'malformed-google-login',
      credentialSupplied: false,
    });
    if (status.isBlocked) return sendLoginDenied(req, res);
    return res.status(400).json({ error: 'Google credential required' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    const status = recordRejectedLogin(req, {
      username: 'Google sign-in',
      authMethod: 'google',
      reason: 'invalid-google-token',
      credentialSupplied: true,
    });
    if (status.isBlocked) return sendLoginDenied(req, res);
    return res.status(401).json({ error: 'Google sign-in could not be verified' });
  }

  const email = safeString(payload?.email, 254).toLowerCase();
  const subject = safeString(payload?.sub, 255);
  if (!isAllowedGoogleIdentity(payload, GOOGLE_ALLOWED_DOMAIN)) {
    recordRejectedLogin(req, {
      username: 'Google sign-in',
      email,
      authMethod: 'google',
      reason: 'external-google-domain',
      credentialSupplied: true,
      result: showRealLogin(req) ? 'failure' : 'decoy',
    });
    return sendLoginDenied(req, res, {
      error: 'Sign in with an approved corporate Google account.',
      code: 'GOOGLE_IDENTITY_NOT_ALLOWED',
    });
  }

  const db = getDb();
  const provisioned = provisionGoogleUser(db, { email, subject });
  if (provisioned.conflict) {
    getLoginSecurityStore().recordSuccess(requestIp(req));
    recordAuthenticationEvent(req, {
      username: email,
      email,
      authMethod: 'google',
      result: 'review-required',
      reason: 'google-identity-conflict',
      credentialSupplied: true,
    });
    return res.status(403).json({
      code: 'ACCOUNT_REVIEW_REQUIRED',
      error: 'This Google account requires administrator review.',
    });
  }

  const user = provisioned.user;
  if (user.is_approved !== 1) {
    getLoginSecurityStore().recordSuccess(requestIp(req));
    recordAuthenticationEvent(req, {
      userId: user.id,
      username: user.username,
      email: user.email || '',
      authMethod: 'google',
      result: 'pending',
      reason: provisioned.created ? 'new-account-awaiting-approval' : 'account-awaiting-approval',
      credentialSupplied: true,
    });
    return res.status(403).json({
      code: 'ACCOUNT_PENDING',
      pending: true,
      error: 'Your corporate account is verified and awaiting access approval.',
    });
  }

  issueSession(user, req, res, 'google', remember);
});

// DWS Hub SSO. These are top-level browser navigations, so every outcome is a
// redirect: to the Hub, to the requested ERP page, or back to /login?sso_error=…
function redirectToLoginWithError(res, code) {
  return res.redirect(302, `/login?sso_error=${encodeURIComponent(code)}`);
}

function redirectBlockedSso(req, res) {
  clearSessionCookie(res);
  clearTransaction(res);
  if (showRealLogin(req)) return redirectToLoginWithError(res, 'access_denied');
  return res.redirect(302, DECOY_PATH);
}

function recordHubEvent(req, fields) {
  recordAuthenticationEvent(req, {
    username: fields.email || 'DWS Hub sign-in',
    authMethod: 'dws-hub',
    credentialSupplied: true,
    ...fields,
  });
}

router.get('/sso/login', async (req, res) => {
  const hubSso = getHubSsoClient();
  if (!hubSso.config.enabled) return redirectToLoginWithError(res, 'sso_disabled');
  if (getLoginSecurityStore().status(requestIp(req)).isBlocked) {
    recordHubEvent(req, { result: 'blocked', reason: 'ip-blocked', credentialSupplied: false });
    return redirectBlockedSso(req, res);
  }
  try {
    await hubSso.getDiscovery();
    const transaction = startTransaction(res, req.query?.next);
    return res.redirect(302, await hubSso.authorizationUrl(transaction));
  } catch (error) {
    console.error('DWS Hub sign-in could not start:', error.message);
    recordHubEvent(req, { result: 'failure', reason: 'hub-unavailable', credentialSupplied: false });
    clearTransaction(res);
    return redirectToLoginWithError(res, 'hub_unavailable');
  }
});

router.get('/sso/callback', async (req, res) => {
  const hubSso = getHubSsoClient();
  if (!hubSso.config.enabled) return redirectToLoginWithError(res, 'sso_disabled');
  if (getLoginSecurityStore().status(requestIp(req)).isBlocked) {
    recordHubEvent(req, { result: 'blocked', reason: 'ip-blocked' });
    return redirectBlockedSso(req, res);
  }

  const code = safeString(req.query?.code, 2048);
  const state = safeString(req.query?.state, 256);
  const hubErrorCode = safeString(req.query?.error, 60);
  const transaction = readTransaction(req, state);
  clearTransaction(res);

  if (hubErrorCode) {
    recordHubEvent(req, { result: 'failure', reason: `hub-error:${hubErrorCode}`, credentialSupplied: false });
    return redirectToLoginWithError(res, 'hub_denied');
  }
  if (!transaction && code && launchRestartAllowed(req)) {
    // Opened from the Hub tile: the Hub ran its own authorize, so the code's PKCE
    // verifier is not ours and the code is never redeemed. Start a normal sign-in
    // instead; with the user's Hub session it completes without a prompt.
    markLaunchRestart(res);
    recordHubEvent(req, { result: 'restarted', reason: 'hub-launch-restarted', credentialSupplied: false });
    return res.redirect(302, '/api/auth/sso/login');
  }
  if (!transaction || !code) {
    // Expired, replayed or foreign callback, or a second Hub launch right after a
    // restart: the PKCE verifier is unknown, so the code is unusable.
    recordHubEvent(req, { result: 'failure', reason: transaction ? 'missing-code' : 'state-mismatch' });
    return redirectToLoginWithError(res, 'session_expired');
  }

  let claims;
  try {
    const idToken = await hubSso.exchangeCode({ code, verifier: transaction.verifier });
    claims = await hubSso.verifyIdToken(idToken, { nonce: transaction.nonce });
  } catch (error) {
    console.error('DWS Hub sign-in failed:', error.message);
    const unreachable = ['HUB_UNREACHABLE', 'HUB_DISCOVERY_FAILED'].includes(error.code);
    recordHubEvent(req, {
      result: 'failure',
      reason: unreachable ? 'hub-unavailable' : String(error.code || 'hub-token-error').toLowerCase(),
    });
    return redirectToLoginWithError(res, unreachable ? 'hub_unavailable' : 'token_invalid');
  }

  const subject = safeString(claims.sub, 255);
  const email = safeString(claims.email, 254).toLowerCase();
  if (!isAllowedHubEmail(email, hubSso.config.allowedEmailDomains)) {
    recordHubEvent(req, { email, result: 'failure', reason: 'hub-email-domain-not-allowed' });
    return redirectToLoginWithError(res, 'identity_not_allowed');
  }

  let provisioned;
  try {
    provisioned = provisionHubUser(getDb(), { subject, email });
  } catch (error) {
    console.error('DWS Hub account provisioning failed:', error.message);
    recordHubEvent(req, { email, result: 'failure', reason: 'hub-provisioning-error' });
    return redirectToLoginWithError(res, 'hub_unavailable');
  }
  if (provisioned.conflict) {
    recordHubEvent(req, { email, result: 'review-required', reason: 'hub-identity-conflict' });
    return redirectToLoginWithError(res, 'review_required');
  }

  const user = provisioned.user;
  getLoginSecurityStore().recordSuccess(requestIp(req));
  if (user.is_approved !== 1) {
    recordHubEvent(req, {
      userId: user.id,
      email: user.email || email,
      result: 'pending',
      reason: provisioned.created ? 'new-account-awaiting-approval' : 'account-awaiting-approval',
    });
    return redirectToLoginWithError(res, 'pending');
  }

  const session = startSession(user, req, res, 'dws-hub', HUB_SESSION_REMEMBER);
  res.redirect(302, transaction.next);
  recordLoginSuccess(session.tokenUser, req);
  preloadDashboards('login');
});

router.get('/me', requireAuth, (req, res) => {
  if (req.sessionTransport === 'cookie') {
    recordSessionCookieEvent(req, {
      user: req.user,
      token: req.sessionToken,
      eventType: 'validated',
      expiresAt: req.sessionClaims?.exp ? new Date(req.sessionClaims.exp * 1000).toISOString() : '',
      authMethod: 'session-restore',
      transport: 'cookie',
    });
  }
  res.json({
    user: publicUser({ ...req.user, is_admin: req.user.is_admin ? 1 : 0 }),
    csrfToken: req.sessionClaims?.csrf || '',
  });
});

router.post('/logout', requireAuth, (req, res) => {
  if (req.sessionTransport === 'cookie') {
    recordSessionCookieEvent(req, {
      user: req.user,
      token: req.sessionToken,
      eventType: 'cleared',
      expiresAt: req.sessionClaims?.exp ? new Date(req.sessionClaims.exp * 1000).toISOString() : '',
      authMethod: 'logout',
      transport: 'cookie',
    });
  }
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/security/blocked-ips', requireAuth, requireMatthew, (req, res) => {
  res.json(getLoginSecurityStore().listBlocked());
});

router.get('/security/ip-rules', requireAuth, requireMatthew, (req, res) => {
  const security = getLoginSecurityStore();
  res.json({
    current_ip: requestIp(req),
    blocked: security.listBlocked(),
    allowlisted: security.listAllowlisted(),
  });
});

router.post('/security/allowlist', requireAuth, requireMatthew, (req, res) => {
  const ipAddress = normalizeIp(safeString(req.body?.ip_address, 80));
  const label = safeString(req.body?.label, 120);
  if (!isIP(ipAddress)) return res.status(400).json({ error: 'A valid IPv4 or IPv6 address is required' });
  const entry = getLoginSecurityStore().allowlist(ipAddress, label, req.user.username);
  res.json({ message: 'IP address whitelisted', entry });
});

router.post('/security/allowlist/remove', requireAuth, requireMatthew, (req, res) => {
  const ipAddress = normalizeIp(safeString(req.body?.ip_address, 80));
  if (!isIP(ipAddress)) return res.status(400).json({ error: 'A valid IPv4 or IPv6 address is required' });
  const removed = getLoginSecurityStore().removeAllowlist(ipAddress);
  if (!removed) return res.status(404).json({ error: 'Whitelisted IP address not found' });
  res.json({ message: 'IP address removed from whitelist' });
});

router.post('/security/unlock', requireAuth, requireMatthew, (req, res) => {
  const ipAddress = safeString(req.body?.ip_address, 80);
  if (!ipAddress) return res.status(400).json({ error: 'IP address required' });
  const unlocked = getLoginSecurityStore().unlock(ipAddress, req.user.username);
  if (!unlocked) return res.status(404).json({ error: 'Blocked IP not found' });
  res.json({ message: 'IP address unlocked' });
});

router.post('/activity-report', requireAuth, requireMatthew, async (req, res) => {
  if (manualActivityReportInFlight) {
    return res.status(409).json({ error: 'An activity report is already being sent' });
  }

  manualActivityReportInFlight = true;
  try {
    const now = new Date();
    let window = currentShiftWindow(now);
    if (window.endAt.getTime() - window.startAt.getTime() < 60 * 1000) {
      window = latestScheduledWindow(now);
    }
    const result = await sendShiftReport({ ...window, scheduled: false });
    res.json({ message: 'Activity report emailed', result });
  } catch (error) {
    console.error('Manual activity report failed:', error.message);
    res.status(502).json({ error: 'Failed to email the activity report' });
  } finally {
    manualActivityReportInFlight = false;
  }
});

module.exports = router;
module.exports.DECOY_PATH = DECOY_PATH;
