import React, { useEffect, useState } from 'react';
import api from '../../services/api';

// test > Vessel Match — browse the materialized SQLite mirror (sheets_mirror.db):
// one tab per table, showing its columns + rows.
const PAGE = 100;

export default function VesselMatch() {
  const [tables, setTables] = useState([]);
  const [active, setActive] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingTable, setLoadingTable] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/mirror/tables');
        const t = r.data?.tables || [];
        setTables(t);
        if (!r.data?.available) setError('Mirror not generated yet — run the mirror script on the server.');
        else if (t.length) setActive(t[0].table_name);
      } catch (e) {
        setError(e.response?.data?.error || 'Failed to load tables');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!active) return;
    setLoadingTable(true);
    (async () => {
      try {
        const r = await api.get(`/mirror/table/${encodeURIComponent(active)}?limit=${PAGE}&offset=${offset}`);
        setData(r.data);
      } catch (e) {
        setData(null);
        setError(e.response?.data?.error || 'Failed to load table');
      } finally {
        setLoadingTable(false);
      }
    })();
  }, [active, offset]);

  const selectTab = (name) => { if (name !== active) { setActive(name); setOffset(0); setData(null); } };
  const metaFor = (name) => tables.find(t => t.table_name === name) || {};
  const tabLabel = (t) => `${t.tab_name || t.table_name}${t.render_format ? ` · ${t.render_format}` : ''}`;

  const th = { textAlign: 'left', padding: '5px 8px', fontSize: 9.5, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-app)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', position: 'sticky', top: 0 };
  const td = { padding: '4px 8px', fontSize: 10, color: 'var(--text-main)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' };

  return (
    <div style={{ fontFamily: 'Cambria, Georgia, "Times New Roman", serif' }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Vessel Match</h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
          Materialized sheet tables from the SQLite mirror.
        </p>
      </div>

      {loading && <div style={{ padding: 30, color: 'var(--text-muted)' }}>Loading tables…</div>}
      {error && (
        <div style={{ padding: 14, borderRadius: 8, background: '#fef2f2', color: '#dc2626', fontSize: 13, marginBottom: 14, border: '1px solid #fecaca' }}>{error}</div>
      )}

      {!loading && tables.length > 0 && (
        <>
          {/* Tabs */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14, borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
            {tables.map(t => {
              const on = t.table_name === active;
              return (
                <button key={t.table_name} onClick={() => selectTab(t.table_name)} style={{
                  padding: '6px 12px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer',
                  border: '1px solid', borderColor: on ? 'var(--primary)' : 'var(--border)',
                  background: on ? 'var(--primary)' : 'var(--bg-card)', color: on ? '#fff' : 'var(--text-main)',
                  fontWeight: on ? 600 : 500, whiteSpace: 'nowrap',
                }} title={`${t.sheet_name || ''} / ${t.tab_name || ''} — ${t.row_count ?? '?'} rows × ${t.col_count ?? '?'} cols`}>
                  {tabLabel(t)}
                  {typeof t.row_count === 'number' && <span style={{ opacity: 0.7, marginLeft: 6, fontSize: 11 }}>{t.row_count}</span>}
                </button>
              );
            })}
          </div>

          {/* Active table */}
          {active && (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, color: 'var(--text-main)' }}>
                  <span style={{ fontWeight: 600 }}>{metaFor(active).sheet_name} / {metaFor(active).tab_name}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                    {data ? `${data.total} rows × ${data.columns.length} cols` : ''}
                  </span>
                </div>
                {data && data.total > PAGE && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                    <button onClick={() => setOffset(Math.max(0, offset - PAGE))} disabled={offset === 0} style={pageBtn(offset === 0)}>‹ Prev</button>
                    <span>{offset + 1}–{Math.min(offset + PAGE, data.total)}</span>
                    <button onClick={() => setOffset(offset + PAGE)} disabled={offset + PAGE >= data.total} style={pageBtn(offset + PAGE >= data.total)}>Next ›</button>
                  </div>
                )}
              </div>

              {loadingTable && <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
              {!loadingTable && data && (
                <div style={{ overflow: 'auto', maxHeight: '65vh' }}>
                  <table style={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%' }}>
                    <thead>
                      <tr>{data.columns.map(c => <th key={c} style={th}>{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row, i) => (
                        <tr key={i}>
                          {data.columns.map(c => <td key={c} style={td} title={row[c] == null ? '' : String(row[c])}>{row[c] == null ? '' : String(row[c])}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.rows.length === 0 && <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>No rows.</div>}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const pageBtn = (disabled) => ({
  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-card)', color: disabled ? 'var(--text-muted)' : 'var(--text-main)',
  fontSize: 12, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
});
