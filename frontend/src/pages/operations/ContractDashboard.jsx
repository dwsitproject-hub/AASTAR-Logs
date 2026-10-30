import React, { useEffect, useState, useMemo, useRef } from 'react';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import AnimatedCollapse from '../../components/AnimatedCollapse';
import { useRealtimeEvent } from '../../hooks/useRealtime';

const fmt = (n) => !n ? '0' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtDemm = (val) => {
  if (!val || val === 'TBA') return 'TBA';
  const n = parseFloat(val.toString().replace(/[^\d.-]/g, ''));
  if (isNaN(n)) return 'TBA';
  return 'USD ' + n.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' PDPR';
};

const badgeClass = (status) => {
  const s = (status || '').toUpperCase();
  if (['OPEN','PROV','SPACE','CLOSED'].includes(s)) return s;
  return 'other';
};
const badgeColors = {
  OPEN: { bg: '#2e7d32', fg: '#fff' },
  PROV: { bg: '#f9a825', fg: '#1a1a2e' },
  CLOSED: { bg: '#616161', fg: '#fff' },
  SPACE: { bg: '#5c6bc0', fg: '#fff' },
  other: { bg: '#607d8b', fg: '#fff' }
};
const statusKey = (v) => {
  const raw = (v?.status || '').toUpperCase().trim();
  if (raw) return raw;
  return v?.isClosed ? 'CLOSED' : 'OPEN';
};
const entityColors = (entity) => {
  const e = (entity || '').toUpperCase().trim();
  if (e === 'GR') return { bg: '#2e7d32', fg: '#fff' };
  if (e === 'A*JV') return { bg: '#8e24aa', fg: '#fff' };
  if (e.indexOf('A*') === 0) return { bg: '#d32f2f', fg: '#fff' };
  return { bg: 'rgba(255,255,255,0.15)', fg: '#fff' };
};

function Contract({ c, isSales }) {
  const bits = [];
  if (isSales && c.isGR) {
    if (c.contractNo) bits.push(<span key="cno" style={{ color: '#444', fontFamily: 'monospace', fontSize: 11 }}>{c.contractNo}</span>);
    if (c.counterparty) bits.push(<span key="p" style={{ color: '#14532d' }}>{c.counterparty}</span>);
    if (c.qty) bits.push(<span key="q" style={{ color: '#b8860b', fontWeight: 700 }}>{c.qty}</span>);
    if (c.cert) bits.push(<span key="ce" style={{ color: '#6a4c93', fontWeight: 600 }}>{c.cert}</span>);
    if (c.cargo) bits.push(<span key="ca" style={cargoChip}>{c.cargo}</span>);
    if (c.tolerance) bits.push(<span key="t" style={{ color: '#8a6d3b', fontWeight: 600, fontSize: 11 }}>{c.tolerance}</span>);
  } else {
    if (c.contractNo) bits.push(<span key="cno" style={{ color: '#444', fontFamily: 'monospace', fontSize: 11 }}>{c.contractNo}</span>);
    if (c.counterparty) bits.push(<span key="p" style={{ color: isSales ? '#14532d' : '#0d2c54' }}>{c.counterparty}</span>);
    if (c.qty) bits.push(<span key="q" style={{ color: '#b8860b', fontWeight: 700 }}>{c.qty}</span>);
    if (c.cargo || c.tolerance) bits.push(
      <span key="cb">
        {c.cargo && <span style={cargoChip}>{c.cargo}</span>}
        {c.tolerance && <span style={{ color: '#8a6d3b', fontWeight: 600, fontSize: 11, marginLeft: 4 }}>{c.tolerance}</span>}
      </span>
    );
  }
  const joinedMain = bits.reduce((acc, b, i) => i === 0 ? [b] : [...acc, <span key={'s'+i} style={{ opacity: 0.4, margin: '0 6px' }}>·</span>, b], []);

  if (c.isPartial) bits.push(<span key="partial" style={{ color: '#9d174d', background: '#fce7f3', padding: '1px 5px', borderRadius: 3, fontSize: 9, fontWeight: 700 }}>PARTIAL</span>);
  const subBits = [];
  if (c.periodStart || c.periodEnd) {
    subBits.push(<span key="p"><span style={subKey}>Period:</span> <span style={{ color: '#34495e', fontWeight: 600 }}>{c.periodStart || '?'} → {c.periodEnd || '?'}</span></span>);
  }
  if (c.payment) subBits.push(<span key="pay"><span style={subKey}>Pay:</span> {c.payment}</span>);
  if (c.pricing) subBits.push(
    <span key="pr">
      <span style={subKey}>Price:</span> <span style={{ color: '#00695c', fontWeight: 700 }}>{c.pricing}</span>
      {c.pricingType && <span style={priceTypeChip}>{c.pricingType}</span>}
      {(c.broker || c.brokerRef) && (
        <span style={brokerInfoStyle}>
          {c.broker && <span><span style={subKey}>Broker:</span> {c.broker}</span>}
          {c.broker && c.brokerRef && <span style={{ opacity: 0.45, margin: '0 5px' }}>·</span>}
          {c.brokerRef && <span><span style={subKey}>Ref:</span> {c.brokerRef}</span>}
        </span>
      )}
    </span>
  );

  return (
    <div style={{ border: '1px solid #e7ecf0', borderLeft: `3px solid ${isSales ? '#2d6a4f' : '#1565c0'}`, borderRadius: 5, padding: '8px 10px', marginBottom: 8, background: '#fff' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#1a1a2e', lineHeight: 1.45, marginBottom: 4 }}>
        {joinedMain}
        {isSales && c.isGR && <span style={{ fontSize: 8, background: '#6a4c93', color: '#fff', padding: '1px 5px', borderRadius: 3, fontWeight: 700, marginLeft: 4 }}>GR</span>}
      </div>
      {subBits.length > 0 && (
        <div style={{ fontSize: 11, color: '#5a6b7b', lineHeight: 1.5 }}>
          {subBits.reduce((acc, b, i) => i === 0 ? [b] : [...acc, <span key={'sep'+i}> &nbsp;|&nbsp; </span>, b], [])}
        </div>
      )}
    </div>
  );
}

function VesselCard({ v, dimmed, onToggleCheck, expanded, onToggleContracts, details, loadingDetails }) {
  const badge = badgeColors[badgeClass(v.status)];
  const ent = entityColors(v.entity);
  const purchases = details?.purchases || v.purchases || [];
  const sales = details?.sales || v.sales || [];
  const purchaseCount = details ? purchases.length : (v.purchaseCount ?? purchases.length);
  const salesCount = details ? sales.length : (v.salesCount ?? sales.length);

  return (
    <div style={{ background: '#fff', borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16, overflow: 'hidden', border: '1px solid #e3e8ed', opacity: dimmed ? 0.35 : 1, transition: 'opacity 0.2s' }}>
      {/* Vessel head */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', background: 'linear-gradient(90deg,#16213e,#1f3a5f)', color: '#fff', flexWrap: 'wrap', position: 'relative' }}>
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3 }}>{v.vessel}</span>
        {!v.nominated && <span title="Not nominated" style={nominatedBadge}>NOM</span>}
        {v.status && <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '3px 9px', borderRadius: 12, letterSpacing: 0.5, background: badge.bg, color: badge.fg }}>{v.status}</span>}
        {v.entity && <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4, background: ent.bg, color: ent.fg }}>{v.entity}</span>}
        <span style={{ fontSize: 11, opacity: 0.92, background: 'rgba(255,255,255,0.12)', padding: '4px 10px', borderRadius: 5 }}>
          <span style={{ opacity: 0.7, fontWeight: 600 }}>Demmurage Rate:</span> <span style={{ fontWeight: 700 }}>{fmtDemm(v.demmurage)}</span>
        </span>
        <button onClick={() => onToggleCheck(v.vslId)} style={{ position: 'absolute', top: 10, right: 12, width: 22, height: 22, borderRadius: 4, border: '2px solid ' + (dimmed ? '#2e7d32' : 'rgba(255,255,255,0.5)'), background: dimmed ? '#2e7d32' : 'transparent', cursor: 'pointer', color: '#fff', fontSize: 14, lineHeight: 1 }}>{dimmed ? '✓' : ''}</button>
      </div>

      {/* Balance lines */}
      {v.balanceLines?.map((bl, bi) => (
        <div key={bi} style={{ padding: '7px 16px', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #e3e8ed', background: bl.label === 'Sales needed' ? '#e8f5e9' : '#e3f2fd', color: bl.label === 'Sales needed' ? '#1b5e20' : '#0d47a1' }}>
          <span>⚖ {bl.label}:</span>
          <span style={{ fontWeight: 800 }}>{fmt(bl.amount)} {bl.cargo}</span>
          <span style={{ fontWeight: 600, opacity: 0.7, fontSize: 11 }}>Purchase {fmt(bl.purchase)} {bl.cargo}&nbsp;·&nbsp;Sales {fmt(bl.sales)} {bl.cargo}</span>
        </div>
      ))}

      {/* Loadports */}
      {v.loadports?.length > 0 && (
        <div style={{ background: '#f4f8f6', borderBottom: '1px solid #e3e8ed' }}>
          {v.loadports.map((lp, lpi) => {
            const portEntries = v.vdbByPort?.[lp.loadport];
            const cargoParts = portEntries?.flatMap(e => e.cargo && e.qty ? [<span key={e.cargo + e.shipper}>{fmt(e.qty)} {e.cargo}{e.shipper && <span style={shipperTag}>{e.shipper}</span>}</span>] : []);
            return (
              <div key={lpi} style={{ display: 'flex', flexWrap: 'wrap', width: '100%', borderBottom: '1px dashed #dfe6e2' }}>
                <LpCell label="Loadport" value={lp.loadport} portStyle />
                <LpCell label="Laycan" value={lp.laycan} />
                <LpCell label="ETA" value={lp.eta} />
                <LpCell label="ETB" value={lp.etb} />
                <LpCell label="ETC" value={lp.etc} />
                {cargoParts?.length > 0 && (
                  <div style={lpCellStyle}>
                    <span style={lpLabelStyle}>Cargo</span>
                    <span style={lpValueStyle}>
                      {cargoParts.reduce((acc, x, i) => i === 0 ? [x] : [...acc, ', ', x], [])}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Discharge */}
      {v.dischargePorts?.length > 0 && (
        <div style={{ background: '#fef9f0', borderBottom: '1px solid #e3e8ed' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', width: '100%' }}>
            <div style={lpCellStyle}>
              <span style={{ ...lpLabelStyle, color: '#bf360c' }}>Discharge</span>
              <span style={{ ...lpValueStyle, color: '#e65100' }}>{v.dischargePorts.map(dp => dp.port).join(', ')}</span>
            </div>
            {(() => {
              const parts = v.dischargePorts.filter(dp => dp.cargo && dp.qty).map(dp => `${fmt(dp.qty)} ${dp.cargo}`);
              return parts.length > 0 && <LpCell label="Cargo" value={parts.join(', ')} />;
            })()}
          </div>
        </div>
      )}

      {/* Contracts toggle */}
      <button onClick={onToggleContracts} style={{ width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', padding: '11px 16px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: '#34495e', display: 'flex', alignItems: 'center', gap: 10, background: '#f7f9fb', borderTop: '1px solid #e3e8ed' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#1565c0' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#1565c0' }}></span>
          Purchase <span style={{ fontWeight: 600, opacity: 0.6, fontSize: 11 }}>({purchaseCount})</span>
        </span>
        <span style={{ opacity: 0.3 }}>|</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#2d6a4f' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#2d6a4f' }}></span>
          Sales <span style={{ fontWeight: 600, opacity: 0.6, fontSize: 11 }}>({salesCount})</span>
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, transform: expanded ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>▼</span>
      </button>

      <AnimatedCollapse open={expanded} duration={300}>
        {loadingDetails && <div style={{ padding: 14, fontSize: 12, color: '#667085', background: '#fff' }}>Loading contracts...</div>}
        <div style={contractCombinedScrollStyle}>
        <div style={{ display: 'flex', gap: 0, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 360px', minWidth: 300, padding: '12px 14px', background: '#fbfcfd', borderRight: '1px solid #eef1f4' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 9, display: 'flex', alignItems: 'center', gap: 8, color: '#1565c0' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#1565c0' }}></span>
              Purchase <span style={{ fontWeight: 600, opacity: 0.6 }}>({purchaseCount})</span>
            </div>
            {purchases.length > 0
              ? purchases.map((c, i) => <Contract key={i} c={c} isSales={false} />)
              : !loadingDetails && <div style={emptySide}>No purchase contracts</div>}
          </div>
          <div style={{ flex: '1 1 360px', minWidth: 300, padding: '12px 14px', background: '#fff' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 9, display: 'flex', alignItems: 'center', gap: 8, color: '#2d6a4f' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#2d6a4f' }}></span>
              Sales <span style={{ fontWeight: 600, opacity: 0.6 }}>({salesCount})</span>
            </div>
            {sales.length > 0
              ? sales.map((c, i) => <Contract key={i} c={c} isSales={true} />)
              : !loadingDetails && <div style={emptySide}>No sales contracts</div>}
          </div>
        </div>
        </div>
      </AnimatedCollapse>
    </div>
  );
}

function LpCell({ label, value, portStyle }) {
  return (
    <div style={lpCellStyle}>
      <span style={lpLabelStyle}>{label}</span>
      <span style={portStyle ? { ...lpValueStyle, color: '#14532d' } : lpValueStyle}>{value || '—'}</span>
    </div>
  );
}

function FilterDropdown({ label, items, selected, onChange, onClear }) {
  const [open, setOpen] = useState(false);
  const count = Object.keys(selected).length;

  return (
    <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
      <button onClick={() => setOpen(o => !o)} style={dropdownBtn}>
        {label} <span style={pill}>{count === 0 ? 'All' : count + ' sel'}</span> <span style={{ fontSize: 9, opacity: 0.6 }}>▼</span>
      </button>
      {open && (
        <div style={dropdownMenu}>
          {items.map(item => (
            <label key={item} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 7px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
              <input type="checkbox" checked={!!selected[item]} onChange={e => onChange(item, e.target.checked)} />
              {item}
            </label>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 4px 2px', borderTop: '1px solid #eef1f4', marginTop: 6 }}>
            <a onClick={onClear} style={{ fontSize: 11, color: '#2d6a4f', cursor: 'pointer', fontWeight: 600 }}>Clear</a>
            <a onClick={() => setOpen(false)} style={{ fontSize: 11, color: '#2d6a4f', cursor: 'pointer', fontWeight: 600 }}>Done</a>
          </div>
        </div>
      )}
    </div>
  );
}

function estimateVesselCardHeight(v, expanded) {
  const loadportCount = Math.max(1, v.loadports?.length || 0);
  const balanceCount = v.balanceLines?.length || 0;
  const dischargeHeight = v.dischargePorts?.length > 0 ? 52 : 0;
  const base = 144 + (loadportCount * 54) + (balanceCount * 34) + dischargeHeight;
  if (!expanded) return Math.max(260, base + 58);

  const purchaseRows = Math.min(v.purchases?.length || 0, 6);
  const salesRows = Math.min(v.sales?.length || 0, 6);
  return Math.max(700, base + 230 + (Math.max(purchaseRows, salesRows) * 74));
}

function VirtualVesselGrid({ vessels, checkedVessels, expanded, onToggleCheck, onToggleContracts, contractDetails, loadingDetails }) {
  const containerRef = useRef(null);
  const [scrollState, setScrollState] = useState({ top: 0, height: 900 });
  const [containerWidth, setContainerWidth] = useState(1400);
  const gap = 16;
  const columnCount = containerWidth >= 1180 ? 4 : containerWidth >= 860 ? 3 : containerWidth >= 560 ? 2 : 1;

  useEffect(() => {
    let frame = 0;
    const updateScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setScrollState({ top: window.scrollY || 0, height: window.innerHeight || 900 });
      });
    };
    updateScroll();
    window.addEventListener('scroll', updateScroll, { passive: true });
    window.addEventListener('resize', updateScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', updateScroll);
      window.removeEventListener('resize', updateScroll);
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const updateWidth = () => setContainerWidth(el.clientWidth || 1400);
    updateWidth();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    let top = 0;
    const rows = [];
    for (let start = 0; start < vessels.length; start += columnCount) {
      const items = vessels.slice(start, start + columnCount).map((v, offset) => {
        const index = start + offset;
        const details = contractDetails[v.vslId];
        const heightSource = details ? { ...v, purchases: details.purchases || [], sales: details.sales || [] } : v;
        return { v, index, height: estimateVesselCardHeight(heightSource, !!expanded[index]) };
      });
      const height = Math.max(260, ...items.map(item => item.height));
      rows.push({ top, height, items });
      top += height + gap;
    }
    return { rows, totalHeight: Math.max(0, top - gap) };
  }, [vessels, expanded, columnCount, contractDetails]);

  const containerTop = containerRef.current
    ? containerRef.current.getBoundingClientRect().top + (window.scrollY || 0)
    : 0;
  const viewportTop = Math.max(0, scrollState.top - containerTop);
  const firstVisibleRow = layout.rows.findIndex(row => row.top + row.height >= viewportTop);
  const startRow = Math.max(0, (firstVisibleRow === -1 ? 0 : firstVisibleRow) - 1);
  const rowWindow = Math.max(1, Math.ceil(20 / columnCount));
  const visibleRows = layout.rows.slice(startRow, startRow + rowWindow);

  return (
    <div ref={containerRef} style={{ position: 'relative', height: layout.totalHeight, minHeight: 260 }}>
      {visibleRows.map(row => (
        <div
          key={row.top}
          style={{
            position: 'absolute',
            top: row.top,
            left: 0,
            right: 0,
            display: 'grid',
            gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
            gap,
            alignItems: 'start'
          }}
        >
          {row.items.map(({ v, index }) => (
            <VesselCard
              key={v.vslId + index}
              v={v}
              dimmed={!!checkedVessels[v.vslId]}
              onToggleCheck={onToggleCheck}
              expanded={!!expanded[index]}
              onToggleContracts={() => onToggleContracts(index)}
              details={contractDetails[v.vslId]}
              loadingDetails={!!loadingDetails[v.vslId]}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function ContractDashboard({ embedded = false }) {
  const [data, setData] = useState(null);
  const dataRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selEntities, setSelEntities] = useState({});
  const [selCargoes, setSelCargoes] = useState({});
  const [selLoadports, setSelLoadports] = useState({});
  const [selDischarges, setSelDischarges] = useState({});
  const [selStatuses, setSelStatuses] = useState({});
  const [checkedVessels, setCheckedVessels] = useState({});
  const [showPending, setShowPending] = useState(false);
  const [allExpanded, setAllExpanded] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [contractDetails, setContractDetails] = useState({});
  const [loadingDetails, setLoadingDetails] = useState({});
  const filterDebounce = useRef();
  const pageLimit = 80;

  const selectedKeys = (obj) => Object.keys(obj).filter(k => obj[k]);
  const requestParams = (offset = 0, limit = pageLimit) => ({
    q: search.trim() || undefined,
    entities: selectedKeys(selEntities).join(',') || undefined,
    cargoes: selectedKeys(selCargoes).join(',') || undefined,
    loadports: selectedKeys(selLoadports).join(',') || undefined,
    discharges: selectedKeys(selDischarges).join(',') || undefined,
    statuses: selectedKeys(selStatuses).join(',') || undefined,
    pending: showPending ? '1' : undefined,
    offset,
    limit
  });

  const load = (silent = false, offset = 0, append = false, { preserveView = false, limit = pageLimit } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    api.get('/sheets/contract-dashboard', { params: requestParams(offset, limit) })
      .then(r => {
        setData(prev => {
          const next = append && prev
            ? { ...r.data, vessels: [...prev.vessels, ...r.data.vessels] }
            : r.data;
          dataRef.current = next;
          return next;
        });
        if (!append && !preserveView) {
          setExpanded({});
          setAllExpanded(false);
          setContractDetails({});
          setLoadingDetails({});
        }
      })
      .catch(err => setError(err.response?.data?.error || 'Failed to load Contract Dashboard'))
      .finally(() => { if (!silent) setLoading(false); });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useDataRefresh({
    databases: ['DB1', 'DB2', 'DB3', 'DB4', 'DB5', 'DB6'],
    resources: ['vessel-matching', 'matching-sales', 'vessel-update'],
    onRefresh: () => {
      const loaded = Math.min(Math.max(dataRef.current?.vessels?.length || pageLimit, pageLimit), 200);
      load(true, 0, false, { preserveView: true, limit: loaded });
    },
  });

  useEffect(() => {
    if (!data) return;
    clearTimeout(filterDebounce.current);
    filterDebounce.current = setTimeout(() => load(true, 0, false), 250);
    return () => clearTimeout(filterDebounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, selEntities, selCargoes, selLoadports, selDischarges, selStatuses, showPending]);

  useRealtimeEvent(message => {
    if (!['vessel-update', 'vessel-matching', 'matching-sales', 'bulk-databases'].includes(message.resource)) return;
    load(true, 0, false);
  });

  const loadMore = () => {
    const nextOffset = data?.pagination?.nextOffset;
    if (nextOffset == null) return;
    load(true, nextOffset, true);
  };

  const loadContractDetails = async (vslId) => {
    if (!vslId || contractDetails[vslId] || loadingDetails[vslId]) return;
    setLoadingDetails(s => ({ ...s, [vslId]: true }));
    try {
      const r = await api.get('/sheets/contract-dashboard', { params: { details: '1', vslId } });
      setContractDetails(s => ({ ...s, [vslId]: r.data }));
    } catch {
      setContractDetails(s => ({ ...s, [vslId]: { purchases: [], sales: [] } }));
    } finally {
      setLoadingDetails(s => ({ ...s, [vslId]: false }));
    }
  };

  const allLoadports = useMemo(() => {
    if (!data) return [];
    if (data.filterOptions?.loadports) return data.filterOptions.loadports;
    const s = {};
    data.vessels.forEach(v => v.loadports?.forEach(lp => { if (lp.loadport) s[lp.loadport] = true; }));
    return Object.keys(s).sort();
  }, [data]);

  const allDischarges = useMemo(() => {
    if (!data) return [];
    if (data.filterOptions?.discharges) return data.filterOptions.discharges;
    const s = {};
    data.vessels.forEach(v => v.dischargePorts?.forEach(dp => { if (dp.port) s[dp.port] = true; }));
    return Object.keys(s).sort();
  }, [data]);

  const allStatuses = useMemo(() => {
    if (!data) return [];
    const statuses = data.filterOptions?.statuses || (() => {
      const s = {};
      data.vessels.forEach(v => { s[statusKey(v)] = true; });
      return Object.keys(s);
    })();
    return statuses.sort((a, b) => {
      const order = { OPEN: 0, PROV: 1, SPACE: 2, CLOSED: 99 };
      return (order[a] ?? 50) - (order[b] ?? 50) || a.localeCompare(b);
    });
  }, [data]);

  useEffect(() => {
    if (!data) return;
    setSelStatuses(current => {
      if (Object.keys(current).length > 0) return current;
      const defaults = {};
      data.vessels.forEach(v => {
        const key = statusKey(v);
        if (key !== 'CLOSED') defaults[key] = true;
      });
      return defaults;
    });
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.vessels;
  }, [data]);

  if (loading) return <div style={{ textAlign: 'center', padding: 70, fontSize: 14, color: '#666' }}>Loading vessels & contracts...</div>;
  if (error) return <div style={{ color: '#d32f2f', textAlign: 'center', padding: 24, fontSize: 13 }}>{error}</div>;
  if (!data) return null;

  const toggleCheck = (id) => setCheckedVessels(c => ({ ...c, [id]: !c[id] }));
  const toggleAll = () => {
    const next = !allExpanded;
    setAllExpanded(next);
    const m = {};
    filtered.forEach((_, i) => m[i] = next);
    setExpanded(m);
    if (next) {
      filtered.forEach(v => loadContractDetails(v.vslId));
    } else {
      // Collapse All: release every cached contract-detail payload so a long
      // session doesn't retain purchases/sales for every vessel ever opened.
      setContractDetails({});
      setLoadingDetails({});
    }
  };
  const toggleContracts = (v, vi) => {
    const nextOpen = !expanded[vi];
    setExpanded(e => ({ ...e, [vi]: nextOpen }));
    if (nextOpen) {
      loadContractDetails(v.vslId);
    } else {
      // Drop this vessel's cached contracts on collapse. The card falls back to
      // the light summary counts, and reopening re-fetches instantly.
      setContractDetails(s => { const n = { ...s }; delete n[v.vslId]; return n; });
      setLoadingDetails(s => { const n = { ...s }; delete n[v.vslId]; return n; });
    }
  };
  return (
    <div style={{ background: '#eef1f4', padding: embedded ? 0 : 14, margin: embedded ? 0 : '-28px -32px', minHeight: embedded ? '100%' : 'calc(100vh - var(--topbar-height))', fontSize: 12, color: '#1a1a2e' }}>
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center',
        margin: 0,
        flexWrap: 'wrap',
        position: 'sticky', top: embedded ? 0 : 'var(--topbar-height)',
        zIndex: 20,
        background: '#fff',
        borderBottom: '1px solid #e3e8ed',
        padding: '10px 14px'
      }}>
        <h1 style={{ fontSize: 14, fontWeight: 600, margin: 0, whiteSpace: 'nowrap' }}>Vessel / Contract Dashboard</h1>
        <span style={{ fontSize: 11, color: '#7b8794' }}>Updated {data.today}</span>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search vessel, contract, counterparty..." style={{ flex: 1, minWidth: 160, padding: '7px 10px', border: '1px solid #cdd5dd', borderRadius: 6, fontSize: 12, outline: 'none' }} />
        <FilterDropdown label="Entity" items={data.filterOptions?.entities || data.entities} selected={selEntities} onChange={(k, v) => setSelEntities(s => { const c = {...s}; if (v) c[k] = true; else delete c[k]; return c; })} onClear={() => setSelEntities({})} />
        <FilterDropdown label="Cargo" items={data.filterOptions?.cargoes || data.cargoes} selected={selCargoes} onChange={(k, v) => setSelCargoes(s => { const c = {...s}; if (v) c[k] = true; else delete c[k]; return c; })} onClear={() => setSelCargoes({})} />
        <FilterDropdown label="Loadport" items={allLoadports} selected={selLoadports} onChange={(k, v) => setSelLoadports(s => { const c = {...s}; if (v) c[k] = true; else delete c[k]; return c; })} onClear={() => setSelLoadports({})} />
        <FilterDropdown label="Discharge" items={allDischarges} selected={selDischarges} onChange={(k, v) => setSelDischarges(s => { const c = {...s}; if (v) c[k] = true; else delete c[k]; return c; })} onClear={() => setSelDischarges({})} />
        <FilterDropdown label="Status" items={allStatuses} selected={selStatuses} onChange={(k, v) => setSelStatuses(s => { const c = {...s}; if (v) c[k] = true; else delete c[k]; return c; })} onClear={() => setSelStatuses({})} />
        <span style={{ background: '#2d6a4f', color: '#fff', padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{filtered.length}/{data.pagination?.total ?? filtered.length} {filtered.length === 1 ? 'vessel' : 'vessels'}</span>
        <button onClick={toggleAll} style={ctrlBtn('#2d6a4f')}>{allExpanded ? '▼ Collapse All' : '▶ Expand All'}</button>
        <button onClick={() => setShowPending(p => !p)} style={ctrlBtn(showPending ? '#e65100' : '#2d6a4f')}>{showPending ? '✓ Pending' : '⚠ Pending'}</button>
      </div>

      <div style={{ padding: 14 }}>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 50, color: '#99a', fontStyle: 'italic' }}>No vessels match your filters.</div>
      ) : (
        <VirtualVesselGrid
          vessels={filtered}
          checkedVessels={checkedVessels}
          expanded={expanded}
          onToggleCheck={toggleCheck}
          onToggleContracts={(vi) => toggleContracts(filtered[vi], vi)}
          contractDetails={contractDetails}
          loadingDetails={loadingDetails}
        />
      )}
      {data.pagination?.hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 0 8px' }}>
          <button onClick={loadMore} style={ctrlBtn('#2d6a4f')}>Load More Vessels</button>
        </div>
      )}
      </div>
    </div>
  );
}

// Styles
const lpCellStyle = { padding: '7px 14px', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2, borderRight: '1px solid #e8eeea' };
const lpLabelStyle = { fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, color: '#7a8a82', fontWeight: 600 };
const lpValueStyle = { fontSize: 12, fontWeight: 600, color: '#1b4332' };
const cargoChip = { display: 'inline-block', background: '#eef3f0', color: '#2d6a4f', padding: '1px 7px', borderRadius: 3, fontSize: 11, fontWeight: 700 };
const shipperTag = { display: 'inline-block', fontSize: 9, fontWeight: 700, background: '#e0f2f1', color: '#00695c', padding: '1px 5px', borderRadius: 3, marginLeft: 4 };
const subKey = { color: '#93a1ab', fontWeight: 600 };
const priceTypeChip = { fontSize: 9, background: '#b2dfdb', color: '#004d40', padding: '1px 5px', borderRadius: 3, fontWeight: 700, marginLeft: 3 };
const brokerInfoStyle = { marginLeft: 8, color: '#455a64', fontWeight: 600 };
const nominatedBadge = { fontSize: 9, fontWeight: 800, letterSpacing: 0.5, padding: '3px 7px', borderRadius: 999, background: '#fff7ed', color: '#9a3412', border: '1px solid rgba(251,146,60,0.75)' };
const emptySide = { fontSize: 11, color: '#aab4bd', fontStyle: 'italic', padding: '2px 2px 6px' };
const contractCombinedScrollStyle = { maxHeight: 520, overflowY: 'auto' };
const dropdownBtn = { background: '#fff', border: '1px solid #cdd5dd', borderRadius: 6, padding: '9px 14px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 7, color: '#1a1a2e' };
const pill = { background: '#2d6a4f', color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 7px' };
const dropdownMenu = { position: 'absolute', top: 'calc(100% + 4px)', left: 0, background: '#fff', border: '1px solid #d4dce3', borderRadius: 6, boxShadow: '0 4px 14px rgba(0,0,0,0.14)', padding: 8, minWidth: 180, maxHeight: 280, overflowY: 'auto', zIndex: 50 };
const ctrlBtn = (bg) => ({ background: bg, color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 500 });
