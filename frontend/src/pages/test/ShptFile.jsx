import React, { useEffect, useState, useRef } from 'react';
import api from '../../services/api';

// test > Shpt File — browse the materialized 'Shpt File' tab (read-only pull via
// SA1, folded into the existing Aastar Sales batchGet — no extra Google API call).
const PAGE = 200;

const HEADER = {
  ref: 'Ref', trade_group: 'Grp', shpt_yr: 'Yr', ops_pic: 'PIC', seller_grp: 'Seller Grp',
  seller: 'Seller', buyer_grp: 'Buyer Grp', buyer: 'Buyer', contract_no: 'Contract',
  latest_shpt_date: 'Latest Shpt', shpt_laycan: 'Laycan', shpt_mth: 'Shpt Mth',
  vessel_name: 'Vessel', bl_date: 'B/L Date', bl_mth: 'B/L Mth', bl_quantity: 'B/L Qty',
  cargo: 'Cargo', cargo_remarks: 'Cargo Rmk', load_port: 'Load Port', load_country: 'Load Ctry',
  discharge_port: 'Disch Port', discharge_country: 'Disch Ctry', term: 'Term',
  purchase_price_pmt: 'Purch $/MT', purchase_value_usd: 'Purch Value', other_costs: 'Other Cost',
  pmt_date: 'Pmt Date', pmt_terms: 'Pmt Terms', lc_no: 'LC No', lc_issue_date: 'LC Issue',
  unit_price_provn: 'Unit(Provn)', unit_price_final: 'Unit(Final)', invoice_value_usd: 'Invoice Value',
  pmt_received_usd: 'Pmt Recd', invoice_outstanding_usd: 'Outstanding', pmt_rec_date: 'Rec Date',
  pmt_rec_mth: 'Rec Mth', rec_bank: 'Bank', due_date: 'Due Date', nod_overdue: 'Overdue',
  remarks: 'Remarks', source_row: 'Row',
};
const MONEY = new Set(['purchase_value_usd', 'other_costs', 'invoice_value_usd', 'pmt_received_usd', 'invoice_outstanding_usd']);

export default function ShptFile() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const deb = useRef();

  const load = (o = offset) => {
    setLoading(true);
    const params = { limit: PAGE, offset: o };
    if (q.trim()) params.q = q.trim();
    api.get('/shpt-file', { params })
      .then(r => { setData(r.data); if (!r.data.available) setError('Shpt File not generated yet.'); else setError(''); })
      .catch(e => setError(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { clearTimeout(deb.current); deb.current = setTimeout(() => { setOffset(0); load(0); }, q ? 300 : 0); return () => clearTimeout(deb.current); /* eslint-disable-next-line */ }, [q]);
  useEffect(() => { load(offset); /* eslint-disable-next-line */ }, [offset]);

  const columns = data?.columns || [];
  const rows = data?.rows || [];
  const total = data?.total || 0;

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Shpt File</h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
          Read-only mirror of the Shpt File tab (pulled by the same SA as Aastar Sales).
          {data?.builtAt && <span> Updated {new Date(data.builtAt).toLocaleString()}.</span>}
        </p>
      </div>

      {error && <div style={{ padding: 14, borderRadius: 8, background: '#fef2f2', color: '#dc2626', fontSize: 13, marginBottom: 14, border: '1px solid #fecaca' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search contract, seller, buyer, vessel, cargo…" style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: 13, flex: 1, minWidth: 240 }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{total} rows</span>
      </div>

      {loading && !data ? <div style={{ padding: 30, color: 'var(--text-muted)' }}>Loading…</div> : (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflow: 'auto', maxHeight: '68vh' }}>
            <table style={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%' }}>
              <thead><tr>{columns.map(c => <th key={c} style={{ ...th, textAlign: MONEY.has(c) ? 'right' : 'left' }}>{HEADER[c] || c}</th>)}</tr></thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {columns.map(c => <td key={c} style={{ ...td, textAlign: MONEY.has(c) ? 'right' : 'left', fontVariantNumeric: MONEY.has(c) ? 'tabular-nums' : 'normal' }} title={row[c] == null ? '' : String(row[c])}>{row[c] == null ? '' : String(row[c])}</td>)}
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

const th = { padding: '6px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-app)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', position: 'sticky', top: 0 };
const td = { padding: '5px 10px', fontSize: 12, color: 'var(--text-main)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' };
const pageBtn = (d) => ({ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: d ? 'var(--text-muted)' : 'var(--text-main)', fontSize: 12, cursor: d ? 'default' : 'pointer', opacity: d ? 0.5 : 1 });
