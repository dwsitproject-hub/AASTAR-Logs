import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { toBlob } from 'html-to-image';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import VesselStatusDetailModal from './VesselStatusDetailModal';
import './VesselStatus.css';

const DEFAULT_SHIPPERS = ['EUP', 'SPC', 'PMC', 'TPG', 'GLM'];
const DEFAULT_ENTITIES = ['A*', 'A*JV', 'GR'];
const CALIBRI = 'Calibri, Arial, sans-serif';

function MultiSelectDropdown({ label, options, selected, onChange, minWidth = 200 }) {
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
        background: 'var(--bg-card)', color: 'var(--text-main)', fontFamily: CALIBRI, fontSize: 13, cursor: 'pointer',
      }}>
        <span>{summary}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: 'var(--shadow-lg)', maxHeight: 320, overflowY: 'auto', padding: 6,
        }}>
          <div style={{ display: 'flex', gap: 6, padding: '4px 6px 6px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
            <button onClick={() => onChange([...options])} style={miniBtn}>Select all</button>
            <button onClick={() => onChange([])} style={miniBtn}>Clear</button>
          </div>
          {options.map(opt => {
            const checked = selected.includes(opt);
            return (
              <label key={opt} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6,
                fontSize: 13, color: 'var(--text-main)', cursor: 'pointer',
                background: checked ? 'rgba(37,99,235,0.08)' : 'transparent',
              }}>
                <input type="checkbox" checked={checked} onChange={() => toggle(opt)} style={{ width: 14, height: 14, accentColor: '#2563eb' }} />
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
  background: 'transparent', color: 'var(--text-muted)', fontFamily: CALIBRI, cursor: 'pointer',
};

function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Subtle background tints to differentiate vessels by month
const MONTH_TINTS = [
  '#eff6ff', // blue-50
  '#f0fdf4', // green-50
  '#fef3c7', // amber-50
  '#fce7f3', // pink-50
  '#f3e8ff', // violet-50
  '#ecfeff', // cyan-50
  '#fef2f2', // red-50
  '#f0fdfa', // teal-50
];
function monthTint(monthLabel, monthList) {
  const idx = monthList.indexOf(monthLabel);
  if (idx < 0) return 'transparent';
  return MONTH_TINTS[idx % MONTH_TINTS.length];
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="vessel-status-action-icon">
      <path d="M8.5 5.5 10 3.5h4l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2h3.5Z" />
      <circle cx="12" cy="12.5" r="3.5" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="vessel-status-action-icon">
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="vessel-status-close-icon">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}
export default function VesselStatus() {
  const [payload, setPayload] = useState({ vessels: [], details: [], shippers: [], entities: [], ports: [], cargoes: [], updatedAt: null });
  const payloadRef = useRef(payload);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedShippers, setSelectedShippers] = useState([]);
  const [selectedEntities, setSelectedEntities] = useState([]);
  const [selectedPorts, setSelectedPorts] = useState([]);
  const [selectedCargoes, setSelectedCargoes] = useState([]);
  const [shippersInitialized, setShippersInitialized] = useState(false);
  const [entitiesInitialized, setEntitiesInitialized] = useState(false);
  const [captureStatus, setCaptureStatus] = useState('idle');
  const [presenting, setPresenting] = useState(false);
  const [selectedDetailId, setSelectedDetailId] = useState(null);
  const [contractRows, setContractRows] = useState([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [contractsError, setContractsError] = useState('');
  const contractsRequestedRef = useRef(false);
  const captureRef = useRef(null);

  useEffect(() => { payloadRef.current = payload; }, [payload]);

  const fetchOnce = async ({ silent = false, force = false } = {}) => {
    try {
      const res = await api.get('/sheets/vessel-status');
      const next = res.data;
      if (silent && !force && payloadRef.current.updatedAt === next.updatedAt) return;
      payloadRef.current = next;
      setPayload(next);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load vessel status');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { fetchOnce(); }, []);
  useDataRefresh({
    databases: ['DB6'],
    resources: ['vessel-update'],
    onRefresh: ({ reason }) => fetchOnce({ silent: true, force: reason !== 'fallback' }),
  });

  // Default shipper selection: EUP, SPC, PMC, TPG, GLM (when present in data)
  useEffect(() => {
    if (!shippersInitialized && payload.shippers.length) {
      const defaults = DEFAULT_SHIPPERS.filter(s => payload.shippers.includes(s));
      setSelectedShippers(defaults.length ? defaults : payload.shippers);
      setShippersInitialized(true);
    }
  }, [payload.shippers, shippersInitialized]);

  // Default entity selection: A*, A*JV, GR (when present in data)
  useEffect(() => {
    if (!entitiesInitialized && payload.entities.length) {
      const defaults = DEFAULT_ENTITIES.filter(e => payload.entities.includes(e));
      setSelectedEntities(defaults.length ? defaults : payload.entities);
      setEntitiesInitialized(true);
    }
  }, [payload.entities, entitiesInitialized]);
  useEffect(() => {
    if (payload.ports.length && selectedPorts.length === 0) setSelectedPorts(payload.ports);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload.ports.join('|')]);
  useEffect(() => {
    if (payload.cargoes.length && selectedCargoes.length === 0) setSelectedCargoes(payload.cargoes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload.cargoes.join('|')]);

  const filtered = useMemo(() => {
    return payload.vessels.filter(v =>
      (selectedShippers.length === 0 || selectedShippers.includes(v.shipper)) &&
      (selectedEntities.length === 0 || selectedEntities.includes(v.entity)) &&
      (selectedPorts.length    === 0 || selectedPorts.includes(v.port)) &&
      (selectedCargoes.length  === 0 || selectedCargoes.includes(v.cargo))
    );
  }, [payload.vessels, selectedShippers, selectedEntities, selectedPorts, selectedCargoes]);

  // Stable month ordering for color assignment — derived from sorted source order
  const orderedMonths = useMemo(() => {
    const seen = new Set();
    const out = [];
    payload.vessels.forEach(v => {
      if (v.month && !seen.has(v.month)) { seen.add(v.month); out.push(v.month); }
    });
    return out;
  }, [payload.vessels]);

  const selectedDetail = useMemo(
    () => (payload.details || []).find(detail => detail.id === selectedDetailId) || null,
    [payload.details, selectedDetailId],
  );

  const loadContractRows = useCallback(async () => {
    if (contractsRequestedRef.current) return;
    contractsRequestedRef.current = true;
    setContractsLoading(true);
    setContractsError('');
    try {
      const response = await api.get('/sheets/vessel-contract');
      setContractRows(response.data?.rows || []);
    } catch (err) {
      contractsRequestedRef.current = false;
      setContractsError(err.response?.data?.error || 'Linked contract details could not be loaded.');
    } finally {
      setContractsLoading(false);
    }
  }, []);

  const openVesselDetail = useCallback((detailId) => {
    setSelectedDetailId(detailId);
    loadContractRows();
  }, [loadContractRows]);

  const closeVesselDetail = useCallback(() => setSelectedDetailId(null), []);

  const closeFullscreen = useCallback(() => {
    setPresenting(false);
    if (document.fullscreenElement) {
      const exitRequest = document.exitFullscreen?.();
      exitRequest?.catch?.(() => {});
    }
  }, []);

  const openFullscreen = useCallback(() => {
    setPresenting(true);
    const request = document.documentElement.requestFullscreen?.();
    request?.catch?.(() => {});
  }, []);


  useEffect(() => {
    if (!presenting) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = event => {
      if (event.key === 'Escape' && !selectedDetailId) closeFullscreen();
    };
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [presenting, selectedDetailId, closeFullscreen]);
  const handleCapture = async () => {
    if (!captureRef.current) return;
    setCaptureStatus('capturing');
    try {
      const blob = await toBlob(captureRef.current, {
        pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true,
      });
      if (!blob) { setCaptureStatus('failed'); setTimeout(() => setCaptureStatus('idle'), 2000); return; }
      try {
        if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          setCaptureStatus('copied');
        } else {
          downloadBlob(blob);
          setCaptureStatus('downloaded');
        }
      } catch {
        downloadBlob(blob);
        setCaptureStatus('downloaded');
      }
      setTimeout(() => setCaptureStatus('idle'), 2000);
    } catch (err) {
      console.error('Capture failed:', err);
      setCaptureStatus('failed');
      setTimeout(() => setCaptureStatus('idle'), 2000);
    }
  };
  const captureLabel = { idle: 'Copy Table', capturing: 'Capturing...', copied: 'Copied!', downloaded: 'Downloaded', failed: 'Failed' }[captureStatus];
  const captureBg = captureStatus === 'copied' || captureStatus === 'downloaded' ? '#1565c0' : '#2d6a4f';

  return (
    <div style={{ fontFamily: CALIBRI }}>
      <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Vessel Status</h2>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>Incoming Export Vessels — Daily Operations</p>
        </div>
        {payload.updatedAt && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Last updated: <span style={{ color: 'var(--text-main)', fontWeight: 500 }}>{new Date(payload.updatedAt).toLocaleTimeString()}</span>
          </span>
        )}
      </div>

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading vessel data...</div>}
      {error && (
        <div style={{ padding: 14, borderRadius: 8, background: '#fef2f2', color: '#dc2626', fontSize: 13, marginBottom: 16, border: '1px solid #fecaca' }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <MultiSelectDropdown label="Shipper" options={payload.shippers} selected={selectedShippers} onChange={setSelectedShippers} minWidth={180} />
            <MultiSelectDropdown label="Entity"  options={payload.entities} selected={selectedEntities} onChange={setSelectedEntities} minWidth={180} />
            <MultiSelectDropdown label="Port"    options={payload.ports}    selected={selectedPorts}    onChange={setSelectedPorts}    minWidth={220} />
            <MultiSelectDropdown label="Cargo"   options={payload.cargoes}  selected={selectedCargoes}  onChange={setSelectedCargoes}  minWidth={180} />
            <div className="vessel-status-actions">
              <button
                type="button"
                onClick={handleCapture}
                disabled={captureStatus === 'capturing'}
                className="vessel-status-action-button"
                style={{ background: captureBg }}
              >
                <CameraIcon />
                {captureLabel}
              </button>
              <button type="button" onClick={openFullscreen} className="vessel-status-action-button vessel-status-fullscreen-button">
                <FullscreenIcon />
                Fullscreen
              </button>
            </div>
          </div>

          <div
            className={`vessel-status-table-shell${presenting ? ' is-presenting' : ''}`}
            role={presenting ? 'dialog' : undefined}
            aria-modal={presenting ? 'true' : undefined}
            aria-label={presenting ? 'Vessel Status fullscreen table' : undefined}
          >
            {presenting && (
              <div className="vessel-status-presentation-toolbar">
                <span className="vessel-status-presentation-title">Vessel Status</span>
                <button type="button" className="vessel-status-presentation-close" onClick={closeFullscreen} title="Exit fullscreen" aria-label="Exit fullscreen">
                  <CloseIcon />
                </button>
              </div>
            )}
            <div className="vessel-status-table-stage">
              <div className="vessel-status-table-fit">
                <div
                  ref={captureRef}
                  className="vessel-status-table-content"
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    boxShadow: 'var(--shadow)',
                    overflow: presenting ? 'visible' : 'hidden',
                    maxWidth: presenting ? 'none' : '100%',
                  }}
                >
                  <div className="vessel-status-table-scroll">
                <table style={{ width: 'auto', borderCollapse: 'collapse', fontFamily: CALIBRI, fontSize: 12, tableLayout: 'auto' }}>
                <thead>
                  <tr style={{ background: '#f9fafb', borderBottom: '1px solid var(--border)' }}>
                    {[
                      { label: 'Month', align: 'left' },
                      { label: 'Entity', align: 'left' },
                      { label: 'Shipper', align: 'left' },
                      { label: 'Vessel', align: 'left' },
                      { label: 'Port', align: 'left' },
                      { label: 'Cargo', align: 'center' },
                      { label: 'Demmurage Rate PDPR', align: 'left' },
                      { label: 'Laytime Rate', align: 'left' },
                      { label: 'Laytime Starts', align: 'left' },
                      { label: 'Laycan', align: 'left' },
                      { label: 'Cargo Readiness', align: 'center' },
                      { label: 'ETA', align: 'center' },
                      { label: 'ETB', align: 'center' },
                      { label: 'ETC', align: 'center' },
                      { label: 'Remarks', align: 'left' },
                    ].map(h => (
                      <th key={h.label} style={{ padding: '7px 8px', textAlign: h.align, fontWeight: 600, color: 'var(--text-muted)', fontSize: 11, letterSpacing: 0, whiteSpace: 'nowrap' }}>{h.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((v, i) => {
                    const tint = monthTint(v.month, orderedMonths);
                    return (
                      <tr
                        key={`${v.rowId}-${v.port}-${v.cargo}-${i}`}
                        className="vessel-status-row"
                        tabIndex={0}
                        aria-label={`Open shipment details for ${v.vessel || 'TBN'} at ${v.port}`}
                        onClick={() => openVesselDetail(v.detailId)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            openVesselDetail(v.detailId);
                          }
                        }}
                        style={{
                          borderBottom: '1px solid var(--border)',
                          background: tint,
                        }}
                      >
                        <td style={{ ...tdCell, fontWeight: 500 }}>{v.month}</td>
                        <td style={{ ...tdCell, fontWeight: 500 }}>{v.entity}</td>
                        <td style={tdMuted}>{v.shipper}</td>
                        <td style={{ ...tdCell, fontWeight: 600, color: '#2563eb' }}>{v.vessel}</td>
                        <td style={tdCell}>{v.port}</td>
                        <td style={{ ...tdCell, whiteSpace: 'nowrap', textAlign: 'center' }}>
                          <span>{fmtNum(v.quantity)}</span>
                          {v.cargo && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{v.cargo}</span>}
                        </td>
                        <td style={{ ...tdCell, color: '#b45309', whiteSpace: 'nowrap' }}>{v.demmurage}</td>
                        <td style={{ ...tdCell, color: '#7c2d12', whiteSpace: 'nowrap' }}>{v.laytimeRate}</td>
                        <td style={{ ...tdCell, color: '#7c2d12', whiteSpace: 'nowrap' }}>{v.laytimeStarts}</td>
                        <td style={{ ...tdCell, color: '#0c4a6e', whiteSpace: 'nowrap' }}>{v.laycan}</td>
                        <td style={{ ...tdCell, color: 'var(--text-muted)', whiteSpace: 'nowrap', textAlign: 'center' }}>{v.cargoReadiness}</td>
                        <td style={{ ...tdCell, color: '#047857', fontWeight: 500, whiteSpace: 'nowrap', textAlign: 'center' }}>{v.eta}</td>
                        <td style={{ ...tdCell, color: '#0369a1', whiteSpace: 'nowrap', textAlign: 'center' }}>{v.etb}</td>
                        <td style={{ ...tdCell, color: '#6d28d9', whiteSpace: 'nowrap', textAlign: 'center' }}>{v.etc}</td>
                        <td style={{ ...tdCell, color: 'var(--text-muted)' }}>{v.remarks}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filtered.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No vessels match the selected filters.</div>
              )}
              </div>
              <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', gap: 16, flexWrap: 'wrap' }}>
                <span>Showing <strong style={{ color: 'var(--text-main)' }}>{filtered.length}</strong> of <strong style={{ color: 'var(--text-main)' }}>{payload.vessels.length}</strong> vessels</span>
                <span>ETA = Estimated Time of Arrival · ETB = Estimated Time of Berthing · ETC = Estimated Time of Completion</span>
              </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {selectedDetail && (
        <VesselStatusDetailModal
          detail={selectedDetail}
          contractRows={contractRows}
          contractsLoading={contractsLoading}
          contractsError={contractsError}
          onClose={closeVesselDetail}
        />
      )}
    </div>
  );
}

function downloadBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vessel-status.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const tdCell = { padding: '6px 8px', color: 'var(--text-main)', whiteSpace: 'nowrap' };
const tdMuted = { padding: '6px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' };
