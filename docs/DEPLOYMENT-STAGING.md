# Staging Deployment Guide — Astar ERP

Step-by-step runbook for deploying Astar ERP to the DWS staging environment, with sign-in
through **DWS Hub (OIDC, strict mode)**, the **Hub SDK** (analytics, JS errors, bug reports) and
**Sentinel** (AI analysis of those errors against this repository).

| | |
|---|---|
| Frontend server | `172.28.92.56` — nginx container `astar-erp-frontend-staging`, host port **3150** |
| Backend server | `172.28.92.57` — Node container `astar-erp-backend-staging`, host port **4150** on the private address only |
| Database | ApsaraDB RDS for PostgreSQL `pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com:5432`, new database `astar_erp` |
| DWS Hub (staging) | `http://test-dwshub.kpndomain.com` (issuer, OIDC endpoints and SDK; served by the frontend server on port 80) |
| Users open | **http://172.28.92.56:3150/** |
| Install folder (both servers) | `/opt/astar-erp` |
| Code | GitHub `dwsitproject-hub/AASTAR-Logs`, branch **`SIT`** |
| Google Sheets | the 5 staging copies, through `aastar-logs-staging@production-plan-512202.iam.gserviceaccount.com` |

```
 Browser ──► FE 172.28.92.56:3150   nginx: pages, /api and /api/ws proxy
               │                    Hub SDK script ◄── test-dwshub.kpndomain.com
               │ http://172.28.92.57:4150   (private network, FE only)
               ▼
            BE 172.28.92.57:4150   Node API: sessions, roles, Google Sheets sync (every 15 s)
              │            │                    │                         │
              ▼            ▼                    ▼                         ▼
     Docker volume     DWS Hub             Google Sheets API        ApsaraDB RDS (astar_erp)
     astar-erp-        token + JWKS        (5 staging copies)       target schema, migrations
     staging-data      (pinned to FE)                               (app data moves here in Phase 1)

 Sign-in: Browser ─► FE /api/auth/sso/login ─► Hub authorize ─► FE /api/auth/sso/callback
          (the backend exchanges the code with PKCE and verifies the ID token against the Hub JWKS)
```

Allow about 90 minutes. Steps 1–5 prepare, steps 6–8 deploy, steps 9–10 sign in and verify.

---

## 0. Read this first

**What changes on the servers**

- One new container per server (`astar-erp-frontend-staging`, `astar-erp-backend-staging`) and one Docker
  volume on the backend server (`astar-erp-staging-data`). No existing container, port, network or volume is
  touched.
- One new database (`astar_erp`) and three roles (`astar_erp_owner`, `astar_erp_app`, `astar_erp_read`) on the
  shared RDS instance. The role names are prefixed so they cannot collide with other applications' roles.
- One app registration (SSO + SDK + Sentinel settings) in the staging DWS Hub.
- One cron entry on the backend server for the nightly backup.

**Where staging keeps its data.** The application still stores users, roles, Sheets Config, sign-in security
and the 17 Google Sheets mirrors in SQLite, inside the backend's Docker volume. The RDS database receives the
target PostgreSQL schema through the migration runner, so it is ready for **Phase 1** (moving the app's own
data to PostgreSQL, TECHNICAL-DESIGN §11). Until Phase 1 ships, the app does not read RDS: a database outage
does not affect staging, and `./deploy.sh --skip-migrate` deploys without touching it.

**Why staging uses plain-HTTP cookies.** Staging is served over HTTP (like the staging Hub). Browsers refuse
`Secure` cookies on HTTP pages, which would make sign-in impossible, so the backend runs with
`SESSION_COOKIE_SECURE=false`: the session cookie becomes `erp_session` (still `HttpOnly`, `SameSite=Lax`,
CSRF-protected). The backend refuses this setting if `FRONTEND_URL` is `https://`, so it cannot leak into an
HTTPS deployment. Remove it when staging moves to HTTPS (Appendix D).

**Ports.** 3150 (FE) and 4150 (BE) were free in the `docker ps` output of 3 Nov 2026 (Appendix A). Step 3
checks again, including services outside Docker. If a port is taken, use another free one consistently in
every place listed in Appendix A.

---

## 1. Preparation (on your PC)

### 1.1 Publish the code

The servers pull from GitHub, so everything to deploy must be on `SIT`:

```powershell
cd "D:\Claude\AASTAR Logs"
git status
git push origin SIT
```

### 1.2 Collect

- [ ] RDS console access, or the RDS **privileged account** login (to create the database and roles).
- [ ] DWS Hub **Admin** on the staging Hub (to register the app, get the SDK key and set up Sentinel).
- [ ] The Google key file `service-account-staging.json` for `aastar-logs-staging@…` (on your PC in
      `D:\Claude\AASTAR Logs\backend\service-accounts\`). Carry it to the backend server only; never commit it.
- [ ] A strong password for `astar_erp_owner` (password manager). Avoid `@ : / # ?` or URL-encode them later.
- [ ] Your **DWS Hub email** (your first Hub sign-in links to the administrator created with it).

The 5 spreadsheet copies are already shared with `aastar-logs-staging@…` as Editor.

---

## 2. What is already built into the code

| Integration | Where | What it does |
|---|---|---|
| DWS Hub SSO | `backend/services/hubSso.js`, `routes/auth.js` | `/api/auth/sso/login` → Hub authorize (code + PKCE S256, `state`, `nonce`) → `/api/auth/sso/callback`: code exchange, ID token verified with `jose` against the Hub JWKS (`iss`, `aud`, `exp`, `sub`, `nonce`). Users are keyed by `sub`; an existing ERP account is linked by email on the first Hub sign-in; new Hub users get a **pending** account an ERP admin approves. |
| Hub tile launch | `routes/auth.js` | A callback the app did not start (opened from the Hub tile) restarts a normal sign-in once; the Hub session makes it seamless. The foreign code is never redeemed. |
| Hub SDK | `frontend/vite.config.js`, `src/services/hubSdk.js` | Script tag injected at build time with `data-app-key` and `data-release` (the git commit); `DwsHub.identify({ id: sub, email })` after sign-in, `reset()` on sign-out, `track()` for key actions (vessel updates, matching, unlink, KPN export, admin changes). |
| Sentinel | build | `data-release` = commit on `SIT` (Sentinel reads exactly that code); function names kept in the bundle (`keepNames`) for readable stacks; errors in pages are reported by the error boundary. |

---

## 3. Pre-flight checks on the servers

### 3.1 Frontend server `172.28.92.56`

```bash
ss -ltnp | grep -E ':3150\b'                                   # no output = free
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E ':3150->' || echo "3150 free in Docker"
docker --version && docker compose version                     # Docker 20.10+, Compose v2
git --version
curl -s -o /dev/null -w 'npm %{http_code}\n' https://registry.npmjs.org/      # the image build runs npm ci
curl -s -o /dev/null -w 'hub-sdk %{http_code}\n' http://test-dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js
```

> `tas_staging_nginx` was restarting when the ports were chosen, so its ports were unknown. If 3150 shows as
> used, pick another free port (Appendix A).

### 3.2 Backend server `172.28.92.57`

```bash
ss -ltnp | grep -E ':4150\b'                                   # no output = free
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E ':4150->' || echo "4150 free in Docker"
docker --version && docker compose version && git --version

# Outbound access the app needs
curl -s -o /dev/null -w 'google-oauth %{http_code}\n' https://oauth2.googleapis.com/token        # 404/405 = reachable
curl -s -o /dev/null -w 'google-sheets %{http_code}\n' https://sheets.googleapis.com/v4/spreadsheets   # 401/404 = reachable
curl -s -o /dev/null -w 'npm %{http_code}\n' https://registry.npmjs.org/
# DWS Hub (the container pins the name to 172.28.92.56; the server itself may not resolve it)
curl -s --resolve test-dwshub.kpndomain.com:80:172.28.92.56 \
  http://test-dwshub.kpndomain.com/api/sso/.well-known/openid-configuration ; echo
# RDS port (after the whitelist in step 5.2)
timeout 5 bash -c '</dev/tcp/pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com/5432' && echo "RDS port open"
```

Expected: Google `404`/`405`/`401` (anything but `000`), npm `200`, and Hub JSON whose `issuer` is
`http://test-dwshub.kpndomain.com`.

---

## 4. Register the app in DWS Hub (staging)

### 4.1 Check the Hub (from the backend server)

```bash
curl -s --resolve test-dwshub.kpndomain.com:80:172.28.92.56 \
  http://test-dwshub.kpndomain.com/api/sso/.well-known/openid-configuration | python3 -m json.tool
curl -s --resolve test-dwshub.kpndomain.com:80:172.28.92.56 -o /dev/null -w 'jwks %{http_code}\n'   http://test-dwshub.kpndomain.com/api/sso/jwks     # 200
curl -s --resolve test-dwshub.kpndomain.com:80:172.28.92.56 -o /dev/null -w 'bridge %{http_code}\n' http://test-dwshub.kpndomain.com/api/sso/bridge   # 410 (strict mode)
```

### 4.2 Application and SSO

Hub Admin → **Applications** → add:

| Hub field | Value |
|---|---|
| Name | Astar ERP (Staging) |
| `sso_mode` | `oidc` |
| `oauth_client_id` | `astar-erp-staging` |
| `oidc_redirect_uris` | `http://172.28.92.56:3150/api/auth/sso/callback` (exact, no trailing slash) |
| Target / launch URL | `http://172.28.92.56:3150/api/auth/sso/login` |
| Icon | upload `docs/design/app-icon/dws-hub-tile-512.png` (AASTAR Logistic (Export) app icon) |

The Hub uses public clients with PKCE (no client secret). The values must match `DWS_HUB_CLIENT_ID` and
`DWS_HUB_REDIRECT_URI` in step 6.2 exactly.

### 4.3 SDK key

Same application → **SDK**: copy the `data-app-key` value (`dwsk_…`) for step 7.2. The Target URL and redirect
URI are allowed origins automatically; if the SDK screen lists allowed origins, make sure
`http://172.28.92.56:3150` is there.

### 4.4 Sentinel

1. **Code access.** Sentinel reads the repository through the Hub's read-only GitHub token
   (`SENTINEL_GITHUB_TOKEN`). The repository is private, so an organisation owner adds
   `dwsitproject-hub/AASTAR-Logs` to that fine-grained token's **selected repositories**
   (Contents: Read-only, Metadata: Read-only).
2. Hub Admin → **Analytic → Astar ERP (Staging) → Sentinel settings**:

   | Field | Value |
   |---|---|
   | GitHub repository | `dwsitproject-hub/AASTAR-Logs` |
   | Branch | `SIT` (used when a report has no release; builds report the exact commit) |
   | Application folder | empty (the frontend is in frontend/, the API in backend/) |
   | Analyse automatically | ✓ |
   | Notes for Sentinel | the text below |

   ```
   Astar ERP: React 18 + Vite SPA (frontend/src) served by nginx; Express 4 API (backend/) under /api,
   realtime WebSocket at /api/ws. Data comes from Google Sheets: backend/services/bulkDataSync.js copies
   17 sheet ranges into SQLite every 15 s (config/dataSources.js, Admin -> Sheets Config); pages read that
   copy. Writes (Vessel Update, Vessel Matching, Contract Unlink) go to the sheet first through a
   serialized queue (services/sheetMutations.js), then to the local copy. Sign-in: DWS Hub OIDC
   (services/hubSso.js); users need ERP approval and page permissions (middleware/auth.js).
   A 409 SHEET_BUSY or 503 from /api means the sheet queue or Google was slow, not a crash.
   ```

   Then click **Test repository access**: it should show branch `SIT` and the latest commit.

---

## 5. Database on ApsaraDB RDS

### 5.1 Version and SSL

RDS console → instance → **Basic Information**: the schema is tested on PostgreSQL 14, 16 and 18.
**Data Security → SSL**: SSL was **off** on this instance on 20 Oct 2026, so the connection uses
`sslmode=disable` on the private network. If you turn SSL on, see step 6.2.

### 5.2 Whitelist the backend server

RDS console → **Whitelist Settings** → add `172.28.92.57` (group e.g. `astar_erp_be`). Re-run the RDS port
check from 3.2: `RDS port open`.

### 5.3 Create the roles and the database

Run as the RDS **privileged account** (console → **Log On to Database**/DMS on database `postgres`, or from the
backend server with the command below). Replace `<owner password>`:

```sql
CREATE ROLE astar_erp_owner LOGIN PASSWORD '<owner password>';
CREATE ROLE astar_erp_app  NOLOGIN;   -- runtime rights (Phase 1 login role joins it)
CREATE ROLE astar_erp_read NOLOGIN;   -- read-only reporting
GRANT astar_erp_owner TO CURRENT_USER;  -- lets the privileged account create a database owned by it
CREATE DATABASE astar_erp OWNER astar_erp_owner ENCODING 'UTF8' TEMPLATE template0;
```

From the backend server (asks for the privileged password, nothing stored):

```bash
docker run --rm -it postgres:16-alpine psql \
  "host=pgm-d9jx9o06qae8gf3h.pgsql.ap-southeast-5.rds.aliyuncs.com port=5432 dbname=postgres user=<privileged account> sslmode=prefer"
```

Check:

```sql
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE 'astar_erp%';      -- 3 rows
SELECT datname, pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'astar_erp';  -- owner astar_erp_owner
```

> **Console alternative.** Accounts → Create Account `astar_erp_owner` (Standard); Databases → Create Database
> `astar_erp` (authorized account `astar_erp_owner`, UTF8). Then, as the privileged account, run the two
> `CREATE ROLE … NOLOGIN` lines and `GRANT ALL ON DATABASE astar_erp TO astar_erp_owner;`.

The migrations run as `astar_erp_owner` (no superuser rights needed; verified on PostgreSQL 16 with the same
setup). They create the schemas `app`, `security`, `audit`, `mirror`, `links` and record each file in
`public.schema_migrations`.

---

## 6. Backend server `172.28.92.57`

### 6.1 Get the code

```bash
sudo mkdir -p /opt/astar-erp && sudo chown "$USER" /opt/astar-erp
cd /opt/astar-erp

# A read-only deploy key for this server (GitHub → AASTAR-Logs → Settings → Deploy keys → Add key,
# title "astar-erp-staging-be", "Allow write access" OFF)
ssh-keygen -t ed25519 -C "astar-erp-staging-be" -f ~/.ssh/id_ed25519_astarerp -N ""
cat ~/.ssh/id_ed25519_astarerp.pub          # paste into GitHub
cat >> ~/.ssh/config <<'EOF'
Host github-astarerp
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_astarerp
  IdentitiesOnly yes
EOF
ssh -T git@github-astarerp                  # "successfully authenticated"

git clone -b SIT git@github-astarerp:dwsitproject-hub/AASTAR-Logs.git .
```

### 6.2 Settings and secrets

```bash
cd /opt/astar-erp/deploy/staging/backend
cp .env.staging.example .env.staging && chmod 600 .env.staging
openssl rand -base64 48      # -> JWT_SECRET
openssl rand -base64 48      # -> SESSION_AUDIT_HMAC_KEY
nano .env.staging
```

| Setting | Value |
|---|---|
| `JWT_SECRET`, `SESSION_AUDIT_HMAC_KEY` | the two generated values (different) |
| `FRONTEND_URL` | `http://172.28.92.56:3150` (pre-filled) |
| `SESSION_COOKIE_SECURE` | `false` (pre-filled; staging is HTTP) |
| `DWS_HUB_URL` | `http://test-dwshub.kpndomain.com` (pre-filled) |
| `DWS_HUB_CLIENT_ID` | `astar-erp-staging` (as registered in 4.2) |
| `DWS_HUB_REDIRECT_URI` | `http://172.28.92.56:3150/api/auth/sso/callback` (as registered in 4.2) |
| `DWS_HUB_ALLOWED_EMAIL_DOMAINS` | empty (any Hub account may request access; an ERP admin approves) or e.g. `kpn-corp.com,energi-up.com` |
| `SHEETS_SERVICE_ACCOUNT_EMAIL`, `SHEET_ID_*` | pre-filled with the staging copies; they only seed **Admin → Sheets Config** on the first start |
| `MIGRATION_DATABASE_URL` | replace `REPLACE_ME` with the `astar_erp_owner` password (URL-encoded) |

If RDS SSL is on: download the RDS CA, put it in `deploy/staging/backend/secrets/rds-ca.pem`, add
`- ./secrets:/app/secrets:ro` under `volumes` in `docker-compose.yml`, and end the URL with
`?sslmode=verify-full&sslrootcert=/app/secrets/rds-ca.pem`.

```bash
grep -nE '^[^#]*REPLACE_ME' .env.staging || echo "all values set"
```

### 6.3 Google key file

Copy the key from your PC (MobaXterm file panel, or):

```powershell
scp "D:\Claude\AASTAR Logs\backend\service-accounts\service-account-staging.json" root@172.28.92.57:/opt/astar-erp/deploy/staging/backend/service-accounts/
```

On the server (the container runs as uid 1000; nobody else needs to read the key):

```bash
cd /opt/astar-erp/deploy/staging/backend
mkdir -p service-accounts
sudo chown -R 1000:1000 service-accounts && sudo chmod 700 service-accounts && sudo chmod 600 service-accounts/*.json
```

### 6.4 Build, migrate, start

```bash
cd /opt/astar-erp/deploy/staging/backend
chmod +x deploy.sh backup.sh
./deploy.sh
```

`deploy.sh` pulls `SIT`, builds the image, applies the RDS migrations, starts the container, waits for it to be
healthy and prints `/api/health` and `/api/ready`. Expected:

```
applying 0001_target_schema.sql ... applied
applying 0002_spreadsheet_sources.sql ... applied
Container astar-erp-backend-staging: healthy
{"status":"ok"}
{"status":"ready","database":true,"sheetsSyncAgeSeconds":…,"pendingSheetWrites":0,…}
```

`/api/ready` reports `degraded` for up to a minute while the first sheet sync runs.

Check the Hub and Google from inside the container:

```bash
docker exec astar-erp-backend-staging node -e "fetch('http://test-dwshub.kpndomain.com/api/sso/jwks').then(r=>console.log('hub jwks', r.status)).catch(e=>console.log('ERR', e.cause?.code||e.message))"   # 200
docker logs astar-erp-backend-staging 2>&1 | grep -iE "sync|SESSION_COOKIE" | tail -5
```

Expect `SESSION_COOKIE_SECURE=false: … Internal staging only.` and no `Bulk fetch failed` lines after the first minute.

### 6.5 First administrator

Create your administrator with **your DWS Hub email**; your first Hub sign-in links to it:

```bash
docker exec astar-erp-backend-staging npm run --silent seed:admin -- <your DWS Hub email> --username "Jerry Pratama Hakim"
```

---

## 7. Frontend server `172.28.92.56`

### 7.1 Get the code

Same as 6.1 with this server's own deploy key (comment and GitHub title `astar-erp-staging-fe`):

```bash
sudo mkdir -p /opt/astar-erp && sudo chown "$USER" /opt/astar-erp
cd /opt/astar-erp
# ssh-keygen … -C "astar-erp-staging-fe" -f ~/.ssh/id_ed25519_astarerp, add as read-only deploy key, ssh config as in 6.1
git clone -b SIT git@github-astarerp:dwsitproject-hub/AASTAR-Logs.git .
```

### 7.2 Settings

```bash
cd /opt/astar-erp/deploy/staging/frontend
cp .env.example .env && nano .env
```

| Setting | Value |
|---|---|
| `BACKEND_URL` | `http://172.28.92.57:4150` |
| `FRONTEND_HOST_PORT` | `3150` |
| `VITE_HUB_SDK_KEY` | the `dwsk_…` key from 4.3 |
| `VITE_HUB_SDK_URL` | `http://test-dwshub.kpndomain.com` |

### 7.3 Build and start

```bash
chmod +x deploy.sh
./deploy.sh
```

Expected:

```
Deploying release <commit> from branch SIT
Container astar-erp-frontend-staging: healthy
ok
{"status":"ok"}                     <- /api/health through to the backend
data-release="<commit>"             <- the Hub SDK tag carries the release for Sentinel
```

---

## 8. Network access (Alibaba Cloud security groups)

| Server | Rule | Source / destination |
|---|---|---|
| BE `172.28.92.57` | inbound TCP **4150** | `172.28.92.56/32` **only** |
| FE `172.28.92.56` | inbound TCP **3150** | office network / VPN ranges that use staging |
| BE `172.28.92.57` | outbound TCP 443 | Google APIs (`oauth2.googleapis.com`, `sheets.googleapis.com`), npm, Docker Hub |
| BE `172.28.92.57` | outbound TCP 80 | `172.28.92.56` (staging Hub) |
| RDS | whitelist 5432 | `172.28.92.57` |

The backend trusts the visitor address the frontend's nginx reports (`TRUST_PROXY_HOPS=1`) for sign-in
throttling and the audit log, so 4150 must not be reachable from anywhere else. From your PC,
`http://172.28.92.57:4150/api/health` must time out.

---

## 9. Sign in and set up users

1. Open **http://172.28.92.56:3150/** → **Sign in with DWS Hub** → sign in at the Hub → you land on the
   dashboard as an administrator (the account from 6.5 is now linked to your Hub user, shown in
   Admin → User Management).
2. **Admin → Sheets Config**: all spreadsheets show **Syncing** except *TPG Shipment Details* (**Not synced**,
   no staging copy) and the badge **Copies only**. *Vessel vs Contract 2.0 → DB7 EOM* shows **Empty**: the EOM
   tab in the copy only contains `#REF!` (fix the copy, not the app).
3. Other users: they sign in with DWS Hub once (this creates a **pending** account), then an administrator
   approves them in **User Management** and grants pages. To pre-approve someone, create them first
   (`seed:admin` makes administrators; for normal users approve after their first sign-in).

---

## 10. Verification checklist

| # | Check | Expected |
|---|---|---|
| 1 | `docker ps` on both servers | both new containers `Up (healthy)`; no other container restarted |
| 2 | http://172.28.92.56:3150/ | sign-in page with **Sign in with DWS Hub**; no one-click local sign-in |
| 3 | Sign in with DWS Hub | back on the dashboard; your name and **ADMIN** in the top bar |
| 4 | Open Astar ERP from its **tile in the Hub** | lands signed in (Hub launch restarts a normal sign-in) |
| 5 | Logistics → Vessel Status, Commercial pages | data from the staging copies; "Last updated" within a minute |
| 6 | Admin → Sheets Config | statuses as in 9.2; **Check connection** on any card succeeds |
| 7 | A write: Logistics → Vessel Update → edit a test row | saved, visible in the **copy** of Vessel vs Contract 2.0 |
| 8 | Hub Admin → Applications → SDK | **Receiving data** within a minute |
| 9 | Hub Admin → Analytic → Astar ERP (Staging) | your user (not anonymous), page views |
| 10 | Browser console on staging: `setTimeout(() => { throw new Error('Sentinel staging check') })` | appears under JS errors; Sentinel analyses it with release = deployed commit |
| 11 | 🐞 **Report a bug** button | report arrives in the Hub; Sentinel analysis attached |
| 12 | `http://172.28.92.57:4150/api/health` from your PC | not reachable |
| 13 | Sign out | back to sign-in; Hub Analytic starts a new session |

---

## 11. Backups and logs

The data that cannot be rebuilt from the spreadsheets — users and roles, Sheets Config and its history,
sign-in security, activity log — is in three SQLite files in the volume. `backup.sh` takes consistent online
copies and keeps the newest 14:

```bash
cd /opt/astar-erp/deploy/staging/backend && ./backup.sh
crontab -e
# Astar ERP staging: nightly backup of user/security data (server time)
30 1 * * * /opt/astar-erp/deploy/staging/backend/backup.sh >> /opt/astar-erp/deploy/staging/backend/backups/backup.log 2>&1
```

Restore one set (stops the API briefly):

```bash
cd /opt/astar-erp/deploy/staging/backend && docker compose stop backend
docker run --rm -v astar-erp-staging-data:/data -v "$PWD/backups/<timestamp>:/restore:ro" alpine \
  sh -c 'cp /restore/*.db /data/ && rm -f /data/*.db-wal /data/*.db-shm && chown 1000:1000 /data/*.db'
docker compose start backend
```

RDS: rely on its automated backups (≥ 7 days) once Phase 1 moves data there.

Logs: `docker logs -f astar-erp-backend-staging`, `docker logs -f astar-erp-frontend-staging` (rotated, 5 × 10 MB).

---

## 12. Updating staging

Backend first, then frontend:

```bash
# backend server
cd /opt/astar-erp/deploy/staging/backend && ./deploy.sh
# frontend server
cd /opt/astar-erp/deploy/staging/frontend && ./deploy.sh
```

Each frontend deploy reports the new commit as its release, so Sentinel reads the code that is running.

**Rollback.** On the affected server: `cd /opt/astar-erp && git checkout <previous commit>`, then
`./deploy.sh --no-pull` (backend: add `--skip-migrate`). Migrations are additive, so older code runs on a newer
schema. Return to the branch with `git checkout SIT`.

**Remove completely.** `docker compose down` in both `deploy/staging/*` folders (backend: `down -v` also deletes
the data volume — back up first), delete `/opt/astar-erp`, the cron line, the Hub registration, the security
group rules and the deploy keys, and optionally `DROP DATABASE astar_erp` and the three roles.

---

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `deploy.sh`: `Fill in the REPLACE_ME values` | `.env.staging` incomplete | 6.2 |
| Migration: `password authentication failed` / timeout | owner password, URL encoding, whitelist | 5.2, 6.2; `--skip-migrate` deploys the app meanwhile |
| Migration: `permission denied for database astar_erp` | console path without the GRANT | run `GRANT ALL ON DATABASE astar_erp TO astar_erp_owner;` as the privileged account |
| Migration: `server does not support SSL` / `SSL required` | `sslmode` does not match the RDS SSL setting | `sslmode=disable` (SSL off) or the CA setup in 6.2 (SSL on) |
| Migration: `MIGRATION_CHECKSUM_MISMATCH` | an applied migration file was edited | never edit applied files; add a new numbered file |
| Backend exits: `JWT_SECRET must be…` | secret missing/short | 6.2 |
| Backend exits: `SESSION_COOKIE_SECURE=false is only allowed…` | `FRONTEND_URL` is https | remove `SESSION_COOKIE_SECURE` (Appendix D) |
| Sign-in loops back to the sign-in page, no error | session cookie refused (HTTPS/HTTP mismatch) | `SESSION_COOKIE_SECURE=false` on HTTP staging; open the exact `FRONTEND_URL` address |
| `Origin not allowed` on sign-in | page opened under another address (hostname vs IP) | use `http://172.28.92.56:3150`, or add the other address to `CORS_ORIGINS` in `.env.staging` |
| Sign-in page: **DWS Hub is not reachable right now** | container cannot reach the Hub | `extra_hosts` / `HUB_HOST_IP`; the `fetch` check in 6.4 |
| Hub: `invalid redirect_uri` / enforcement error | registration differs | 4.2: `sso_mode=oidc`, exact redirect URI, same client id |
| **DWS Hub sign-in could not be verified** | client id (`aud`), issuer, server clock | `DWS_HUB_CLIENT_ID`; `timedatectl` (NTP on); `docker logs astar-erp-backend-staging \| grep "DWS Hub"` |
| **…awaiting ERP access approval** | new Hub user | approve in User Management |
| **Your sign-in took too long or was started elsewhere** | > 10 minutes at the Hub, back button, or a second Hub-tile launch within 2 minutes | click **Sign in with DWS Hub** |
| **This DWS Hub account is not allowed to use Astar ERP** | email domain outside `DWS_HUB_ALLOWED_EMAIL_DOMAINS` | widen or empty the list, `./deploy.sh --skip-migrate` |
| 502 Bad Gateway on pages' data | FE cannot reach BE 4150 | security group (8); `curl http://172.28.92.57:4150/api/health` from the FE server |
| Sheets Config: **Sync error** `caller does not have permission` | copy not shared with the account | share it with `aastar-logs-staging@…` as Editor |
| Sheets Config: **No key on server** | key file missing/unreadable | 6.3 (owner uid 1000) |
| Sheets Config refuses a spreadsheet: production not allowed | `SHEETS_COPIES_ONLY` | by design on staging: use a copy |
| SDK: console `403 origin_not_allowed` | address not in allowed origins | 4.3 |
| SDK: users anonymous in Hub Analytic | signed in before the SDK loaded | reload; check `DwsHub.identify` runs (`data-debug="true"` via `VITE_HUB_SDK_DEBUG=true` build) |
| Sentinel: **No source code** | token cannot read `AASTAR-Logs` | 4.4 step 1; **Test repository access** |

---

## Appendix A — Ports

Chosen from the `docker ps` output of both servers (3 Nov 2026):

| Server | In use (host) | Chosen |
|---|---|---|
| FE `172.28.92.56` | 2001, 3000, 3001, 3002 (127.0.0.1), 3020, 3030, 3040 (127.0.0.1), 3042, 3050, 3060, 3070, 3080, 3090, 3091, 3100, 4041, 4042, 8010, 8088; 80 (staging Hub); `tas_staging_nginx` unknown | **3150** |
| BE `172.28.92.57` | 3000, 3001, 3003, 3010, 3011, 4000, 4001, 4010, 4100, 5000, 5001, 5003, 5050, 5070, 6380, 8085 | **4150** (bound to `172.28.92.57` only) |

To use other ports, change them consistently: FE `.env` `FRONTEND_HOST_PORT`; BE `BACKEND_HOST_PORT`
(environment or `deploy/staging/backend/.env`); FE `.env` `BACKEND_URL`; BE `.env.staging` `FRONTEND_URL` and
`DWS_HUB_REDIRECT_URI`; the Hub registration (4.2); security groups (8).

## Appendix B — Files

| File | Purpose |
|---|---|
| `deploy/staging/backend/docker-compose.yml` | backend container, private port, data volume, key mount, Hub name pin |
| `deploy/staging/backend/.env.staging.example` | settings template (copy to `.env.staging`, never committed) |
| `deploy/staging/backend/deploy.sh` | pull, build, migrate, start, health |
| `deploy/staging/backend/backup.sh` | nightly online backup of the SQLite user/security data |
| `deploy/staging/frontend/docker-compose.yml` | nginx container, staging config, SDK build arguments |
| `deploy/staging/frontend/.env.example` | backend address, port, SDK key |
| `deploy/staging/frontend/deploy.sh` | pull, build with the commit as release, start, check |
| `frontend/nginx/staging.conf.template` | nginx: pages, `/api` + `/api/ws` proxy, `/healthz`, headers |
| `backend/db/migrations/*.sql` | RDS schema (applied by `deploy.sh`) |

## Appendix C — Settings reference (backend)

| Variable | Staging value | Notes |
|---|---|---|
| `NODE_ENV` | `production` (compose) | disables the one-click local sign-in |
| `PORT` / `HOST` | `3001` / `0.0.0.0` (compose) | inside the container |
| `TRUST_PROXY_HOPS` | `1` (compose) | nginx on the FE server |
| `SHEETS_COPIES_ONLY` | `1` (compose) | production spreadsheets refused and never synced |
| `JWT_SECRET`, `SESSION_AUDIT_HMAC_KEY` | generated | rotating `JWT_SECRET` signs everyone out |
| `FRONTEND_URL` | `http://172.28.92.56:3150` | CORS and WebSocket origin |
| `SESSION_COOKIE_SECURE` | `false` | HTTP staging only |
| `DWS_HUB_*` | see 6.2 | `DWS_HUB_SSO_ENABLED=0` hides the button |
| `SHEETS_SERVICE_ACCOUNT_EMAIL`, `SHEET_ID_*` | staging copies | seed Admin → Sheets Config once |
| `MIGRATION_DATABASE_URL` | owner account URL | migrations only |
| `MATTHEW_EMAIL` | `matthew.chiu@kpn-corp.com` | recovery administrator |
| `AISSTREAM_API_KEY`, `SMTP_*`, `USER_ACTIVITY_REPORT_TO` | optional | live AIS feed, activity report e-mail |

## Appendix D — Moving staging to HTTPS later

1. Put staging behind TLS (a host nginx vhost such as `test-astar-erp.kpndomain.com`, or an SLB).
2. Backend `.env.staging`: `FRONTEND_URL=https://…`, `DWS_HUB_REDIRECT_URI=https://…/api/auth/sso/callback`,
   delete `SESSION_COOKIE_SECURE`; `./deploy.sh --skip-migrate`.
3. Hub: update the redirect URI and Target URL. The SDK must then come from an **HTTPS** Hub (browsers block an
   HTTP script on an HTTPS page): set `VITE_HUB_SDK_URL` accordingly and redeploy the frontend.
4. If the TLS proxy adds a hop in front of nginx without `real_ip`, set `TRUST_PROXY_HOPS=2`.
