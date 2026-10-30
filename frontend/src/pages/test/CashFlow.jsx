import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import {
  ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, Cell,
} from 'recharts';

// test > Cash Flow Analysis — working-capital / bank-financing view derived from
// the Shpt File. Timing: cash OUT at PMT DATE (else B/L DATE), cash IN at PMT REC
// DATE (else DUE DATE else B/L DATE). See the note banner for the framing.

const fmtUSD = (n) => {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  const s = a >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`;
  return s;
};
const COL = { out: '#dc2626', in: '#16a34a', net: '#2563eb', cum: '#7c3aed', purple: '#7c3aed' };

export default function CashFlow() {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [win, setWin] = useState(24); // months window for the monthly chart

  useEffect(() => {
    api.get('/cash-flow')
      .then(r => { if (!r.data.available) setError('Cash flow not available yet.'); else setD(r.data); })
      .catch(e => setError(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: 30, color: 'var(--text-muted)' }}>Loading…</div>;
  if (error) return <div style={{ padding: 14, borderRadius: 8, background: '#fef2f2', color: '#dc2626', fontSize: 13, border: '1px solid #fecaca' }}>{error}</div>;
  if (!d) return null;

  const series = win === 0 ? d.series : d.series.slice(-win);
  const aging = [
    { bucket: 'Current', v: d.exposure.aging.current },
    { bucket: '1–30d', v: d.exposure.aging.d1_30 },
    { bucket: '31–60d', v: d.exposure.aging.d31_60 },
    { bucket: '61–90d', v: d.exposure.aging.d61_90 },
    { bucket: '90d+', v: d.exposure.aging.d90p },
  ];
  const agingColors = ['#16a34a', '#84cc16', '#eab308', '#f97316', '#dc2626'];

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Cash Flow Analysis</h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
          Working-capital &amp; bank-financing view from the Shpt File.
          {d.builtAt && <span> Updated {new Date(d.builtAt).toLocaleString()}.</span>}
        </p>
      </div>

      <div style={{ padding: '9px 12px', borderRadius: 8, background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.25)', color: 'var(--text-main)', fontSize: 12, marginBottom: 16 }}>
        <b>How to read this:</b> In this file, invoiced sales far exceed recorded purchases (many rows log a sale with the purchase leg blank), so a raw net looks perpetually positive. The real financing need is the <b>working-capital gap</b>: <b>open payables</b> you must fund now and the <b>purchase run-rate</b> before receivables collect. Cards below lead with those.
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 18 }}>
        {kpi('Open payables (to fund)', fmtUSD(d.exposure.payablesOpen), 'Unpaid purchases — financing needed', '#dc2626')}
        {kpi('Open receivables', fmtUSD(d.exposure.receivablesOutstanding), 'Invoices still to collect', '#16a34a')}
        {kpi('Net exposure', fmtUSD(d.exposure.netExposure), 'Receivables − payables', d.exposure.netExposure >= 0 ? '#2563eb' : '#dc2626')}
        {kpi('Purchase run-rate / mo', fmtUSD(d.runRate.avgOut), `Avg over last ${d.runRate.monthsUsed} mo`, '#7c3aed')}
        {kpi('Total purchased', fmtUSD(d.totals.purchase), `${(d.totals.qty).toLocaleString()} MT`, '#64748b')}
        {kpi('Total sales invoiced', fmtUSD(d.totals.sale), `${d.totals.rows} rows`, '#64748b')}
      </div>

      {/* Monthly cash flow */}
      <Card title="Monthly cash flow — purchases (out) vs receipts (in)" right={
        <select value={win} onChange={e => setWin(Number(e.target.value))} style={sel}>
          <option value={12}>Last 12 mo</option><option value={24}>Last 24 mo</option><option value={0}>All</option>
        </select>
      }>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={series} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
            <YAxis tickFormatter={fmtUSD} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} width={54} />
            <Tooltip formatter={(v, n) => [fmtUSD(v), n]} contentStyle={ttip} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="out" name="Purchases (out)" fill={COL.out} radius={[2, 2, 0, 0]} />
            <Bar dataKey="in" name="Receipts (in)" fill={COL.in} radius={[2, 2, 0, 0]} />
            <Line dataKey="net" name="Net" stroke={COL.net} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, marginBottom: 14 }}>
        {/* Receivables aging */}
        <Card title={`Receivables aging — ${fmtUSD(d.exposure.receivablesOutstanding)} outstanding`}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={aging} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis tickFormatter={fmtUSD} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} width={54} />
              <Tooltip formatter={(v) => fmtUSD(v)} contentStyle={ttip} />
              <Bar dataKey="v" name="Outstanding" radius={[3, 3, 0, 0]}>
                {aging.map((a, i) => <Cell key={i} fill={agingColors[i]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Forward projection */}
        <Card title={`Forward projection — next 6 months`}>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={d.projection} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <YAxis tickFormatter={fmtUSD} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} width={54} />
              <Tooltip formatter={(v, n) => [fmtUSD(v), n]} contentStyle={ttip} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="out" name="Proj. purchases" fill={COL.out} radius={[2, 2, 0, 0]} />
              <Bar dataKey="in" name="Proj. receipts" fill={COL.in} radius={[2, 2, 0, 0]} />
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
            Baseline = historical run-rate; month 1 also loads current open payables/receivables.
          </div>
        </Card>
      </div>

      {/* Breakdown by cargo */}
      <Card title="Purchase value by cargo (top 12)">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={d.breakdown.byCargo} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="key" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis tickFormatter={fmtUSD} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} width={54} />
            <Tooltip formatter={(v, n) => [fmtUSD(v), n]} contentStyle={ttip} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="purchase" name="Purchases" fill={COL.out} radius={[2, 2, 0, 0]} />
            <Bar dataKey="sale" name="Sales" fill={COL.in} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
        {breakdownTable('Top sellers (by purchase)', d.breakdown.bySeller, 'purchase')}
        {breakdownTable('Top buyers (by sales)', d.breakdown.byBuyer, 'sale')}
      </div>
    </div>
  );
}

function kpi(label, value, sub, color) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, margin: '3px 0 1px' }}>{value}</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{sub}</div>
    </div>
  );
}
function Card({ title, right, children }) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-main)' }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}
function breakdownTable(title, rows, key) {
  const fmt = (n) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  return (
    <Card title={title}>
      <div style={{ overflow: 'auto', maxHeight: 260 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>
            <th style={bth}>Name</th><th style={{ ...bth, textAlign: 'right' }}>Purchases</th><th style={{ ...bth, textAlign: 'right' }}>Sales</th><th style={{ ...bth, textAlign: 'right' }}>Qty (MT)</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={btd}>{r.key}</td>
                <td style={{ ...btd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.purchase)}</td>
                <td style={{ ...btd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.sale)}</td>
                <td style={{ ...btd, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.qty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const ttip = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--text-main)' };
const sel = { padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-main)', fontSize: 12 };
const bth = { textAlign: 'left', padding: '5px 8px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg-card)' };
const btd = { padding: '4px 8px', fontSize: 12, color: 'var(--text-main)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
