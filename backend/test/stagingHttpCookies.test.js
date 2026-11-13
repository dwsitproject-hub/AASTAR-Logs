'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { secureCookies } = require('../services/sessionCookie');

test('cookies stay Secure unless plain-HTTP staging asks otherwise, and never on HTTPS', () => {
  assert.equal(secureCookies({}), true);
  assert.equal(secureCookies({ SESSION_COOKIE_SECURE: 'true' }), true);
  assert.equal(secureCookies({ SESSION_COOKIE_SECURE: 'false', FRONTEND_URL: 'http://172.28.92.56:3150' }), false);
  assert.throws(
    () => secureCookies({ SESSION_COOKIE_SECURE: 'false', FRONTEND_URL: 'https://erp.example.com' }),
    /only allowed when FRONTEND_URL is plain http/,
  );
});

test('plain-HTTP staging drops Secure and the __Host- prefix from the session and SSO cookies', () => {
  const script = `
    const s = require(${JSON.stringify(path.join(__dirname, '../services/sessionCookie.js'))});
    const h = require(${JSON.stringify(path.join(__dirname, '../services/hubSso.js'))});
    console.log(JSON.stringify({ name: s.SESSION_COOKIE_NAME, options: s.sessionCookieOptions(), sso: h.TRANSACTION_COOKIE_NAME, launch: h.LAUNCH_RESTART_COOKIE_NAME }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, SESSION_COOKIE_SECURE: 'false', FRONTEND_URL: 'http://172.28.92.56:3150' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(output.name, 'erp_session');
  assert.equal(output.options.secure, false);
  assert.equal(output.options.sameSite, 'lax');
  assert.equal(output.options.httpOnly, true);
  assert.equal(output.sso, 'erp_sso');
  assert.equal(output.launch, 'erp_sso_launch');
});
