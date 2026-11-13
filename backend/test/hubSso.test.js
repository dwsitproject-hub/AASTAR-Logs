'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLIENT_ID = 'astar-erp-test';

async function startMockHub(t) {
  const express = require('express');
  const { SignJWT, exportJWK, generateKeyPair } = await import('jose');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const { privateKey: strangerKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'hub-key-1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const hub = express();
  hub.use(express.json());
  let issuer = '';
  let tokenOverride = null;

  hub.get('/api/sso/.well-known/openid-configuration', (_req, res) => res.json({
    issuer,
    authorization_endpoint: `${issuer}/api/sso/authorize`,
    token_endpoint: `${issuer}/api/sso/token`,
    jwks_uri: `${issuer}/api/sso/jwks`,
  }));
  hub.get('/api/sso/jwks', (_req, res) => res.json({ keys: [jwk] }));
  hub.post('/api/sso/token', async (req, res) => {
    const grant = codes.get(req.body?.code);
    codes.delete(req.body?.code);
    const challenge = crypto.createHash('sha256').update(String(req.body?.code_verifier || '')).digest('base64url');
    if (!grant
      || req.body.grant_type !== 'authorization_code'
      || req.body.client_id !== grant.clientId
      || req.body.redirect_uri !== grant.redirectUri
      || challenge !== grant.challenge) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    const claims = { user_id: grant.sub, email: grant.email, name: 'Test User', nonce: grant.nonce, ...tokenOverride?.claims };
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'hub-key-1' })
      .setIssuer(tokenOverride?.issuer || issuer)
      .setAudience(tokenOverride?.audience || CLIENT_ID)
      .setSubject(grant.sub)
      .setIssuedAt()
      .setExpirationTime(tokenOverride?.expiresAt || '60s')
      .sign(tokenOverride?.sign === 'stranger' ? strangerKey : privateKey);
    return res.json({ token_type: 'Bearer', expires_in: 60, id_token: idToken, scope: 'openid profile email' });
  });

  const server = hub.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));

  return {
    issuer,
    // Stands in for the Hub's /authorize screen: the user is signed in and a code is issued.
    authorize(authorizationUrl, identity) {
      const url = new URL(authorizationUrl);
      assert.equal(`${url.origin}${url.pathname}`, `${issuer}/api/sso/authorize`);
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, {
        clientId: url.searchParams.get('client_id'),
        redirectUri: url.searchParams.get('redirect_uri'),
        challenge: url.searchParams.get('code_challenge'),
        nonce: url.searchParams.get('nonce'),
        ...identity,
      });
      return { code, state: url.searchParams.get('state'), redirectUri: url.searchParams.get('redirect_uri') };
    },
    setTokenOverride(value) { tokenOverride = value; },
  };
}

function cookiePair(setCookieHeaders, name) {
  const header = setCookieHeaders.find(value => value.startsWith(`${name}=`));
  return header ? header.split(';')[0] : '';
}

test('DWS Hub OIDC sign-in: PKCE, JWKS verification, approval gate and identity linking', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-hub-sso-'));
  process.env.DB_PATH = path.join(directory, 'erp.db');
  process.env.USER_ACTIVITY_DB_PATH = path.join(directory, 'activity.db');
  process.env.LOGIN_SECURITY_DB_PATH = path.join(directory, 'login-security.db');

  const hub = await startMockHub(t);
  process.env.DWS_HUB_URL = hub.issuer;
  process.env.DWS_HUB_CLIENT_ID = CLIENT_ID;
  process.env.DWS_HUB_REDIRECT_URI = 'https://erp.example.test/api/auth/sso/callback';
  process.env.DWS_HUB_ALLOWED_EMAIL_DOMAINS = 'kpn-corp.com,energi-up.com';

  const express = require('express');
  const { initDb, getDb } = require('../db/database');
  const authRoutes = require('../routes/auth');
  const { SESSION_COOKIE_NAME } = require('../services/sessionCookie');
  const { LAUNCH_RESTART_COOKIE_NAME, TRANSACTION_COOKIE_NAME, safeNextPath } = require('../services/hubSso');
  const { stopUserActivity } = require('../services/userActivity');
  const { getLoginSecurityStore } = require('../services/loginSecurity');

  initDb();
  const db = getDb();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    stopUserActivity();
    getLoginSecurityStore().close?.();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const get = (pathname, cookieHeader = '') => fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });

  async function signIn(identity, { next = '/logistics/vessel-status', tamperState = false } = {}) {
    const start = await get(`/api/auth/sso/login?next=${encodeURIComponent(next)}`);
    assert.equal(start.status, 302);
    const transactionCookie = cookiePair(start.headers.getSetCookie(), TRANSACTION_COOKIE_NAME);
    assert.ok(transactionCookie, 'transaction cookie is set');
    assert.match(start.headers.getSetCookie().join('\n'), /HttpOnly.*SameSite=Lax|SameSite=Lax.*HttpOnly/i);
    const { code, state } = hub.authorize(start.headers.get('location'), identity);
    const returnedState = tamperState ? `${state}x` : state;
    const callback = await get(
      `/api/auth/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(returnedState)}`,
      transactionCookie,
    );
    return { callback, code, state, transactionCookie };
  }

  await t.test('discovery advertises the Hub button', async () => {
    const response = await get('/api/auth/access-status');
    assert.equal((await response.json()).hubSso.enabled, true);
  });

  await t.test('authorization request carries PKCE S256, state, nonce and the registered redirect URI', async () => {
    const start = await get('/api/auth/sso/login');
    const url = new URL(start.headers.get('location'));
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), process.env.DWS_HUB_REDIRECT_URI);
    assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(url.searchParams.get('state').length >= 32);
    assert.ok(url.searchParams.get('nonce').length >= 32);
    assert.equal(url.searchParams.get('scope'), 'openid profile email');
  });

  const newcomer = { sub: '7d9c1f1e-0000-4000-8000-000000000001', email: 'new.person@energi-up.com' };

  await t.test('first sign-in creates a pending account and does not issue a session', async () => {
    const { callback } = await signIn(newcomer);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/login?sso_error=pending');
    assert.equal(cookiePair(callback.headers.getSetCookie(), SESSION_COOKIE_NAME), '');
    const row = db.prepare('SELECT username, email, hub_sub, is_approved FROM users WHERE hub_sub = ?').get(newcomer.sub);
    assert.deepEqual({ ...row }, { username: newcomer.email, email: newcomer.email, hub_sub: newcomer.sub, is_approved: 0 });
  });

  await t.test('approved account gets a session cookie and lands on the requested page', async () => {
    db.prepare(`UPDATE users SET is_approved = 1, tab_permissions = '["/logistics/vessel-status"]' WHERE hub_sub = ?`).run(newcomer.sub);
    const { callback } = await signIn(newcomer);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/logistics/vessel-status');
    const sessionCookie = cookiePair(callback.headers.getSetCookie(), SESSION_COOKIE_NAME);
    assert.ok(sessionCookie);
    const me = await get('/api/auth/me', sessionCookie);
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.user.hub_sub, newcomer.sub);
    assert.equal(body.user.email, newcomer.email);
    assert.ok(body.csrfToken);
  });

  await t.test('an existing ERP account is linked by email on its first Hub sign-in', async () => {
    db.prepare(`
      INSERT INTO users (username, email, google_sub, is_admin, is_approved, permissions, tab_permissions, auth_version)
      VALUES ('Existing', 'existing.user@kpn-corp.com', 'google-123', 0, 1, '[]', '["/commercial/open-shipments"]', 1)
    `).run();
    const identity = { sub: '7d9c1f1e-0000-4000-8000-000000000002', email: 'Existing.User@kpn-corp.com' };
    const { callback } = await signIn(identity);
    assert.equal(callback.headers.get('location'), '/logistics/vessel-status');
    const row = db.prepare("SELECT hub_sub, google_sub FROM users WHERE username = 'Existing'").get();
    assert.equal(row.hub_sub, identity.sub);
    assert.equal(row.google_sub, 'google-123');
  });

  await t.test('a different Hub subject for an already linked email requires review', async () => {
    const { callback } = await signIn({ sub: '7d9c1f1e-0000-4000-8000-0000000000ff', email: newcomer.email });
    assert.equal(callback.headers.get('location'), '/login?sso_error=review_required');
  });

  await t.test('email domains outside the allow-list are refused before provisioning', async () => {
    const { callback } = await signIn({ sub: '7d9c1f1e-0000-4000-8000-000000000003', email: 'someone@gmail.com' });
    assert.equal(callback.headers.get('location'), '/login?sso_error=identity_not_allowed');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'someone@gmail.com'").get().n, 0);
  });

  await t.test('a tampered state is rejected without redeeming the code', async () => {
    const { callback } = await signIn(newcomer, { tamperState: true });
    assert.equal(callback.headers.get('location'), '/login?sso_error=session_expired');
    assert.equal(cookiePair(callback.headers.getSetCookie(), SESSION_COOKIE_NAME), '');
  });

  await t.test('a Hub tile launch restarts a normal sign-in once and never redeems the foreign code', async () => {
    const start = await get('/api/auth/sso/login');
    const transactionCookie = cookiePair(start.headers.getSetCookie(), TRANSACTION_COOKIE_NAME);
    const { code, state } = hub.authorize(start.headers.get('location'), newcomer);

    const launch = await get(`/api/auth/sso/callback?code=${code}&state=${state}&code_verifier=from-the-hub`);
    assert.equal(launch.headers.get('location'), '/api/auth/sso/login');
    const launchCookie = cookiePair(launch.headers.getSetCookie(), LAUNCH_RESTART_COOKIE_NAME);
    assert.ok(launchCookie, 'the restart is remembered for a short time');
    assert.equal(cookiePair(launch.headers.getSetCookie(), SESSION_COOKIE_NAME), '');

    const second = await get(`/api/auth/sso/callback?code=${code}&state=${state}`, launchCookie);
    assert.equal(second.headers.get('location'), '/login?sso_error=session_expired', 'no restart loop');

    // The code was never sent to the Hub: it is still redeemable by the sign-in that started it.
    const own = await get(`/api/auth/sso/callback?code=${code}&state=${state}`, transactionCookie);
    assert.notEqual(own.headers.get('location'), '/login?sso_error=token_invalid');
  });

  await t.test('a reused authorization code is refused by the Hub', async () => {
    const { code, state, transactionCookie } = await signIn(newcomer);
    const replay = await get(`/api/auth/sso/callback?code=${code}&state=${state}`, transactionCookie);
    assert.equal(replay.headers.get('location'), '/login?sso_error=token_invalid');
  });

  await t.test('ID tokens with the wrong audience, issuer, signature or expiry are rejected', async () => {
    for (const override of [
      { audience: 'another-app' },
      { issuer: 'https://evil.example' },
      { sign: 'stranger' },
      { expiresAt: Math.floor(Date.now() / 1000) - 120 },
      { claims: { nonce: 'not-the-nonce' } },
    ]) {
      hub.setTokenOverride(override);
      const { callback } = await signIn(newcomer);
      assert.equal(callback.headers.get('location'), '/login?sso_error=token_invalid', JSON.stringify(override));
      assert.equal(cookiePair(callback.headers.getSetCookie(), SESSION_COOKIE_NAME), '');
    }
    hub.setTokenOverride(null);
  });

  await t.test('a Hub error response is shown as a denied sign-in', async () => {
    const callback = await get('/api/auth/sso/callback?error=access_denied&state=x');
    assert.equal(callback.headers.get('location'), '/login?sso_error=hub_denied');
  });

  await t.test('post-login destinations are restricted to ERP pages', () => {
    assert.equal(safeNextPath('/logistics/demurrage?x=1'), '/logistics/demurrage?x=1');
    for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example', '/api/users', '/login', '', null, 'dashboard']) {
      assert.equal(safeNextPath(unsafe), '/dashboard', String(unsafe));
    }
  });
});

test('DWS Hub sign-in reports an unreachable Hub without crashing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-hub-sso-down-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { createHubSsoClient } = require('../services/hubSso');
  const client = createHubSsoClient({
    enabled: true,
    hubUrl: 'http://127.0.0.1:9',
    clientId: CLIENT_ID,
    redirectUri: 'https://erp.example.test/api/auth/sso/callback',
    scope: 'openid',
    allowedEmailDomains: [],
  });
  await assert.rejects(client.getDiscovery(), error => error.code === 'HUB_UNREACHABLE');
});
