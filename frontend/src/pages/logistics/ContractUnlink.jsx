import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import { trackHubAction } from '../../services/hubSdk';
import useDataRefresh from '../../services/useDataRefresh';
import './ContractUnlink.css';

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>
);
const UnlinkIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /><path d="m8 8 8 8" /></svg>
);

function displayDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-SG', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function AssignmentDetails({ row }) {
  return (
    <>
      <div className="cu-contract-main">
        <strong>{row.contractNo || row.ref || 'No contract number'}</strong>
        {row.ref && row.ref !== row.contractNo && <span>{row.ref}</span>}
      </div>
      <div className="cu-muted">{row.counterparty || '-'}</div>
    </>
  );
}

function ConfirmDialog({ row, busy, onCancel, onConfirm }) {
  const confirmRef = useRef(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const close = event => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [busy, onCancel]);
  return (
    <div className="cu-modal-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <div className="cu-modal" role="dialog" aria-modal="true" aria-labelledby="unlink-title">
        <div className="cu-modal-icon"><UnlinkIcon /></div>
        <h2 id="unlink-title">Unlink contract?</h2>
        <p><strong>{row.contractNo || row.ref}</strong> will be removed from <strong>{row.vessel}</strong> at {row.loadport || 'its assigned loadport'}.</p>
        <dl>
          <div><dt>Contract</dt><dd>{row.sourceTab}</dd></div>
          <div><dt>VSL ID</dt><dd>{row.vslId}</dd></div>
        </dl>
        <div className="cu-modal-actions">
          <button type="button" className="cu-button cu-button-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button ref={confirmRef} type="button" className="cu-button cu-button-danger" onClick={onConfirm} disabled={busy}>
            <UnlinkIcon /> {busy ? 'Unlinking...' : 'Unlink contract'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ContractUnlink({ initialData = null }) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [data, setData] = useState(initialData || { rows: [], pagination: { total: 0 } });
  const [loading, setLoading] = useState(!initialData);
  const [loadingMore, setLoadingMore] = useState(false);
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = async ({ append = false, silent = false } = {}) => {
    const offset = append ? data.rows.length : 0;
    if (append) setLoadingMore(true);
    else if (!silent) setLoading(true);
    try {
      const response = await api.get('/sheets/contract-unlink', { params: { q: debouncedQuery, offset, limit: 100 } });
      setData(current => ({
        ...response.data,
        rows: append ? [...current.rows, ...(response.data.rows || [])] : (response.data.rows || []),
      }));
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || 'Could not load contract links.' });
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!initialData) load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [debouncedQuery, initialData]);
  useDataRefresh({
    databases: ['DB1', 'DB2', 'DB3', 'DB4', 'DB5', 'DB6', 'DB10'],
    resources: ['contract-unlink', 'vessel-matching', 'vessel-update'],
    onRefresh: () => load({ silent: true }),
  });

  const sourceSummary = useMemo(() => Object.entries(data.sourceCounts || {})
    .sort(([a], [b]) => a.localeCompare(b)), [data.sourceCounts]);

  const unlink = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await api.post('/sheets/contract-unlink', { matchId: target.matchId, expectedVslId: target.vslId });
      trackHubAction('contract_unlinked');
      setData(current => ({
        ...current,
        rows: current.rows.filter(row => row.key !== target.key),
        pagination: { ...current.pagination, total: Math.max(0, Number(current.pagination?.total || 1) - 1) },
      }));
      setMessage({ type: 'success', text: `${target.contractNo || target.ref} is now pending matching.` });
      setTarget(null);
      setTimeout(() => load({ silent: true }), 1200);
    } catch (error) {
      setMessage({ type: 'error', text: error.response?.data?.error || 'Contract could not be unlinked.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="contract-unlink-page">
      <header className="cu-header">
        <div>
          <p className="cu-eyebrow">DB10 vessel links</p>
          <h1>Contract Unlink</h1>
        </div>
        <div className="cu-total"><strong>{data.pagination?.total || 0}</strong><span>Active links</span></div>
      </header>

      <div className="cu-toolbar">
        <label className="cu-search">
          <SearchIcon />
          <span className="sr-only">Search active contract links</span>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search contract, vessel, VSL ID, cargo or counterparty" />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search">x</button>}
        </label>
        <div className="cu-source-summary" aria-label="Active links by source">
          {sourceSummary.map(([source, count]) => <span key={source}>{source.replace('AASTAR', 'A*').replace('KIMARA', 'KM')} <strong>{count}</strong></span>)}
        </div>
      </div>

      {message && <div className={`cu-message ${message.type}`} role="status">{message.text}<button type="button" onClick={() => setMessage(null)} aria-label="Dismiss">x</button></div>}

      <div className="cu-table-shell" aria-busy={loading}>
        <table className="cu-table">
          <thead><tr><th>Contract</th><th>Source</th><th>Cargo / Qty</th><th>Vessel</th><th>Loadport</th><th>Linked</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {!loading && data.rows.map(row => (
              <tr key={row.key}>
                <td data-label="Contract"><AssignmentDetails row={row} /></td>
                <td data-label="Source"><span className={`cu-side ${row.sourceTab.endsWith('PURCHASE') ? 'purchase' : 'sales'}`}>{row.sourceTab}</span></td>
                <td data-label="Cargo / Qty"><strong>{row.qty || '-'}</strong> {row.cargo || ''}{row.isPartial && <span className="cu-partial">Partial</span>}</td>
                <td data-label="Vessel"><strong>{row.vessel}</strong><span className="cu-code">{row.vslId}</span></td>
                <td data-label="Loadport"><strong>{row.loadport || '-'}</strong>{row.shipper && <span className="cu-muted">Shipper: {row.shipper}</span>}</td>
                <td data-label="Linked"><span>{displayDate(row.linkedAt)}</span><span className="cu-muted">{row.linkedBy || '-'}</span></td>
                <td className="cu-action"><button type="button" onClick={() => setTarget(row)} title="Unlink contract"><UnlinkIcon /><span>Unlink</span></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="cu-state">Loading active links...</div>}
        {!loading && !data.rows.length && <div className="cu-state">No active links match this search.</div>}
      </div>

      {data.pagination?.hasMore && <button type="button" className="cu-load-more" onClick={() => load({ append: true })} disabled={loadingMore}>{loadingMore ? 'Loading...' : 'Load more'}</button>}
      {target && <ConfirmDialog row={target} busy={busy} onCancel={() => setTarget(null)} onConfirm={unlink} />}
    </section>
  );
}
