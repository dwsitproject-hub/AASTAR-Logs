'use strict';
// Draws the Astar ERP documentation diagrams as SVG and renders them to PNG.
// Usage: node diagrams.js <outDir>
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });

const C = {
  ink: '#1d2733', muted: '#5b6b7c', line: '#7a8a9a', navy: '#1f3a5f', navyFill: '#e8eef6',
  teal: '#1f6f6b', tealFill: '#e3f2f0', amber: '#9a5a12', amberFill: '#fbf0e1', plum: '#5b3b77',
  plumFill: '#f1eaf6', grey: '#eef1f4', white: '#ffffff', red: '#a33a3a', redFill: '#fbe9e9',
};
const FONT = 'Arial';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class Svg {
  constructor(w, h) { this.w = w; this.h = h; this.parts = []; }
  add(s) { this.parts.push(s); return this; }
  text(x, y, s, { size = 13, weight = 400, fill = C.ink, anchor = 'start', italic = false } = {}) {
    return this.add(`<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${italic ? ' font-style="italic"' : ''}>${esc(s)}</text>`);
  }
  rect(x, y, w, h, { fill = C.white, stroke = C.line, rx = 6, dash = '', sw = 1.4 } = {}) {
    return this.add(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
  }
  // Box with a bold title and optional lines underneath, centred.
  box(x, y, w, h, title, lines = [], { fill = C.navyFill, stroke = C.navy, titleFill = C.navy, dash = '', size = 14 } = {}) {
    this.rect(x, y, w, h, { fill, stroke, dash });
    const total = 1 + lines.length;
    const lineH = 17;
    let ty = y + h / 2 - ((total - 1) * lineH) / 2 + 5;
    this.text(x + w / 2, ty, title, { size, weight: 700, fill: titleFill, anchor: 'middle' });
    for (const line of lines) { ty += lineH; this.text(x + w / 2, ty, line, { size: 12, fill: C.muted, anchor: 'middle' }); }
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, r: x + w, b: y + h };
  }
  arrow(x1, y1, x2, y2, { label = '', dash = '', color = C.line, labelDx = 0, labelDy = -6, both = false, size = 11 } = {}) {
    const id = `m${this.parts.length}`;
    this.add(`<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker></defs>`);
    this.add(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#${id})"${both ? ` marker-start="url(#${id})"` : ''}/>`);
    if (label) this.text((x1 + x2) / 2 + labelDx, (y1 + y2) / 2 + labelDy, label, { size, fill: C.muted, anchor: 'middle' });
    return this;
  }
  poly(points, { color = C.line, dash = '', label = '', lx, ly, end = true } = {}) {
    const id = `p${this.parts.length}`;
    this.add(`<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker></defs>`);
    this.add(`<polyline points="${points.map(p => p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ''}${end ? ` marker-end="url(#${id})"` : ''}/>`);
    if (label) this.text(lx, ly, label, { size: 11, fill: C.muted, anchor: 'middle' });
    return this;
  }
  toString() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}"><rect width="100%" height="100%" fill="#ffffff"/>${this.parts.join('')}</svg>`;
  }
}

function save(name, svg) {
  const markup = svg.toString();
  fs.writeFileSync(path.join(OUT, `${name}.svg`), markup);
  const png = new Resvg(markup, { fitTo: { mode: 'zoom', value: 2 }, font: { loadSystemFonts: true, defaultFontFamily: FONT } }).render().asPng();
  fs.writeFileSync(path.join(OUT, `${name}.png`), png);
  console.log('wrote', name, svg.w, 'x', svg.h);
}

// ---------------------------------------------------------------------------
// ERD helpers: entity boxes with PK/FK/UK markers and crow's-foot connectors
// ---------------------------------------------------------------------------
const ROW = 18;
function entity(svg, x, y, w, name, fields, { fill = C.navyFill, stroke = C.navy, note = '' } = {}) {
  const h = 26 + fields.length * ROW + 8 + (note ? 16 : 0);
  svg.rect(x, y, w, h, { fill: C.white, stroke, rx: 4 });
  svg.add(`<rect x="${x}" y="${y}" width="${w}" height="26" rx="4" fill="${stroke}"/>`);
  svg.text(x + 8, y + 18, name, { size: 13, weight: 700, fill: C.white });
  fields.forEach((f, i) => {
    const fy = y + 26 + 16 + i * ROW;
    const [col, type, key = ''] = f;
    if (key) svg.text(x + 8, fy, key, { size: 10, weight: 700, fill: key.includes('PK') ? C.amber : C.teal });
    svg.text(x + 40, fy, col, { size: 12, weight: key.includes('PK') ? 700 : 400 });
    svg.text(x + w - 8, fy, type, { size: 11, fill: C.muted, anchor: 'end' });
  });
  if (note) svg.text(x + 8, y + h - 8, note, { size: 10, fill: C.muted, italic: true });
  return { x, y, w, h, r: x + w, b: y + h, cx: x + w / 2, cy: y + h / 2, rowY: i => y + 26 + 11 + i * ROW };
}
// Crow's foot end marks drawn at (x,y) for a line arriving horizontally (dir = +1 from left, -1 from right)
function crowEnd(svg, x, y, dir, kind, color) {
  const s = 10 * dir;
  if (kind === 'many') {
    svg.add(`<path d="M${x - s},${y} L${x},${y - 7} M${x - s},${y} L${x},${y + 7} M${x - s},${y} L${x},${y}" stroke="${color}" stroke-width="1.5" fill="none"/>`);
    svg.add(`<line x1="${x - s * 1.6}" y1="${y - 7}" x2="${x - s * 1.6}" y2="${y + 7}" stroke="${color}" stroke-width="1.5"/>`);
  } else if (kind === 'one') {
    svg.add(`<line x1="${x - s * 0.6}" y1="${y - 7}" x2="${x - s * 0.6}" y2="${y + 7}" stroke="${color}" stroke-width="1.5"/>`);
    svg.add(`<line x1="${x - s * 1.1}" y1="${y - 7}" x2="${x - s * 1.1}" y2="${y + 7}" stroke="${color}" stroke-width="1.5"/>`);
  } else if (kind === 'zeroOne') {
    svg.add(`<line x1="${x - s * 0.6}" y1="${y - 7}" x2="${x - s * 0.6}" y2="${y + 7}" stroke="${color}" stroke-width="1.5"/>`);
    svg.add(`<circle cx="${x - s * 1.4}" cy="${y}" r="4" fill="#fff" stroke="${color}" stroke-width="1.5"/>`);
  }
}
// Orthogonal relationship line between two entity rows: from right side of a to left side of b (or reverse)
function rel(svg, a, ai, b, bi, aKind, bKind, { label = '', color = C.ink, dash = '', midX, side = 'auto' } = {}) {
  const ay = a.rowY(ai);
  const by = b.rowY(bi);
  let ax, bx, adir, bdir;
  const aRight = side === 'auto' ? a.r <= b.x : side === 'rl';
  if (side === 'll') { ax = a.x; bx = b.x; adir = 1; bdir = 1; }
  else if (side === 'rr') { ax = a.r; bx = b.r; adir = -1; bdir = -1; }
  else if (aRight) { ax = a.r; bx = b.x; adir = -1; bdir = 1; }
  else { ax = a.x; bx = b.r; adir = 1; bdir = -1; }
  let mx = midX;
  if (mx === undefined) {
    if (side === 'll') mx = Math.min(a.x, b.x) - 28;
    else if (side === 'rr') mx = Math.max(a.r, b.r) + 28;
    else mx = (ax + bx) / 2;
  }
  svg.add(`<polyline points="${ax},${ay} ${mx},${ay} ${mx},${by} ${bx},${by}" fill="none" stroke="${color}" stroke-width="1.4"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
  crowEnd(svg, ax, ay, adir, aKind, color);
  crowEnd(svg, bx, by, bdir, bKind, color);
  if (label) svg.text(mx + 4, (ay + by) / 2 - 4, label, { size: 10, fill: C.muted });
}

// ---------------------------------------------------------------------------
// 1. Business L0 map (PRD §3)
// ---------------------------------------------------------------------------
{
  const s = new Svg(1100, 600);
  s.text(550, 34, 'Astar ERP — L0 business process map', { size: 18, weight: 700, anchor: 'middle', fill: C.navy });
  const idm = s.box(330, 56, 440, 62, 'L0-01  Identity & Access Management', ['DWS Hub sign-in · approval · page access'], { fill: C.plumFill, stroke: C.plum, titleFill: C.plum });
  const sync = s.box(40, 250, 230, 90, 'L0-07  Master Data Sync', ['Google Sheets → ERP mirror', 'every 15 s; edits written back'], { fill: C.amberFill, stroke: C.amber, titleFill: C.amber });
  const v = s.box(370, 160, 300, 66, 'L0-03  Vessel Scheduling', ['laycan · CR · ETA/ETB/ETC · tracking']);
  const a = s.box(370, 246, 300, 66, 'L0-02  Contract-to-Vessel Allocation', ['matching · partials · unlink']);
  const st = s.box(370, 332, 300, 66, 'L0-05  Stock Monitoring', ['daily stock vs incoming vessels']);
  const d = s.box(370, 418, 300, 66, 'L0-06  Laytime & Demurrage', ['calculator · estimated demurrage']);
  const ex = s.box(790, 246, 270, 90, 'L0-04  Export Execution', ['& Reporting', 'summaries · weekly ops · KPN export'], { fill: C.tealFill, stroke: C.teal, titleFill: C.teal });
  const ops = s.box(40, 520, 1020, 54, 'L0-08  Platform Operations, Support & Audit', ['activity audit · readiness · DWS Hub analytics, bug reports and Sentinel'], { fill: C.grey, stroke: C.muted, titleFill: C.ink, dash: '6 4' });
  s.arrow(idm.cx, idm.b, idm.cx, v.y - 4, { label: 'governs access to every process', labelDx: 120, labelDy: 4 });
  for (const target of [v, a, st, d]) s.arrow(sync.r, sync.cy, target.x - 2, target.cy, { color: C.amber });
  s.arrow(v.cx - 60, v.b, a.cx - 60, a.y - 2, { label: 'slots', labelDx: -20, labelDy: 4 });
  s.poly([[v.r, v.cy], [720, v.cy], [720, d.cy], [d.r + 2, d.cy]], { label: 'ETA / ETC', lx: 752, ly: 380 });
  for (const source of [v, a, st]) s.arrow(source.r, source.cy, ex.x - 2, ex.cy, { color: C.teal });
  s.text(550, 508, 'observes all processes', { size: 11, fill: C.muted, anchor: 'middle', italic: true });
  save('prd-l0-business-map', s);
}

// ---------------------------------------------------------------------------
// 2. Target deployment: 3 servers on Alibaba Cloud
// ---------------------------------------------------------------------------
{
  const s = new Svg(1200, 700);
  s.text(600, 34, 'Target deployment — frontend server, backend server, ApsaraDB RDS for PostgreSQL 18', { size: 18, weight: 700, anchor: 'middle', fill: C.navy });
  const users = s.box(40, 185, 170, 90, 'Users', ['browser (HTTPS)', '≥ 10 concurrent'], { fill: C.grey, stroke: C.muted, titleFill: C.ink });
  s.rect(260, 70, 640, 600, { fill: '#f7f9fc', stroke: C.navy, dash: '8 5', rx: 10 });
  s.text(280, 96, 'Alibaba Cloud VPC (private subnet; only the frontend has a public endpoint)', { size: 13, weight: 700, fill: C.navy });
  const fe = s.box(300, 130, 260, 200, 'Server 1 — Frontend', ['ECS · Nginx 1.2x', 'TLS 443 (public / SLB)', 'serves frontend/dist (SPA)', 'CSP · HSTS · gzip', 'proxy /api/* and /api/ws →', 'backend :3001 (private)'], { fill: C.tealFill, stroke: C.teal, titleFill: C.teal });
  const be = s.box(300, 400, 260, 230, 'Server 2 — Backend', ['ECS · Node.js 22 LTS · PM2', 'Express API + WebSocket :3001', 'Sheets sync job (15 s)', 'single instance (in-memory', 'caches, write queue, rate limits)', 'Google service-account keys', 'outbound HTTPS only'], { fill: C.navyFill, stroke: C.navy, titleFill: C.navy });
  const db = s.box(640, 400, 230, 230, 'Server 3 — Database', ['ApsaraDB RDS', 'PostgreSQL 18', 'schemas: app · security', 'audit · mirror · links', 'SSL · whitelist = backend IP', 'auto backup + PITR', 'port 5432 (private)'], { fill: C.plumFill, stroke: C.plum, titleFill: C.plum });
  const sg = s.box(640, 130, 230, 200, 'Security groups', ['SG-FE: in 443 from internet;', 'out 3001 to SG-BE', 'SG-BE: in 3001 from SG-FE only;', 'out 443 internet, 5432 RDS', 'RDS whitelist: BE private IP', 'SSH via bastion only'], { fill: C.white, stroke: C.muted, titleFill: C.ink, size: 13 });
  const hub = s.box(960, 110, 210, 110, 'DWS Hub', ['OIDC sign-in (authorize,', 'token, JWKS) · SDK script', 'analytics · Sentinel'], { fill: C.amberFill, stroke: C.amber, titleFill: C.amber });
  const gs = s.box(960, 260, 210, 90, 'Google Sheets API', ['17 ranges read every 15 s', 'interactive writes'], { fill: C.amberFill, stroke: C.amber, titleFill: C.amber });
  const smtp = s.box(960, 390, 210, 70, 'SMTP', ['activity reports'], { fill: C.amberFill, stroke: C.amber, titleFill: C.amber });
  const vf = s.box(960, 500, 210, 70, 'VesselFinder', ['map embed (browser)'], { fill: C.amberFill, stroke: C.amber, titleFill: C.amber });
  s.arrow(users.r, users.cy, fe.x - 2, fe.cy, { label: 'HTTPS 443', labelDy: -8 });
  s.arrow(fe.cx, fe.b, be.cx, be.y - 2, { label: 'HTTP/WS 3001 (private)', labelDx: -82, labelDy: 4 });
  s.arrow(be.r, be.cy, db.x - 2, db.cy, { label: 'TLS 5432', labelDy: -8 });
  s.poly([[470, be.y], [470, 348], [915, 348], [915, hub.cy + 20], [hub.x - 2, hub.cy + 20]]);
  s.poly([[500, be.y], [500, 363], [930, 363], [930, gs.cy], [gs.x - 2, gs.cy]]);
  s.poly([[530, be.y], [530, 378], [945, 378], [945, smtp.cy], [smtp.x - 2, smtp.cy]]);
  s.text(760, 342, 'outbound HTTPS 443: Hub token/JWKS · Sheets API · SMTP', { size: 10, fill: C.muted, anchor: 'middle' });
  s.poly([[users.cx, users.y], [users.cx, 60], [hub.cx, 60], [hub.cx, hub.y - 2]], { dash: '5 4', label: 'authorize redirect · SDK beacons (browser → Hub)', lx: 620, ly: 54 });
  s.poly([[users.cx, users.b], [users.cx, 685], [vf.cx, 685], [vf.cx, vf.b + 2]], { dash: '5 4', label: 'map iframe (browser)', lx: 620, ly: 680 });
  save('tech-deployment-3-servers', s);
}

// ---------------------------------------------------------------------------
// 3. System L0 process map
// ---------------------------------------------------------------------------
{
  const s = new Svg(1200, 640);
  s.text(600, 34, 'Astar ERP — L0 system process map', { size: 18, weight: 700, anchor: 'middle', fill: C.navy });
  const browser = s.box(40, 250, 170, 110, 'Browser (SPA)', ['React 18 pages', 'Hub SDK'], { fill: C.grey, stroke: C.muted, titleFill: C.ink });
  const s1 = s.box(270, 70, 260, 70, 'SP-01  Authentication & Session', ['DWS Hub OIDC · cookie session'], { fill: C.plumFill, stroke: C.plum, titleFill: C.plum });
  const s2 = s.box(570, 70, 260, 70, 'SP-02  Authorization', ['page / tab / admin / owner checks'], { fill: C.plumFill, stroke: C.plum, titleFill: C.plum });
  const s4 = s.box(270, 200, 260, 70, 'SP-04  Query & Presentation', ['read API · dashboard caches']);
  const s5 = s.box(270, 300, 260, 70, 'SP-05  Write-back Transactions', ['serialized sheet writes']);
  const s6 = s.box(270, 400, 260, 70, 'SP-06  Realtime Notification', ['WebSocket data.updated']);
  const store = s.box(600, 230, 220, 120, 'PostgreSQL', ['mirror · links (read model)', 'app · security · audit'], { fill: C.plumFill, stroke: C.plum, titleFill: C.plum });
  const s3 = s.box(880, 230, 270, 120, 'SP-03  Data Ingestion', ['Sheets → mirror every 15 s', 'normalise · hash · swap', 'link-graph rebuild'], { fill: C.amberFill, stroke: C.amber, titleFill: C.amber });
  const gs = s.box(880, 420, 270, 60, 'Google Sheets (system of record)', [], { fill: C.amberFill, stroke: C.amber, titleFill: C.amber, size: 13 });
  const s7 = s.box(40, 530, 350, 70, 'SP-07  Audit & Security Reporting', ['activity buckets · auth events · shift reports'], { fill: C.grey, stroke: C.muted, titleFill: C.ink, dash: '6 4' });
  const s8 = s.box(420, 530, 350, 70, 'SP-08  Observability & Support', ['health/ready · logs · Hub SDK · Sentinel'], { fill: C.grey, stroke: C.muted, titleFill: C.ink, dash: '6 4' });
  const s9 = s.box(800, 530, 350, 70, 'SP-09  Build, Deploy & Operate', ['3-server release · backup · restart'], { fill: C.grey, stroke: C.muted, titleFill: C.ink, dash: '6 4' });
  s.arrow(browser.r, browser.y + 10, s1.x - 2, s1.cy, { label: 'sign-in' });
  s.arrow(s1.r, s1.cy, s2.x - 2, s2.cy);
  s.arrow(s2.cx, s2.b, store.cx, store.y - 2, { label: 'user row', labelDx: -36, labelDy: 10 });
  s.arrow(browser.r, browser.cy - 10, s4.x - 2, s4.cy, { label: 'GET', both: true });
  s.arrow(browser.r, browser.cy + 20, s5.x - 2, s5.cy, { label: 'POST' });
  s.arrow(s6.x - 2, s6.cy, browser.r, browser.b - 10, { label: 'push' });
  s.arrow(s4.r, s4.cy, store.x - 2, store.y + 20, { label: 'read' });
  s.poly([[s5.r, s5.cy], [560, s5.cy], [560, 450], [gs.x - 2, 450]], { label: 'write (Sheets API)', lx: 720, ly: 444 });
  s.arrow(gs.cx, gs.y, s3.cx, s3.b + 2, { label: 'batchGet', labelDx: 36, labelDy: 4 });
  s.arrow(s3.x, s3.cy, store.r + 2, store.cy, { label: 'rebuild' });
  s.poly([[s3.cx, s3.y], [s3.cx, 170], [s4.cx, 170], [s4.cx, s4.y - 2]], { label: 'invalidate caches', lx: 930, ly: 164, dash: '4 3' });
  s.arrow(s5.cx, s5.b, s6.cx, s6.y - 2, { label: 'broadcast', labelDx: 40, labelDy: 4 });
  s.poly([[s3.x, s3.b - 15], [850, s3.b - 15], [850, 498], [s6.cx + 60, 498], [s6.cx + 60, s6.b + 2]], { dash: '4 3', label: 'broadcast after sync', lx: 700, ly: 492 });
  s.text(600, 522, 'cross-cutting processes (all components)', { size: 11, fill: C.muted, anchor: 'middle', italic: true });
  save('tech-l0-system-map', s);
}

// ---------------------------------------------------------------------------
// 4. ERD — application, security and audit schemas (PostgreSQL target)
// ---------------------------------------------------------------------------
{
  const s = new Svg(1400, 980);
  s.text(700, 32, 'ERD 1 — application, security and audit data (PostgreSQL schemas app · security · audit)', { size: 18, weight: 700, anchor: 'middle', fill: C.navy });
  s.text(700, 54, 'PK primary key · UK unique · FK foreign key · (FK) logical reference, not enforced so audit rows survive user deletion', { size: 12, anchor: 'middle', fill: C.muted });
  const P = { fill: C.plumFill, stroke: C.plum };
  const N = { stroke: C.navy };
  const T = { stroke: C.teal };
  const G = { stroke: C.muted };
  const users = entity(s, 540, 80, 300, 'app.users', [
    ['id', 'bigint', 'PK'], ['username', 'text', 'UK'], ['email', 'text', 'UK'], ['google_sub', 'text', 'UK'], ['hub_sub', 'text', 'UK'],
    ['is_admin', 'boolean'], ['is_approved', 'boolean'], ['permissions', 'jsonb'], ['tab_permissions', 'jsonb'], ['auth_version', 'integer'], ['created_at / updated_at', 'timestamptz'],
  ], N);
  const sessions = entity(s, 960, 80, 300, 'app.user_sessions  (planned)', [
    ['jti', 'uuid', 'PK'], ['user_id', 'bigint', 'FK'], ['auth_method', 'text'], ['issued_at', 'timestamptz'], ['expires_at', 'timestamptz'], ['revoked_at', 'timestamptz'],
  ], N);
  const mig = entity(s, 60, 80, 280, 'app.app_migrations', [['name', 'text', 'PK'], ['applied_at', 'timestamptz']], G);
  const cfg = entity(s, 60, 190, 280, 'app.sheets_config  (legacy)', [
    ['id', 'bigint', 'PK'], ['sheet_id', 'text'], ['tab_name', 'text'], ['department', 'text'], ['range / render_format', 'text'],
  ], G);
  const auth = entity(s, 960, 300, 330, 'audit.authentication_events  ‖ month', [
    ['id, occurred_at', 'bigint, tstz', 'PK'], ['user_id', 'bigint', '(FK)'], ['auth_method', 'text'], ['result / reason', 'text'], ['ip_address', 'inet'], ['country … device', 'text'],
  ], T);
  const cookie = entity(s, 960, 470, 330, 'audit.session_cookie_events  ‖ month', [
    ['id, occurred_at', 'bigint, tstz', 'PK'], ['user_id', 'bigint', '(FK)'], ['event_type', 'text'], ['session_fingerprint', 'text'], ['expires_at', 'timestamptz'], ['ip_address', 'inet'],
  ], T);
  const action = entity(s, 960, 640, 330, 'audit.user_action_events  ‖ month', [
    ['id, occurred_at', 'bigint, tstz', 'PK'], ['user_id', 'bigint', '(FK)'], ['method / path', 'text'], ['status_code / duration_ms', 'integer'], ['changed_fields', 'jsonb'], ['ip_address', 'inet'],
  ], T);
  const daily = entity(s, 540, 400, 300, 'audit.daily_user_activity', [
    ['activity_date', 'date', 'PK'], ['session_id', 'text', 'PK'], ['user_id', 'bigint', '(FK)'], ['username', 'text'], ['ip_address', 'inet'], ['first/last_seen_at', 'timestamptz'], ['request_count / login_count', 'integer'],
  ], T);
  const bucket = entity(s, 540, 600, 300, 'audit.activity_time_buckets', [
    ['bucket_start', 'timestamptz', 'PK'], ['session_id', 'text', 'PK'], ['user_id', 'bigint', '(FK)'], ['username', 'text'], ['ip_address', 'inet'], ['request_count / login_count', 'integer'],
  ], T);
  const ipsec = entity(s, 60, 360, 300, 'security.login_ip_security', [
    ['ip_address', 'inet', 'PK'], ['failed_attempts', 'integer'], ['first/last_failed_at', 'timestamptz'], ['is_blocked', 'boolean'], ['blocked_at / reason', 'tstz / text'], ['unlocked_at / by', 'tstz / text'],
  ], P);
  const allow = entity(s, 60, 560, 300, 'security.login_ip_allowlist', [['ip_address', 'inet', 'PK'], ['label', 'text'], ['created_at', 'timestamptz'], ['created_by', 'text']], P);
  const failed = entity(s, 60, 720, 300, 'audit.failed_login_attempts  ‖ month', [
    ['id, occurred_at', 'bigint, tstz', 'PK'], ['username', 'text'], ['ip_address', 'inet', '(FK)'], ['country … device', 'text'],
  ], T);
  const page = entity(s, 540, 800, 300, 'audit.page_visit_events  ‖ month', [['id, occurred_at', 'bigint, tstz', 'PK'], ['page / path', 'text'], ['referrer', 'text'], ['ip_address', 'inet']], T);
  const rr = entity(s, 960, 810, 330, 'audit.report_runs · periodic_report_runs', [['activity_date | window_end', 'date | tstz', 'PK'], ['recipient / status', 'text'], ['started_at / sent_at', 'timestamptz'], ['error', 'text']], G);

  rel(s, users, 0, sessions, 1, 'one', 'many');
  s.text(900, 74, 'revocable sessions', { size: 10, fill: C.muted, anchor: 'middle' });
  rel(s, users, 0, auth, 1, 'zeroOne', 'many', { dash: '5 4', midX: 900 });
  rel(s, users, 0, cookie, 1, 'zeroOne', 'many', { dash: '5 4', midX: 900 });
  rel(s, users, 0, action, 1, 'zeroOne', 'many', { dash: '5 4', midX: 900 });
  rel(s, users, 0, daily, 2, 'zeroOne', 'many', { dash: '5 4', side: 'll', midX: 500 });
  rel(s, users, 0, bucket, 2, 'zeroOne', 'many', { dash: '5 4', side: 'll', midX: 500 });
  rel(s, ipsec, 0, failed, 2, 'zeroOne', 'many', { dash: '5 4', side: 'll', midX: 36 });
  // Apps Script bridge (isolated proof of concept)
  const rows = entity(s, 60, 880, 300, 'app.apps_script_sheet_rows / _outbox', [['record_id', 'text', 'PK'], ['values_json', 'jsonb']], G);
  void allow; void mig; void cfg; void page; void rr; void rows;
  s.text(700, 968, '‖ month = range-partitioned by occurred_at (monthly partitions + default partition; retention by dropping partitions)', { size: 11, fill: C.muted, anchor: 'middle', italic: true });
  save('erd-application', s);
}

// ---------------------------------------------------------------------------
// 5. ERD — business read model (mirror + links)
// ---------------------------------------------------------------------------
{
  const s = new Svg(1470, 1090);
  s.text(735, 32, 'ERD 2 — business read model (Google Sheets mirrors in schema mirror, derived graph in schema links)', { size: 18, weight: 700, anchor: 'middle', fill: C.navy });
  s.text(735, 54, 'Relationships are logical (by VSL ID / Match ID values copied from the sheets); the sheets enforce none of them', { size: 12, anchor: 'middle', fill: C.muted });
  const A = { stroke: C.amber };
  const N = { stroke: C.navy };
  const T = { stroke: C.teal };
  const G = { stroke: C.muted };
  const vessel = entity(s, 40, 90, 330, 'VESSEL  mirror.db6_vessel_db', [
    ['_sheet_row', 'integer', 'PK'], ['vsl_id', 'text', 'UK'], ['charterer / entity', 'text'], ['vessel / voyage', 'text'], ['imo / mmsi', 'text'], ['status / ops', 'text'],
    ['demm_rate / laytime_rate', 'text'], ['laytime_starts / remarks', 'text'], ['latitude / longitude', 'text'], ['nominated', 'text'],
  ], N);
  const port = entity(s, 40, 380, 330, 'PORT CALL  (10 blocks per vessel row)', [
    ['slot vsl_id (vslid_n)', 'text', 'PK'], ['vessel vsl_id', 'text', 'FK'], ['port_no', '1..10'], ['port_name', 'text', 'FK'], ['status L/D · open/closed', 'text'], ['shipper / entity', 'text'],
    ['qty / l_cargo', 'text', 'FK'], ['laycan / cr', 'text'], ['eta · etb · etc (+time)', 'text'],
  ], N);
  s.text(48, 380 + 26 + 9 * ROW + 26, 'view mirror.v_port_calls unpivots the 10 port blocks', { size: 10, fill: C.muted, italic: true });
  const vlink = entity(s, 520, 300, 340, 'VESSEL LINK  mirror.db10_vessel_links_source', [
    ['_sheet_row', 'integer', 'PK'], ['match_id', 'text', 'FK'], ['source_tab', 'text'], ['contract_ref', 'text'], ['parent_match_id', 'text', 'FK'], ['vsl_id (slot)', 'text', 'FK'],
    ['active', 'TRUE/FALSE'], ['created_at / updated_at', 'text'], ['updated_by', 'text'],
  ], A);
  s.text(528, 300 + 26 + 9 * ROW + 26, 'authoritative assignment ledger (latest row per match_id wins)', { size: 10, fill: C.muted, italic: true });
  const contract = entity(s, 1010, 330, 370, 'CONTRACT  (one of 5 source tables)', [
    ['*_erp_match_id', 'text', 'PK'], ['*_ref / *_contract_no', 'text'], ['counterparty (buyer / seller)', 'text'], ['*_cargo / *_qty / *_tolerance', 'text'], ['shipment period / load port', 'text'],
    ['*_status / payment terms', 'text'], ['*_partial / *_partial_qty', 'text'], ['*_vsl_id (legacy mirror)', 'text'], ['_<prefix>_row', 'integer'],
  ], T);
  const sources = [
    ['db1_aastar_sales_with_shadow', 'AASTAR SALES (sales_*)'],
    ['db2_aastar_purchase_with_shadow', 'AASTAR PURCHASE (purchase_*)'],
    ['db3_kimara_sales_with_shadow', 'KIMARA SALES (kimara_sales_*)'],
    ['db4_kimara_purchase_with_shadow', 'KIMARA PURCHASE (kimara_purchase_*)'],
    ['db5_main_shipment_file_with_shadow_gr', 'GR MAIN SHIPMENT FILE (main_*)'],
  ];
  s.rect(1010, 70, 370, 222, { fill: C.tealFill, stroke: C.teal, rx: 4 });
  s.text(1020, 90, 'CONTRACT sources (mirror schema)', { size: 12, weight: 700, fill: C.teal });
  sources.forEach(([t, d], i) => { s.text(1020, 112 + i * 36, t, { size: 11, weight: 700 }); s.text(1030, 126 + i * 36, d, { size: 10, fill: C.muted }); });
  s.arrow(1195, 292, 1195, 328, { color: C.teal });

  rel(s, vessel, 1, port, 1, 'one', 'many', { side: 'll', midX: 22, label: '1 : 0..10' });
  rel(s, port, 0, vlink, 5, 'one', 'many', { label: 'slot has links' });
  rel(s, contract, 0, vlink, 1, 'one', 'many', { label: 'contract assigned' });
  rel(s, contract, 0, contract, 6, 'one', 'many', { side: 'rr', midX: 1400 });
  s.text(1408, 405, 'partials', { size: 10, fill: C.muted });
  s.text(1408, 418, '(parent_', { size: 10, fill: C.muted });
  s.text(1408, 431, 'match_id)', { size: 10, fill: C.muted });

  // Derived graph
  const pn = entity(s, 520, 620, 300, 'links.parent_nodes', [['node_id', 'text', 'PK'], ['vsl_id (slot)', 'text', 'FK'], ['database / table', 'text'], ['source_row / column', 'text']], G);
  const ln = entity(s, 520, 790, 300, 'links.links', [['link_id', 'bigint', 'PK'], ['parent_node_id', 'text', 'FK'], ['child_node_id', 'text', 'FK'], ['vsl_id', 'text']], G);
  const cn = entity(s, 1010, 680, 370, 'links.child_nodes', [['node_id', 'text', 'PK'], ['vsl_id', 'text'], ['database / table', 'text'], ['source_row / column', 'text'], ['matched_parent_count', 'integer']], G);
  rel(s, pn, 0, ln, 1, 'one', 'many', { side: 'll', midX: 494 });
  rel(s, cn, 0, ln, 2, 'one', 'many');
  rel(s, port, 0, pn, 1, 'one', 'zeroOne', { dash: '5 4', label: 'derived from' });
  rel(s, contract, 8, cn, 0, 'one', 'zeroOne', { dash: '5 4', side: 'rr', midX: 1440 });

  // Reference / standalone mirrors
  const abv = entity(s, 40, 690, 330, 'mirror.db8_abv  (dropdown lists)', [['port', 'text', 'PK'], ['cargo', 'text']], A);
  rel(s, port, 3, abv, 0, 'many', 'zeroOne', { side: 'll', midX: 20 });
  entity(s, 40, 800, 330, 'mirror.db7_eom  (end-of-month stock)', [['section / month', 'text'], ['cargo quantities', 'text']], A);
  entity(s, 40, 910, 330, 'mirror.db9_stock_monthly  (raw grid)', [['_sheet_row', 'integer', 'PK'], ['c1 … c14', 'text']], A);
  s.rect(520, 930, 860, 82, { fill: C.grey, stroke: C.muted, rx: 4 });
  s.text(530, 952, 'Standalone mirrors (no keys to the vessel model)', { size: 12, weight: 700 });
  s.text(530, 974, 'db12_tpg_imports · db13_tpg_local_purchase · db14_tpg_local_sales · db15_glm_imports · db16_glm_local_purchase · db17_glm_local_sales', { size: 11 });
  s.text(530, 994, '→ Weekly Ops Meeting cards.   db11_shpt_details → synced, not used by any page.   Every table has a row in mirror.database_meta and mirror.column_map.', { size: 11, fill: C.muted });
  save('erd-business', s);
}

// ---------------------------------------------------------------------------
// Sequence diagram helper
// ---------------------------------------------------------------------------
function sequence(name, title, actors, messages, { width = 1200, gap = 34 } = {}) {
  const top = 70;
  const height = top + 60 + messages.length * gap + 40;
  const s = new Svg(width, height);
  s.text(width / 2, 34, title, { size: 18, weight: 700, anchor: 'middle', fill: C.navy });
  const step = (width - 220) / (actors.length - 1);
  const xs = actors.map((_, i) => 110 + i * step);
  actors.forEach((a, i) => {
    s.box(xs[i] - 85, top, 170, 44, a.name, a.sub ? [a.sub] : [], { fill: a.fill || C.navyFill, stroke: a.stroke || C.navy, titleFill: a.stroke || C.navy, size: 13 });
    s.add(`<line x1="${xs[i]}" y1="${top + 44}" x2="${xs[i]}" y2="${height - 20}" stroke="#c3ccd6" stroke-width="1.2" stroke-dasharray="4 4"/>`);
  });
  messages.forEach((m, i) => {
    const y = top + 70 + i * gap;
    if (m.note) {
      const half = Math.max(80, m.note.length * 3.2 + 12);
      const x1 = xs[m.from] - half;
      const x2 = xs[m.to ?? m.from] + half;
      s.rect(x1, y - 14, x2 - x1, 22, { fill: '#fffbe6', stroke: '#d9c46a', rx: 3 });
      s.text((x1 + x2) / 2, y + 2, m.note, { size: 11, anchor: 'middle' });
      return;
    }
    const x1 = xs[m.from];
    const x2 = xs[m.to];
    if (m.from === m.to) {
      s.poly([[x1, y - 8], [x1 + 40, y - 8], [x1 + 40, y + 6], [x1 + 4, y + 6]], { color: m.color || C.ink });
      s.text(x1 + 48, y + 2, m.label, { size: 11 });
      return;
    }
    s.arrow(x1, y, x2 + (x2 > x1 ? -3 : 3), y, { color: m.color || C.ink, dash: m.reply ? '5 4' : '' });
    s.text((x1 + x2) / 2, y - 6, m.label, { size: 11, anchor: 'middle', fill: m.color || C.ink });
  });
  save(name, s);
}

// 6. SSO sequence
sequence('seq-sso-login', 'SP-01 — DWS Hub sign-in (authorization code + PKCE S256)', [
  { name: 'Browser', fill: C.grey, stroke: C.muted },
  { name: 'Frontend', sub: 'Nginx', fill: C.tealFill, stroke: C.teal },
  { name: 'Backend', sub: 'Express :3001' },
  { name: 'DWS Hub', sub: 'OIDC provider', fill: C.amberFill, stroke: C.amber },
  { name: 'PostgreSQL', sub: 'app / audit', fill: C.plumFill, stroke: C.plum },
], [
  { from: 0, to: 1, label: 'GET /api/auth/sso/login?next=/logistics/…' },
  { from: 1, to: 2, label: 'proxy' },
  { from: 2, to: 3, label: 'GET /.well-known/openid-configuration (cached 1 h)' },
  { from: 2, to: 2, label: 'state, nonce, PKCE verifier → sealed __Host-erp_sso cookie (10 min)' },
  { from: 2, to: 0, label: '302 → Hub /authorize?code_challenge=S256(verifier)&state&nonce', reply: true },
  { from: 0, to: 3, label: 'authorize (user signs in at the Hub)' },
  { from: 3, to: 0, label: '302 → /api/auth/sso/callback?code&state', reply: true },
  { from: 0, to: 2, label: 'GET callback (via Nginx) + transaction cookie' },
  { note: 'state must equal the sealed cookie; cookie cleared (single use)', from: 2 },
  { from: 2, to: 3, label: 'POST /api/sso/token {code, code_verifier, client_id, redirect_uri}' },
  { from: 3, to: 2, label: '{ id_token } (expires_in 60 s)', reply: true },
  { from: 2, to: 3, label: 'GET /api/sso/jwks (jose cache; refetch on unknown kid)' },
  { note: 'verify signature · iss · aud · exp · sub · nonce; email domain allow-list', from: 2 },
  { from: 2, to: 4, label: 'find users by hub_sub → else link by email → else insert pending' },
  { from: 2, to: 4, label: 'INSERT audit.authentication_events (dws-hub, result)' },
  { from: 2, to: 0, label: 'approved: Set-Cookie __Host-erp_session (8 h) + 302 next  |  pending: 302 /login?sso_error=pending', reply: true },
  { from: 0, to: 2, label: 'GET /api/auth/me → user + csrfToken; DwsHub.identify({ id: sub, email })' },
], { gap: 36 });

// 7. Sync pipeline
{
  const s = new Svg(1200, 420);
  s.text(600, 34, 'SP-03 — Google Sheets ingestion pipeline (every 15 s, one run at a time)', { size: 18, weight: 700, anchor: 'middle', fill: C.navy });
  const steps = [
    ['1 Timer tick', ['skip if a run', 'is in progress']],
    ['2 Group sources', ['by spreadsheet +', 'service account']],
    ['3 batchGet', ['UNFORMATTED values', 'serial dates, 60 s timeout']],
    ['4 Normalise', ['fill-down merged rows', 'Match-ID repair', 'identifier cleanup']],
    ['5 Hash compare', ['unchanged → stop', 'failed range → keep', 'old data']],
  ];
  const steps2 = [
    ['6 Load staging', ['COPY into', 'mirror.<t>__staging']],
    ['7 Swap', ['one short txn: DROP', 'old, RENAME staging,', 'meta.version + 1']],
    ['8 Link graph', ['rebuild links.* if', 'DB1-6 / DB10 changed']],
    ['9 Invalidate', ['dashboard caches', 'keyed by version']],
    ['10 Broadcast', ['data.updated to', 'permitted sockets']],
  ];
  const w = 200, h = 96, gx = 30;
  const row = (list, y, fill, stroke) => list.map(([t, l], i) => s.box(40 + i * (w + gx), y, w, h, t, l, { fill, stroke, titleFill: stroke, size: 13 }));
  const r1 = row(steps, 80, C.amberFill, C.amber);
  const r2 = row(steps2, 270, C.navyFill, C.navy);
  for (let i = 0; i < 4; i++) { s.arrow(r1[i].r, r1[i].cy, r1[i + 1].x - 2, r1[i + 1].cy); s.arrow(r2[i].r, r2[i].cy, r2[i + 1].x - 2, r2[i + 1].cy); }
  s.poly([[r1[4].cx, r1[4].b], [r1[4].cx, 230], [r2[0].cx, 230], [r2[0].cx, r2[0].y - 2]], { label: 'changed databases only', lx: 600, ly: 224 });
  s.text(600, 400, 'Target (PostgreSQL): readers keep reading the old table until step 7 commits — no torn reads. Today (SQLite): temp file + atomic rename.', { size: 12, anchor: 'middle', fill: C.muted, italic: true });
  save('flow-sync-pipeline', s);
}

// 8. Write path sequence
sequence('seq-write-path', 'SP-05 — interactive write (Vessel Update save / create / delete, Vessel Matching, Contract Unlink)', [
  { name: 'Browser', fill: C.grey, stroke: C.muted },
  { name: 'Backend route', sub: 'routes/sheets.js' },
  { name: 'Mutation queue', sub: 'sheetMutations.js', fill: C.tealFill, stroke: C.teal },
  { name: 'Google Sheets', fill: C.amberFill, stroke: C.amber },
  { name: 'PostgreSQL', sub: 'mirror / links', fill: C.plumFill, stroke: C.plum },
  { name: 'Other browsers', fill: C.grey, stroke: C.muted },
], [
  { from: 0, to: 1, label: 'POST /api/sheets/vessel-update/save  (X-ERP-CSRF)' },
  { note: 'requireAuth → CSRF → page access (/logistics/vessel-update)', from: 1 },
  { from: 1, to: 2, label: 'runSheetMutation(task)  — waits ≤ 10 s' },
  { from: 2, to: 0, label: 'queue wait > 10 s → 409 SHEET_BUSY "try again"', reply: true, color: C.red },
  { from: 2, to: 3, label: 'values.get A1:A (live row identity)' },
  { note: 'rows whose live VSL ID ≠ snapshot are skipped (reported back)', from: 2 },
  { from: 2, to: 3, label: 'values.batchUpdate (60 s timeout)' },
  { from: 2, to: 4, label: 'update mirror row; reconcile DB10 links for released / moved slots' },
  { from: 2, to: 5, label: 'broadcast data.updated (resource vessel-update)' },
  { from: 2, to: 0, label: '200 { saved, skipped, clearedMatches, remappedMatches }', reply: true },
  { from: 1, to: 1, label: '+500 ms: background full refresh (SP-03)' },
], { width: 1300, gap: 38 });
