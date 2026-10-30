import React from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ReferenceDot } from 'recharts';
import { fmtNum, cargoesMatch, portsMatch, shippersMatch } from './stockUtils';

// This module owns the recharts dependency so it can be code-split out of the
// StockSummary route chunk (recharts is ~380 kB). StockSummary lazy-loads the
// default export, so recharts loads only once chart data is ready to render.

function CustomTooltip({ active, payload, label, vesselsByDate }) {
  if (!active || !payload || !payload.length) return null;
  const vessels = vesselsByDate?.[label] || [];
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
      fontSize: 11, color: 'var(--text-main)', boxShadow: 'var(--shadow-lg)', padding: '8px 12px',
      minWidth: 160,
    }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 5, fontWeight: 600 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: p.color, flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{p.name}:</span>
          <span style={{ fontWeight: 600 }}>{fmtNum(p.value)}</span>
        </div>
      ))}
      {vessels.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
          {vessels.map((v, i) => (
            <div key={i} style={{ marginBottom: i < vessels.length - 1 ? 4 : 0 }}>
              <div style={{ color: v.isClosed ? '#475569' : '#dc2626', fontWeight: 600 }}>{v.vessel}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>Export ({v.shipper ? `${v.shipper} ` : ''}{v.cargo}): {fmtNum(v.quantity)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VesselLabel({ viewBox, vessels }) {
  if (!viewBox || !vessels || !vessels.length) return null;
  const { x, y } = viewBox;
  return (
    <g>
      {vessels.map((v, i) => {
        const lineY = y - 4 - (vessels.length - 1 - i) * 11;
        const qty = v.quantity ? ` (${Number(v.quantity).toLocaleString('en-US', { maximumFractionDigits: 0 })})` : '';
        const color = v.isClosed ? '#475569' : '#dc2626';
        return (
          <text key={i} x={x} y={lineY} fill={color} fontSize={9}
            textAnchor="middle"
            style={{
              paintOrder: 'stroke',
              stroke: 'var(--bg-card)',
              strokeWidth: 3,
              strokeLinejoin: 'round',
            }}>
            {v.vessel}{qty}
          </text>
        );
      })}
    </g>
  );
}

export default function ChartCard({ title, subtitle, data, lineKeys, colorOf, vesselsByDate }) {
  if (!data.length || !lineKeys.length) return null;
  const allVals = [];
  lineKeys.forEach(k => data.forEach(d => { const v = d[k]; if (typeof v === 'number') allVals.push(v); }));
  const maxY = allVals.length ? Math.max(...allVals) : 0;
  const yMax = Math.ceil((maxY * 1.1) / 100) * 100 || 'auto';
  const tickInterval = Math.max(1, Math.floor(data.length / 6));
  const ticks = data.filter((_, i) => i % tickInterval === 0).map(d => d.date);
  const safeId = title.replace(/\W+/g, '_');

  // Extra top margin if we have stacked vessel labels
  const maxStack = vesselsByDate ? Math.max(...Object.values(vesselsByDate).map(arr => arr.length)) : 0;
  const topMargin = 8 + maxStack * 11;

  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '14px 14px 8px',
      boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
    }}>
      <div style={{ marginBottom: 10 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-main)', margin: 0, lineHeight: 1.3 }}>{title}</h3>
        {subtitle && <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>{subtitle}</p>}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data} margin={{ top: topMargin, right: 8, left: 0, bottom: 0 }}>
          <defs>
            {lineKeys.map(k => {
              const col = colorOf(k);
              return (
                <linearGradient key={k} id={`grad-${safeId}-${k.replace(/\W+/g, '_')}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={col} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={col} stopOpacity={0} />
                </linearGradient>
              );
            })}
          </defs>
          <CartesianGrid stroke="rgba(0,0,0,0.05)" vertical={false} />
          <XAxis dataKey="date" ticks={ticks} tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} dy={4} />
          <YAxis domain={[0, yMax]} tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={44} tickFormatter={fmtNum} />
          <ReferenceLine y={0} stroke="#334155" strokeWidth={1.4} />
          <Tooltip
            content={<CustomTooltip vesselsByDate={vesselsByDate} />}
            cursor={{ stroke: 'rgba(0,0,0,0.08)' }}
          />
          {lineKeys.length <= 6 && <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} iconType="circle" iconSize={6} />}
          {lineKeys.map(k => {
            const col = colorOf(k);
            const gradId = `grad-${safeId}-${k.replace(/\W+/g, '_')}`;
            return (
              <Area key={k} type="monotone" dataKey={k} stroke={col} strokeWidth={1.6}
                fill={`url(#${gradId})`} dot={false}
                activeDot={{ r: 3, fill: col, strokeWidth: 1.5, stroke: 'var(--bg-card)' }} />
            );
          })}
          {vesselsByDate && Object.entries(vesselsByDate).map(([dateLabel, vesselList]) => {
            const anyOpen = vesselList.some(v => !v.isClosed);
            return (
              <ReferenceLine key={dateLabel} x={dateLabel} stroke={anyOpen ? '#dc2626' : '#475569'} strokeDasharray="3 3" strokeWidth={1}
                label={<VesselLabel vessels={vesselList} />} />
            );
          })}
          {vesselsByDate && Object.entries(vesselsByDate).flatMap(([dateLabel, vesselList]) => {
            const dataPoint = data.find(d => d.date === dateLabel);
            if (!dataPoint) return [];
            return vesselList.flatMap(v => {
              const matchingLines = lineKeys.filter(lk => {
                // In By Port view lineKeys are cargoes; In By Cargo view they're ports
                return cargoesMatch(lk, v.cargo) || (portsMatch(lk, v.port) && shippersMatch(lk, v.shipper));
              });
              return matchingLines
                .map(lk => {
                  const yVal = dataPoint[lk];
                  if (yVal == null) return null;
                  const color = v.isClosed ? '#475569' : '#dc2626';
                  return <ReferenceDot key={`${dateLabel}|${lk}|${v.vessel}`} x={dateLabel} y={yVal} r={4} fill={color} stroke="var(--bg-card)" strokeWidth={1.5} ifOverflow="extendDomain" />;
                })
                .filter(Boolean);
            });
          })}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
