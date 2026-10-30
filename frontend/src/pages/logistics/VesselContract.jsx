import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import { useTheme } from '../../context/ThemeContext';

const FONT_FAMILY = "'Segoe UI', system-ui, -apple-system, sans-serif";
const UI_FONT_SIZE = 12;
const PENDING_PAGE_SIZE = 500;
const PENDING_TABS = [
  {
    id: 'company',
    label: 'Aastar / Kimara',
    sources: ['AASTAR SALES', 'AASTAR PURCHASE', 'KIMARA SALES', 'KIMARA PURCHASE']
  },
  {
    id: 'gr',
    label: 'GR',
    sources: ['GR SALES', 'GR PURCHASE']
  }
];

const fmtQty = (value) => {
  const n = Number(typeof value === 'string' ? value.replace(/,/g, '') : value || 0);
  if (!Number.isFinite(n) || n === 0) return '';
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
};

const norm = (value) => (value || '').toString().trim().toLowerCase();
const baseVslId = (value) => {
  const vslId = (value || '').toString().trim();
  return vslId.replace(/_\d+$/, '') || vslId;
};
const formatDemurrage = (value) => {
  const raw = (value || '').toString().trim();
  if (!raw) return '';
  const numericText = raw.replace(/[^\d.-]/g, '');
  const numeric = numericText ? Number(numericText) : NaN;
  if (!Number.isFinite(numeric)) return raw;
  return `USD ${numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })} PDPR`;
};
const roundQty = (value) => Math.round(Number(value || 0) * 1000) / 1000;

function ContractStack({ title, contracts, accent }) {
  return (
    <div style={{ minWidth: 180, overflowWrap: 'anywhere' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: accent, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 5 }}>
        {title} ({contracts.length})
      </div>
      {contracts.length === 0 ? (
        <div style={{ fontSize: UI_FONT_SIZE, color: 'var(--text-muted)', fontStyle: 'italic' }}>No contracts</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {contracts.map((c, i) => (
            <div key={`${c.id || c.contractNo}-${i}`} style={{
              border: '1px solid var(--border)',
              borderLeft: `3px solid ${accent}`,
              borderRadius: 6,
              padding: '7px 8px',
              background: 'var(--bg-card)',
              boxShadow: '0 1px 1px rgba(15, 23, 42, 0.03)'
            }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 3 }}>
                <span style={{ fontWeight: 700, color: 'var(--text-main)', fontSize: UI_FONT_SIZE }}>{c.contractNo || c.id || '-'}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: UI_FONT_SIZE }}>{c.counterparty || '-'}</span>
                {c.qty && <span style={{ color: accent, fontSize: UI_FONT_SIZE, fontWeight: 700 }}>{fmtQty(c.qty)} MT</span>}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: UI_FONT_SIZE, lineHeight: 1.45 }}>
                {[c.periodStart && c.periodEnd ? `${c.periodStart} to ${c.periodEnd}` : '', c.payment, c.pricing ? `${c.pricing} ${c.pricingType || ''}` : ''].filter(Boolean).join(' | ')}
              </div>
              {(c.broker || c.brokerRef) && (
                <div style={{ color: 'var(--text-muted)', fontSize: UI_FONT_SIZE, marginTop: 2 }}>
                  {[c.broker, c.brokerRef].filter(Boolean).join(' | ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }) {
  const s = (status || '').toUpperCase();
  const bg = s === 'OPEN' ? '#dcfce7' : s === 'CLOSED' ? '#e5e7eb' : '#fef3c7';
  const fg = s === 'OPEN' ? '#166534' : s === 'CLOSED' ? '#475569' : '#92400e';
  return <span style={{ background: bg, color: fg, borderRadius: 999, padding: '3px 8px', fontSize: 11, fontWeight: 700 }}>{s || '-'}</span>;
}

function PendingContractCard({ row, accent }) {
  const period = [row.contractStart, row.contractEnd].filter(Boolean).join(' to ') || '-';
  const broker = [row.broker, row.brokerRef].filter(Boolean).join(' | ') || '-';

  return (
    <article style={{
      minWidth: 0,
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${accent}`,
      borderRadius: 6,
      padding: 9,
      background: 'var(--bg-card)',
      boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)'
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--text-main)', fontSize: UI_FONT_SIZE, fontWeight: 750, overflowWrap: 'anywhere' }}>{row.contractNo || row.ref || '-'}</div>
          {row.ref && row.contractNo && <div style={{ marginTop: 2, color: 'var(--text-muted)', fontSize: 10, overflowWrap: 'anywhere' }}>{row.ref}</div>}
        </div>
        <StatusPill status={row.status} />
      </div>

      <div style={{ marginTop: 7, color: 'var(--text-main)', fontSize: 11, fontWeight: 650, overflowWrap: 'anywhere' }}>{row.counterparty || '-'}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
        <span style={{ background: '#e0f2fe', color: '#075985', borderRadius: 5, padding: '2px 5px', fontSize: 10, fontWeight: 800 }}>{row.cargo || '-'}</span>
        <span style={{ color: accent, fontSize: 11, fontWeight: 800 }}>{fmtQty(row.qty) || '-'} MT</span>
        {row.tolerance && <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{row.tolerance}</span>}
        {row.isPartial && <span style={{ color: '#b45309', fontSize: 10, fontWeight: 800 }}>PARTIAL</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '7px 10px', marginTop: 9, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>Loadport</div>
          <div style={{ marginTop: 1, fontSize: 10, overflowWrap: 'anywhere' }}>{row.loadport || '-'}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>Period</div>
          <div style={{ marginTop: 1, fontSize: 10, overflowWrap: 'anywhere' }}>{period}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>Broker</div>
          <div style={{ marginTop: 1, fontSize: 10, overflowWrap: 'anywhere' }}>{broker}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>Intended Vessel</div>
          <div style={{ marginTop: 1, fontSize: 10, overflowWrap: 'anywhere' }}>{row.intentionVessel || '-'}</div>
        </div>
      </div>
    </article>
  );
}

function FilterDropdown({ label, items, selected, onChange, onClear }) {
  const [open, setOpen] = useState(false);
  const count = Object.keys(selected).length;

  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(value => !value)} style={{
        height: 32,
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '0 9px',
        background: 'var(--bg-card)',
        color: 'var(--text-main)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: UI_FONT_SIZE,
        whiteSpace: 'nowrap'
      }}>
        {label} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{count ? `${count} selected` : 'All'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          zIndex: 40,
          width: 210,
          maxHeight: 250,
          overflowY: 'auto',
          padding: 6,
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'var(--bg-card)',
          boxShadow: 'var(--shadow-lg)'
        }}>
          {items.length === 0 ? (
            <div style={{ padding: 7, color: 'var(--text-muted)', fontSize: UI_FONT_SIZE }}>No options</div>
          ) : items.map(item => (
            <label key={item} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 4px', color: 'var(--text-main)', fontSize: UI_FONT_SIZE, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!selected[item]} onChange={e => onChange(item, e.target.checked)} />
              <span>{item}</span>
            </label>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', marginTop: 5, padding: '7px 4px 2px' }}>
            <button onClick={onClear} style={{ border: 0, padding: 0, background: 'none', color: '#2563eb', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}>Clear</button>
            <button onClick={() => setOpen(false)} style={{ border: 0, padding: 0, background: 'none', color: '#2563eb', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function VesselContract() {
  const { isDark } = useTheme();
  const [data, setData] = useState(null);
  const dataRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [pendingData, setPendingData] = useState(null);
  const pendingDataRef = useRef(null);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingRefreshing, setPendingRefreshing] = useState(false);
  const [pendingError, setPendingError] = useState('');
  const [pendingTab, setPendingTab] = useState('company');
  const [query, setQuery] = useState('');
  const [selectedEntities, setSelectedEntities] = useState({});
  const [selectedCargoes, setSelectedCargoes] = useState({});
  const [selectedLoadports, setSelectedLoadports] = useState({});
  const [selectedStatuses, setSelectedStatuses] = useState({ OPEN: true });

  const load = async ({ silent = false, force = false } = {}) => {
    const hasData = dataRef.current !== null;
    if (!silent && hasData) setRefreshing(true);
    else if (!hasData) setLoading(true);
    try {
      const res = await api.get('/sheets/vessel-contract');
      const next = res.data;
      if (silent && !force && hasData && dataRef.current.updatedAt === next.updatedAt) return;
      dataRef.current = next;
      setData(next);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load Vessel Contract');
    } finally {
      if (!silent && hasData) setRefreshing(false);
      else if (!hasData) setLoading(false);
    }
  };

  const loadPending = async ({ silent = false, force = false, offset = 0, append = false } = {}) => {
    const hasData = pendingDataRef.current !== null;
    if (!silent && hasData) setPendingRefreshing(true);
    else if (!hasData) setPendingLoading(true);
    try {
      const res = await api.get('/sheets/vessel-contract/pending', {
        params: { offset, limit: PENDING_PAGE_SIZE }
      });
      if (silent && !force && !append && hasData && pendingDataRef.current.updatedAt === res.data.updatedAt) return;
      const next = append && pendingDataRef.current
        ? { ...res.data, rows: [...pendingDataRef.current.rows, ...res.data.rows] }
        : res.data;
      pendingDataRef.current = next;
      setPendingData(next);
      setPendingError('');
    } catch (err) {
      setPendingError(err.response?.data?.error || 'Failed to load pending contracts');
    } finally {
      if (!silent && hasData) setPendingRefreshing(false);
      else if (!hasData) setPendingLoading(false);
    }
  };

  useEffect(() => {
    load();
    loadPending();
  }, []);
  useDataRefresh({
    databases: ['DB1', 'DB2', 'DB3', 'DB4', 'DB5', 'DB6', 'DB10'],
    resources: ['vessel-matching', 'matching-sales', 'vessel-update'],
    onRefresh: ({ reason }) => {
      load({ silent: true, force: reason !== 'fallback' });
      loadPending({ silent: true, force: reason !== 'fallback' });
    },
  });

  const rows = useMemo(() => {
    const q = norm(query);
    const entities = Object.keys(selectedEntities);
    const cargoes = Object.keys(selectedCargoes);
    const loadports = Object.keys(selectedLoadports);
    const statuses = Object.keys(selectedStatuses);
    return (data?.rows || []).filter(row => {
      if (entities.length && !entities.includes(row.entity || '')) return false;
      if (cargoes.length && !cargoes.includes(row.cargo || '')) return false;
      if (loadports.length && !loadports.includes(row.loadport || '')) return false;
      if (statuses.length && !statuses.includes((row.status || '').toUpperCase())) return false;
      if (!q) return true;
      const text = [
        row.vessel, row.vslId, row.entity, row.status, row.loadport, row.cargo,
        ...row.purchaseContracts.flatMap(c => [c.contractNo, c.counterparty, c.broker, c.brokerRef]),
        ...row.salesContracts.flatMap(c => [c.contractNo, c.counterparty, c.broker, c.brokerRef])
      ].join(' ').toLowerCase();
      return text.includes(q);
    });
  }, [data, query, selectedEntities, selectedCargoes, selectedLoadports, selectedStatuses]);

  const filterOptions = useMemo(() => ({
    entities: data?.options?.entities || [],
    cargoes: data?.options?.cargoes || [],
    loadports: data?.options?.loadports || [],
    statuses: data?.options?.statuses || []
  }), [data]);

  const activePendingTab = PENDING_TABS.find(tab => tab.id === pendingTab) || PENDING_TABS[0];
  const pendingRowsBySource = useMemo(() => {
    const grouped = Object.fromEntries(activePendingTab.sources.map(source => [source, []]));
    (pendingData?.rows || []).forEach(row => {
      if (grouped[row.sourceTab]) grouped[row.sourceTab].push(row);
    });
    return grouped;
  }, [pendingData, pendingTab]);
  const pendingTabTotals = useMemo(() => Object.fromEntries(PENDING_TABS.map(tab => [
    tab.id,
    tab.sources.reduce((total, source) => total + Number(pendingData?.sourceCounts?.[source] || 0), 0)
  ])), [pendingData]);

  const totals = useMemo(() => rows.reduce((acc, row) => {
    acc.loaded += Number(row.loadedQty || 0);
    acc.purchase += Number(row.purchaseQty || 0);
    acc.sales += Number(row.salesQty || 0);
    return acc;
  }, { loaded: 0, purchase: 0, sales: 0 }), [rows]);

  const groupedRows = useMemo(() => {
    const vesselMap = new Map();

    rows.forEach(row => {
      const vesselKey = baseVslId(row.vslId) || row.vessel || `vessel-${vesselMap.size}`;
      if (!vesselMap.has(vesselKey)) {
        vesselMap.set(vesselKey, {
          key: vesselKey,
          vessel: row.vessel || 'TBN',
          vslId: baseVslId(row.vslId),
          entity: row.entity,
          status: row.status,
          nominated: row.nominated,
          demmurage: row.demmurage,
          dischargePorts: row.dischargePorts || [],
          ports: new Map(),
          loadedQty: 0,
          purchaseQty: 0,
          salesQty: 0
        });
      }

      const vesselGroup = vesselMap.get(vesselKey);
      vesselGroup.loadedQty += Number(row.loadedQty || 0);
      vesselGroup.purchaseQty += Number(row.purchaseQty || 0);
      vesselGroup.salesQty += Number(row.salesQty || 0);

      if (!vesselGroup.demmurage && row.demmurage) vesselGroup.demmurage = row.demmurage;
      if ((!vesselGroup.dischargePorts || vesselGroup.dischargePorts.length === 0) && row.dischargePorts?.length) {
        vesselGroup.dischargePorts = row.dischargePorts;
      }

      const portKey = row.vslId || row.loadport || 'Unassigned Loadport';
      if (!vesselGroup.ports.has(portKey)) {
        vesselGroup.ports.set(portKey, {
          key: `${vesselKey}-${portKey}`,
          vslId: row.vslId,
          loadport: row.loadport || 'Unassigned Loadport',
          dischargePorts: row.dischargePorts || [],
          laycan: row.laycan,
          eta: row.eta,
          etb: row.etb,
          etc: row.etc,
          rows: [],
          loadedQty: 0,
          purchaseQty: 0,
          salesQty: 0
        });
      }

      const portGroup = vesselGroup.ports.get(portKey);
      portGroup.rows.push(row);
      if ((!portGroup.dischargePorts || portGroup.dischargePorts.length === 0) && row.dischargePorts?.length) {
        portGroup.dischargePorts = row.dischargePorts;
      }
      portGroup.loadedQty += Number(row.loadedQty || 0);
      portGroup.purchaseQty += Number(row.purchaseQty || 0);
      portGroup.salesQty += Number(row.salesQty || 0);
    });

    return Array.from(vesselMap.values()).map(vessel => ({
      ...vessel,
      loadedQty: roundQty(vessel.loadedQty),
      purchaseQty: roundQty(vessel.purchaseQty),
      salesQty: roundQty(vessel.salesQty),
      ports: Array.from(vessel.ports.values()).map(port => ({
        ...port,
        loadedQty: roundQty(port.loadedQty),
        purchaseQty: roundQty(port.purchaseQty),
        salesQty: roundQty(port.salesQty)
      }))
    }));
  }, [rows]);

  const th = {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    background: isDark ? '#1e293b' : '#f8fafc',
    color: 'var(--text-muted)',
    borderBottom: '1px solid var(--border)',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    padding: '7px 8px',
    textAlign: 'left',
    whiteSpace: 'nowrap'
  };
  const td = { borderBottom: '1px solid var(--border)', padding: '7px 8px', verticalAlign: 'top', fontSize: UI_FONT_SIZE };
  const scheduleItem = { color: 'var(--text-muted)', fontSize: UI_FONT_SIZE, lineHeight: 1.4, whiteSpace: 'nowrap' };
  const scheduleValue = { color: 'var(--text-main)', fontWeight: 600 };
  const vesselStripCell = {
    position: 'sticky',
    top: 30,
    zIndex: 5,
    boxShadow: '0 2px 4px rgba(15, 23, 42, 0.12)'
  };
  const loadportStripCell = {
    position: 'sticky',
    top: 90,
    zIndex: 4,
    boxShadow: '0 2px 4px rgba(15, 23, 42, 0.10)'
  };
  const vesselCardBorder = isDark ? '#64748b' : '#334155';

  return (
    <div style={{ color: 'var(--text-main)', fontFamily: FONT_FAMILY, fontSize: UI_FONT_SIZE, lineHeight: 1.4 }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 20, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '8px 0', flexWrap: 'wrap', background: 'var(--bg-app)', borderBottom: '1px solid var(--border)' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 650 }}>Vessel Contract</h2>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search vessel, port, cargo, contract..."
            style={{
              width: 250,
              maxWidth: '32vw',
              height: 34,
              border: '1px solid var(--border)',
              borderRadius: 7,
              padding: '0 10px',
              background: 'var(--bg-card)',
              color: 'var(--text-main)',
              fontSize: UI_FONT_SIZE,
              fontFamily: 'inherit'
            }}
          />
          <FilterDropdown label="Entity" items={filterOptions.entities} selected={selectedEntities} onChange={(key, checked) => setSelectedEntities(current => ({ ...current, ...(checked ? { [key]: true } : (() => { const next = { ...current }; delete next[key]; return next; })()) }))} onClear={() => setSelectedEntities({})} />
          <FilterDropdown label="Cargo" items={filterOptions.cargoes} selected={selectedCargoes} onChange={(key, checked) => setSelectedCargoes(current => ({ ...current, ...(checked ? { [key]: true } : (() => { const next = { ...current }; delete next[key]; return next; })()) }))} onClear={() => setSelectedCargoes({})} />
          <FilterDropdown label="Loadport" items={filterOptions.loadports} selected={selectedLoadports} onChange={(key, checked) => setSelectedLoadports(current => ({ ...current, ...(checked ? { [key]: true } : (() => { const next = { ...current }; delete next[key]; return next; })()) }))} onClear={() => setSelectedLoadports({})} />
          <FilterDropdown label="Status" items={filterOptions.statuses} selected={selectedStatuses} onChange={(key, checked) => setSelectedStatuses(current => ({ ...current, ...(checked ? { [key]: true } : (() => { const next = { ...current }; delete next[key]; return next; })()) }))} onClear={() => setSelectedStatuses({})} />
          <button onClick={() => { load(); loadPending(); }} disabled={refreshing || pendingRefreshing} style={{
            height: 34,
            border: 'none',
            borderRadius: 7,
            padding: '0 13px',
            background: refreshing || pendingRefreshing ? '#94a3b8' : '#2563eb',
            color: '#fff',
            cursor: refreshing || pendingRefreshing ? 'wait' : 'pointer',
            fontSize: 12,
            fontWeight: 700
          }}>{refreshing || pendingRefreshing ? 'Refreshing...' : 'Refresh'}</button>
        </div>
      </div>

      {error && <div style={{ padding: 12, borderRadius: 8, background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', marginBottom: 12 }}>{error}</div>}
      {loading && !data ? (
        <div style={{ padding: 45, textAlign: 'center', color: 'var(--text-muted)' }}>Loading vessel contracts...</div>
      ) : (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ maxHeight: 'calc(100vh - 260px)', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'auto', minWidth: 0 }}>
              <thead>
                <tr>
                  <th style={th}>VSL ID</th>
                  <th style={th}>Cargo</th>
                  <th style={th}>Schedule</th>
                  <th style={th}>Qty</th>
                  <th style={th}>Purchase Contracts</th>
                  <th style={th}>Sales Contracts</th>
                  <th style={th}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {groupedRows.map((vesselGroup, vesselIdx) => (
                  <React.Fragment key={vesselGroup.key}>
                    {vesselIdx > 0 && <tr aria-hidden="true"><td colSpan={7} style={{ height: 8, padding: 0, border: 0, background: 'var(--bg-app)' }} /></tr>}
                    <tr>
                      <td colSpan={7} style={{ ...vesselStripCell,
                        borderTop: `1px solid ${vesselCardBorder}`,
                        borderRight: `1px solid ${vesselCardBorder}`,
                        borderBottom: `1px solid ${vesselCardBorder}`,
                        borderLeft: `1px solid ${vesselCardBorder}`,
                        borderRadius: '7px 7px 0 0',
                        padding: '10px 12px',
                        background: isDark ? '#0f172a' : '#eef6ff'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                          <div style={{ minWidth: 240 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontFamily: 'Cambria, Georgia, serif', fontWeight: 700, fontSize: 15 }}>{vesselGroup.vessel}</span>
                              {vesselGroup.nominated === false && <span style={{ background: '#fff7ed', color: '#c2410c', borderRadius: 999, padding: '3px 7px', fontSize: 10, fontWeight: 800 }}>NOM</span>}
                              <StatusPill status={vesselGroup.status} />
                            </div>
                            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}>
                              {[vesselGroup.vslId, vesselGroup.entity].filter(Boolean).join(' | ') || '-'}
                              {vesselGroup.demmurage ? ` | Demm: ${formatDemurrage(vesselGroup.demmurage)}` : ''}
                            </div>
                          </div>
                          <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, flexWrap: 'wrap', color: 'var(--text-muted)', fontSize: 11 }}>
                            <span>Ports: <b style={{ color: 'var(--text-main)' }}>{vesselGroup.ports.length}</b></span>
                            <span>Loaded: <b style={{ color: 'var(--text-main)' }}>{fmtQty(vesselGroup.loadedQty) || '0'}</b></span>
                            <span>Purchase: <b style={{ color: 'var(--text-main)' }}>{fmtQty(vesselGroup.purchaseQty) || '0'}</b></span>
                            <span>Sales: <b style={{ color: 'var(--text-main)' }}>{fmtQty(vesselGroup.salesQty) || '0'}</b></span>
                          </div>
                        </div>
                      </td>
                    </tr>
                    {vesselGroup.ports.map((portGroup) => (
                      <React.Fragment key={portGroup.key}>
                        <tr>
                          <td colSpan={7} style={{ ...loadportStripCell,
                            borderRight: `1px solid ${vesselCardBorder}`,
                            borderLeft: `1px solid ${vesselCardBorder}`,
                            padding: '8px 12px',
                            borderBottom: '1px solid var(--border)',
                            background: isDark ? '#172033' : '#f8fafc'
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                              <div style={{ display: 'grid', gap: 2, minWidth: 210 }}>
                                <span style={{ ...scheduleItem, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>Loadport: <b style={scheduleValue}>{portGroup.loadport}</b></span>
                                <span style={scheduleItem}>Discharge Port: <b style={scheduleValue}>{portGroup.dischargePorts?.map(d => d.port).filter(Boolean).join(', ') || '-'}</b></span>
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(62px, auto))', gap: '2px 14px' }}>
                                <span style={scheduleItem}>Laycan: <b style={scheduleValue}>{portGroup.laycan || '-'}</b></span>
                                <span style={scheduleItem}>ETA: <b style={scheduleValue}>{portGroup.eta || '-'}</b></span>
                                <span style={scheduleItem}>ETB: <b style={scheduleValue}>{portGroup.etb || '-'}</b></span>
                                <span style={scheduleItem}>ETC: <b style={scheduleValue}>{portGroup.etc || '-'}</b></span>
                              </div>
                              <span style={{ ...scheduleItem, marginLeft: 'auto' }}>
                                Loaded <b style={{ color: 'var(--text-main)' }}>{fmtQty(portGroup.loadedQty) || '0'}</b> | Purchase <b style={{ color: 'var(--text-main)' }}>{fmtQty(portGroup.purchaseQty) || '0'}</b> | Sales <b style={{ color: 'var(--text-main)' }}>{fmtQty(portGroup.salesQty) || '0'}</b>
                              </span>
                            </div>
                          </td>
                        </tr>
                        {portGroup.rows.map((row, idx) => {
                          const usesPurchaseBalance = (row.purchaseContracts || []).length > 0;
                          const balance = usesPurchaseBalance
                            ? Number(row.balanceToPurchase || 0)
                            : Number(row.balanceToLoaded || 0);
                          const balanceColor = balance > 0 ? '#b45309' : '#166534';
                          const isLastGroupRow = portGroup.key === vesselGroup.ports[vesselGroup.ports.length - 1]?.key && idx === portGroup.rows.length - 1;
                          const groupRowBorder = isLastGroupRow ? `1px solid ${vesselCardBorder}` : td.borderBottom;
                          return (
                            <tr key={`${row.key}-${idx}`} style={{ background: idx % 2 ? (isDark ? '#111827' : '#fbfdff') : 'transparent' }}>
                              <td style={{ ...td, minWidth: 140, color: 'var(--text-muted)', borderLeft: `1px solid ${vesselCardBorder}`, borderBottom: groupRowBorder }}>
                                <div style={{ fontSize: UI_FONT_SIZE }}>{row.vslId || '-'}</div>
                              </td>
                              <td style={{ ...td, minWidth: 75, borderBottom: groupRowBorder }}>
                                <span style={{ background: '#e0f2fe', color: '#075985', borderRadius: 6, padding: '4px 7px', fontSize: UI_FONT_SIZE, fontWeight: 800 }}>
                                  {row.cargo || '-'}
                                </span>
                              </td>
                              <td style={{ ...td, minWidth: 145, color: 'var(--text-muted)', lineHeight: 1.5, borderBottom: groupRowBorder }}>
                                <div style={scheduleItem}>Laycan: <b style={scheduleValue}>{row.laycan || '-'}</b></div>
                                <div style={scheduleItem}>ETA: <b style={scheduleValue}>{row.eta || '-'}</b> | ETB: <b style={scheduleValue}>{row.etb || '-'}</b> | ETC: <b style={scheduleValue}>{row.etc || '-'}</b></div>
                                <div style={scheduleItem}>Demurrage: <b style={scheduleValue}>{formatDemurrage(row.demmurage) || '-'}</b></div>
                              </td>
                              <td style={{ ...td, minWidth: 105, lineHeight: 1.75, borderBottom: groupRowBorder }}>
                                <div>Loaded: <b>{fmtQty(row.loadedQty) || '-'}</b></div>
                                <div>Purchase: <b>{fmtQty(row.purchaseQty) || '-'}</b></div>
                                <div>Sales: <b>{fmtQty(row.salesQty) || '-'}</b></div>
                              </td>
                              <td style={{ ...td, minWidth: 190, borderBottom: groupRowBorder }}><ContractStack title="Purchase" contracts={row.purchaseContracts} accent="#2563eb" /></td>
                              <td style={{ ...td, minWidth: 190, borderBottom: groupRowBorder }}><ContractStack title="Sales" contracts={row.salesContracts} accent="#047857" /></td>
                              <td style={{ ...td, minWidth: 110, borderRight: `1px solid ${vesselCardBorder}`, borderBottom: groupRowBorder }}>
                                <div style={{ color: balanceColor, fontWeight: 800 }}>{fmtQty(Math.abs(balance)) || 'Matched'}</div>
                                <div style={{ color: 'var(--text-muted)', fontSize: UI_FONT_SIZE, marginTop: 4 }}>
                                  {balance > 0
                                    ? (usesPurchaseBalance ? 'Sales short vs purchase' : 'Sales short vs loaded')
                                    : balance < 0
                                      ? (usesPurchaseBalance ? 'Sales over purchase' : 'Sales over loaded')
                                      : (usesPurchaseBalance ? 'Purchase equals sales' : 'Loaded equals sales')}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </React.Fragment>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No vessel contract rows match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <section aria-labelledby="pending-matching-title" style={{ marginTop: 18, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '10px 12px', borderBottom: '1px solid var(--border)', background: isDark ? '#172033' : '#f8fafc' }}>
          <div>
            <h3 id="pending-matching-title" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Pending Matching</h3>
            <div style={{ marginTop: 2, color: 'var(--text-muted)', fontSize: 11 }}>Contracts without an active vessel link</div>
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            <b style={{ color: 'var(--text-main)' }}>{pendingTabTotals[pendingTab] ?? '-'}</b> in this view
            <span style={{ margin: '0 6px' }}>|</span>
            <b style={{ color: 'var(--text-main)' }}>{pendingData?.pagination?.total ?? '-'}</b> total
          </div>
        </div>

        <div role="tablist" aria-label="Pending contract sources" style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-card)' }}>
          {PENDING_TABS.map(tab => {
            const active = tab.id === pendingTab;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active}
                onClick={() => setPendingTab(tab.id)}
                style={{
                  height: 30,
                  border: `1px solid ${active ? '#2563eb' : 'var(--border)'}`,
                  borderRadius: 6,
                  padding: '0 10px',
                  background: active ? '#2563eb' : 'var(--bg-card)',
                  color: active ? '#fff' : 'var(--text-main)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 11,
                  fontWeight: 700,
                  transition: 'background-color 150ms ease, border-color 150ms ease, color 150ms ease'
                }}
              >{tab.label} <span style={{ opacity: active ? 0.85 : 0.65 }}>({pendingTabTotals[tab.id] || 0})</span></button>
            );
          })}
        </div>

        {pendingError && <div style={{ margin: 12, padding: 10, borderRadius: 6, background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', fontSize: UI_FONT_SIZE }}>{pendingError}</div>}
        {pendingLoading && !pendingData ? (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>Loading pending contracts...</div>
        ) : pendingTabTotals[pendingTab] === 0 ? (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>All contracts in this group are currently matched.</div>
        ) : (
          <>
            <div style={{ maxHeight: 620, overflow: 'auto' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${activePendingTab.sources.length}, minmax(270px, 1fr))`,
                minWidth: activePendingTab.sources.length === 4 ? 1120 : 700,
                alignItems: 'start'
              }}>
                {activePendingTab.sources.map((source, sourceIndex) => {
                  const contracts = pendingRowsBySource[source] || [];
                  const sourceTotal = Number(pendingData?.sourceCounts?.[source] || 0);
                  const accent = source.endsWith('PURCHASE') ? '#2563eb' : '#047857';
                  return (
                    <div key={source} style={{ minWidth: 0, minHeight: 180, borderRight: sourceIndex < activePendingTab.sources.length - 1 ? '1px solid var(--border)' : 0, background: isDark ? '#111827' : '#f8fafc' }}>
                      <div style={{ position: 'sticky', top: 0, zIndex: 3, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border)', background: isDark ? '#1e293b' : '#eef2f7' }}>
                        <span style={{ color: accent, fontSize: 11, fontWeight: 800 }}>{source}</span>
                        <span style={{ minWidth: 22, borderRadius: 999, padding: '2px 6px', background: isDark ? '#334155' : '#fff', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, textAlign: 'center' }}>{sourceTotal}</span>
                      </div>
                      <div style={{ display: 'grid', gap: 8, padding: 8 }}>
                        {contracts.map(row => <PendingContractCard key={row.key} row={row} accent={accent} />)}
                        {contracts.length === 0 && <div style={{ padding: '22px 8px', color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic', textAlign: 'center' }}>No pending contracts</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {pendingData?.pagination?.hasMore && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 10, borderTop: '1px solid var(--border)' }}>
                <button
                  onClick={() => loadPending({ offset: pendingData.pagination.nextOffset, append: true })}
                  disabled={pendingRefreshing}
                  style={{ height: 32, border: '1px solid var(--border)', borderRadius: 6, padding: '0 12px', background: 'var(--bg-card)', color: 'var(--text-main)', cursor: pendingRefreshing ? 'wait' : 'pointer', fontFamily: 'inherit', fontSize: UI_FONT_SIZE, fontWeight: 700 }}
                >{pendingRefreshing ? 'Loading...' : `Show more (${pendingData.pagination.total - pendingData.rows.length} remaining)`}</button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
