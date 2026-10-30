'use strict';

const geoip = require('geoip-lite');
const { requestIp } = require('./userActivity');

function isRealLoginLocation(location) {
  if (!location) return false;
  return location.country === 'TW' || location.country === 'ID';
}

function showRealLogin(request) {
  // Use the trusted proxy-resolved IP, never caller-supplied country/city headers.
  try {
    return isRealLoginLocation(geoip.lookup(requestIp(request)));
  } catch {
    return false;
  }
}

function sendLoginDenied(request, response, {
  status = 403,
  code = 'LOGIN_ACCESS_DENIED',
  error = 'Sign-in is unavailable from this IP. Please contact your ERP administrator.',
  decoyStatus = 200,
} = {}) {
  if (showRealLogin(request)) return response.status(status).json({ error, code });
  return response.status(decoyStatus).json({ decoy: true, redirect: '/atlas/royal-continent' });
}

module.exports = { isRealLoginLocation, showRealLogin, sendLoginDenied };
