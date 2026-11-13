process.umask(0o077);
require('dotenv').config();
const express = require('express');
const http = require('node:http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { getDb, initDb } = require('./db/database');
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const sheetsRoutes = require('./routes/sheets');
const dataRoutes = require('./routes/data');
const spreadsheetSourcesRoutes = require('./routes/spreadsheetSources');
const rolesRoutes = require('./routes/roles');
const { initSpreadsheetSources } = require('./services/spreadsheetSources');
const vesselSlotsRoutes = require('./routes/vesselSlots');
const appsScriptTestRoutes = require('./routes/appsScriptTest');
const { bulkSyncStatus, startBulkDataSync, stopBulkDataSync } = require('./services/bulkDataSync');
const { preloadDashboards } = require('./services/dashboardPreload');
const { attachRealtime, closeRealtime } = require('./services/realtime');
const { sheetMutationStats } = require('./services/sheetMutations');
const { credentialAuditMetadata, recordAuthenticationEvent, startUserActivity, stopUserActivity } = require('./services/userActivity');
const { getLoginSecurityStore, securityStatusForRequest } = require('./services/loginSecurity');
const { showRealLogin, sendLoginDenied } = require('./services/loginPresentation');
const { clearSessionCookie } = require('./services/sessionCookie');
const appsScriptSheetSync = require('./services/appsScriptSheetSync');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
// Loopback by default (single host behind a local Nginx). On the 3-server
// platform set HOST to the backend's private IP so the frontend server can proxy to it.
const HOST = String(process.env.HOST || '127.0.0.1').trim();
// Number of reverse proxies in front of Express whose X-Forwarded-For is trusted:
// 1 = Nginx only (default); 2 = SLB + Nginx when Nginx does not rewrite the client IP.
const TRUST_PROXY_HOPS = Math.max(0, Math.min(5, Number.parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 0));

app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY_HOPS);

// The SPA's own document headers (CSP, HSTS) are set by Nginx; these cover the API responses.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: false,
  hsts: false,
  frameguard: { action: 'sameorigin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(compression()); // gzip/brotli JSON responses — big bandwidth win on the sheet payloads
const allowedOrigins = new Set([
  process.env.FRONTEND_URL || 'http://localhost:5173',
  ...(process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  ...(process.env.DESKTOP_CLIENT_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean)
]);

app.use(cors({
  origin: (requestOrigin, callback) => {
    // Same-origin requests do not include an Origin header.
    if (!requestOrigin || allowedOrigins.has(requestOrigin)) {
      return callback(null, true);
    }
    const error = new Error('Origin not allowed');
    error.code = 'CORS_ORIGIN_DENIED';
    error.status = 403;
    return callback(error);
  },
  credentials: true
}));
app.use(express.json({ limit: '100kb', strict: true }));

const blockedIpExemptions = new Set([
  '/api/health',
  '/api/auth/access-status',
  '/api/auth/login',
  '/api/auth/google',
  '/api/auth/sso/login',
  '/api/auth/sso/callback',
  '/api/auth/page-visit',
]);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || blockedIpExemptions.has(req.path) || req.path.startsWith('/api/test/apps-script-sheet')) {
    return next();
  }
  if (securityStatusForRequest(req).isBlocked) {
    // Only the document gate may pass; blocked IPs still cannot use ERP APIs.
    if (req.path === '/api/auth/gate' && showRealLogin(req)) return next();
    clearSessionCookie(res);
    return sendLoginDenied(req, res, { decoyStatus: 403 });
  }
  next();
});

const loginRateLimitHandler = authMethod => (req, res) => {
  const isGoogle = authMethod === 'google';
  const credentialAudit = isGoogle
    ? {}
    : credentialAuditMetadata(typeof req.body?.password === 'string' ? req.body.password.slice(0, 256) : '');
  recordAuthenticationEvent(req, {
    username: isGoogle ? 'Google sign-in' : (typeof req.body?.username === 'string' ? req.body.username.slice(0, 120) : ''),
    authMethod,
    result: 'rate-limited',
    reason: 'too-many-login-requests',
    credentialSupplied: isGoogle ? Boolean(req.body?.credential) : Boolean(req.body?.password),
    ...credentialAudit,
  });
  clearSessionCookie(res);
  return sendLoginDenied(req, res, {
    status: 429,
    code: 'LOGIN_RATE_LIMITED',
    error: 'Too many sign-in attempts. Please try again later.',
  });
};

const passwordLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PASSWORD_LOGIN_RATE_LIMIT || 30),
  skip: req => securityStatusForRequest(req).isAllowlisted,
  standardHeaders: true,
  legacyHeaders: false,
  handler: loginRateLimitHandler('password'),
});
app.use('/api/auth/login', passwordLoginLimiter);

const googleLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.GOOGLE_LOGIN_RATE_LIMIT || 200),
  skip: req => securityStatusForRequest(req).isAllowlisted,
  standardHeaders: true,
  legacyHeaders: false,
  handler: loginRateLimitHandler('google'),
});
app.use('/api/auth/google', googleLoginLimiter);

// SSO endpoints are browser navigations, so the limit answers with a redirect.
const hubSsoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.DWS_HUB_LOGIN_RATE_LIMIT || 300),
  skip: req => securityStatusForRequest(req).isAllowlisted,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    recordAuthenticationEvent(req, {
      username: 'DWS Hub sign-in',
      authMethod: 'dws-hub',
      result: 'rate-limited',
      reason: 'too-many-login-requests',
      credentialSupplied: Boolean(req.query?.code),
    });
    res.redirect(302, '/login?sso_error=rate_limited');
  },
});
app.use('/api/auth/sso', hubSsoLimiter);

const pageVisitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many page-visit events' },
});
app.use('/api/auth/page-visit', pageVisitLimiter);

const serviceHookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 900,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many service-hook requests' },
});
app.use('/api/test/apps-script-sheet/events', serviceHookLimiter);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15000,
  message: { error: 'Too many requests. Please wait a moment and try again.' }
});
app.use(limiter);

app.use('/api/auth', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/sheets', sheetsRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/spreadsheet-sources', spreadsheetSourcesRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/vessel-slots', vesselSlotsRoutes);
app.use('/api/test/apps-script-sheet', appsScriptTestRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Readiness for the load balancer / monitoring: the user DB answers and the
// Google Sheets mirror is not stale. No data or configuration details are exposed.
const READY_MAX_SYNC_AGE_MS = Number(process.env.READY_MAX_SYNC_AGE_MS || 5 * 60 * 1000);
app.get('/api/ready', (req, res) => {
  res.set('Cache-Control', 'no-store');
  let database = true;
  try {
    getDb().prepare('SELECT 1').get();
  } catch {
    database = false;
  }
  const sync = bulkSyncStatus();
  const syncAgeMs = sync.lastSuccessAt ? Date.now() - sync.lastSuccessAt : null;
  const sheetsFresh = syncAgeMs !== null && syncAgeMs <= READY_MAX_SYNC_AGE_MS;
  const ready = database && sheetsFresh && !shuttingDown;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'degraded',
    database,
    sheetsSyncAgeSeconds: syncAgeMs === null ? null : Math.round(syncAgeMs / 1000),
    pendingSheetWrites: sheetMutationStats().pending,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use((error, req, res, _next) => {
  if (error?.code === 'CORS_ORIGIN_DENIED') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }
  if (error instanceof SyntaxError && Object.hasOwn(error, 'body')) {
    return res.status(400).json({ error: 'Invalid JSON request' });
  }
  console.error('Unhandled API error:', req.method, req.path, error?.stack || error?.message || error);
  return res.status(500).json({ error: 'Internal server error' });
});

initDb();
// Spreadsheet IDs and accounts come from Admin -> Sheets Config; apply them before the first sync.
initSpreadsheetSources(getDb());
getLoginSecurityStore();
startUserActivity();
attachRealtime(server, { allowedOrigins });
appsScriptSheetSync.start();
// The legacy indexed SA cache and standalone stock poller are intentionally
// disabled. Only the spreadsheets in Admin -> Sheets Config (bulkDataSync) pull data now.
startBulkDataSync();
setTimeout(() => preloadDashboards('startup'), 8000);

server.listen(PORT, HOST, () => {
  console.log(`ERP backend running on ${HOST}:${PORT}`);
});

// Keep serving when one request's promise rejects outside a handler's try/catch
// (Express 4 does not catch async errors); log it with its stack instead of
// letting Node 22 terminate the process for every connected user.
process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection:', reason?.stack || reason);
});

// Graceful stop for PM2/systemd restarts: refuse new work, close sockets, flush
// the buffered user-activity log, then exit. A hard exit follows after 10 s.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10 * 1000).unref();
  stopBulkDataSync();
  closeRealtime();
  server.close(() => {
    try { stopUserActivity(); } catch (error) { console.error('Activity flush failed:', error.message); }
    try { getDb().close(); } catch {}
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
