import React, { useEffect, useState } from 'react';
import api from '../../services/api';

const PAGE = 100;

export default function Data() {
  const [databases, setDatabases] = useState([]);
  const [database, setDatabase] = useState('');
  const [tables, setTables] = useState([]);
  const [table, setTable] = useState('');
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshTick(tick => tick + 1), 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    api.get('/data/databases')
      .then(response => {
        const items = response.data?.databases || [];
        setDatabases(items);
        const first = items.find(item => item.available) || items[0];
        if (first) setDatabase(first.name);
      })
      .catch(err => setError(err.response?.data?.error || 'Failed to load databases'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!database) return;
    setData(null);
    setTable('');
    setOffset(0);
    api.get(`/data/${database}/tables`)
      .then(response => {
        const items = response.data?.tables || [];
        setTables(items);
        if (items.length) setTable(items[0].table_name);
      })
      .catch(err => setError(err.response?.data?.error || 'Failed to load database tables'));
  }, [database]);

  useEffect(() => {
    if (!database || !table) return;
    api.get(`/data/${database}/table/${encodeURIComponent(table)}`, { params: { limit: PAGE, offset } })
      .then(response => { setData(response.data); setError(''); })
      .catch(err => setError(err.response?.data?.error || 'Failed to load table'));
  }, [database, table, offset, refreshTick]);

  const selected = databases.find(item => item.name === database);
  const controls = { padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: 13 };
  const th = { textAlign: 'left', padding: '6px 10px', fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-app)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', position: 'sticky', top: 0 };
  const td = { padding: '5px 10px', fontSize: 11, color: 'var(--text-main)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--text-main)' }}>Data</h2>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>Bulk-pulled source databases and tables.</p>
      </div>

      {error && <div style={{ padding: 12, marginBottom: 14, borderRadius: 7, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', fontSize: 13 }}>{error}</div>}
      {loading ? <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading databases...</div> : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Database</label>
            <select value={database} onChange={event => setDatabase(event.target.value)} style={controls}>
              {databases.map(item => <option key={item.name} value={item.name}>{item.name}{item.available ? '' : ' (not synced)'}</option>)}
            </select>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Table</label>
            <select value={table} onChange={event => { setTable(event.target.value); setOffset(0); }} style={{ ...controls, minWidth: 220 }} disabled={!tables.length}>
              {tables.map(item => <option key={item.table_name} value={item.table_name}>{item.table_name} ({item.total})</option>)}
            </select>
            {selected && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{selected.sources.length} source range(s) | {(selected.bytes / 1024).toFixed(1)} KB</span>}
          </div>

          {!table ? <div style={{ padding: 24, color: 'var(--text-muted)' }}>No table is available yet.</div> : (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
                <span>{data ? `${data.total} rows | ${data.columns.length} columns` : 'Loading table...'}</span>
                {data && data.total > PAGE && <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0}>Prev</button>
                  <span>{offset + 1}-{Math.min(offset + PAGE, data.total)}</span>
                  <button onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= data.total}>Next</button>
                </span>}
              </div>
              {data && <div style={{ overflow: 'auto', maxHeight: '68vh' }}>
                <table style={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%' }}>
                  <thead><tr>{data.columns.map(column => <th key={column} style={th}>{column}</th>)}</tr></thead>
                  <tbody>{data.rows.map((row, index) => <tr key={index}>{data.columns.map(column => <td key={column} style={td} title={row[column] == null ? '' : String(row[column])}>{row[column] == null ? '' : String(row[column])}</td>)}</tr>)}</tbody>
                </table>
              </div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
