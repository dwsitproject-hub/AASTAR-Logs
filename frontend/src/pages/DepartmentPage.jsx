import React, { useEffect, useState } from 'react';
import api from '../services/api';

export default function DepartmentPage({ department, label, color }) {
  const [sheets, setSheets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    setLoading(true);
    api.get(`/sheets/data/${department}`)
      .then(res => { setSheets(res.data); setActiveSheet(0); })
      .catch(err => setError(err.response?.data?.error || 'Failed to load data'))
      .finally(() => setLoading(false));
  }, [department]);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--text-muted)' }}>
      Loading data...
    </div>
  );

  if (error) return (
    <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', borderRadius: 8, padding: 20 }}>
      {error}
    </div>
  );

  if (!sheets.length) return (
    <div style={{ background: '#fff', borderRadius: 'var(--radius)', padding: 32, textAlign: 'center', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
      No Google Sheets configured for this department yet. Ask an admin to add sheet configurations.
    </div>
  );

  const current = sheets[activeSheet];
  const headers = current?.data?.[0] || [];
  const rows = current?.data?.slice(1) || [];

  return (
    <div>
      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {sheets.map((s, i) => (
            <button key={s.id} onClick={() => setActiveSheet(i)} style={{
              padding: '7px 16px', borderRadius: 20, fontSize: 13, fontWeight: 500,
              border: `1px solid ${i === activeSheet ? color : 'var(--border)'}`,
              background: i === activeSheet ? color : '#fff',
              color: i === activeSheet ? '#fff' : 'var(--text-main)',
              transition: 'all 0.15s'
            }}>
              {s.sheet_name} / {s.tab_name}
            </button>
          ))}
        </div>
      )}

      {/* Data card */}
      <div style={{ background: '#fff', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{current.sheet_name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 13, marginLeft: 8 }}>/ {current.tab_name}</span>
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {rows.length} rows · Last updated: {current.updatedAt ? new Date(current.updatedAt).toLocaleTimeString() : 'N/A'}
          </span>
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>No data found in this sheet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {headers.map((h, i) => (
                    <th key={i} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri} style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    {headers.map((_, ci) => (
                      <td key={ci} style={{ padding: '10px 16px', color: 'var(--text-main)' }}>
                        {row[ci] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
