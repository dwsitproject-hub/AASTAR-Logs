import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';

const UI_FONT = "'Segoe UI', system-ui, -apple-system, sans-serif";
const BORDER = '#b6d6c9';
const OPEN_ROW = '#c2e4d5';
const CLOSED_ROW = '#e4e7e8';
const MUTED = '#536c66';
const DEFAULT_CHARTERER = 'AlphaStar';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function text(value) {
  return value == null ? '' : String(value).trim();
}

function sameValue(left, right) {
  return text(left).toLowerCase() === text(right).toLowerCase();
}

function vesselGroupKey(row) {
  return text(row.vslId) || text(row.vessel) || row.key;
}

function number(value) {
  const parsed = Number(text(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmtQty(value) {
  const qty = number(value);
  return qty ? qty.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '-';
}

function fmtUpdated(value) {
  if (!value) return 'Waiting for DB6';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function monthFrom(value) {
  const match = text(value).match(/[A-Za-z]{3,}/);
  if (!match) return '-';
  const month = MONTHS.find(item => item.toLowerCase() === match[0].slice(0, 3).toLowerCase());
  return month || match[0].slice(0, 3);
}

function planningDate(value) {
  const raw = text(value).replace(/[\u2013\u2014\u2192]/g, '-');
  if (!raw || raw === '-') return null;
  const year = new Date().getFullYear();
  const monthIndex = name => MONTHS.findIndex(month => month.toLowerCase() === text(name).slice(0, 3).toLowerCase());
  const iso = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const dayMonth = raw.match(/(\d{1,2})\s*[-/ ]?\s*([A-Za-z]{3,})/);
  if (dayMonth && monthIndex(dayMonth[2]) >= 0) return Date.UTC(year, monthIndex(dayMonth[2]), Number(dayMonth[1]));
  const monthDay = raw.match(/([A-Za-z]{3,})\s*[-/ ]?\s*(\d{1,2})/);
  if (monthDay && monthIndex(monthDay[1]) >= 0) return Date.UTC(year, monthIndex(monthDay[1]), Number(monthDay[2]));
  const monthOnly = raw.match(/[A-Za-z]{3,}/);
  if (monthOnly && monthIndex(monthOnly[0]) >= 0) return Date.UTC(year, monthIndex(monthOnly[0]), 1);
  const native = Date.parse(raw);
  return Number.isNaN(native) ? null : Date.UTC(new Date(native).getFullYear(), new Date(native).getMonth(), new Date(native).getDate());
}

function isPastDate(value) {
  const timestamp = planningDate(value);
  if (timestamp == null) return false;
  const today = new Date();
  return timestamp < Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
}

function earliestPlanningDate(rows) {
  const timestamps = rows.flatMap(row => ['laycan', 'cr', 'eta', 'etb', 'etc']
    .map(field => planningDate(row[field]))
    .filter(timestamp => timestamp != null));
  return timestamps.length ? Math.min(...timestamps) : Number.POSITIVE_INFINITY;
}

function statusTone(value) {
  return text(value).toLowerCase() === 'closed' ? 'closed' : 'open';
}

function shipperTone(value) {
  const key = text(value).toUpperCase();
  return {
    '3P': ['#934c05', '#fff7ed'],
    SPC: ['#b91c1c', '#fff1f2'],
    EUP: ['#087443', '#ecfdf5'],
    PMC: ['#0f766e', '#f0fdfa'],
    TPG: ['#1d4ed8', '#eff6ff'],
    GLM: ['#7c3aed', '#f5f3ff'],
    JPN: ['#be185d', '#fdf2f8'],
  }[key] || ['#475569', '#f1f5f9'];
}

function contractPeriod(contract) {
  const start = text(contract.periodStart);
  const end = text(contract.periodEnd);
  if (!start && !end) return '';
  return `${start || '-'} - ${end || '-'}`;
}

function contractLine(contract) {
  const party = text(contract.counterparty) || '-';
  const ref = text(contract.contractNo || contract.ref) || '-';
  const cargo = text(contract.cargo);
  const qty = contract.qty ? `${fmtQty(contract.qty)}${cargo ? ` ${cargo}` : ''}` : cargo;
  const period = contractPeriod(contract);
  return [party, ref, qty, period].filter(Boolean).join(' | ');
}

function StatusCell({ value, planningStatus, muted = false, large = false }) {
  const closed = statusTone(value) === 'closed';
  return (
    <div style={{ display: 'grid', gap: 3, justifyItems: 'center' }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        color: closed ? '#69757a' : '#173c32', fontSize: large ? 12 : 10, fontWeight: 700,
        whiteSpace: 'nowrap'
      }}>
        {closed ? 'CLOSED' : 'OPEN'} <span style={{ fontSize: 9, color: '#477b6c' }}>v</span>
      </span>
      {text(planningStatus).toLowerCase() === 'pending' && (
        <span style={{ color: muted ? '#737b7d' : '#9a4b0b', fontSize: large ? 11 : 9, fontWeight: 700, whiteSpace: 'nowrap' }}>PENDING</span>
      )}
    </div>
  );
}

function ShipperChip({ value, muted = false, large = false }) {
  const label = text(value) || '-';
  const [background, color] = muted ? ['#c9cecc', '#6f7876'] : shipperTone(label);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 34, padding: '2px 7px', borderRadius: 999,
      background, color, fontSize: large ? 12 : 10, fontWeight: 800, lineHeight: 1.2,
      whiteSpace: 'nowrap'
    }}>
      {label}
    </span>
  );
}

function ContractColumn({ row }) {
  const purchases = row.purchaseContracts || [];
  const sales = row.salesContracts || [];
  if (!purchases.length && !sales.length) {
    return <span style={{ color: MUTED, fontSize: 10, fontStyle: 'italic' }}>No matched contracts</span>;
  }
  return (
    <div style={{ display: 'grid', gap: 7, lineHeight: 1.18 }}>
      {purchases.length > 0 && (
        <div>
          <div style={{ fontWeight: 800, fontSize: 10, marginBottom: 2 }}>Purchase</div>
          {purchases.map((contract, index) => (
            <div key={`purchase-${contract.id || contract.contractNo || index}`} style={{ fontSize: 10 }}>{contractLine(contract)}</div>
          ))}
        </div>
      )}
      {sales.length > 0 && (
        <div>
          <div style={{ fontWeight: 800, fontSize: 10, marginBottom: 2 }}>Sales</div>
          {sales.map((contract, index) => (
            <div key={`sales-${contract.id || contract.contractNo || index}`} style={{ fontSize: 10 }}>{contractLine(contract)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContractProgress({ row, muted = false }) {
  const purchaseDone = (row.purchaseContracts || []).length > 0;
  const salesDone = (row.salesContracts || []).length > 0;
  if (!purchaseDone && !salesDone) return <span style={{ color: muted ? '#737b7d' : MUTED }}>-</span>;
  return (
    <div style={{ display: 'grid', gap: 4, color: muted ? '#737b7d' : '#173c32', fontSize: 12, fontWeight: 700 }}>
      {salesDone && <span>Sales done</span>}
      {purchaseDone && <span>Purchase done</span>}
    </div>
  );
}

function MultiSelectFilter({ label, values, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const uniqueOptions = [...new Set((options || []).filter(Boolean))];
  const allSelected = values.length === 0;
  const summary = allSelected
    ? 'All'
    : values.length === 1 ? values[0] : `${values.length} selected`;

  useEffect(() => {
    const close = event => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const toggle = option => {
    if (allSelected) {
      onChange([option]);
      return;
    }
    const next = values.includes(option)
      ? values.filter(value => value !== option)
      : [...values, option];
    onChange(next.length === uniqueOptions.length ? [] : next);
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'grid', gap: 3, minWidth: 130 }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</span>
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-haspopup="listbox" style={{
        height: 30, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        border: '1px solid var(--border)', borderRadius: 5, padding: '0 8px',
        background: 'var(--bg-card)', color: 'var(--text-main)',
        fontFamily: UI_FONT, fontSize: 11, cursor: 'pointer'
      }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <span aria-hidden="true" style={{ color: 'var(--text-muted)', fontSize: 9 }}>{open ? '^' : 'v'}</span>
      </button>
      {open && (
        <div role="group" aria-label={label} style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50,
          width: 'max(100%, 190px)', maxHeight: 280, overflowY: 'auto',
          padding: 5, border: '1px solid var(--border)', borderRadius: 6,
          background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg)'
        }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 7, minHeight: 30,
            padding: '5px 7px', borderBottom: '1px solid var(--border)',
            color: 'var(--text-main)', fontSize: 11, fontWeight: 700, cursor: 'pointer'
          }}>
            <input type="checkbox" checked={allSelected} onChange={() => onChange([])} style={{ width: 14, height: 14, accentColor: '#16704f' }} />
            <span>All</span>
          </label>
          {uniqueOptions.map(option => (
            <label key={option} style={{
              display: 'flex', alignItems: 'center', gap: 7, minHeight: 29,
              padding: '4px 7px', color: 'var(--text-main)', fontSize: 11, cursor: 'pointer'
            }}>
              <input
                type="checkbox"
                checked={!allSelected && values.includes(option)}
                onChange={() => toggle(option)}
                style={{ width: 14, height: 14, accentColor: '#16704f' }}
              />
              <span style={{ overflowWrap: 'anywhere' }}>{option}</span>
            </label>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '5px 6px 2px', borderTop: '1px solid var(--border)' }}>
            <button type="button" onClick={() => setOpen(false)} style={{
              border: 0, padding: 0, background: 'transparent', color: '#16704f',
              fontFamily: UI_FONT, fontSize: 11, fontWeight: 700, cursor: 'pointer'
            }}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ExportPlanning({ audience = 'chartering' }) {
  const isChartering = audience === 'chartering';
  const [data, setData] = useState(null);
  const dataRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilters, setStatusFilters] = useState(['OPEN']);
  const [chartererFilters, setChartererFilters] = useState([DEFAULT_CHARTERER]);
  const [planningFilters, setPlanningFilters] = useState([]);
  const [loadportFilters, setLoadportFilters] = useState([]);
  const [cargoFilters, setCargoFilters] = useState([]);

  const load = async ({ silent = false, force = false } = {}) => {
    const hasData = !!dataRef.current;
    if (silent && !hasData) setLoading(true);
    else if (!silent) setRefreshing(true);
    try {
      const response = await api.get('/sheets/export-planning');
      const next = response.data;
      if (silent && !force && hasData && dataRef.current.updatedAt === next.updatedAt) return;
      dataRef.current = next;
      setData(next);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load Export Planning');
    } finally {
      if (silent && !hasData) setLoading(false);
      else if (!silent) setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);
  useDataRefresh({
    databases: ['DB1', 'DB2', 'DB3', 'DB4', 'DB5', 'DB6', 'DB10'],
    resources: ['bulk-databases', 'vessel-update'],
    fallbackMs: 15000,
    onRefresh: ({ reason }) => load({ silent: true, force: reason !== 'fallback' }),
  });

  const rows = useMemo(() => {
    const q = text(query).toLowerCase();
    const filtered = (data?.rows || []).filter(row => {
      if (statusFilters.length && !statusFilters.some(value => sameValue(row.vesselStatus, value))) return false;
      if (chartererFilters.length && !chartererFilters.some(value => sameValue(row.charterer, value))) return false;
      if (planningFilters.length && !planningFilters.some(value => sameValue(row.planningStatus, value))) return false;
      if (loadportFilters.length && !loadportFilters.some(value => sameValue(row.loadport, value))) return false;
      if (cargoFilters.length && !cargoFilters.some(value => sameValue(row.cargo, value))) return false;
      if (!q) return true;
      const discharge = (row.dischargePorts || []).map(port => `${port.port} ${port.cargo}`).join(' ');
      const contracts = [...(row.purchaseContracts || []), ...(row.salesContracts || [])]
        .map(contract => `${contract.counterparty} ${contract.contractNo} ${contract.cargo}`).join(' ');
      return [row.vessel, row.vslId, row.charterer, row.entity, row.loadport, row.loadportVslId, row.shipper, row.cargo, row.ops, discharge, contracts]
        .map(text).join(' ').toLowerCase().includes(q);
    });

    const groups = new Map();
    filtered.forEach(row => {
      const key = vesselGroupKey(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    return Array.from(groups.values())
      .sort((a, b) => earliestPlanningDate(a) - earliestPlanningDate(b)
        || text(a[0]?.vessel).localeCompare(text(b[0]?.vessel)))
      .flat();
  }, [data, query, statusFilters, chartererFilters, planningFilters, loadportFilters, cargoFilters]);

  const vesselSpanByIndex = useMemo(() => {
    const spans = new Map();
    rows.forEach((row, index) => {
      const key = vesselGroupKey(row);
      const previous = rows[index - 1];
      if (previous && vesselGroupKey(previous) === key) return;

      let span = 1;
      for (let next = index + 1; next < rows.length; next += 1) {
        if (vesselGroupKey(rows[next]) !== key) break;
        span += 1;
      }
      spans.set(index, span);
    });
    return spans;
  }, [rows]);

  const options = data?.options || {};
  const chartererOptions = (options.charterers || []).some(option => sameValue(option, DEFAULT_CHARTERER))
    ? options.charterers
    : [DEFAULT_CHARTERER, ...(options.charterers || [])];
  const reset = () => {
    setQuery('');
    setStatusFilters(['OPEN']);
    setChartererFilters([DEFAULT_CHARTERER]);
    setPlanningFilters([]);
    setLoadportFilters([]);
    setCargoFilters([]);
  };

  const cell = {
    padding: isChartering ? '10px 11px' : '8px 9px',
    borderRight: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`,
    color: '#173c32', fontSize: isChartering ? 13 : 11, verticalAlign: 'middle', overflowWrap: 'anywhere'
  };
  const header = {
    position: 'sticky', top: 0, zIndex: 2, padding: isChartering ? '10px 11px' : '8px 9px',
    borderRight: `1px solid ${BORDER}`, borderBottom: `1px solid #9ec8b8`,
    background: '#d8eee5', color: '#244c41', textAlign: 'left',
    fontSize: isChartering ? 11 : 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.35,
    whiteSpace: 'nowrap'
  };

  return (
    <div style={{ fontFamily: UI_FONT, color: 'var(--text-main)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 750 }}>Export Planning</h1>
          <div style={{ marginTop: 3, color: 'var(--text-muted)', fontSize: 11 }}>
            Shipment coordination | Updated {fmtUpdated(data?.updatedAt)}
          </div>
        </div>
        <div style={{ color: refreshing ? '#16704f' : 'var(--text-muted)', fontSize: 10, fontWeight: 700 }}>
          {refreshing ? 'Refreshing...' : `${rows.length} shipment rows`}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', padding: 10, marginBottom: 10, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6 }}>
        <label style={{ display: 'grid', gap: 3, flex: '1 1 220px', minWidth: 180 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.3 }}>Search</span>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Vessel, port, cargo, contract..." style={{ height: 30, border: '1px solid var(--border)', borderRadius: 5, padding: '0 9px', background: 'var(--bg-card)', color: 'var(--text-main)', fontFamily: UI_FONT, fontSize: 11 }} />
        </label>
        <MultiSelectFilter label="Status" values={statusFilters} onChange={setStatusFilters} options={options.statuses || []} />
        <MultiSelectFilter label="Charterer" values={chartererFilters} onChange={setChartererFilters} options={chartererOptions} />
        <MultiSelectFilter label="Planning" values={planningFilters} onChange={setPlanningFilters} options={options.planningStatuses || []} />
        <MultiSelectFilter label="Loadport" values={loadportFilters} onChange={setLoadportFilters} options={options.loadports || []} />
        <MultiSelectFilter label="Cargo" values={cargoFilters} onChange={setCargoFilters} options={options.cargoes || []} />
        <button type="button" onClick={reset} style={{ height: 30, border: '1px solid var(--border)', borderRadius: 5, padding: '0 10px', background: 'transparent', color: 'var(--text-muted)', fontFamily: UI_FONT, fontSize: 10, fontWeight: 750, cursor: 'pointer' }}>Reset</button>
      </div>

      {error && <div style={{ marginBottom: 10, padding: 10, border: '1px solid #fecaca', borderRadius: 6, background: '#fef2f2', color: '#b91c1c', fontSize: 11 }}>{error}</div>}
      {loading && !data ? (
        <div style={{ padding: 45, textAlign: 'center', color: 'var(--text-muted)' }}>Loading export planning...</div>
      ) : (
        <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 210px)', border: `1px solid ${BORDER}`, background: OPEN_ROW }}>
          <table style={{ width: '100%', minWidth: isChartering ? 1435 : 1370, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <colgroup>
              {isChartering ? (
                <>
                  <col style={{ width: 100 }} />
                  <col style={{ width: 65 }} />
                  <col style={{ width: 80 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 190 }} />
                  <col style={{ width: 130 }} />
                  <col style={{ width: 170 }} />
                  <col style={{ width: 70 }} />
                  <col style={{ width: 70 }} />
                  <col style={{ width: 70 }} />
                  <col style={{ width: 70 }} />
                  <col style={{ width: 180 }} />
                  <col style={{ width: 150 }} />
                </>
              ) : (
                <>
                  <col style={{ width: 90 }} />
                  <col style={{ width: 60 }} />
                  <col style={{ width: 72 }} />
                  <col style={{ width: 58 }} />
                  <col style={{ width: 166 }} />
                  <col style={{ width: 112 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 58 }} />
                  <col style={{ width: 58 }} />
                  <col style={{ width: 58 }} />
                  <col style={{ width: 58 }} />
                  <col style={{ width: 158 }} />
                  <col style={{ width: 370 }} />
                </>
              )}
            </colgroup>
            <thead>
              <tr>
                {[
                  'Charterer', 'Month', 'Shipper', 'Status', 'Vessel', 'Cargo / Qty',
                  'Loadport', 'CR', 'ETA', 'ETB', 'ETC', 'Discharge',
                  isChartering ? 'Sales / Purchase' : 'Matched Contracts'
                ].map(label => (
                  <th key={label} style={header}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const closed = statusTone(row.portStatus || row.vesselStatus) === 'closed';
                const tbn = /^tbn$/i.test(text(row.vessel));
                const rowBackground = closed ? CLOSED_ROW : tbn ? '#fff4c2' : OPEN_ROW;
                const vesselSpan = vesselSpanByIndex.get(index);
                const previous = rows[index - 1];
                const next = rows[index + 1];
                const groupStart = !previous || vesselGroupKey(previous) !== vesselGroupKey(row);
                const groupEnd = !next || vesselGroupKey(next) !== vesselGroupKey(row);
                const groupEdge = {
                  borderBottom: groupEnd ? 0 : '1px solid #c9cfcc',
                };
                const groupShadow = [
                  groupStart ? 'inset 0 1px 0 #111' : '',
                  !next ? 'inset 0 -1px 0 #111' : '',
                ].filter(Boolean).join(', ');
                const edgeShadow = side => [
                  groupShadow,
                  side === 'left' ? 'inset 1px 0 0 #111' : '',
                  side === 'right' ? 'inset -1px 0 0 #111' : '',
                ].filter(Boolean).join(', ') || undefined;
                const vesselShadow = [
                  'inset 0 1px 0 #111',
                  index + vesselSpan === rows.length ? 'inset 0 -1px 0 #111' : '',
                ].filter(Boolean).join(', ');
                const rowCell = { ...cell, ...groupEdge, boxShadow: groupShadow || undefined, color: closed ? '#737b7d' : cell.color };
                const dateCell = value => {
                  const past = isPastDate(value);
                  return {
                    ...rowCell,
                    ...(closed || past ? { background: '#dfe2e3', color: '#737b7d' } : {}),
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                  };
                };
                return (
                  <tr key={row.key} style={{ background: rowBackground }}>
                    <td style={{ ...rowCell, boxShadow: edgeShadow('left'), textAlign: 'center', fontWeight: 700 }}>{row.charterer || '-'}</td>
                    <td style={{ ...rowCell, textAlign: 'center' }}>{monthFrom(row.laycan || row.eta)}</td>
                    <td style={{ ...rowCell, textAlign: 'center' }}><ShipperChip value={row.shipper} muted={closed} large={isChartering} /></td>
                    <td style={{ ...rowCell, textAlign: 'center' }}><StatusCell value={row.portStatus || row.vesselStatus} planningStatus={row.planningStatus} muted={closed} large={isChartering} /></td>
                    {vesselSpan && (
                      <td rowSpan={vesselSpan} style={{ ...rowCell, borderBottom: 0, boxShadow: vesselShadow, verticalAlign: 'middle', textAlign: 'center', background: rowBackground, color: closed ? '#737b7d' : tbn ? '#7a5b00' : '#173c32', fontFamily: 'Calibri, Arial, sans-serif', fontWeight: 700 }}>
                        <div style={{ fontSize: isChartering ? 20 : 18, lineHeight: 1.15, fontWeight: 800 }}>{row.vessel || 'TBN'}</div>
                        <div style={{ marginTop: 4, color: MUTED, fontSize: isChartering ? 11 : 9, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontWeight: 500 }}>{row.vslId || row.loadportVslId || '-'}</div>
                      </td>
                    )}
                    <td style={{ ...rowCell, fontStyle: 'italic', fontWeight: 650 }}>{row.quantity ? `${fmtQty(row.quantity)} ${row.cargo || ''}` : (row.cargo || '-')}</td>
                    <td style={{ ...rowCell, fontWeight: 650 }}>{row.loadport || 'No loadport recorded'}</td>
                    <td style={dateCell(row.cr)}>{row.cr || '-'}</td>
                    <td style={dateCell(row.eta)}>{row.eta || '-'}</td>
                    <td style={dateCell(row.etb)}>{row.etb || '-'}</td>
                    <td style={dateCell(row.etc)}>{row.etc || '-'}</td>
                    <td style={{ ...rowCell, textAlign: 'center' }}>
                      {(row.dischargePorts || []).length ? row.dischargePorts.map(port => (
                        <div key={`${port.port}-${port.vslId}`} style={{ marginBottom: 2 }}>{port.port}{port.quantity ? <span style={{ color: MUTED, fontSize: isChartering ? 11 : 9 }}> | {fmtQty(port.quantity)} MT</span> : ''}</div>
                      )) : '-'}
                    </td>
                    <td style={{ ...rowCell, boxShadow: edgeShadow('right'), verticalAlign: 'top', background: closed ? '#e8eaeb' : tbn ? '#fff4c2' : '#d3eadd' }}>
                      {isChartering ? <ContractProgress row={row} muted={closed} /> : <ContractColumn row={row} />}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={13} style={{ padding: 45, textAlign: 'center', color: MUTED }}>No export planning rows match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
