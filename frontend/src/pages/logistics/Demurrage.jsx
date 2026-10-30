import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toBlob } from 'html-to-image';
import api from '../../services/api';
import { calculateDemurrage, parseNumber, normalizeTime, formatMoney } from './demurrageCalc';

// Demurrage calculator: pick a vessel + one of its ports on the left (read-only
// reference stats), tweak the pre-filled inputs on the right, and Calculate.
// Calc logic lives in demurrageCalc.js (mirrors backend/services/exportSummary.js).

const LABEL = { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4, display: 'block' };
const CARD = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 12, padding: 18, boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
};
const INPUT = {
  width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-app)', color: 'var(--text-main)', fontSize: 13, boxSizing: 'border-box',
};

function StatRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--text-main)', fontWeight: 500, textAlign: 'right' }}>{value || '—'}</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <label style={LABEL}>{label}</label>
      {children}
    </div>
  );
}

const emptyInputs = {
  laytimeStarts: '', laycan: '', laycanYear: '', totalCargo: '', laytimeRate: '', demmRate: '',
  etaDate: '', etaTime: '', etbDate: '', etbTime: '', etcDate: '', etcTime: '',
};

function laytimeSelectValue(value) {
  const s = (value || '').toString().trim().toLowerCase();
  if (s.includes('laycan') && s.includes('nor')) return 'Laycan NOR+6';
  if (s.includes('laycan') && /all\s*fast/.test(s)) return 'Laycan All Fast';
  if (s.includes('nor')) return 'NOR +6';
  if (/all\s*fast/.test(s)) return 'All Fast';
  return '';
}

export default function Demurrage() {
  const [vessels, setVessels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [vslId, setVslId] = useState('');
  const [portIdx, setPortIdx] = useState(0);
  const [inputs, setInputs] = useState(emptyInputs);
  const [result, setResult] = useState(null);
  const [captureStatus, setCaptureStatus] = useState('idle');
  const captureRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get('/sheets/vessel-update?status=all'); // include CLOSED vessels too
        if (!alive) return;
        const list = (res.data?.vessels || []).filter(v => v.vessel || v.vsl_id);
        setVessels(list);
        if (list.length) setVslId(list[0].vsl_id || list[0].vessel);
      } catch (err) {
        if (alive) setError(err.response?.data?.error || 'Failed to load vessels');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const vessel = useMemo(
    () => vessels.find(v => (v.vsl_id || v.vessel) === vslId) || null,
    [vessels, vslId]
  );
  // Only ports that actually have a name are pickable.
  const ports = useMemo(
    () => (vessel?.ports || []).map((p, i) => ({ ...p, _i: i })).filter(p => p.port_name),
    [vessel]
  );
  const port = ports[portIdx] || ports[0] || null;

  // When the selected vessel changes, reset the port to the first one.
  useEffect(() => { setPortIdx(0); }, [vslId]);

  // Pre-fill the editable inputs from the selected vessel + port; clear stale result.
  useEffect(() => {
    if (!vessel || !port) { setInputs(emptyInputs); setResult(null); return; }
    setInputs({
      laytimeStarts: vessel.laytime_starts || '',
      laycan: port.laycan || '',
      laycanYear: (port.eta_iso || port.etb_iso || port.etc_iso || '').slice(0, 4),
      totalCargo: parseNumber(port.qty) ?? '',
      laytimeRate: parseNumber(vessel.laytime_rate) ?? '',
      demmRate: vessel.demm_rate ?? parseNumber(vessel.demm_rate_display) ?? '',
      etaDate: port.eta_iso || '', etaTime: normalizeTime(port.eta_time),
      etbDate: port.etb_iso || '', etbTime: normalizeTime(port.etb_time),
      etcDate: port.etc_iso || '', etcTime: normalizeTime(port.etc_time),
    });
    setResult(null);
  }, [vessel, port]);

  const setField = (k) => (e) => setInputs(s => ({ ...s, [k]: e.target.value }));
  const onCalculate = () => setResult(calculateDemurrage(inputs));

  // Screen-capture the whole calculator card (same html-to-image pattern as
  // Vessel Status / Export Summary): copy PNG to clipboard, fall back to download.
  const handleCapture = async () => {
    if (!captureRef.current) return;
    setCaptureStatus('capturing');
    try {
      const blob = await toBlob(captureRef.current, { pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true });
      if (!blob) { setCaptureStatus('failed'); setTimeout(() => setCaptureStatus('idle'), 2000); return; }
      try {
        if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          setCaptureStatus('copied');
        } else {
          downloadBlob(blob, vessel);
          setCaptureStatus('downloaded');
        }
      } catch {
        downloadBlob(blob, vessel);
        setCaptureStatus('downloaded');
      }
      setTimeout(() => setCaptureStatus('idle'), 2000);
    } catch (err) {
      console.error('Capture failed:', err);
      setCaptureStatus('failed');
      setTimeout(() => setCaptureStatus('idle'), 2000);
    }
  };
  const captureLabel = { idle: '📷 Capture', capturing: 'Capturing…', copied: '✓ Copied!', downloaded: '✓ Downloaded', failed: '✗ Failed' }[captureStatus];
  const captureBg = captureStatus === 'copied' || captureStatus === 'downloaded' ? '#1565c0' : '#2d6a4f';

  const fmtDays = (d) => (d == null || !isFinite(d) ? '—' : `${d.toFixed(2)} days`);

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Demurrage Calculator</h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
          Pick a vessel and port to load its stats, adjust the inputs, then calculate the demurrage.
        </p>
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading vessels…</div>}
      {error && (
        <div style={{ padding: 14, borderRadius: 8, background: '#fef2f2', color: '#dc2626', fontSize: 13, marginBottom: 16, border: '1px solid #fecaca' }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button onClick={handleCapture} disabled={captureStatus === 'capturing'} style={{
            background: captureBg, color: '#fff', border: 'none',
            padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
            fontSize: 13, fontWeight: 500, transition: 'background 0.15s', height: 32,
          }}>{captureLabel}</button>
        </div>
        <div ref={captureRef} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 18, alignItems: 'start' }}>
          {/* LEFT: player picker + read-only stats */}
          <div style={CARD}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 2, minWidth: 160 }}>
                <label style={LABEL}>Vessel</label>
                <select value={vslId} onChange={e => setVslId(e.target.value)} style={INPUT}>
                  {vessels.map(v => {
                    const id = v.vsl_id || v.vessel;
                    const closed = (v.status || '').toUpperCase() === 'CLOSED';
                    return <option key={id} value={id}>{v.vessel || '(unnamed)'}{v.voyage ? ` · ${v.voyage}` : ''}{closed ? ' · CLOSED' : ''}</option>;
                  })}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 120 }}>
                <label style={LABEL}>Port</label>
                <select value={portIdx} onChange={e => setPortIdx(Number(e.target.value))} style={INPUT} disabled={!ports.length}>
                  {ports.length === 0 && <option>No ports</option>}
                  {ports.map((p, i) => <option key={p._i} value={i}>{p.port_name}</option>)}
                </select>
              </div>
            </div>

            {!vessel ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No vessel selected.</div>
            ) : (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-muted)', textTransform: 'uppercase', margin: '4px 0 6px' }}>Vessel</div>
                <StatRow label="Vessel" value={vessel.vessel} />
                <StatRow label="VSL ID" value={vessel.vsl_id} />
                <StatRow label="Entity" value={vessel.entity} />
                <StatRow label="Voyage" value={vessel.voyage} />
                <StatRow label="Status" value={vessel.status} />
                <StatRow label="Ops" value={vessel.ops} />
                <StatRow label="Demurrage Rate" value={vessel.demm_rate_display} />
                <StatRow label="Laytime Rate" value={vessel.laytime_rate} />
                <StatRow label="Laytime Starts" value={vessel.laytime_starts} />
                <StatRow label="Est Demurrage (sheet)" value={vessel.est_demmurage} />

                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-muted)', textTransform: 'uppercase', margin: '14px 0 6px' }}>Port</div>
                <StatRow label="Port" value={port?.port_name} />
                <StatRow label="Shipper" value={port?.shipper} />
                <StatRow label="Cargo" value={port?.l_cargo} />
                <StatRow label="Quantity" value={port?.qty} />
                <StatRow label="Laycan" value={port?.laycan} />
                <StatRow label="CR" value={port?.cr} />
                <StatRow label="ETA" value={[port?.eta, port?.eta_time].filter(Boolean).join(' ')} />
                <StatRow label="ETB" value={[port?.etb, port?.etb_time].filter(Boolean).join(' ')} />
                <StatRow label="ETC" value={[port?.etc, port?.etc_time].filter(Boolean).join(' ')} />
              </div>
            )}
          </div>

          {/* RIGHT: editable inputs + calculate + output */}
          <div style={CARD}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 12 }}>Inputs</div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Laytime Starts">
                <select value={laytimeSelectValue(inputs.laytimeStarts)}
                  onChange={e => setInputs(s => ({ ...s, laytimeStarts: e.target.value }))} style={INPUT}>
                  <option value="">— select —</option>
                  <option value="NOR +6">NOR +6</option>
                  <option value="All Fast">All Fast</option>
                  <option value="Laycan NOR+6">Laycan NOR+6</option>
                  <option value="Laycan All Fast">Laycan All Fast</option>
                </select>
              </Field>
              <Field label="Cargo Qty (MT)">
                <input type="number" value={inputs.totalCargo} onChange={setField('totalCargo')} style={INPUT} />
              </Field>
              <Field label="Laytime Rate (MT/hr)">
                <input type="number" value={inputs.laytimeRate} onChange={setField('laytimeRate')} style={INPUT} />
              </Field>
              <Field label="Demurrage Rate (USD/day)">
                <input type="number" value={inputs.demmRate} onChange={setField('demmRate')} style={INPUT} />
              </Field>
              <Field label="Laycan (source)">
                <input value={inputs.laycan || '—'} readOnly style={{ ...INPUT, color: 'var(--text-muted)' }} />
              </Field>
            </div>

            {[
              { key: 'eta', label: 'ETA', hint: 'used when NOR (+6h)' },
              { key: 'etb', label: 'ETB', hint: 'used when All Fast' },
              { key: 'etc', label: 'ETC (completion)', hint: 'laytime ends' },
            ].map(row => (
              <div key={row.key} style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 12, marginBottom: 12 }}>
                <Field label={`${row.label} date`}>
                  <input type="date" value={inputs[`${row.key}Date`]} onChange={setField(`${row.key}Date`)} style={INPUT} />
                </Field>
                <Field label="time">
                  <input type="time" value={inputs[`${row.key}Time`]} onChange={setField(`${row.key}Time`)} style={INPUT} />
                </Field>
              </div>
            ))}

            <button onClick={onCalculate} style={{
              width: '100%', marginTop: 4, padding: '10px 16px', borderRadius: 8, border: 'none',
              background: 'var(--primary)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>Calculate Demurrage</button>

            {result && (
              <div style={{ marginTop: 16 }}>
                {!result.ok ? (
                  <div style={{ padding: 12, borderRadius: 8, background: '#fef2f2', color: '#dc2626', fontSize: 13, border: '1px solid #fecaca' }}>
                    {result.error}
                  </div>
                ) : (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '14px 16px', background: result.withinLaytime ? 'rgba(16,185,129,0.10)' : 'rgba(220,38,38,0.08)' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        {result.withinLaytime ? 'Within laytime — no demurrage' : 'Estimated Demurrage'}
                      </div>
                      <div style={{ fontSize: 26, fontWeight: 700, color: result.withinLaytime ? '#059669' : '#dc2626', marginTop: 2 }}>
                        {result.withinLaytime ? formatMoney(0) || 'USD 0' : (formatMoney(result.estDemurrage) || (result.estDemurrage == null ? 'Set a demurrage rate' : 'USD 0'))}
                      </div>
                    </div>
                    <div style={{ padding: '10px 16px' }}>
                      <StatRow label="Laytime start basis" value={
                        result.basis === 'nor' ? 'NOR + 6h (from ETA)' :
                          result.basis === 'allfast' ? 'All Fast (from ETB)' :
                            result.basis === 'laycan_nor' ? 'Laycan NOR+6 (first laycan date + 6h)' :
                              'Laycan All Fast (first laycan date)'
                      } />
                      <StatRow label="Laytime start" value={result.laytimeStart ? result.laytimeStart.toLocaleString('en-GB') : '—'} />
                      <StatRow label="Laytime allowed" value={fmtDays(result.allowedDays)} />
                      <StatRow label="Laytime used" value={fmtDays(result.actualDays)} />
                      <StatRow label={result.withinLaytime ? 'Time saved (despatch)' : 'Demurrage days'} value={fmtDays(Math.abs(result.withinLaytime ? result.rawDiffDays : result.demmDays))} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        </>
      )}
    </div>
  );
}

function downloadBlob(blob, vessel) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const name = (vessel?.vessel || 'demurrage').toString().trim().replace(/\W+/g, '-').toLowerCase();
  a.download = `demurrage-${name || 'result'}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
