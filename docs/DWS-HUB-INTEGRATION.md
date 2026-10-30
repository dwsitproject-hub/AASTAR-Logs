# Astar ERP: DWS Hub SSO, Hub SDK and Sentinel Runbook

This runbook connects Astar ERP to Downstream Hub (DWS Hub) for three things:

1. **Single sign-on** under the Hub's strict OIDC contract: authorization code + PKCE S256, with the ID token verified through the JWKS.
2. **The Hub SDK**: page views, time in app, JavaScript errors, the bug-report button and breadcrumbs.
3. **Sentinel**: AI root-cause analysis of bug reports and errors, using that SDK data plus the ERP source code.

Staging and production Hubs are separate systems. Do every step once per environment, with that environment's keys.

---

## 1. How sign-in works

```
Browser                    Astar ERP backend                       DWS Hub
  │  "Sign in with DWS Hub"       │                                    │
  ├──GET /api/auth/sso/login?next=/logistics/… ─►│                     │
  │                               │ new state, nonce, PKCE verifier    │
  │                               │ sealed in an HttpOnly cookie       │
  │                               │ (__Host-erp_sso, 10 min, Lax)      │
  │◄── 302 /api/sso/authorize?response_type=code&code_challenge=…(S256)│
  ├────────────────────────────────────────────────────────────────────►│ user signs in to the Hub
  │◄── 302 /api/auth/sso/callback?code=…&state=… ──────────────────────┤
  ├──────────────────────────────►│ state must match the cookie         │
  │                               ├── POST /api/sso/token {code, code_verifier, …} ─►│
  │                               │◄── { id_token } ───────────────────┤
  │                               │ verify the ID token with the JWKS:  │
  │                               │ signature, iss, aud, exp, sub, nonce│
  │                               │ map sub → ERP user (users.hub_sub)  │
  │                               │ approved? → ERP session cookie      │
  │◄── 302 /logistics/… (or /login?sso_error=pending) ─┤                │
```

- **Identity.** `sub` is the canonical key, stored in `users.hub_sub`. On a user's first Hub sign-in, an existing ERP account with the same email (case-insensitive) is linked once. After that, only `sub` is used. A *different* `sub` arriving for an already-linked email is refused as `review_required`.
- **Authorization stays in the ERP.** A new Hub user is created **pending**, with no pages. An ERP administrator approves them and assigns pages in **Admin → User Management**, exactly as before. The Hub proves who the user is; it does not grant ERP access.
- **Sessions.** The Hub ID token lives 60 s and is used once. After that, the ERP issues its own session cookie: 8 h by default, or 30 days with `DWS_HUB_SESSION_REMEMBER=1`. Signing out of the ERP does not sign the user out of the Hub, so clicking the button again signs straight back in.
- **Google sign-in** still works while `GOOGLE_CLIENT_ID` is set. Remove it to make the Hub the only way in. The desktop (Electron) client cannot complete a browser redirect, so it keeps Google sign-in for now.

## 2. Register the application in the Hub

In **Hub Admin → Applications → (Astar ERP)**:

| Field | Value |
|---|---|
| `sso_mode` | `oidc` |
| `oauth_client_id` | e.g. `astar-erp` (unique) |
| `oidc_redirect_uris` | `https://<erp-host>/api/auth/sso/callback`, plus `http://localhost:5173/api/auth/sso/callback` on the staging Hub only, for development |
| Target URL (Hub tile) | `https://<erp-host>/api/auth/sso/login`. This makes a launch from the Hub start the ERP's own PKCE flow, so the user arrives signed in. If the tile points at `/` instead, the user lands on the login page and clicks once. |

## 3. Backend configuration (`backend/.env`)

```bash
DWS_HUB_URL=https://dwshub.kpndomain.com          # discovery: <url>/api/sso/.well-known/openid-configuration
DWS_HUB_CLIENT_ID=astar-erp
DWS_HUB_REDIRECT_URI=https://<erp-host>/api/auth/sso/callback   # must match the Hub exactly
DWS_HUB_ALLOWED_EMAIL_DOMAINS=kpn-corp.com        # optional; empty = any Hub user may request access
# DWS_HUB_SESSION_REMEMBER=1                      # 30-day sessions instead of 8 h
# DWS_HUB_LOGIN_RATE_LIMIT=300                    # per IP per 15 min
# DWS_HUB_SSO_ENABLED=0                           # hide the button without deleting settings
```

The SSO is enabled when the URL, client ID and redirect URI are all set. The backend must reach the Hub over HTTPS for discovery, token and JWKS; the browser only needs to reach `/authorize`.

**Sanity checks** (expected in strict mode: `jwks` 200, discovery 200, `bridge` 410):

```bash
curl -i https://dwshub.kpndomain.com/api/sso/.well-known/openid-configuration
```

```bash
curl -i https://dwshub.kpndomain.com/api/sso/jwks
```

```bash
curl -i https://<erp-host>/api/auth/access-status
```

The last call should show `"hubSso":{"enabled":true}`.

## 4. Frontend configuration (`frontend/.env.production`)

```bash
VITE_HUB_SDK_KEY=dwsk_…                           # Hub Admin → Applications → Astar ERP → SDK
VITE_HUB_SDK_URL=https://dwshub.kpndomain.com     # must be the same environment as the key
# VITE_GIT_SHA=<commit>                           # otherwise `git rev-parse --short HEAD`, else version+date
```

`npm run build` injects the SDK `<script>` as the first element of `<head>`, before the app bundle. The tag carries `data-app-key` and `data-release`. Without a key, no tag is emitted. The tag is also never emitted in `--mode desktop`. The build keeps function names (`rolldownOptions.output.keepNames`), so stack traces stay readable for people and for Sentinel.

**What the app sends to the SDK:**

| Call | Where |
|---|---|
| `DwsHub.identify({ id: hub_sub, email })` | after every session restore or sign-in (`AuthContext.jsx`); users without a Hub link are identified by email only |
| `DwsHub.reset()` | on sign-out |
| `DwsHub.track(…)` | `vessel_update_saved`, `vessel_entry_created`, `vessel_entry_deleted`, `contract_vessel_matched`, `contract_vessel_unmatched`, `contract_unlinked`, `kpn_export_csv_downloaded`, `admin_user_access_updated`. Properties are counts or flags only; no names or contract numbers. |
| Page render errors | `PageErrorBoundary` re-dispatches them with `window.reportError`, so they reach the SDK like uncaught errors. Its "Report a bug" button opens the SDK dialog. |

## 5. Nginx and security headers

The SPA document is served by Nginx, which therefore owns the CSP. Allow the Hub for scripts and requests:

```
script-src  'self' https://dwshub.kpndomain.com https://accounts.google.com;
connect-src 'self' https://dwshub.kpndomain.com wss://<erp-host>;
```

If the ERP is served from an address other than its Target URL or redirect URIs, add it under the Hub's **SDK → Allowed origins**.

## 6. Sentinel (Hub side, once per environment)

In **Admin → Analytic → Astar ERP → Sentinel settings**:

| Field | Value |
|---|---|
| GitHub repository | the repository that holds this code. The code is not yet in git, so this step must wait (see CODE-REVIEW §3.4). Without it, Sentinel analyses runtime evidence only. |
| Branch | `main` (used when no `data-release` is reported) |
| Application folder | `frontend/` for browser errors; Sentinel can also read `backend/` for API-side causes |
| Notes for Sentinel | the text below |
| Analyse automatically | ✓ |

**Suggested notes for Sentinel:**

> React 18 + Vite SPA (`frontend/src`), Express 4 API at `/api` (`backend/`). Google Sheets are the system of record. They are mirrored every 15 s into SQLite files `DB1–DB17` (`backend/config/dataSources.js`, `services/bulkDataSync.js`); pages read the mirrors. Writes (Vessel Update, Vessel Matching, Contract Unlink) go to Sheets through one serialized queue (`services/sheetMutations.js`). 409 responses are expected optimistic-concurrency conflicts ("row shifted", `SHEET_BUSY`), not bugs. 503 "temporarily unavailable" means a mirror DB is missing or a sync failed. Access control is per tab (`navConfig.js`, `middleware/auth.js`). Sign-in is DWS Hub OIDC (`services/hubSso.js`).

**Data protection.** The SDK collects page paths without query strings, errors, breadcrumbs (method, path and status only) and the identified user's Hub id and email. It never collects form contents. Sentinel pseudonymises emails before calling the Claude API. Confirm the Anthropic commercial terms with procurement and legal before production use.

## 7. Error messages users may see after a Hub sign-in

| `sso_error` | Cause | Fix |
|---|---|---|
| `pending` | Hub identity verified; ERP access not yet approved | An administrator approves the user and assigns pages |
| `review_required` | The email is already linked to a different Hub `sub` | An administrator checks the account (it may be a re-created Hub user) |
| `identity_not_allowed` | Email domain is not in `DWS_HUB_ALLOWED_EMAIL_DOMAINS` | Extend the list, or the user is not eligible |
| `session_expired` | More than 10 minutes on the Hub, sign-in started in another tab, cookie blocked, or a Hub-initiated launch to `/callback` | Click the button again; point the Hub tile at `/api/auth/sso/login` |
| `token_invalid` | Token exchange or verification failed: `invalid_grant`, wrong `client_id` or `redirect_uri`, reused code, `iss`/`aud`/signature mismatch | Check that `DWS_HUB_CLIENT_ID` and `DWS_HUB_REDIRECT_URI` match the Hub exactly; read the backend log line "DWS Hub sign-in failed" |
| `hub_unavailable` | Discovery, token or JWKS endpoint unreachable from the backend | Check outbound HTTPS from the ERP server to the Hub |
| `rate_limited` | More than `DWS_HUB_LOGIN_RATE_LIMIT` sign-in requests from one IP in 15 min | Raise the limit for large NATed offices |

Every outcome is written to `authentication_events` with `auth_method = 'dws-hub'`.

## 8. Verification

- **Automated:** `cd backend && npm test`. `test/hubSso.test.js` runs the full flow against a mock Hub with real RS256 keys and covers:
  - PKCE S256, state and nonce;
  - pending account, then approval, then session;
  - linking by email, `sub` conflict and domain allow-list;
  - tampered state, missing cookie and code reuse;
  - wrong audience, issuer, signature, expiry and nonce;
  - Hub error response and an unreachable Hub.
- **Manual (staging):**
  1. Sign in with a new Hub user and confirm the "awaiting approval" message.
  2. Approve the user in Admin and sign in again; you should land on the requested page.
  3. Check that **Admin → Analytic → Astar ERP** in the Hub shows the user, pages and tracked actions within a minute.
  4. Trigger a bug report and confirm Sentinel analyses it.
