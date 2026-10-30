import React, { useEffect, useState, useRef } from 'react';
import api from '../../services/api';

// test > Master Matching — browse the consolidated master_matching.db: one row
// per contract assignment, matched to its vessel/port/ETA/ETB/ETC by vsl_id,
// with partial shipments' contract fields backfilled and a parsed final qty.
const PAGE = 200;

const HEADER = {
  tab: 'Tab', ref: 'Ref', is_partial: 'Partial', contract_no: 'Contract',
  parent_contract_no: 'Parent Ctr', shpt_year: 'Year', cargo: 'Cargo',
  counterparty: 'Buyer/Seller', final_quantity: 'Final Qty', qty_original: 'Qty (orig)',
  intention_vessel: 'Intention Vessel', vsl_id: 'VSL_ID', matched: 'Matched',
  vessel: 'Vessel', entity: 'Entity', port: 'Port', laycan: 'Laycan',
  eta: 'ETA', etb: 'ETB', etc: 'ETC', contract_start: 'Ctr Start',
  contract_end: 'Ctr End', discharge_port: 'Discharge', remarks_outstanding: 'Remarks', source_row: 'Row',
};

export default function MasterMatching() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('');
  const [partialOnly, setPartialOnly] = useState(false);
  const [matched, setMatched] = useState('');   // '', '1', '0'
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const searchDebounce = useRef();

  const load = (o = offset) => {
    setLoading(true);
    const params = { limit: PAGE, offset: o };
    if (tab) params.tab = tab;
    if (partialOnly) params.partial = '1';
    if (matched) params.matched = matched;
    if (q.trim()) params.q = q.trim();
    api.get('/master-matching', { params })
      .then(r => { setData(r.data); if (!r.data.available) setError('Master table not generated yet.'); else setError(''); })
      .catch(e => setError(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  };

  // Reset to first page whenever a filter changes (debounce the search box).
  useEffect(() => {
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => { setOffset(0); load(0); }, q ? 300 : 0);
    return () => clearTimeout(searchDebounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, partialOnly, matched, q]);

  useEffect(() => { load(offset); /* eslint-disable-next-line */ }, [offset]);

  const columns = data?.columns || [];
  const rows = data?.rows || [];
  const total = data?.total || 0;

  const cell = (col, v) => {
    if (col === 'is_partial') return v === 1 || v === '1'
      ? <span style={{ ...badge, background: '#fce7f3', color: '#9d174d' }}>PARTIAL</span> : '';
    if (col === 'matched') return v === 1 || v === '1'
      ? <span style={{ ...badge, background: '#dcfce7', color: '#166534' }}>✓</span>
      : <span style={{ ...badge, background: '#f1f5f9', color: '#64748b' }}>—</span>;
    if (col === 'final_quantity' && v) return <span style={{ fontWeight: 700, color: '#0f766e' }}>{v}</span>;
    return v == null ? '' : String(v);
  };

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Master Matching</h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
          Consolidated contracts matched to vessel / port / ETA-ETB-ETC by VSL_ID.
          {data?.builtAt && <span> Updated {new Date(data.builtAt).toLocaleString()}.</span>}
        </p>
      </div>

      {error && <div style={{ padding: 14, borderRadius: 8, background: '#fef2f2', color: '#dc2626', fontSize: 13, marginBottom: 14, border: '1px solid #fecaca' }}>{error}</div>}

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <select value={tab} onChange={e => setTab(e.target.value)} style={ctrl}>
          <option value="">All tabs</option>
          {(data?.tabs || []).map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={matched} onChange={e => setMatched(e.target.value)} style={ctrl}>
          <option value="">Matched: all</option>
          <option value="1">Matched only</option>
          <option value="0">Unmatched only</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-main)', cursor: 'pointer' }}>
          <input type="checkbox" checked={partialOnly} onChange={e => setPartialOnly(e.target.checked)} /> Partials only
        </label>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search ref, contract, vessel, buyer…" style={{ ...ctrl, flex: 1, minWidth: 220 }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{total} rows</span>
      </div>

      {loading && !data ? (
        <div style={{ padding: 30, color: 'var(--text-muted)' }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflow: 'auto', maxHeight: '68vh' }}>
            <table style={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%' }}>
              <thead>
                <tr>{columns.map(c => <th key={c} style={th}>{HEADER[c] || c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} style={{ background: (row.is_partial === 1) ? 'rgba(244,114,182,0.06)' : 'transparent' }}>
                    {columns.map(c => <td key={c} style={td} title={row[c] == null ? '' : String(row[c])}>{cell(c, row[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>No rows.</div>}
          </div>
          {total > PAGE && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
              <button onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0} style={pageBtn(offset === 0)}>‹ Prev</button>
              <span>{offset + 1}–{Math.min(offset + PAGE, total)}</span>
              <button onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= total} style={pageBtn(offset + PAGE >= total)}>Next ›</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ctrl = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: 13 };
const th = { textAlign: 'left', padding: '6px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-app)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', position: 'sticky', top: 0 };
const td = { padding: '5px 10px', fontSize: 12, color: 'var(--text-main)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' };
const badge = { display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10 };
const pageBtn = (disabled) => ({ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: disabled ? 'var(--text-muted)' : 'var(--text-main)', fontSize: 12, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 });
