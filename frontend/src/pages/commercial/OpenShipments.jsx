import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import vesselSilhouette from '../../assets/vessel-silhouette.png';
import { getShipmentBasis } from './openShipmentsBasis';

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const text = value => (value == null ? '' : String(value).trim());
const norm = value => text(value).toLowerCase();
const baseVslId = value => text(value).replace(/_\d+$/, '');
const fmtQty = value => {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString('en-US', { maximumFractionDigits: 3 }) : '0';
};
const fmtTons = value => `${fmtQty(value)} t`;
const fmtDemm = value => {
  const raw = text(value);
  if (!raw || raw.toUpperCase() === 'TBA') return raw || '-';
  const number = Number(raw.replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? `USD ${number.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : raw;
};

function trackingIdentifier(value, length) {
  const digits = text(value).replace(/\D/g, '');
  return digits.length === length ? digits : '';
}

function trackingLinks(imoValue, mmsiValue) {
  const imo = trackingIdentifier(imoValue, 7);
  const mmsi = trackingIdentifier(mmsiValue, 9);
  const query = imo ? `imo=${imo}` : mmsi ? `mmsi=${mmsi}` : '';
  const marinePath = imo ? `imo:${imo}` : mmsi ? `mmsi:${mmsi}` : '';
  return {
    vesselFinder: query ? `https://www.vesselfinder.com/?${query}` : '',
    marineTraffic: marinePath ? `https://www.marinetraffic.com/en/ais/details/ships/${marinePath}` : '',
    identifier: imo ? `IMO ${imo}` : mmsi ? `MMSI ${mmsi}` : ''
  };
}

function parseDate(value, monthHint = null) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  const raw = text(value);
  if (!raw || raw === '-' || raw === '—') return null;
  const iso = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const months = Object.fromEntries(MONTHS.map((month, index) => [month.toLowerCase(), index]));
  const monthIndex = name => months[text(name).slice(0, 3).toLowerCase()];
  const dayMonth = raw.match(/(\d{1,2})\s*[-/ ]?\s*([A-Za-z]{3,})/);
  if (dayMonth && monthIndex(dayMonth[2]) != null) return Date.UTC(new Date().getUTCFullYear(), monthIndex(dayMonth[2]), Number(dayMonth[1]));
  const monthDay = raw.match(/([A-Za-z]{3,})\s*[-/ ]?\s*(\d{1,2})/);
  if (monthDay && monthIndex(monthDay[1]) != null) return Date.UTC(new Date().getUTCFullYear(), monthIndex(monthDay[1]), Number(monthDay[2]));
  if (/^\d{1,2}$/.test(raw) && monthHint != null) return Date.UTC(new Date().getUTCFullYear(), monthHint, Number(raw));
  const native = Date.parse(raw);
  return Number.isNaN(native) ? null : Date.UTC(new Date(native).getUTCFullYear(), new Date(native).getUTCMonth(), new Date(native).getUTCDate());
}

function dateRange(value) {
  const raw = text(value).replace(/[–—]/g, '-');
  if (!raw) return null;
  const parts = raw.split(/\s+-\s+/).filter(Boolean);
  if (parts.length < 2) {
    const one = parseDate(raw);
    return one == null ? null : [one, one];
  }
  const start = parseDate(parts[0]);
  const end = parseDate(parts[parts.length - 1], start == null ? null : new Date(start).getUTCMonth());
  if (start == null && end == null) return null;
  return [start == null ? end : start, end == null ? start : end];
}

function fmtDate(value) {
  const timestamp = typeof value === 'number' ? value : parseDate(value);
  if (timestamp == null) return '—';
  const date = new Date(timestamp);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function formatUpdated(value) {
  if (!value) return 'connecting...';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Singapore' }).format(date);
}

function shortPort(value) { return text(value).split(',')[0] || 'Unassigned'; }

function contractRange(row) {
  const ranges = [...(row.salesContracts || []), ...(row.purchaseContracts || [])].map(contract => {
    const start = parseDate(contract.periodStart);
    const end = parseDate(contract.periodEnd) || start;
    return start == null && end == null ? null : [start || end, end || start];
  }).filter(Boolean);
  return ranges.length ? [Math.min(...ranges.map(range => range[0])), Math.max(...ranges.map(range => range[1]))] : null;
}

function mergeLegRows(rows) {
  const map = new Map();
  rows.forEach(row => {
    const key = row.vslId || `${row.loadport || 'unassigned'}-${row.laycan || ''}`;
    if (!map.has(key)) map.set(key, { ...row, cargoes: [], salesContracts: [], purchaseContracts: [], loadedQty: 0, salesQty: 0, purchaseQty: 0 });
    const merged = map.get(key);
    if (row.cargo && !merged.cargoes.includes(row.cargo)) merged.cargoes.push(row.cargo);
    merged.loadedQty += Number(row.loadedQty || 0);
    merged.salesQty += Number(row.salesQty || 0);
    merged.purchaseQty += Number(row.purchaseQty || 0);
    merged.salesContracts.push(...(row.salesContracts || []));
    merged.purchaseContracts.push(...(row.purchaseContracts || []));
    if (!merged.laycan && row.laycan) merged.laycan = row.laycan;
    if (!merged.eta && row.eta) merged.eta = row.eta;
    if (!merged.etb && row.etb) merged.etb = row.etb;
    if (!merged.etc && row.etc) merged.etc = row.etc;
    if (!merged.dischargePorts?.length && row.dischargePorts?.length) merged.dischargePorts = row.dischargePorts;
  });
  return Array.from(map.values()).map(row => ({
    ...row,
    cargo: row.cargoes.join(', '),
    salesContracts: Array.from(new Map(row.salesContracts.map(contract => [`${contract.id || contract.contractNo}-${contract.qty}`, contract])).values()),
    purchaseContracts: Array.from(new Map(row.purchaseContracts.map(contract => [`${contract.id || contract.contractNo}-${contract.qty}`, contract])).values())
  })).sort((a, b) => (parseDate(a.eta) || parseDate(a.laycan) || Infinity) - (parseDate(b.eta) || parseDate(b.laycan) || Infinity));
}

function rowFlags(row) {
  const flags = [];
  if (!(row.salesContracts || []).length) flags.push({ label: 'UNALLOCATED', tone: 'amber', attention: false });
  if (!text(row.vessel) || /^tbn$/i.test(text(row.vessel).replace(/^mt\s+/i, ''))) flags.push({ label: 'TBN', tone: 'red', attention: true });
  return flags;
}

function makeGroup(key, rows) {
  const legRows = mergeLegRows(rows);
  const first = rows[0] || {};
  const dates = legRows.flatMap(row => [parseDate(row.eta), parseDate(row.laycan), contractRange(row)?.[0]].filter(Boolean));
  return {
    key, vessel: first.vessel || 'TBN', vslId: baseVslId(first.vslId), entity: first.entity || '', status: first.status || 'OPEN',
    imo: first.imo || '', mmsi: first.mmsi || '', nominated: first.nominated, demmurage: first.demmurage, legRows,
    flags: Array.from(new Map(legRows.flatMap(rowFlags).map(flag => [flag.label, flag])).values()),
    volume: legRows.reduce((sum, row) => sum + Number(row.salesQty || 0), 0), calls: legRows.length, firstDate: Math.min(...dates, Infinity)
  };
}

function buildVesselGroups(rows) {
  const map = new Map();
  rows.forEach(row => {
    const key = baseVslId(row.vslId) || text(row.vessel) || `vessel-${map.size}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return Array.from(map, ([key, groupRows]) => makeGroup(key, groupRows)).sort((a, b) => (a.firstDate || Infinity) - (b.firstDate || Infinity) || norm(a.vessel).localeCompare(norm(b.vessel)));
}

function groupBuckets(rows, view) {
  if (view === 'vessel') return [{ heading: '', groups: buildVesselGroups(rows) }];
  const bucketMap = new Map();
  rows.forEach(row => {
    const keys = view === 'buyer' ? Array.from(new Set((row.salesContracts || []).map(contract => text(contract.counterparty) || 'Unallocated buyer'))) : [text(row.loadport) || 'Unassigned loadport'];
    (keys.length ? keys : ['Unallocated buyer']).forEach(key => {
      if (!bucketMap.has(key)) bucketMap.set(key, []);
      bucketMap.get(key).push(row);
    });
  });
  return Array.from(bucketMap, ([heading, bucketRows]) => ({ heading, groups: buildVesselGroups(bucketRows) })).sort((a, b) => (a.groups[0]?.firstDate || Infinity) - (b.groups[0]?.firstDate || Infinity) || norm(a.heading).localeCompare(norm(b.heading)));
}

function axisForRows(rows) {
  const values = [];
  rows.forEach(row => [dateRange(row.laycan), contractRange(row), [row.cr, row.eta, row.etb, row.etc].map(parseDate)].flat(Infinity).filter(value => value != null).forEach(value => values.push(value)));
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const lo = (values.length ? Math.min(...values) : today - 14 * DAY) - DAY;
  const hi = (values.length ? Math.max(...values) : today + 45 * DAY) + 14 * DAY;
  return { lo, hi, width: Math.max(430, Math.round((hi - lo) / DAY) * 6 + 96) };
}

function percent(timestamp, axis) { return Math.max(0, Math.min(100, ((timestamp - axis.lo) / (axis.hi - axis.lo)) * 100)); }

function Marker({ type, value, axis }) {
  const timestamp = parseDate(value);
  if (timestamp == null) return null;
  return <span className={`timeline-marker marker-${type}`} style={{ left: `${percent(timestamp, axis)}%` }} title={`${type.toUpperCase()} ${fmtDate(timestamp)}`} />;
}

function TrackGrid({ axis }) {
  const ticks = [];
  const start = Math.ceil(axis.lo / DAY) * DAY;
  for (let timestamp = start; timestamp <= axis.hi; timestamp += DAY) {
    const date = new Date(timestamp);
    ticks.push(<span key={timestamp} className={`timeline-grid${date.getUTCDate() === 1 ? ' month' : ''}`} style={{ left: `${percent(timestamp, axis)}%` }} />);
  }
  return ticks;
}

function Ruler({ axis }) {
  const labels = [];
  const start = Math.ceil(axis.lo / DAY) * DAY;
  const days = Math.round((axis.hi - axis.lo) / DAY);
  const step = days <= 20 ? 2 : days <= 60 ? 5 : 7;
  for (let timestamp = start, index = 0; timestamp <= axis.hi; timestamp += DAY, index += 1) {
    const date = new Date(timestamp);
    const month = date.getUTCDate() === 1;
    if (month || index % step === 0) labels.push(<span key={timestamp} className={`ruler-label${month ? ' month' : ''}`} style={{ left: `${percent(timestamp, axis)}%` }}>{month ? MONTHS[date.getUTCMonth()] : date.getUTCDate()}</span>);
  }
  return <div className="timeline-ruler">{labels}</div>;
}

function Timeline({ row, axis }) {
  const shipment = contractRange(row);
  const laycan = dateRange(row.laycan);
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const milestones = [['CR', row.cr, 'cr'], ['ETA', row.eta, 'eta'], ['ETB', row.etb, 'etb'], ['ETC', row.etc, 'etc']];
  return <div className="timeline-stack">
    <div className="milestone-labels">{milestones.map(([label, value, type]) => <div className={`milestone-label ${type}`} key={label}><span>{label}</span><b className="mono">{value ? fmtDate(parseDate(value)) : '—'}</b></div>)}</div>
    <div className="timeline-track">
      <TrackGrid axis={axis} />
      {shipment && <span className="timeline-bar shipment" title={`Shipment period ${fmtDate(shipment[0])} - ${fmtDate(shipment[1])}`} style={{ left: `${percent(shipment[0], axis)}%`, width: `${Math.max(percent(shipment[1], axis) - percent(shipment[0], axis), 1.5)}%` }} />}
      {laycan && <span className="timeline-bar laycan" title={`Laycan ${fmtDate(laycan[0])} - ${fmtDate(laycan[1])}`} style={{ left: `${percent(laycan[0], axis)}%`, width: `${Math.max(percent(laycan[1], axis) - percent(laycan[0], axis), 1.5)}%` }} />}
      <Marker type="cr" value={row.cr} axis={axis} /><Marker type="eta" value={row.eta} axis={axis} /><Marker type="etb" value={row.etb} axis={axis} /><Marker type="etc" value={row.etc} axis={axis} />
      <span className="timeline-today" style={{ left: `${percent(today, axis)}%` }} title={`Today ${fmtDate(today)}`} />
    </div>
    <div className="timeline-windows"><span><b>Laycan</b> {laycan ? `${fmtDate(laycan[0])} - ${fmtDate(laycan[1])}` : '—'}</span><span><b>Shipment</b> {shipment ? `${fmtDate(shipment[0])} - ${fmtDate(shipment[1])}` : '—'}</span></div>
  </div>;
}

function arrivalSummary(group) {
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  if (text(group.status).toUpperCase() === 'CLOSED') return { headline: 'Shipment completed', detail: 'Vessel status is closed', tone: 'complete' };

  const etaCalls = group.legRows.map(row => ({ row, timestamp: parseDate(row.eta) })).filter(call => call.timestamp != null);
  const nextCall = etaCalls.filter(call => call.timestamp >= today).sort((a, b) => a.timestamp - b.timestamp)[0]
    || etaCalls.sort((a, b) => b.timestamp - a.timestamp)[0];

  if (nextCall) {
    const days = Math.round((nextCall.timestamp - today) / DAY);
    const port = shortPort(nextCall.row.loadport);
    if (days < 0) return { headline: `ETA overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`, detail: `ETA ${fmtDate(nextCall.timestamp)} at ${port}`, tone: 'overdue' };
    if (days === 0) return { headline: 'Arriving today', detail: `ETA ${fmtDate(nextCall.timestamp)} at ${port}`, tone: 'urgent' };
    if (days === 1) return { headline: 'Arriving tomorrow', detail: `ETA ${fmtDate(nextCall.timestamp)} at ${port}`, tone: 'urgent' };
    if (days <= 3) return { headline: `Arriving in ${days} days`, detail: `ETA ${fmtDate(nextCall.timestamp)} at ${port}`, tone: 'urgent' };
    if (days <= 7) return { headline: `Arriving in ${days} days`, detail: `ETA ${fmtDate(nextCall.timestamp)} at ${port}`, tone: 'soon' };
    return { headline: `ETA in ${days} days`, detail: `${fmtDate(nextCall.timestamp)} at ${port}`, tone: 'scheduled' };
  }

  const laycanCalls = group.legRows.map(row => ({ row, range: dateRange(row.laycan) })).filter(call => call.range);
  if (laycanCalls.length) {
    const nextLaycan = laycanCalls.sort((a, b) => a.range[0] - b.range[0])[0];
    const days = Math.round((nextLaycan.range[0] - today) / DAY);
    return { headline: 'ETA not set', detail: `Laycan ${fmtDate(nextLaycan.range[0])} - ${fmtDate(nextLaycan.range[1])} at ${shortPort(nextLaycan.row.loadport)}${days >= 0 ? ` · ${days} days away` : ''}`, tone: 'waiting' };
  }

  return { headline: 'Awaiting schedule', detail: 'ETA and Laycan are not available', tone: 'waiting' };
}

function SearchIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>; }
function AlertIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>; }
function ExternalLinkIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 3h6v6" /><path d="m10 14 11-11" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>; }

function VesselTrackingActions({ imo, mmsi, vessel }) {
  const links = trackingLinks(imo, mmsi);
  const services = [
    ['VesselFinder', links.vesselFinder],
    ['MarineTraffic', links.marineTraffic]
  ];
  return <div className="tracking-actions" aria-label={`Track ${vessel || 'vessel'}`}>
    {services.map(([label, href]) => href
      ? <a className="tracking-button" href={href} target="_blank" rel="noopener noreferrer" title={`Open ${label} using ${links.identifier}`} key={label}><ExternalLinkIcon /><span>{label}</span></a>
      : <button className="tracking-button" type="button" disabled title="IMO or MMSI is not available" key={label}><ExternalLinkIcon /><span>{label}</span></button>)}
  </div>;
}

function CargoDropdown({ items, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const count = Object.keys(selected).length;
  return <div className="dropdown">
    <button className={`filter-chip dropdown-button${open ? ' pressed' : ''}`} type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>Cargo{count > 0 && <span className="dropdown-badge">{count}</span>}<span className="caret">▾</span></button>
    {open && <div className="dropdown-panel"><div className="dropdown-head"><span>Filter by cargo</span><button type="button" onClick={() => Object.keys(selected).forEach(item => onChange(item, false))}>Clear</button></div><div className="dropdown-list">{items.map(item => <label key={item} className="dropdown-item"><input type="checkbox" checked={!!selected[item]} onChange={event => onChange(item, event.target.checked)} /><span className={`cargo-swatch ${norm(item).includes('pomefad') ? 'pomefad' : norm(item).includes('pome') ? 'rpome' : norm(item).includes('fame') ? 'fame' : 'other'}`} />{item}</label>)}</div></div>}
  </div>;
}

function ContractDetails({ group }) {
  const contracts = group.legRows.flatMap(row => row.salesContracts || []);
  if (!contracts.length) return null;
  return <details className="contract-details"><summary>contract details · {group.vslId || group.vessel}</summary><table><thead><tr><th>Buyer</th><th>Contract</th><th>Cargo</th><th>Port</th><th>Qty</th><th>Inco</th><th>Shpt period</th><th>Price $/t</th><th>Demurrage $/d</th></tr></thead><tbody>{contracts.map((contract, index) => <tr key={`${contract.id || contract.contractNo}-${index}`}><td className="bold">{contract.counterparty || '—'}</td><td>{contract.contractNo || '—'}</td><td>{contract.cargo || '—'}</td><td>{shortPort(contract.loadport)}</td><td className="mono">{fmtTons(contract.qty)}</td><td>{contract.payment || '—'}</td><td className="mono">{contract.periodStart || '—'} - {contract.periodEnd || '—'}</td><td className="mono">{contract.pricing || '—'}</td><td className="mono">{fmtDemm(group.demmurage)}</td></tr>)}</tbody></table></details>;
}

function ShipmentCard({ group }) {
  const first = group.legRows[0] || {};
  const axis = axisForRows(group.legRows);
  const discharge = Array.from(new Set(group.legRows.flatMap(row => (row.dischargePorts || []).map(port => shortPort(port.port || port))))).filter(Boolean).join(', ') || '—';
  const unallocated = group.legRows.filter(row => !(row.salesContracts || []).length);
  const routeStatus = text(group.status).toUpperCase() === 'CLOSED' ? 'Complete' : first.eta ? 'En route' : 'Awaiting schedule';
  const etaText = first.eta ? `ETA ${fmtDate(parseDate(first.eta))} ${shortPort(first.loadport)}` : '';
  const cargoes = Array.from(new Set(group.legRows.flatMap(row => row.cargoes || []).filter(Boolean)));
  const arrival = arrivalSummary(group);
  return <article className={`shipment-card${group.flags.some(flag => flag.attention) ? ' attention' : ''}`}>
    <div className="vessel-head"><div className="vessel-main-line">
      <span className={`vessel-name${/^tbn$/i.test(group.vessel.replace(/^mt\s+/i, '')) ? ' tbn' : ''}`}>{group.vessel || 'TBN'}</span>
      {group.entity && <span className="entity-badge">{group.entity}</span>}
      {cargoes.map(cargo => <span key={cargo} className={`cargo-tag ${norm(cargo).includes('pomefad') ? 'pomefad' : norm(cargo).includes('pome') ? 'rpome' : norm(cargo).includes('fame') ? 'fame' : 'other'}`}>{cargo}</span>)}
      {group.volume > 0 && <span className="quantity mono">{fmtTons(group.volume)}</span>}
      <span className="flex-spacer" /><VesselTrackingActions imo={group.imo} mmsi={group.mmsi} vessel={group.vessel} /><div className="flag-list">{group.flags.map(flag => <span key={flag.label} className={`flag ${flag.tone}`}>{flag.label}</span>)}</div>
    </div><div className="vessel-meta">
      <span><i className={`status-dot ${routeStatus === 'En route' ? 'sea' : routeStatus === 'Complete' ? 'done' : 'tbn'}`} />{routeStatus}{etaText ? ` · ${etaText}` : ''}</span>
      <span><b>Discharge</b> {discharge}</span><span><b>Ops</b> {first.ops || group.status || '—'}</span>{first.shipper && <span><b>Shipper</b> {first.shipper}</span>}
    </div></div>
    <div className={`arrival-summary ${arrival.tone}`}><img src={vesselSilhouette} alt="" /><div><span className="arrival-kicker">Arrival outlook</span><strong>{arrival.headline}</strong><span className="arrival-detail">{arrival.detail}</span></div></div>
    <div className="voyage-scroll"><div className="voyage-inner" style={{ minWidth: axis.width }}>{group.legRows.map((row, index) => <div className="leg-block" key={`${row.key || row.vslId || row.loadport}-${index}`}>
      <div className="leg-row"><div className="leg-label"><span className="port-name">{shortPort(row.loadport)}</span><span className="port-role">Load</span></div><Timeline row={row} axis={axis} /></div>
      {(row.salesContracts || []).length ? <div className="leg-sub">{row.salesContracts.map((contract, contractIndex) => <div className="leg-sale" key={`${contract.id || contract.contractNo}-${contractIndex}`}><b>{contract.counterparty || '—'}</b><span className="mono">{fmtTons(contract.qty)}</span><span>{contract.cargo || row.cargo || '—'}</span></div>)}</div> : <div className="leg-sub none">no sale matched to this call</div>}
    </div>)}<Ruler axis={axis} /></div></div>
    <div className="notes">{unallocated.map((row, index) => <div className="note" key={`${row.key || row.loadport}-${index}`}><span className="star">*</span><b>Unallocated</b> — {shortPort(row.loadport)} load call has no sale matched</div>)}{group.flags.some(flag => flag.label === 'TBN') && <div className="note red"><span className="star">*</span><b>Vessel TBN</b> — no vessel nominated yet</div>}</div>
    <ContractDetails group={group} />
  </article>;
}

export default function OpenShipments() {
  const [data, setData] = useState(null);
  const dataRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState('vessel');
  const [entity, setEntity] = useState('GR');
  const [shipmentBasis, setShipmentBasis] = useState('ALL');
  const [query, setQuery] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selectedCargoes, setSelectedCargoes] = useState({});

  const load = async ({ silent = false, force = false } = {}) => {
    const hasData = dataRef.current !== null;
    if (!silent && !hasData) setLoading(true);
    try {
      const response = await api.get('/sheets/open-shipments');
      const next = response.data;
      if (silent && !force && hasData && dataRef.current.updatedAt === next.updatedAt) return;
      dataRef.current = next;
      setData(next);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load Open Shipments');
    } finally {
      if (!silent && !hasData) setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);
  useDataRefresh({
    databases: ['DB1', 'DB2', 'DB3', 'DB4', 'DB5', 'DB6'],
    resources: ['vessel-matching', 'matching-sales', 'vessel-update'],
    onRefresh: ({ reason }) => load({ silent: true, force: reason !== 'fallback' }),
  });

  const filteredRows = useMemo(() => {
    const q = norm(query);
    const cargoes = Object.keys(selectedCargoes);
    return (data?.rows || []).filter(row => {
      if (!showClosed && text(row.status).toUpperCase() === 'CLOSED') return false;
      if (entity !== 'ALL' && text(row.entity) !== entity) return false;
      if (shipmentBasis !== 'ALL' && getShipmentBasis(row) !== shipmentBasis) return false;
      if (cargoes.length && !cargoes.includes(text(row.cargo))) return false;
      if (attentionOnly && !rowFlags(row).some(flag => flag.attention)) return false;
      if (!q) return true;
      const searchable = [row.vessel, row.vslId, row.entity, row.status, row.loadport, row.cargo, row.laycan, row.eta, row.etb, row.etc,
        ...(row.salesContracts || []).flatMap(contract => [contract.contractNo, contract.counterparty, contract.broker, contract.brokerRef, contract.cargo]),
        ...(row.purchaseContracts || []).flatMap(contract => [contract.contractNo, contract.counterparty, contract.broker, contract.brokerRef, contract.cargo])].join(' ');
      return norm(searchable).includes(q);
    });
  }, [data, entity, shipmentBasis, query, showClosed, attentionOnly, selectedCargoes]);

  const vesselGroups = useMemo(() => buildVesselGroups(filteredRows), [filteredRows]);
  const buckets = useMemo(() => groupBuckets(filteredRows, view), [filteredRows, view]);
  const stats = useMemo(() => ({
    vessels: vesselGroups.length,
    calls: vesselGroups.reduce((sum, group) => sum + group.calls, 0),
    volume: vesselGroups.reduce((sum, group) => sum + group.volume, 0),
    attention: vesselGroups.filter(group => group.flags.some(flag => flag.attention)).length,
    tbn: vesselGroups.filter(group => /^tbn$/i.test(text(group.vessel).replace(/^mt\s+/i, ''))).length
  }), [vesselGroups]);
  const cargoItems = data?.options?.cargoes || Array.from(new Set((data?.rows || []).map(row => text(row.cargo)).filter(Boolean))).sort();
  const kpis = [[stats.vessels, 'Vessels', ''], [stats.calls, 'Load calls', ''], [`${(stats.volume / 1000).toFixed(1)}kt`, 'Volume', ''], [stats.attention, 'Attention', 'attention'], [stats.tbn, 'TBN', 'tbn']];

  return <>
    <style>{CSS}</style>
    <div className="open-shipments-page"><div className="open-wrap">
      <div className="open-top"><div><h1 className="open-title">Open Shipments - Voyage View</h1><p className="open-sub">Physical sales · <b>{data ? 'live' : 'connecting...'}</b> · {formatUpdated(data?.updatedAt)} · ordered by shipment period · <b>{stats.vessels}</b> vessels · {entity === 'ALL' ? 'All' : entity}</p></div><div className="top-actions"><div className="views" role="group" aria-label="Group by">{['vessel', 'buyer', 'loadport'].map(mode => <button className={`view-button${view === mode ? ' active' : ''}`} type="button" key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div></div></div>
      <div className="kpis">{kpis.map(([number, label, tone]) => <div className={`kpi ${tone}`} key={label}><div className="number mono">{number}</div><div className="label">{label}</div></div>)}</div>
      <div className="filters"><div className="entity-segment" role="group" aria-label="Entity">{['GR', 'A*', 'A*JV', 'ALL'].map(value => <button type="button" key={value} className={entity === value ? 'active' : ''} aria-pressed={entity === value} onClick={() => setEntity(value)}>{value === 'ALL' ? 'All' : value}</button>)}</div><div className="entity-segment basis-segment" role="group" aria-label="Shipment basis">{['ALL', 'FOB', 'CIF'].map(value => <button type="button" key={value} className={shipmentBasis === value ? 'active' : ''} aria-pressed={shipmentBasis === value} onClick={() => setShipmentBasis(value)}>{value === 'ALL' ? 'All basis' : value}</button>)}</div><label className="search-box"><SearchIcon /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search vessel, buyer, port, contract..." aria-label="Search" /></label><CargoDropdown items={cargoItems} selected={selectedCargoes} onChange={(item, checked) => setSelectedCargoes(current => { const next = { ...current }; if (checked) next[item] = true; else delete next[item]; return next; })} /><button className={`filter-chip attention${attentionOnly ? ' active' : ''}`} type="button" aria-pressed={attentionOnly} onClick={() => setAttentionOnly(value => !value)}><AlertIcon /> Attention</button><button className={`filter-chip${showClosed ? ' active' : ''}`} type="button" aria-pressed={showClosed} onClick={() => setShowClosed(value => !value)}>Show closed</button></div>
      <div className="legend-bar"><span className="legend-item"><span className="legend-swatch legend-sp" /><b>Shipment period</b></span><span className="legend-item"><span className="legend-swatch legend-lay" /><b>Laycan</b> window</span><span className="legend-item"><span className="legend-swatch legend-eta" /><b>ETA</b> · est. arrival</span><span className="legend-item"><span className="legend-swatch legend-etb" /><b>ETB</b> · est. berthing</span><span className="legend-item"><span className="legend-swatch legend-etc" /><b>ETC</b> · est. completion</span><span className="legend-item"><span className="legend-swatch legend-cr" /><b>CR</b> · cargo ready</span><span className="legend-item"><span className="legend-swatch legend-today" /><b>Today</b></span><span className="legend-note">red marker = past SP end / waiting · hover for date</span></div>
      {stats.attention > 0 && <div className="warning-banner"><AlertIcon /><div><h3>Attention needed</h3><p><b>{stats.attention}</b> vessel{stats.attention === 1 ? '' : 's'} have an operational flag in the current view.</p></div></div>}{error && <div className="open-error">{error}</div>}
      {loading && !data ? <div className="open-loading">Loading open shipments...</div> : buckets.map(bucket => <section className="shipment-group" key={bucket.heading || 'vessels'}>{bucket.heading && <div className="group-head"><span className="group-name">{bucket.heading}</span><span className="group-meta"><span className="mono">{bucket.groups.length}</span> {bucket.groups.length === 1 ? 'vessel' : 'vessels'}{bucket.groups.some(group => group.flags.some(flag => flag.attention)) ? ' · attention' : ''}</span></div>}<div className="shipment-grid">{bucket.groups.map(group => <ShipmentCard key={group.key} group={group} />)}</div></section>)}
      {!loading && data && !filteredRows.length && <div className="empty-state">No vessels match these filters.</div>}
    </div></div>
  </>;
}

const CSS = String.raw`
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
.open-shipments-page{--paper:#EEF1F0;--surface:#fff;--ink:#13201C;--muted:#5C6B66;--hair:#D5DCD9;--accent:#0A5E5A;--sp:#C2691C;--sp-soft:#c2691c22;--eta:#13201C;--etb:#2D6CB5;--etc:#7A4FB5;--cr:#2E7D5B;--red:#B23A2E;--red-soft:#b23a2e14;--amber:#B5790E;--amber-soft:#b5790e14;--shadow:0 1px 2px rgba(19,32,28,.06),0 8px 24px rgba(19,32,28,.05);margin:-28px;min-height:calc(100vh - 56px);padding:22px 18px 64px;overflow-x:hidden;background:var(--paper);color:var(--ink);font-family:Inter,system-ui,sans-serif;font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased}
.open-shipments-page *{box-sizing:border-box}
.open-shipments-page button,.open-shipments-page input{font:inherit}
.mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.open-wrap{max-width:1440px;margin:0 auto}
.open-top{display:flex;flex-wrap:wrap;gap:14px 18px;align-items:flex-end;justify-content:space-between;margin-bottom:16px}
.open-title{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:25px;letter-spacing:-.01em;margin:0;line-height:1.05}
.open-sub{color:var(--muted);margin:4px 0 0;font-size:12.5px}
.open-sub b{color:var(--ink);font-weight:600}
.top-actions{display:flex;gap:8px;align-items:center}
.open-btn{font-size:12.5px;font-weight:600;border:1px solid var(--hair);background:var(--surface);color:var(--ink);padding:9px 13px;border-radius:9px;cursor:pointer;display:inline-flex;gap:7px;align-items:center}
.open-btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.views{display:flex;gap:2px;background:var(--surface);border:1px solid var(--hair);border-radius:10px;padding:3px}
.view-button{font-size:12.5px;font-weight:600;color:var(--muted);background:none;border:0;padding:7px 11px;border-radius:7px;cursor:pointer}
.view-button.active{background:var(--accent);color:#fff}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:9px;margin-bottom:14px}
.kpi{background:var(--surface);border:1px solid var(--hair);border-radius:12px;padding:11px 12px;box-shadow:var(--shadow)}
.kpi .number{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:21px;line-height:1;letter-spacing:-.02em}
.kpi .label{color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;margin-top:6px}
.kpi.attention .number{color:var(--red)}
.kpi.tbn .number{color:var(--amber)}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:11px}
.entity-segment{display:flex;gap:2px;background:var(--surface);border:1px solid var(--hair);border-radius:999px;padding:3px}
.entity-segment button{font-size:12px;font-weight:600;color:var(--muted);background:none;border:0;padding:6px 12px;border-radius:999px;cursor:pointer}
.entity-segment button.active{background:var(--ink);color:#fff}
.search-box{flex:1 1 180px;min-width:150px;display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--hair);border-radius:9px;padding:8px 11px;color:var(--muted)}
.search-box input{border:0;outline:0;width:100%;background:none;color:var(--ink)}
.filter-chip{font-size:12.5px;font-weight:500;background:var(--surface);border:1px solid var(--hair);color:var(--muted);padding:7px 11px;border-radius:999px;cursor:pointer}
.filter-chip.active,.filter-chip.pressed{background:var(--ink);color:#fff;border-color:var(--ink)}
.filter-chip.attention.active{background:var(--red);border-color:var(--red)}
.dropdown{position:relative}
.dropdown-button{display:inline-flex;align-items:center;gap:7px}
.caret{font-size:9px;opacity:.7}
.dropdown-badge{background:var(--accent);color:#fff;border-radius:999px;font-size:10px;font-weight:700;padding:0 6px;min-width:17px;height:16px;display:inline-flex;align-items:center;justify-content:center}
.dropdown-panel{position:absolute;top:calc(100% + 6px);left:0;z-index:40;background:var(--surface);border:1px solid var(--hair);border-radius:11px;box-shadow:0 12px 32px rgba(19,32,28,.18);padding:8px;width:248px}
.dropdown-head{display:flex;justify-content:space-between;padding:3px 6px 8px;font-size:11px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--hair);margin-bottom:6px}
.dropdown-head button{font-size:11px;font-weight:600;color:var(--accent);background:none;border:0;cursor:pointer}
.dropdown-list{display:grid;grid-template-columns:1fr 1fr;gap:2px;max-height:264px;overflow:auto}
.dropdown-item{display:flex;align-items:center;gap:7px;padding:6px 7px;border-radius:7px;font-size:12px;cursor:pointer;color:var(--ink)}
.dropdown-item:hover{background:var(--paper)}
.dropdown-item input{accent-color:var(--accent);width:14px;height:14px;margin:0}
.dropdown-item .cargo-swatch{width:9px;height:9px;border-radius:3px;background:#6B7A74}
.dropdown-item .cargo-swatch.rpome{background:#0A5E5A}
.dropdown-item .cargo-swatch.pomefad{background:#9A5B12}
.dropdown-item .cargo-swatch.fame{background:#5B4B9A}
.legend-bar{position:sticky;top:6px;z-index:25;display:flex;flex-wrap:wrap;gap:8px 16px;font-size:11px;color:var(--muted);margin:0 2px 16px;align-items:center;background:var(--surface);border:1px solid var(--hair);border-radius:10px;padding:9px 13px;box-shadow:0 4px 14px rgba(19,32,28,.07)}
.legend-item{font-style:normal;display:inline-flex;align-items:center;gap:7px}
.legend-item b{color:var(--ink);font-weight:600}
.legend-note{margin-left:auto}
.legend-swatch{display:inline-block;flex:none}
.legend-sp{width:18px;height:9px;border-radius:2px;background:var(--sp-soft);border-right:2px solid var(--sp)}
.legend-lay{width:18px;height:9px;border-radius:4px;background:#0a5e5a14;border:1px solid #0a5e5a4d}
.legend-eta{width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid var(--eta)}
.legend-etb{width:10px;height:10px;background:var(--etb)}
.legend-etc{width:10px;height:10px;background:var(--etc);transform:rotate(45deg)}
.legend-cr{width:11px;height:11px;border-radius:50%;background:var(--cr)}
.legend-today{width:14px;height:0;border-bottom:2px dashed var(--red)}
.warning-banner,.open-error{display:flex;gap:11px;align-items:flex-start;background:var(--red-soft);border:1px solid #b23a2e3a;border-left:3px solid var(--red);border-radius:11px;padding:12px 14px;margin-bottom:16px;color:var(--red)}
.warning-banner h3{margin:0 0 3px;font-family:'Space Grotesk',sans-serif;font-size:13.5px}
.warning-banner p{margin:0;font-size:12.5px;color:var(--muted)}
.shipment-group{margin-bottom:24px}
.group-head{display:flex;align-items:baseline;gap:10px;margin:0 2px 9px}
.group-name{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15.5px}
.group-meta{color:var(--muted);font-size:12px}
.group-meta .mono{color:var(--ink);font-weight:600}
.shipment-grid{display:grid;grid-template-columns:1fr;gap:12px;align-items:start}
.shipment-card{background:var(--surface);border:1px solid var(--hair);border-radius:13px;padding:14px 16px;min-width:0;box-shadow:var(--shadow)}
.shipment-card.attention{border-left:3px solid var(--red)}
.vessel-main-line{display:flex;flex-wrap:wrap;gap:8px 11px;align-items:center}
.vessel-name{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px}
.vessel-name.tbn{color:var(--amber)}
.entity-badge{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:5px;background:#13201c10;color:var(--ink);letter-spacing:.03em}
.cargo-tag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;color:#fff;background:#6B7A74}
.cargo-tag.rpome{background:#0A5E5A}
.cargo-tag.pomefad{background:#9A5B12}
.cargo-tag.fame{background:#5B4B9A}
.quantity{font-weight:600}
.flex-spacer{flex:1 1 auto}
.tracking-actions{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.tracking-button{height:28px;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 8px;border:1px solid #0a5e5a45;border-radius:6px;background:#0a5e5a0b;color:var(--accent);font-size:10.5px;font-weight:600;line-height:1;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background-color .15s ease,border-color .15s ease,color .15s ease}
.tracking-button:hover{background:#0a5e5a16;border-color:#0a5e5a70}
.tracking-button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tracking-button:disabled{border-color:var(--hair);background:#f3f5f4;color:#98a29e;cursor:not-allowed}
.flag-list{display:flex;flex-wrap:wrap;gap:5px}
.flag{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:3px 7px;border-radius:6px}
.flag.red{background:var(--red-soft);color:var(--red)}
.flag.amber{background:var(--amber-soft);color:var(--amber)}
.vessel-meta{display:flex;flex-wrap:wrap;gap:3px 16px;margin-top:8px;font-size:12px;color:var(--muted)}
.vessel-meta b{color:var(--ink);font-weight:600}
.status-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle;background:var(--amber)}
.status-dot.sea{background:var(--etb)}
.status-dot.done{background:var(--muted)}
.arrival-summary{display:flex;align-items:center;gap:12px;margin-top:12px;padding:9px 11px;border:1px solid #0a5e5a30;border-left:3px solid var(--accent);border-radius:8px;background:#0a5e5a0b}
.arrival-summary img{width:56px;height:28px;object-fit:contain;flex:none;mix-blend-mode:multiply;opacity:.86}
.arrival-summary>div{display:grid;grid-template-columns:auto 1fr;align-items:baseline;gap:1px 9px;min-width:0}
.arrival-kicker{grid-column:1/-1;color:var(--muted);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.arrival-summary strong{font-family:'Space Grotesk',sans-serif;font-size:13px;line-height:1.2}
.arrival-detail{color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.arrival-summary.urgent,.arrival-summary.overdue{border-color:#b23a2e45;border-left-color:var(--red);background:var(--red-soft)}
.arrival-summary.urgent strong,.arrival-summary.overdue strong{color:var(--red)}
.arrival-summary.soon{border-color:#b5790e45;border-left-color:var(--amber);background:var(--amber-soft)}
.arrival-summary.soon strong{color:#8a5b08}
.arrival-summary.waiting{border-color:var(--hair);border-left-color:#8a9691;background:#f7f8f8}
.arrival-summary.complete{border-color:var(--hair);border-left-color:var(--cr);background:#2e7d5b0b}
.voyage-scroll{margin-top:12px;overflow-x:auto;overflow-y:visible}
.voyage-inner{width:100%}
.leg-block{margin-bottom:14px;padding-left:9px;border-left:2px solid #e1e7e4}
.leg-block:last-of-type{margin-bottom:5px}
.leg-row{display:grid;grid-template-columns:86px minmax(0,1fr);column-gap:9px;align-items:start}
.leg-label{font-size:12px;line-height:1.2;position:sticky;left:0;z-index:6;background:var(--surface);box-shadow:6px 0 6px -4px rgba(255,255,255,.95);padding-top:24px}
.port-name{font-weight:700;color:var(--ink);display:block}
.port-role{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:2px 0 0;display:block}
.timeline-stack{min-width:0}
.milestone-labels{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin-bottom:5px}
.milestone-label{display:flex;align-items:baseline;justify-content:center;gap:4px;min-width:0;padding:3px 4px;border-radius:5px;background:var(--paper);font-size:9px}
.milestone-label span{font-weight:800}
.milestone-label b{font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.milestone-label.cr span{color:var(--cr)}
.milestone-label.eta span{color:var(--eta)}
.milestone-label.etb span{color:var(--etb)}
.milestone-label.etc span{color:var(--etc)}
.timeline-track{position:relative;height:24px;overflow:visible}
.timeline-grid{position:absolute;top:0;bottom:0;width:0;border-left:1px solid #eef2f0;z-index:0}
.timeline-grid.month{border-left-color:#e3e8e6}
.timeline-bar{position:absolute;top:50%;transform:translateY(-50%);z-index:1}
.timeline-bar.shipment{height:14px;background:var(--sp-soft);border-right:2px solid var(--sp);border-radius:3px}
.timeline-bar.laycan{height:10px;border-radius:5px;background:#0a5e5a14;border:1px solid #0a5e5a4d}
.timeline-today{position:absolute;top:-2px;bottom:-2px;width:0;border-left:2px dashed var(--red);z-index:4}
.timeline-marker{position:absolute;top:50%;z-index:3}
.marker-eta{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:7px solid var(--eta);transform:translate(-50%,-60%)}
.marker-etb{width:7px;height:7px;background:var(--etb);transform:translate(-50%,-50%)}
.marker-etc{width:7px;height:7px;background:var(--etc);transform:translate(-50%,-50%) rotate(45deg)}
.marker-cr{width:8px;height:8px;box-sizing:border-box;border-radius:50%;background:var(--cr);transform:translate(-50%,-50%);border:1.5px solid #fff;outline:1px solid var(--cr)}
.timeline-windows{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:4px;color:var(--muted);font-size:9.5px}
.timeline-windows b{color:var(--ink);font-weight:700}
.leg-sub{margin:6px 0 0 95px;font-size:11px;color:var(--muted);display:flex;flex-direction:column;gap:2px}
.leg-sale{display:grid;grid-template-columns:minmax(80px,1fr) auto minmax(70px,auto);gap:7px;align-items:baseline}
.leg-sale b{color:var(--ink);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.leg-sale .mono{font-weight:600;color:var(--ink);white-space:nowrap}
.leg-sub.none{font-style:italic;opacity:.85}
.timeline-ruler{position:relative;height:24px;margin:6px 0 0 95px}
.ruler-label{position:absolute;top:8px;transform:translateX(-50%);font-size:9px;color:var(--muted);font-family:'IBM Plex Mono',monospace;white-space:nowrap}
.ruler-label.month{font-weight:700;color:var(--ink);font-size:9.5px}
.notes{margin-top:10px;display:flex;flex-direction:column;gap:3px}
.note{font-size:11.5px;color:var(--muted);line-height:1.35}
.note.red{color:var(--red)}
.note b{color:var(--ink);font-weight:600}
.note.red b{color:var(--red)}
.star{font-weight:700;margin-right:4px}
.contract-details{margin-top:11px;border-top:1px dashed var(--hair);padding-top:9px;overflow-x:auto}
.contract-details summary{cursor:pointer;font-size:11.5px;color:var(--muted);font-weight:600;list-style:none}
.contract-details summary::-webkit-details-marker{display:none}
.contract-details summary::before{content:'▸ ';color:var(--accent)}
.contract-details[open] summary::before{content:'▾ '}
.contract-details table{width:100%;min-width:720px;border-collapse:collapse;margin-top:9px;font-size:11.5px}
.contract-details th{text-align:left;font-weight:600;color:var(--muted);border-bottom:1px solid var(--hair);padding:4px 8px 4px 0;font-size:10.5px;text-transform:uppercase;letter-spacing:.03em}
.contract-details td{padding:5px 8px 5px 0;border-bottom:1px solid var(--paper);vertical-align:top}
.contract-details td.bold{font-weight:600}
.open-loading,.empty-state{text-align:center;color:var(--muted);padding:40px;font-size:13px}
.map-modal{position:fixed;inset:0;background:rgba(19,32,28,.55);display:flex;align-items:center;justify-content:center;z-index:50;padding:18px}
.map-card{background:var(--surface);border-radius:14px;width:100%;max-width:920px;max-height:88vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.map-head{display:flex;align-items:center;justify-content:space-between;padding:13px 18px;border-bottom:1px solid var(--hair)}
.map-head h2{margin:0;font-family:'Space Grotesk',sans-serif;font-size:16px;display:flex;align-items:center;gap:8px}
.map-head button{font-size:18px;line-height:1;border:0;background:none;cursor:pointer;color:var(--muted);padding:4px 8px}
.map-body{padding:18px;display:grid;gap:14px}
.map-placeholder{position:relative;min-height:260px;overflow:hidden;border:1px solid var(--hair);border-radius:10px;background:#dfe6e4}
.map-ocean{position:absolute;inset:0;background:linear-gradient(145deg,#dfe6e4 0 44%,#cbd7d3 44% 47%,#dfe6e4 47% 100%);opacity:.8}
.map-copy{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:6px;text-align:center;color:var(--muted);font-size:12px}
.map-copy strong{font-family:'Space Grotesk',sans-serif;color:var(--ink);font-size:18px}
.map-port-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 18px}
.map-port{display:flex;align-items:center;gap:7px;color:var(--ink);font-size:12px}
.map-port .mono{margin-left:auto;color:var(--muted);font-size:10px}
.map-port-dot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:none}
.map-footer{border-top:1px solid var(--hair);padding:11px 18px;color:var(--muted);font-size:11px}
@media(min-width:980px){.shipment-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:760px){.open-shipments-page{margin:-24px -20px;padding:18px 12px 48px}
.kpis{grid-template-columns:repeat(3,1fr)}
.open-title{font-size:21px}
.tracking-actions{order:4;width:100%}
.arrival-summary>div{grid-template-columns:1fr}
.arrival-detail{white-space:normal}
.leg-row{grid-template-columns:76px minmax(0,1fr)}
.leg-sub{margin-left:85px}
.timeline-ruler{margin-left:85px}
.milestone-labels{grid-template-columns:repeat(2,minmax(0,1fr))}
.legend-note{margin-left:0}
.map-port-list{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}
}
`;
