const { recordAuthenticatedRequest, recordSessionCookieEvent } = require('../services/userActivity');
const { verifySessionToken } = require('../services/sessionAuth');
const {
  clearSessionCookie,
  csrfValidForRequest,
  sessionTokenFromRequest,
} = require('../services/sessionCookie');
const MATTHEW_EMAIL = String(process.env.MATTHEW_EMAIL || 'matthew.chiu@kpn-corp.com').trim().toLowerCase();

function requireAuth(req, res, next) {
  const session = sessionTokenFromRequest(req);
  if (!session.token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const verified = verifySessionToken(session.token);
    if (!csrfValidForRequest(req, verified.claims, session.transport)) {
      return res.status(403).json({ code: 'CSRF_INVALID', error: 'Request verification failed' });
    }
    req.user = verified.user;
    req.sessionClaims = verified.claims;
    req.sessionToken = session.token;
    req.sessionTransport = session.transport;
    recordAuthenticatedRequest(req, res);
    next();
  } catch (error) {
    if (session.transport === 'cookie') {
      recordSessionCookieEvent(req, {
        token: session.token,
        eventType: 'rejected',
        authMethod: 'session-validation',
        transport: 'cookie',
      });
      clearSessionCookie(res);
    }
    if (error?.code === 'ACCOUNT_PENDING') {
      return res.status(403).json({ code: 'ACCOUNT_PENDING', error: error.message });
    }
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireMatthew(req, res, next) {
  if (String(req.user?.email || '').trim().toLowerCase() !== MATTHEW_EMAIL) {
    return res.status(403).json({ error: 'This action is only available to Matthew' });
  }
  next();
}

function hasPageAccess(user, pagePath) {
  if (!user || typeof pagePath !== 'string' || !pagePath.startsWith('/')) return false;
  if (user.is_admin) return true;
  const department = pagePath.split('/')[1];
  if ((user.permissions || []).includes(department)) return true;
  return (user.tab_permissions || []).includes(pagePath);
}

function requireAnyPage(...pagePaths) {
  return (req, res, next) => {
    if (!pagePaths.some(pagePath => hasPageAccess(req.user, pagePath))) {
      return res.status(403).json({ error: 'Page access required' });
    }
    next();
  };
}

module.exports = { hasPageAccess, requireAnyPage, requireAuth, requireAdmin, requireMatthew };
