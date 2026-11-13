# AASTAR Logistic (Export) production deployment

How to put AASTAR Logistic (Export) into production on the shared production servers, step by step, how to move users
over from the application running today at `erp-aastar-trading-sg.trade`, and how to run it afterwards. It is built
the same way as staging ([DEPLOYMENT-STAGING.md](DEPLOYMENT-STAGING.md)) — the same images and checks — on the
production servers, database and DWS Hub, against the **production** Google Sheets.

```
Browser ──► FE server 172.28.80.50:3150   astar-erp-frontend (nginx: web app, /api and /api/ws proxied)
            (later aastar-logistic.kpndomain.com via the host nginx on :80)
                      │ /api, /api/ws
                      ▼
            BE server 172.28.80.51:4150   astar-erp-backend (Node API: sign-in, roles, Google Sheets sync every 15 s)
                      │
                      ├──► Docker volume astar-erp-production-data  (SQLite: users, roles, Sheets Config, activity, sheet mirrors)
                      ├──► Google Sheets API                         (the 6 production spreadsheets; reads AND writes)
                      ├──► production DWS Hub  dwshub.kpndomain.com  (OIDC token and signing keys)
                      └──► ApsaraDB RDS (prod) pgm-d9jn3khh0b3907w4.pgsql.ap-southeast-5.rds.aliyuncs.com:5432, database astar_erp
Browser ──► production DWS Hub  (sign-in; Hub SDK script and analytics, Sentinel)
```

| | FE server 172.28.80.50 | BE server 172.28.80.51 |
|---|---|---|
| Container | `astar-erp-frontend` | `astar-erp-backend` |
| Port | **3150** on 172.28.80.50 only | **4150** on 172.28.80.51 only |
| Compose file | `deploy/production/fe.compose.yml` | `deploy/production/be.compose.yml` |
| Settings (filled on the server) | `/opt/astar-erp/.env`, `/opt/astar-erp/fe-build.env` | `/opt/astar-erp/.env`, `production.env`, `secrets.production.env`, `service-accounts/` |
| Deploy | `/opt/astar-erp/src/deploy/production/release.sh fe <tag>` | `/opt/astar-erp/src/deploy/production/release.sh be <tag>` |
| Code | `/opt/astar-erp/src`, at a release tag | `/opt/astar-erp/src`, at the same release tag |

Do the sections in order. Sections 1–6 are one-time preparation; section 7 onwards is the deployment itself.

**Conventions.** Every command block runs on the machine named above it, as `root` in PuTTY. Passwords are typed into
`nano`, never onto a command line. A command block never contains `<…>` (bash reads `<` as a redirect): values to edit
are written `FILL_…` and changed before pressing Enter.

---

## 1. Ports and the Docker network

Both servers already run many applications. The ports below were checked against the running containers
(`docker ps`, 13 November 2026):

| Server | Host ports already taken | AASTAR uses |
|---|---|---|
| FE 172.28.80.50 | 80 and 443 (host nginx), 2001, 3001, 3002, 3020, 3040, 3042, 3050, 3070, 3080, 3100, 3160, 8000, 8080, 8081, 8090, 8443 | **3150** — the same as staging |
| BE 172.28.80.51 | 3000, 3003, 4000, 4001, 4100, 4160, 5000, 5001, 5003, 5010, 5050, 5070, 5433, 5434, 8001, 8091, 13000 | **4150** — the same as staging |

Ports a container only exposes inside Docker (`3000/tcp`, `5432/tcp`, `6379/tcp` without `->`) do not take a host
port. Programs outside Docker are not in that list, so the preflight (§5) checks again with `ss`. If a port is taken,
use the free one it prints, and the same number everywhere: `ASTAR_API_BIND` (BE `.env`), `ASTAR_BACKEND_URL` and
`ASTAR_WEB_BIND` (FE `.env`), `FRONTEND_URL` / `DWS_HUB_REDIRECT_URI` (BE `production.env`), the Hub registration (§4)
and the vhost (§8).

**Why nothing here can cut the other applications off from the Synology NAS.** On staging, a Docker network that
Docker picked by itself landed in 172.30.0.0/16 — the NAS's own range (172.30.1.94) — and every application on that
host lost the NAS. Here:

- The app's network `astar-erp_net` has a **fixed subnet** (`ASTAR_SUBNET`), chosen per server by the preflight so it
  overlaps no Docker network, route, the servers' LAN or the NAS. The compose files refuse to start without it.
- The app **does not use the NAS at all**: no mount is added, and no existing mount is touched.
- Nothing in this guide restarts Docker, edits `/etc/docker/daemon.json`, prunes, or touches another application's
  container, network or volume.

## 2. Before you start: who provides what

| Item | From | Used in |
|---|---|---|
| RDS: `172.28.80.51` on the whitelist; account `astar_erp_owner`, database `astar_erp`, two roles (privileged account) | DBA / cloud admin | §3 |
| The app registered in the **production** DWS Hub: client id, both redirect URIs, SDK key; Sentinel's GitHub token covering `AASTAR-Logs` | Hub administrator, GitHub org owner | §4 |
| Read-only GitHub deploy key per server | Repository admin | §5 |
| Access to the **current server** (where `erp-aastar-trading-sg.trade` runs): its data, Google key files and `.env` | Current server's admin | §6 |
| DNS A record `aastar-logistic.kpndomain.com → 172.28.80.50` | IT infrastructure (DNS) | §8 |
| Firewall rules (table below) | Network team | §2 |
| A release tag, e.g. `v1.0.0`, of a commit that passed staging and is merged into `main` | Release owner | §5, §12 |

**Decisions to make before go-live**

- **Who reaches it from outside the office.** Today's application is on the public internet over HTTPS, and its
  sign-in page is shown to visitors from Indonesia and Taiwan. The production servers are private. Users outside the
  office network (other sites, Taiwan, travelling) need the VPN — or the network team publishes the app through the
  company's public proxy. Decide this before the cut-over, or those users lose access.
- **HTTP or HTTPS.** Like staging, this guide serves the app over plain HTTP on the private network
  (`SESSION_COOKIE_SECURE=false`). Google sign-in stays off until HTTPS (Google accepts only `https://` addresses), so
  everyone signs in with DWS Hub. §11 lists what changes for HTTPS.
- **The cut-over window.** The current application is stopped from its final data export until the new one is
  checked (§6–§10, about an hour). The two must **never** run at the same time against the production spreadsheets:
  each writes back to them (ERP match IDs, vessel links, user edits).
- **The old address.** After the cut-over, `erp-aastar-trading-sg.trade` should redirect to the new address or show a
  notice. Keep the current server stopped, not deleted, for two weeks: it is the rollback (§12).

**Network rules**

| From | To | Why |
|---|---|---|
| Users (office, VPN) | FE 172.28.80.50:3150 (and :80 once DNS exists) | The application |
| Users | `dwshub.kpndomain.com` :443 | Sign-in, Hub SDK script |
| FE 172.28.80.50 | BE 172.28.80.51:4150 | `/api`, `/api/ws` |
| BE 172.28.80.51 | RDS :5432 | Migrations — 172.28.80.51 on the RDS **whitelist** |
| BE 172.28.80.51 | FE 172.28.80.50:443 (`dwshub.kpndomain.com`) | Hub token exchange and signing keys |
| BE 172.28.80.51 | `oauth2.googleapis.com`, `sheets.googleapis.com` :443 | Google Sheets sync and writes |
| Both servers | github.com:22, Docker Hub, registry.npmjs.org :443 | Building the images |

## 3. Database on ApsaraDB RDS (once)

Production instance: `pgm-d9jn3khh0b3907w4.pgsql.ap-southeast-5.rds.aliyuncs.com`. The application keeps its own data
in SQLite until Phase 1; RDS receives the target schema now so Phase 1 needs no new setup. The schema is tested on
PostgreSQL 14, 16 and 18.

1. RDS console → **Whitelist**: add `172.28.80.51` (the BE server) — nothing broader.
2. As the instance's **privileged account** (console → *Log On to Database* / DMS, database `postgres`), with a new
   strong password for production in place of `FILL_OWNER_PASSWORD`:
   ```sql
   CREATE ROLE astar_erp_owner LOGIN PASSWORD 'FILL_OWNER_PASSWORD';
   CREATE ROLE astar_erp_app  NOLOGIN;
   CREATE ROLE astar_erp_read NOLOGIN;
   GRANT astar_erp_owner TO CURRENT_USER;
   CREATE DATABASE astar_erp OWNER astar_erp_owner ENCODING 'UTF8' TEMPLATE template0;
   SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE 'astar_erp%';
   ```
   The last line must list three roles, `astar_erp_owner` with `t`. The role names are prefixed because the instance
   is shared. *Console alternative:* create the account and the database in the console, then run the two
   `CREATE ROLE … NOLOGIN` lines and `GRANT ALL ON DATABASE astar_erp TO astar_erp_owner;` as the privileged account.
3. **Backup**: RDS → Backup and Restoration → automatic backups on (≥ 7 days) — it matters from Phase 1.
4. SSL was off on the instances checked so far (`sslmode=disable` on the private network). If it is on, see §11.

The migrations run as `astar_erp_owner`, need no superuser rights and do not use schema `public`; they record each
file in `migrations.schema_migrations`.

## 4. DWS Hub registration (once, in the **production** Hub)

The production Hub is `https://dwshub.kpndomain.com`, served by the FE server's host nginx. Check it from the BE
server the way the backend container will reach it (its name pinned to 172.28.80.50):

```bash
curl -s --resolve dwshub.kpndomain.com:443:172.28.80.50 https://dwshub.kpndomain.com/api/sso/.well-known/openid-configuration
```

`issuer` must be `https://dwshub.kpndomain.com`. Hub Admin → **Applications** → add *AASTAR Logistic (Export)*:

| Field | Value |
|---|---|
| `sso_mode` | `oidc` (public client, PKCE) |
| `oauth_client_id` | `astar-erp` → `DWS_HUB_CLIENT_ID` |
| `oidc_redirect_uris` | `http://172.28.80.50:3150/api/auth/sso/callback` **and** `http://aastar-logistic.kpndomain.com/api/auth/sso/callback` |
| Target / launch URL | `http://172.28.80.50:3150/api/auth/sso/login` (the domain's, after §8) |
| Icon | `docs/design/app-icon/dws-hub-tile-512.png` |

Registering both redirect URIs now means the DNS switch (§8) is only a settings change. Opening the app from its Hub
tile signs users in directly (the app restarts a Hub-launched sign-in by itself).

**Hub SDK** — the application → **SDK**: copy the production key to `VITE_HUB_SDK_KEY` in `fe-build.env` (§8).
**Allowed origins**: `http://172.28.80.50:3150` and `http://aastar-logistic.kpndomain.com`. Never use staging's key.

**Sentinel** — Admin → Analytic → *AASTAR Logistic (Export)* → **Sentinel settings**: repository
`dwsitproject-hub/AASTAR-Logs`, branch `main`, application folder empty, analyse automatically ✓, and the notes from
[DEPLOYMENT-STAGING.md](DEPLOYMENT-STAGING.md) §4.4. The Hub's GitHub token must include `AASTAR-Logs` (organisation
owner). **Test repository access** must show `main`.

## 5. The code on each server (once per server)

**PuTTY on each server (BE 172.28.80.51, then FE 172.28.80.50).** Each gets its own **read-only** deploy key
(GitHub → AASTAR-Logs → Settings → Deploy keys → *Add*, *Allow write access* off), wired to an SSH alias so other
applications' `git pull` on the shared host is untouched:

```bash
ssh-keygen -t ed25519 -C "astar-erp production $(hostname)" -f /root/.ssh/id_ed25519_astarerp -N ""
cat /root/.ssh/id_ed25519_astarerp.pub
```

```bash
printf '\nHost github-astarerp\n  HostName github.com\n  User git\n  IdentityFile /root/.ssh/id_ed25519_astarerp\n  IdentitiesOnly yes\n' >> /root/.ssh/config
chmod 600 /root/.ssh/config
ssh -T git@github-astarerp
```

Expected: *"Hi dwsitproject-hub/AASTAR-Logs! You've successfully authenticated"* (answer `yes` to the host-key
question the first time).

```bash
mkdir -p /opt/astar-erp
git clone git@github-astarerp:dwsitproject-hub/AASTAR-Logs.git /opt/astar-erp/src
git -C /opt/astar-erp/src fetch --tags origin
git -C /opt/astar-erp/src checkout v1.0.0
```

Expected after the last line: `HEAD is now at …` (a "detached HEAD" note is normal for a tag). `pathspec 'v1.0.0' did not
match` means the tag is not on GitHub yet (§12 step 2). Production runs a tagged release, not whatever `main` is at.
If a clone fails half-way, remove the leftover `/opt/astar-erp/src` before retrying; if it already exists, skip the
`git clone` line.

**Preflight — read-only, on each server.** It changes nothing; paste the whole output back for review:

```bash
bash /opt/astar-erp/src/deploy/production/preflight.sh be      # on 172.28.80.51
bash /opt/astar-erp/src/deploy/production/preflight.sh fe      # on 172.28.80.50
```

| Line | Must be | If not |
|---|---|---|
| `port 4150 is free` / `port 3150 is free` | OK | Use the free port it prints (§1) |
| `suggested subnet for astar-erp_net: …` | OK — note it per server, for `ASTAR_SUBNET` | `NONE`: ask infra for a /24 |
| `… is outside Docker's usual pool` | WARN is normal here (every 172.17–172.31 range is taken) | Confirm with infra that the office / VPN networks do not use it |
| `pgm-…:5432 reachable` (BE) | OK | RDS whitelist (§3), firewall |
| `Hub discovery via 172.28.80.50` and `jwks -> 200` (BE) | OK | Firewall BE → FE :443 |
| `oauth2.googleapis.com` / `sheets.googleapis.com :443` (BE) | OK | Outbound 443 (§2) |
| `github.com:22`, `registry.npmjs.org`, `registry-1.docker.io` | OK | Outbound (§2) |
| `volume astar-erp-production-data not created yet` (BE) | OK | An earlier attempt: ask before removing anything |
| `port 80: host nginx` (FE) | INFO | — |
| `NAS mounts already on this host` | INFO, listed only | This app adds none |

## 6. Data and keys from the current server (once, at the cut-over)

The application does not use the NAS. What it needs from the current server (`erp-aastar-trading-sg.trade`) is its
own data — users, roles, sign-in security, the activity log — and the production Google key files. The sheet mirrors
are rebuilt from Google in a minute and are not copied.

**PuTTY on the current server.** Find the backend folder (the one with `data/erp.db`) and how the app runs:

```bash
find / -path '*/backend/data/erp.db' -not -path '*/node_modules/*' 2>/dev/null
pm2 ls 2>/dev/null; systemctl list-units --type=service 2>/dev/null | grep -iE 'erp|astar'
```

In that folder, note which settings it uses — names only, the values are copied by hand later:

```bash
cd FILL_BACKEND_DIR && grep -oE '^[A-Z_]+=' .env
```

If `.env` sets `DB_PATH`, `LOGIN_SECURITY_DB_PATH`, `USER_ACTIVITY_DB_PATH` or `SERVICE_ACCOUNTS_DIR`, use those
paths below instead of `data/…` and `service-accounts/`.

**At the cut-over: stop the current app first.** From now until §10 is done, users cannot work. Stopping it ends its
sheet sync, so only the new backend will write to the spreadsheets:

```bash
pm2 stop FILL_PM2_NAME
```

(or `systemctl stop …` — whatever the commands above showed; *stop*, never delete.) Then take consistent copies of the
three databases (the app's own `better-sqlite3` makes an online-safe copy) and the key files:

```bash
cd FILL_BACKEND_DIR && mkdir -p /root/astar-erp-export && chmod 700 /root/astar-erp-export
node -e "const D=require('better-sqlite3'),fs=require('fs');(async()=>{for(const n of ['erp.db','login_security.db','user_activity.db']){if(!fs.existsSync('data/'+n)){console.log('missing',n);continue}const d=new D('data/'+n,{readonly:true});await d.backup('/root/astar-erp-export/'+n);d.close();console.log('copied',n)}})()"
cp service-accounts/*.json /root/astar-erp-export/ && ls /root/astar-erp-export
tar czf /root/astar-erp-export.tgz -C /root astar-erp-export && chmod 600 /root/astar-erp-export.tgz
```

Expected: `copied erp.db`, `copied login_security.db`, `copied user_activity.db`, and the key files listed (one per
service account: `aastar-sales`, `grsalesandpurchase`, `vessel-vs-contract-2-0`, `kpn-stock`, `tpgsalesandpurchase`,
`palmshptfile`). Move `/root/astar-erp-export.tgz` to the BE server's `/root/` (MobaXterm / WinSCP via your PC), then
delete it from the current server and your PC. **PuTTY on 172.28.80.51 (BE):**

```bash
mkdir -p /root/astar-erp-import && tar xzf /root/astar-erp-export.tgz -C /root/astar-erp-import --strip-components=1 && chmod 700 /root/astar-erp-import && ls /root/astar-erp-import
```

*Rehearsal:* the same export can be taken any day before (without stopping the app) to try §7 end to end; then
delete the volume (`/opt/astar-erp/src/deploy/production/dc.sh be down -v`) and do it again at the cut-over.

## 7. Backend (BE server 172.28.80.51)

**PuTTY on 172.28.80.51.** The runtime folder holds everything filled in on this server:

```bash
cd /opt/astar-erp && mkdir -p service-accounts backups
cp src/deploy/production/compose.env.example .env
cp src/deploy/production/production.env production.env
cp src/deploy/production/secrets.production.env.example secrets.production.env
chmod 600 .env secrets.production.env
openssl rand -base64 48
openssl rand -base64 48
```

`nano .env` — `ASTAR_SUBNET=` the BE preflight's suggested subnet. `nano secrets.production.env`:

| Setting | Value |
|---|---|
| `JWT_SECRET`, `SESSION_AUDIT_HMAC_KEY` | The two values generated above (different) |
| `PASSWORD_AUDIT_HMAC_KEY` | The current server's value if its `.env` has one (§6), else a new random value |
| `MIGRATION_DATABASE_PASSWORD` | `astar_erp_owner`'s password, inside the single quotes, as is |
| `AISSTREAM_API_KEY`, `SMTP_URL` | Copied from the current server's `.env` if it has them (live vessels, activity e-mail) |

`nano production.env` — review; on day one nothing needs changing (`FRONTEND_URL=http://172.28.80.50:3150`, the
production Hub, `astar-erp` client id, the production spreadsheets, `SESSION_COOKIE_SECURE=false`). Copy
`USER_ACTIVITY_REPORT_TO` / `MATTHEW_EMAIL` from the current server if they differ. **Keep copies of `.env`,
`production.env` and `secrets.production.env` in the password vault.**

The production Google key files (only readable by the container's user, uid 1000):

```bash
cp /root/astar-erp-import/*.json /opt/astar-erp/service-accounts/ && chown -R 1000:1000 /opt/astar-erp/service-accounts && chmod 700 /opt/astar-erp/service-accounts && chmod 600 /opt/astar-erp/service-accounts/*.json
```

Build, migrate and create the container and its data volume **without starting it**:

```bash
/opt/astar-erp/src/deploy/production/release.sh be v1.0.0 --create-only
```

Expected: `Releasing v1.0.0 (…)`, `applying 0001_target_schema.sql`, `0002_spreadsheet_sources.sql`,
`0003_roles.sql` (or `Database is up to date`), and `Created astar-erp-backend … without starting them`. Import the
current server's data into the volume, then start:

```bash
docker run --rm -v astar-erp-production-data:/data -v /root/astar-erp-import:/import:ro alpine sh -c 'cp /import/*.db /data/ && chown 1000:1000 /data/*.db && chmod 600 /data/*.db && ls -l /data'
/opt/astar-erp/src/deploy/production/dc.sh be up -d
```

On its first start the backend upgrades the data: every user keeps their access and gets a **role** (administrators
the built-in *Administrator*; users with the same pages share one generated role, e.g. *Logistics (10 pages)*,
renamable in Admin → Roles), and **Admin → Sheets Config** is filled with the six production spreadsheets. Check:

```bash
docker inspect -f '{{.State.Health.Status}}' astar-erp-backend
curl -s http://172.28.80.51:4150/api/ready ; echo
docker exec astar-erp-backend node -e "const d=new (require('better-sqlite3'))('/app/data/erp.db',{readonly:true});console.log(d.prepare('SELECT COUNT(*) users, SUM(role_id IS NOT NULL) with_role, SUM(is_admin) admins FROM users').get())"
docker exec astar-erp-backend node -e "fetch('https://dwshub.kpndomain.com/api/sso/jwks').then(r=>console.log('hub jwks',r.status)).catch(e=>console.log('ERR',e.cause?.code||e.message))"
docker logs astar-erp-backend 2>&1 | grep -iE 'sync|SESSION_COOKIE|fail' | tail -8
```

Expected: `healthy`; `/api/ready` → `"status":"ready"` within a minute (the first sheet sync); the user counts as on
the current server, every approved user `with_role`; `hub jwks 200`; `SESSION_COOKIE_SECURE=false: session cookies are
sent over plain HTTP` and no `Bulk fetch failed` after the first minute. Then delete
`/root/astar-erp-export.tgz` and `/root/astar-erp-import`.

**Nightly backup** (§13):

```bash
(crontab -l 2>/dev/null | grep -v 'astar-erp/src/deploy/production/backup.sh'; printf '30 1 * * * /opt/astar-erp/src/deploy/production/backup.sh >> /opt/astar-erp/backups/backup.log 2>&1\n') | crontab -
crontab -l | grep astar-erp
/opt/astar-erp/src/deploy/production/backup.sh
```

Expected: the cron line once, then `backup written to /opt/astar-erp/backups/…: erp.db login_security.db user_activity.db`.

## 8. Frontend (FE server 172.28.80.50)

**PuTTY on 172.28.80.50:**

```bash
cd /opt/astar-erp
cp src/deploy/production/compose.env.example .env
cp src/deploy/production/fe-build.env.example fe-build.env
chmod 600 .env
```

`nano .env` — `ASTAR_SUBNET=` the **FE** preflight's suggested subnet. `nano fe-build.env` — the production SDK key
from §4 (or empty `VITE_HUB_SDK_KEY=` to build without the SDK). Deploy:

```bash
/opt/astar-erp/src/deploy/production/release.sh fe v1.0.0
```

It builds the web app with the Hub SDK and the release's commit, starts `astar-erp-frontend` on 172.28.80.50:3150 and
checks it. Expected ending: `ok`, `{"status":"ok"}` (through to the backend), `data-release="…"`, and
`astar-erp-frontend is running v1.0.0`.

**When `aastar-logistic.kpndomain.com` resolves** (DNS request, §2). **PuTTY on 172.28.80.50** — one new vhost on
the shared host nginx; `nginx -t` is not optional:

```bash
cp /opt/astar-erp/src/deploy/production/nginx/host-vhost-aastar-logistic.conf /etc/nginx/conf.d/aastar-logistic.conf
nginx -t && systemctl reload nginx
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: aastar-logistic.kpndomain.com' http://127.0.0.1/
```

Expected: `syntax is ok`, then `200`. **PuTTY on 172.28.80.51 (BE)** — `nano /opt/astar-erp/production.env`:
`FRONTEND_URL=http://aastar-logistic.kpndomain.com`, `CORS_ORIGINS=http://172.28.80.50:3150`,
`DWS_HUB_REDIRECT_URI=http://aastar-logistic.kpndomain.com/api/auth/sso/callback`, then:

```bash
/opt/astar-erp/src/deploy/production/dc.sh be up -d --force-recreate
```

Hub: set the Target / launch URL to `http://aastar-logistic.kpndomain.com/api/auth/sso/login`. From then on users
open the domain; signing in from the IP address ends with *"Your sign-in took too long or was started elsewhere"*.

## 9. First sign-in, administrators and the data

1. **Sign in** at `http://172.28.80.50:3150` with **Sign in with DWS Hub**. Your account from the current server is
   linked to your Hub user **by email** on the first Hub sign-in, so it must be the same address in both. A user whose
   Hub email differs gets a new *pending* account instead: delete it and change the Hub email, or give the new account
   the role.
2. **Admin → User Management**: the current server's users, each with a role. Pending users approve by choosing a
   role. Add people before their first sign-in with **+ Add user**.
3. **Admin → Roles**: rename the generated roles (e.g. *Logistics (10 pages)* → *Logistics desk*); a role's pages
   change for all its users at once.
4. **Admin → Sheets Config**: the six production spreadsheets, each **Syncing**; no *Copies only* badge.
5. The recovery administrator (`MATTHEW_EMAIL`) always keeps the Administrator role and sees **IP Security**.

## 10. Go-live checks

| # | Check | Expected |
|---|---|---|
| 1 | Open `http://172.28.80.50:3150` from an office PC | Sign-in page with the tanker logo and **Sign in with DWS Hub** |
| 2 | Sign in with DWS Hub | Dashboard, your name and **ADMIN** |
| 3 | Click the app's tile in the production Hub | Signed in, no error |
| 4 | Logistics → Vessel Status, Commercial pages | Today's production data; "Last updated" within a minute |
| 5 | Admin → Sheets Config | Six spreadsheets **Syncing**; *Check connection* succeeds on each |
| 6 | One real edit (Logistics → Vessel Update, a field you can safely change back) | Saved and visible in the production spreadsheet |
| 7 | A user with a limited role | Sees only the role's pages; other addresses → dashboard |
| 8 | Hub: Applications → SDK | **Receiving data**; Analytic shows users by name |
| 9 | Sentinel → Test repository access | `main` |
| 10 | `http://172.28.80.51:4150/api/health` from your PC | Not reachable |
| 11 | `docker ps` on both servers | `astar-erp-backend` healthy, `astar-erp-frontend` healthy; every other application unchanged |
| 12 | `findmnt -t cifs` on the BE server | The same mounts as before (this app added none) |
| 13 | Next morning: `/opt/astar-erp/backups/backup.log` | A new backup line |

When all pass, users are told the new address, and `erp-aastar-trading-sg.trade` is redirected (§2).

## 11. HTTPS (recommended)

When a certificate for `aastar-logistic.kpndomain.com` exists on the FE host nginx (check whether its
`*.kpndomain.com` certificate covers the name):

1. Vhost: a `listen 443 ssl;` server with the certificate and the same locations; the port-80 server reduced to
   `return 301 https://$host$request_uri;` — `nginx -t && systemctl reload nginx`.
2. BE `production.env`: `FRONTEND_URL=https://aastar-logistic.kpndomain.com`,
   `DWS_HUB_REDIRECT_URI=https://…/api/auth/sso/callback`, **delete** `SESSION_COOKIE_SECURE` (the backend refuses it
   with an https address), optionally `GOOGLE_CLIENT_ID` (with `https://aastar-logistic.kpndomain.com` as an
   authorised origin on the Google client). `dc.sh be up -d --force-recreate`.
3. Hub: redirect URI, launch URL and SDK allowed origin with `https://`.
4. Everyone signs in again (the cookies become `__Host-erp_session` / `__Host-erp_sso`).
5. If RDS SSL is turned on: put the RDS CA in `/opt/astar-erp/secrets/rds-ca.pem`, mount `./secrets:/app/secrets:ro`
   and end `MIGRATION_DATABASE_URL` with `?sslmode=verify-full&sslrootcert=/app/secrets/rds-ca.pem`.

## 12. Releasing updates and rolling back

Every change goes through staging first; then the same commit is merged into `main`, tagged and deployed.

1. Deploy to staging and test there ([DEPLOYMENT-STAGING.md](DEPLOYMENT-STAGING.md) §12).
2. Pull request `SIT → main`, reviewed and merged. Tag the merged commit (workstation with push rights):
   ```bash
   git fetch origin && git tag -a v1.1.0 origin/main -m "AASTAR Logistic 1.1.0"
   git push origin v1.1.0
   ```
3. Production, **BE server first** (it runs the migrations), then FE:
   ```bash
   /opt/astar-erp/src/deploy/production/release.sh be v1.1.0      # 172.28.80.51
   /opt/astar-erp/src/deploy/production/release.sh fe v1.1.0      # 172.28.80.50
   ```
   The script refuses code with local edits or a missing tag, keeps the running image as `:prev` and recreates the
   container (`--force-recreate`; a plain `up -d` would keep the old code). The API is unavailable for a few seconds
   while it restarts; the sheet queue finishes or rejects pending writes first.
4. If the release changed a template under `deploy/production/`, compare it with the filled copy in `/opt/astar-erp`
   and carry the new lines over by hand — never overwrite the filled files. The compose files are read from the
   checkout and need nothing.

**Rolling back.** Instantly, on the affected server: `docker tag astar-erp-backend:prev astar-erp-backend:production`
then `dc.sh be up -d --force-recreate` (FE: `astar-erp-frontend`, `dc.sh fe`). Or run `release.sh` with the previous
tag. Migrations only add to the schema, so older code works on the newer one.

**Rolling back the cut-over** (first days only): `dc.sh be stop` on the BE server, start the app on the current
server again (`pm2 start …`) and point users back. Changes made in the new app's user management are not carried back;
spreadsheet data is unaffected (it lives in Google Sheets).

## 13. Backup and recovery

| What | Where | How |
|---|---|---|
| Users, roles, Sheets Config, sign-in security, activity log | Volume `astar-erp-production-data` (SQLite) | `backup.sh` nightly at 01:30 server time → `/opt/astar-erp/backups/<timestamp>/`, newest 30 kept. Ask IT to include `/opt/astar-erp/backups` in the server's own backup |
| Sheet data | Google Sheets | The system of record; the mirrors are rebuilt by the sync |
| RDS schema | ApsaraDB | Automatic backups (§3); holds application data from Phase 1 |
| Settings and keys | `/opt/astar-erp/.env`, `production.env`, `secrets.production.env`, `service-accounts/`, `fe-build.env` | Copies in the password vault |
| Code | GitHub, release tags | Re-clone and check out the tag (§5) |

Restore one backup set (the API stops briefly):

```bash
/opt/astar-erp/src/deploy/production/dc.sh be stop
docker run --rm -v astar-erp-production-data:/data -v /opt/astar-erp/backups/FILL_TIMESTAMP:/restore:ro alpine sh -c 'cp /restore/*.db /data/ && rm -f /data/*.db-wal /data/*.db-shm && chown 1000:1000 /data/*.db'
/opt/astar-erp/src/deploy/production/dc.sh be start
```

## 14. Running it day to day

- Health: `curl -s http://172.28.80.51:4150/api/ready` (BE), `curl -s http://172.28.80.50:3150/api/health` (FE).
- Logs: `docker logs -f astar-erp-backend` (BE), `docker logs -f astar-erp-frontend` (FE); rotated, 5 × 10 MB.
- Containers: `/opt/astar-erp/src/deploy/production/dc.sh be ps` (FE: `dc.sh fe ps`).
- **Admin → Sheets Config**: sync status and errors per spreadsheet; **Admin → User Management / Roles** for access.
- Usage and JavaScript errors: DWS Hub → Analytic, with Sentinel's analyses.
- Containers restart by themselves after a crash or a reboot (`restart: unless-stopped`).

**Never on these shared hosts:** `systemctl restart docker`; editing `/etc/docker/daemon.json`; `docker system prune`
or any `docker * prune`; removing another application's container, network or volume; stopping or reloading the host
nginx without `nginx -t`; unmounting or remounting any NAS mount; a `Host github.com` block in `/root/.ssh/config`.

## 15. Troubleshooting

Everything in [DEPLOYMENT-STAGING.md](DEPLOYMENT-STAGING.md) §13 applies, with `astar-erp-backend` /
`astar-erp-frontend`, `/opt/astar-erp/production.env` and 172.28.80.51 in place of the staging names. Production adds:

| Symptom | Cause / fix |
|---|---|
| `STOP - /opt/astar-erp/… is missing` / `fill in the FILL_ values` | Copy and fill the file (§7, §8). |
| `set ASTAR_SUBNET in /opt/astar-erp/.env` | `.env` missing or without the subnet; take it from the preflight (§5). |
| `Pool overlaps with other one on this address space` | The subnet is taken since the preflight: run it again and use its new suggestion. |
| `STOP - the code in /opt/astar-erp/src has local changes` | Someone edited files on the server: `git -C /opt/astar-erp/src status`, undo or move the change to GitHub. |
| `STOP - release tag … does not exist` | Tag the commit and push the tag (§12). |
| `MIGRATION_BAD_URL` / `password authentication failed` / timeout | §3 and `secrets.production.env`; RDS whitelist. `--skip-migrate` deploys the app meanwhile. |
| Sheets Config: **Sync error** `caller does not have permission` / **No key on server** | The key file of that spreadsheet's account is missing from `service-accounts/` (§6, §7). |
| Users get *"awaiting ERP access approval"* although they had access | Their Hub email differs from their ERP email (§9 step 1). |
| *"DWS Hub is not reachable right now"* | The container cannot reach `dwshub.kpndomain.com` via 172.28.80.50:443 (`HUB_HOST_IP` in `be.compose.yml`, firewall). |
| Every user shows the same address in the audit log | The vhost's `X-Forwarded-For` or the container's trusted range (§8); the FE `.env` subnet must match the running network. |
| Data stops updating after the cut-over and the sheets show odd match IDs | The current server's app is running again: stop it (§6). Only one instance may sync. |
| `nginx -t` fails after copying the vhost | Remove `/etc/nginx/conf.d/aastar-logistic.conf` and reload — the other sites keep working; fix and retry. |

Logs: `docker logs -f astar-erp-backend` (BE), `docker logs -f astar-erp-frontend` (FE).
