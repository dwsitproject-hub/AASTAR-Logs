import React, { useEffect, useState, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import {
  colorFor, DEFAULT_STOCK_CARGOES, fmtDate, normCargo,
  portsMatch, shippersMatch, cargoesMatch, shouldCombinePfadCargo,
} from './stockUtils';

// Charts pull in recharts (~380 kB). Lazy-load them so recharts is split into
// its own chunk and only fetched once stock data is ready to render — the page
// shell and filter controls stay in the light StockSummary chunk.
const ChartCard = lazy(() => import('./StockChartCard'));

function MultiSelectDropdown({ label, options, selected, onChange, colorMap, minWidth = 220 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);
  const toggle = (opt) => onChange(selected.includes(opt) ? selected.filter(x => x !== opt) : [...selected, opt]);
  const summary = selected.length === 0 ? 'None' : selected.length === options.length ? `All ${options.length}` : `${selected.length} selected`;
  return (
    <div ref={ref} style={{ position: 'relative', minWidth }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</label>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)',
        background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: 13, cursor: 'pointer',
      }}>
        <span>{summary}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: 'var(--shadow-lg)', maxHeight: 300, overflowY: 'auto', padding: 6,
        }}>
          <div style={{ display: 'flex', gap: 6, padding: '4px 6px 6px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
            <button onClick={() => onChange([...options])} style={miniBtn}>Select all</button>
            <button onClick={() => onChange([])} style={miniBtn}>Clear</button>
          </div>
          {options.map(opt => {
            const checked = selected.includes(opt);
            const dot = colorMap ? colorMap(opt) : null;
            return (
              <label key={opt} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6,
                fontSize: 13, color: 'var(--text-main)', cursor: 'pointer',
                background: checked ? 'rgba(37,99,235,0.08)' : 'transparent',
              }}>
                <input type="checkbox" checked={checked} onChange={() => toggle(opt)} style={{ width: 14, height: 14, accentColor: '#2563eb' }} />
                {dot && <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, flexShrink: 0 }} />}
                <span style={{ flex: 1 }}>{opt}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

const miniBtn = {
  fontSize: 11, padding: '3px 10px', borderRadius: 12, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
};

export default function StockSummary() {
  const [payload, setPayload] = useState({ ports: [], vessels: [], updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [groupBy, setGroupBy] = useState('individual'); // 'port' | 'cargo' | 'individual'
  const [showVessels, setShowVessels] = useState(true);
  const [selectedPorts, setSelectedPorts] = useState([]);
  const [selectedCargoes, setSelectedCargoes] = useState([]);
  const didApplyDefaultFilters = useRef(false);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await api.get('/sheets/stock-summary');
      setPayload(res.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load stock summary');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOnce();
  }, [fetchOnce]);

  useDataRefresh({
    databases: ['DB9'],
    onRefresh: fetchOnce,
    fallbackMs: 7000,
  });

  const allPorts = useMemo(() => payload.ports.map(p => p.name), [payload]);
  const allCargoes = useMemo(() => {
    const set = new Set();
    payload.ports.forEach(p => p.cargoes.forEach(c => set.add(c)));
    return Array.from(set);
  }, [payload]);
  const allDates = useMemo(() => payload.ports.length ? (payload.ports[0].dates || []) : [], [payload]);
  const vessels = payload.vessels || [];

  useEffect(() => {
    if (didApplyDefaultFilters.current || !allPorts.length || !allCargoes.length) return;
    const defaultCargoes = allCargoes.filter(c =>
      DEFAULT_STOCK_CARGOES.some(defaultCargo => normCargo(defaultCargo) === normCargo(c))
    );
    setSelectedPorts(allPorts);
    setSelectedCargoes(defaultCargoes);
    didApplyDefaultFilters.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPorts.join('|'), allCargoes.join('|')]);

  const togglePort = (p) => setSelectedPorts(s => s.includes(p) ? s.filter(x => x !== p) : [...s, p]);
  const toggleCargo = (c) => setSelectedCargoes(s => s.includes(c) ? s.filter(x => x !== c) : [...s, c]);

  // Build vessel overlay keyed by date label, filtered by chart context
  const buildVesselOverlay = (matchesVessel, matchesCargo) => {
    if (!showVessels) return null;
    const map = {};
    vessels.forEach(v => {
      if (!matchesVessel(v) || !matchesCargo(v.cargo)) return;
      const dateLabel = fmtDate(v.eta);
      if (!map[dateLabel]) map[dateLabel] = [];
      map[dateLabel].push(v);
    });
    return Object.keys(map).length ? map : null;
  };

  const charts = useMemo(() => {
    if (groupBy === 'port') {
      return payload.ports
        .filter(p => selectedPorts.includes(p.name))
        .map(p => {
          const lineKeys = p.cargoes.filter(c => selectedCargoes.includes(c));
          if (!lineKeys.length) return null;
          const data = p.dates.map((iso, i) => {
            const row = { date: fmtDate(iso), iso };
            lineKeys.forEach(k => { row[k] = p.series[k][i]; });
            return row;
          });
          const overlay = buildVesselOverlay(v => portsMatch(p.name, v.port) && shippersMatch(p.name, v.shipper), vc => lineKeys.some(lk => cargoesMatch(lk, vc)));
          return {
            id: p.name, title: p.name,
            subtitle: `${lineKeys.length} of ${p.cargoes.length} cargoes`,
            data, lineKeys, colorOf: (k) => colorFor(k, allCargoes), overlay,
          };
        })
        .filter(Boolean);
    }
    if (groupBy === 'cargo') {
      return selectedCargoes.map(cargo => {
        const portsWithCargo = payload.ports.filter(p => selectedPorts.includes(p.name) && p.cargoes.includes(cargo));
        if (!portsWithCargo.length) return null;
        const lineKeys = portsWithCargo.map(p => p.name);
        const data = allDates.map((iso, i) => {
          const row = { date: fmtDate(iso), iso };
          portsWithCargo.forEach(p => { row[p.name] = p.series[cargo][i]; });
          return row;
        });
        const overlay = buildVesselOverlay(v => lineKeys.some(lk => portsMatch(lk, v.port) && shippersMatch(lk, v.shipper)), vc => cargoesMatch(cargo, vc));
        return {
          id: cargo, title: cargo,
          subtitle: `${lineKeys.length} of ${selectedPorts.length} ports carry this`,
          data, lineKeys, colorOf: (k) => colorFor(k, allPorts), overlay,
        };
      }).filter(Boolean);
    }
    // groupBy === 'individual' : one chart per (port, cargo) combo
    const out = [];
    payload.ports
      .filter(p => selectedPorts.includes(p.name))
      .forEach(p => {
        const combinedLineKeys = p.cargoes.filter(c => selectedCargoes.includes(c) && shouldCombinePfadCargo(p.name, c));
        if (combinedLineKeys.length) {
          const data = p.dates.map((iso, i) => {
            const row = { date: fmtDate(iso), iso };
            combinedLineKeys.forEach(k => { row[k] = p.series[k][i]; });
            return row;
          });
          const overlay = buildVesselOverlay(
            v => portsMatch(p.name, v.port) && shippersMatch(p.name, v.shipper),
            vc => combinedLineKeys.some(lk => cargoesMatch(lk, vc))
          );
          out.push({
            id: `${p.name}|PFAD-POMEFAD`,
            title: `${p.name} · PFAD / POMEFAD`,
            subtitle: combinedLineKeys.length === 1 ? combinedLineKeys[0] : 'PFAD and POMEFAD',
            data,
            lineKeys: combinedLineKeys,
            colorOf: (k) => colorFor(k, allCargoes),
            overlay,
          });
        }
        p.cargoes
          .filter(c => selectedCargoes.includes(c))
          .filter(c => !shouldCombinePfadCargo(p.name, c))
          .forEach(c => {
            const data = p.dates.map((iso, i) => ({ date: fmtDate(iso), iso, [c]: p.series[c][i] }));
            const overlay = buildVesselOverlay(v => portsMatch(p.name, v.port) && shippersMatch(p.name, v.shipper), vc => cargoesMatch(c, vc));
            out.push({
              id: `${p.name}|${c}`, title: `${p.name} · ${c}`,
              subtitle: null,
              data, lineKeys: [c], colorOf: (k) => colorFor(k, allCargoes), overlay,
            });
          });
      });
    return out;
  }, [groupBy, payload, selectedPorts, selectedCargoes, allCargoes, allPorts, allDates, showVessels, vessels]);

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Stock Summary</h2>
        {payload.updatedAt && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Last updated: {new Date(payload.updatedAt).toLocaleTimeString()}
            {vessels.length > 0 && <span> · {vessels.length} vessel ETAs in window</span>}
          </p>
        )}
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading stock data...</div>}
      {error && (
        <div style={{ padding: 14, borderRadius: 8, background: '#fef2f2', color: '#dc2626', fontSize: 13, marginBottom: 16, border: '1px solid #fecaca' }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          <div style={{ display: 'flex', gap: 14, marginBottom: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Group by</label>
              <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-card)' }}>
                {[
                  { id: 'port', label: 'Port' },
                  { id: 'cargo', label: 'Cargo' },
                  { id: 'individual', label: 'Individual' },
                ].map(opt => (
                  <button key={opt.id} onClick={() => setGroupBy(opt.id)} style={{
                    padding: '7px 16px', fontSize: 13,
                    background: groupBy === opt.id ? '#2563eb' : 'transparent',
                    color: groupBy === opt.id ? '#fff' : 'var(--text-main)',
                    border: 'none', cursor: 'pointer', fontWeight: groupBy === opt.id ? 600 : 400,
                  }}>{opt.label}</button>
                ))}
              </div>
            </div>
            <MultiSelectDropdown
              label="Ports" options={allPorts} selected={selectedPorts} onChange={setSelectedPorts}
              colorMap={groupBy === 'cargo' ? (p) => colorFor(p, allPorts) : null}
            />
            <MultiSelectDropdown
              label="Cargoes" options={allCargoes} selected={selectedCargoes} onChange={setSelectedCargoes}
              colorMap={groupBy === 'port' || groupBy === 'individual' ? (c) => colorFor(c, allCargoes) : null}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-main)', padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', cursor: 'pointer' }}>
              <input type="checkbox" checked={showVessels} onChange={e => setShowVessels(e.target.checked)} style={{ width: 14, height: 14, accentColor: '#dc2626' }} />
              Show vessel ETAs
            </label>
          </div>

          {charts.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
              No data — select at least one port and one cargo.
            </div>
          ) : (
            <Suspense fallback={<div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Loading charts...</div>}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                gap: 16,
              }}>
                {charts.map(c => (
                  <ChartCard key={c.id} title={c.title} subtitle={c.subtitle} data={c.data} lineKeys={c.lineKeys} colorOf={c.colorOf} vesselsByDate={c.overlay} />
                ))}
              </div>
            </Suspense>
          )}
        </>
      )}
    </div>
  );
}
