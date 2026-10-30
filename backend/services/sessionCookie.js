'use strict';

const crypto = require('node:crypto');
const cookie = require('cookie');

const SESSION_COOKIE_NAME = '__Host-erp_session';
const SESSION_MAX_AGE_SECONDS = Math.max(300, Number(process.env.SESSION_COOKIE_MAX_AGE_SECONDS || 8 * 60 * 60));
const REMEMBER_SESSION_MAX_AGE_SECONDS = Math.max(
  SESSION_MAX_AGE_SECONDS,
  Number(process.env.REMEMBER_SESSION_MAX_AGE_SECONDS || 30 * 24 * 60 * 60),
);
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function requestCookies(request) {
  try {
    return cookie.parse(String(request?.headers?.cookie || ''));
  } catch {
    return {};
  }
}

function bearerToken(request) {
  const header = request?.headers?.authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer ([A-Za-z0-9._-]+)$/) : null;
  return match ? match[1] : '';
}

function sessionTokenFromRequest(request) {
  const cookieToken = requestCookies(request)[SESSION_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.length <= 8192) {
    return { token: cookieToken, transport: 'cookie' };
  }
  const token = bearerToken(request);
  return token ? { token, transport: 'bearer' } : { token: '', transport: 'none' };
}

function sessionCookieOptions(maxAge = SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge,
    priority: 'high',
  };
}

function setSessionCookie(response, token, maxAge = SESSION_MAX_AGE_SECONDS) {
  response.append('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, token, sessionCookieOptions(maxAge)));
}

function clearSessionCookie(response) {
  response.append('Set-Cookie', cookie.serialize(SESSION_COOKIE_NAME, '', {
    ...sessionCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  }));
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function csrfValidForRequest(request, claims, transport) {
  if (transport !== 'cookie' || !UNSAFE_METHODS.has(String(request?.method || '').toUpperCase())) return true;
  return constantTimeEqual(request?.headers?.['x-erp-csrf'], claims?.csrf);
}

function sessionFingerprint(token, key = process.env.SESSION_AUDIT_HMAC_KEY || process.env.PASSWORD_AUDIT_HMAC_KEY || '') {
  if (!token || !key) return '';
  return crypto.createHmac('sha256', key).update(String(token), 'utf8').digest('hex').slice(0, 32);
}

module.exports = {
  REMEMBER_SESSION_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  clearSessionCookie,
  csrfValidForRequest,
  requestCookies,
  sessionCookieOptions,
  sessionFingerprint,
  sessionTokenFromRequest,
  setSessionCookie,
};
