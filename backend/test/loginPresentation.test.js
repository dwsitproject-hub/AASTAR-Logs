'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('regional login presentation does not bypass authentication or IP security', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-login-region-'));
  process.env.LOGIN_SECURITY_DB_PATH = path.join(directory, 'security.db');
  process.env.USER_ACTIVITY_DB_PATH = path.join(directory, 'activity.db');
  process.env.GOOGLE_CLIENT_ID = 'test-client';
  const geoip = require('geoip-lite');
  const locations = {
    '203.0.113.11': { country: 'TW', region: 'TPE', city: 'Taipei' },
    '203.0.113.12': { country: 'ID', region: 'JK', city: 'Jakarta' },
    '203.0.113.13': { country: 'ID', region: 'JB', city: 'Bekasi' },
    '203.0.113.14': { country: 'SG', region: '01', city: 'Singapore' },
  };
  t.mock.method(geoip, 'lookup', ip => locations[ip] || null);
  const { OAuth2Client } = require('google-auth-library');
  t.mock.method(OAuth2Client.prototype, 'verifyIdToken', async () => ({
    getPayload: () => ({ email: 'someone@example.com', hd: 'example.com', email_verified: true, sub: 'external' }),
  }));
  const { isRealLoginLocation, showRealLogin, sendLoginDenied } = require('../services/loginPresentation');
  const { getLoginSecurityStore } = require('../services/loginSecurity');
  const { stopUserActivity } = require('../services/userActivity');
  const store = getLoginSecurityStore();
  const app = require('express')();
  app.set('trust proxy', 1);
  app.use(require('express').json());
  app.use('/api/auth', require('../routes/auth'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
    stopUserActivity();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (ip, route, body) => fetch(`http://127.0.0.1:${server.address().port}/api/auth/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  await t.test('Taiwan and all Indonesian regions, with no client-controlled geographic headers', () => {
    assert.equal(isRealLoginLocation({ country: 'TW' }), true);
    assert.equal(isRealLoginLocation({ country: 'ID', region: 'JK' }), true);
    assert.equal(isRealLoginLocation({ country: 'ID', region: 'JB', city: 'Bekasi' }), true);
    assert.equal(isRealLoginLocation({ country: 'ID' }), true);
    for (const location of [null, {}, { country: 'SG' },
      { country: 'US', region: 'JK', city: 'Jakarta' }]) {
      assert.equal(isRealLoginLocation(location), false);
    }
    assert.equal(showRealLogin({ ip: '203.0.113.14', headers: { 'cf-ipcountry': 'TW', 'x-forwarded-for': '203.0.113.11' } }), false);
    assert.equal(showRealLogin({ ip: '203.0.113.13' }), true);
    assert.equal(showRealLogin({ ip: '::ffff:203.0.113.11' }), true);
    assert.equal(showRealLogin({ ip: '203.0.113.99' }), false);
    t.mock.method(geoip, 'lookup', () => { throw new Error('lookup unavailable'); });
    assert.equal(showRealLogin({ ip: '203.0.113.11' }), false);
    geoip.lookup.mock.restore();
  });

  await t.test('external Google identities are denied without a dummy redirect in target regions', async () => {
    for (const ip of ['203.0.113.11', '203.0.113.12', '203.0.113.13']) {
      const response = await request(ip, 'google', { credential: 'synthetic-external-identity' });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'GOOGLE_IDENTITY_NOT_ALLOWED');
      assert.equal(response.headers.get('set-cookie'), null);
    }
  });

  await t.test('blocked Taiwan and Indonesian IPs see login but remain locked out of sign-in', async () => {
    for (const ip of ['203.0.113.11', '203.0.113.12', '203.0.113.13']) {
      for (let i = 0; i < 4; i++) store.recordFailure(ip, 'synthetic', 'test');
      assert.equal(store.status(ip).isBlocked, true);
      assert.equal(store.status(ip).isAllowlisted, false);
      assert.equal((await request(ip, 'gate')).status, 204);
      const access = await (await request(ip, 'access-status')).json();
      assert.equal(access.decoy, false);
      assert.equal(access.google.enabled, true);
      for (const route of ['login', 'google']) {
        const response = await request(ip, route, { credential: 'synthetic', username: 'synthetic', password: 'synthetic' });
        const body = await response.json();
        assert.equal(response.status, 403);
        assert.equal(body.code, 'LOGIN_ACCESS_DENIED');
        assert.equal(body.decoy, undefined);
        assert.equal(body.redirect, undefined);
        assert.equal(response.headers.get('set-cookie'), null);
      }
      assert.equal(store.status(ip).isBlocked, true);
    }
  });

  await t.test('other countries and unknown IPs retain dummy routing', async () => {
    for (const ip of ['203.0.113.14', '203.0.113.99']) {
      for (let i = 0; i < 4; i++) store.recordFailure(ip, 'synthetic', 'test');
      assert.equal((await request(ip, 'gate')).status, 403);
      assert.equal((await (await request(ip, 'access-status')).json()).decoy, true);
      assert.equal((await (await request(ip, 'google', { credential: 'synthetic' })).json()).decoy, true);
    }
  });

  await t.test('server gate exception is document-only and rate limiting still rejects requests', () => {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const middleware = [];
    const sandbox = {
      app: { use: handler => middleware.push(handler) },
      securityStatusForRequest: req => store.status(req.ip),
      showRealLogin, sendLoginDenied,
      clearSessionCookie: () => {},
      credentialAuditMetadata: () => ({}),
      recordAuthenticationEvent: () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(source.indexOf('const blockedIpExemptions'), source.indexOf('const passwordLoginLimiter'))
      + '\nthis.rateHandler = loginRateLimitHandler;', sandbox);
    const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
    for (const ip of ['203.0.113.11', '203.0.113.12', '203.0.113.13']) {
      let next = false;
      middleware[0]({ ip, path: '/api/auth/gate' }, response(), () => { next = true; });
      assert.equal(next, true);
      const api = response();
      middleware[0]({ ip, path: '/api/users' }, api, () => assert.fail('Blocked API must not pass'));
      assert.equal(api.statusCode, 403);
      assert.equal(api.body.code, 'LOGIN_ACCESS_DENIED');
      const limited = response();
      sandbox.rateHandler('google')({ ip, body: {} }, limited);
      assert.equal(limited.statusCode, 429);
      assert.equal(limited.body.code, 'LOGIN_RATE_LIMITED');
    }
    const outside = response();
    middleware[0]({ ip: '203.0.113.14', path: '/api/auth/gate' }, outside, () => assert.fail('Blocked outside-region gate'));
    assert.equal(outside.statusCode, 403);
    assert.equal(outside.body.decoy, true);
    const oldLimit = response();
    sandbox.rateHandler('google')({ ip: '203.0.113.14', body: {} }, oldLimit);
    assert.equal(oldLimit.statusCode, 200);
    assert.equal(oldLimit.body.decoy, true);
    assert.equal((source.match(/skip: req => securityStatusForRequest\(req\)\.isAllowlisted/g) || []).length, 3); // password, Google and DWS Hub sign-in limiters
  });
});
