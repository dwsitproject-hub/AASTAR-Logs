import React, { useEffect, useMemo, useRef, useState } from 'react';

import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import { buildVesselFinderMapUrl } from './vesselFinderMapUrl';

const ENTITY_COLORS = {
  'A*': '#c2413b',
  'A*JV': '#7c3aed',
  GR: '#087f6f',
};

const colorFor = entity => ENTITY_COLORS[entity] || '#2563eb';
const text = value => (value == null ? '' : String(value).trim());

function formatUpdated(value) {
  if (!value) return 'Waiting for DB6';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Singapore',
  }).format(date);
}


export default function VesselMap() {
  const [data, setData] = useState(null);
  const dataRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [entity, setEntity] = useState('ALL');

  const [selectedId, setSelectedId] = useState('');
  const [mapRevision, setMapRevision] = useState(0);

  const load = async ({ silent = false, force = false } = {}) => {
    if (!silent && !dataRef.current) setLoading(true);
    if (silent) setRefreshing(true);
    try {
      const response = await api.get('/sheets/vessel-map');
      const next = response.data;
      if (!force && dataRef.current?.updatedAt === next.updatedAt) return;
      dataRef.current = next;
      setData(next);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load vessel positions');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load({ force: true }); }, []);
  useDataRefresh({
    databases: ['DB6'],
    resources: ['vessel-update'],
    onRefresh: ({ reason }) => load({ silent: true, force: reason !== 'fallback' }),
  });

  const filteredVessels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (data?.vessels || []).filter(vessel => {
      if (entity !== 'ALL' && vessel.entity !== entity) return false;

      if (!normalizedQuery) return true;
      return [vessel.vessel, vessel.vslId, vessel.entity, vessel.ops, vessel.imo, vessel.mmsi]
        .some(value => text(value).toLowerCase().includes(normalizedQuery));
    }).sort((a, b) => a.vessel.localeCompare(b.vessel, undefined, { sensitivity: 'base' }));
  }, [data, entity, query]);

  const selectedVessel = (data?.vessels || []).find(vessel => vessel.vslId === selectedId) || null;
  const mapUrl = useMemo(() => buildVesselFinderMapUrl(selectedVessel), [selectedVessel]);
  const focusVessel = vessel => {
    setSelectedId(vessel.vslId);
    setMapRevision(revision => revision + 1);
  };

  return (
    <div className="vessel-map-page">
      <style>{CSS}</style>
      <header className="vessel-map-toolbar">
        <div className="vessel-map-heading">
          <h1>Vessel Map</h1>
          <p>Select an open DB6 vessel to locate it by IMO or MMSI</p>
        </div>
        <div className="vessel-map-metrics" aria-label="Open vessel AIS totals">
          <span><b>{data?.counts?.open ?? 0}</b> open</span>
          <span className="positioned"><b>{data?.counts?.trackable ?? 0}</b> AIS trackable</span>
        </div>
        <div className="vessel-map-updated">DB6 updated {formatUpdated(data?.updatedAt)}</div>
      </header>

      <div className="vessel-map-filters">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search vessel, VSL ID, IMO, MMSI or operations..."
          aria-label="Search vessels"
        />
        <select value={entity} onChange={event => setEntity(event.target.value)} aria-label="Filter by entity">
          <option value="ALL">All entities</option>
          {(data?.options?.entities || []).map(item => <option key={item} value={item}>{item}</option>)}
        </select>

        <button type="button" className="map-refresh" onClick={() => load({ silent: true, force: true })} disabled={refreshing}>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && <div className="vessel-map-error">{error}</div>}

      <div className="vessel-map-layout">
        <section className="vessel-map-stage" aria-label="VesselFinder AIS map">
          <iframe
            key={`${mapUrl}-${mapRevision}`}
            className="vesselfinder-map-frame"
            src={mapUrl}
            title={selectedVessel ? `VesselFinder map for ${selectedVessel.vessel}` : 'VesselFinder world AIS map'}
            loading="eager"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="fullscreen"
            allowFullScreen
          />

          <div className="map-scale-note">
            {selectedVessel ? `Focused on ${selectedVessel.vessel}` : 'Select a vessel from the sidebar to focus the map'}
          </div>

          {loading && <div className="vessel-map-loading">Loading DB6 vessels...</div>}
        </section>

        <aside className="vessel-map-list" aria-label="Open vessel list">
          <div className="vessel-list-head">
            <div><strong>Trackable open vessels</strong><span>{filteredVessels.length} shown</span></div>
            <div className="entity-legend">
              {Object.entries(ENTITY_COLORS).map(([name, color]) => <span key={name}><i style={{ background: color }} />{name}</span>)}
            </div>
          </div>
          <div className="vessel-list-scroll">
            {filteredVessels.map(vessel => (
              <button
                type="button"
                key={`${vessel.vslId}-${vessel.row}`}
                className={`vessel-list-row${selectedId === vessel.vslId ? ' selected' : ''}`}
                onClick={() => focusVessel(vessel)}
                title={`Focus map on ${vessel.vessel}`}
              >
                <span className="vessel-list-dot" style={{ background: colorFor(vessel.entity) }} />
                <span className="vessel-list-copy">
                  <b>{vessel.vessel}</b>
                  <small>{vessel.entity || '-'} | {vessel.ops || 'No operations status'}</small>
                </span>
                <span className="vessel-list-position">
                  {vessel.imo ? `IMO ${vessel.imo}` : `MMSI ${vessel.mmsi}`}
                </span>
              </button>
            ))}
            {!loading && filteredVessels.length === 0 && <div className="vessel-list-empty">No open vessels match the filters.</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

const CSS = String.raw`
.vessel-map-page{margin:-28px -32px -32px;min-height:calc(100vh - var(--topbar-height));background:#eef2f1;color:#17221f;font-family:'Segoe UI',system-ui,sans-serif;display:flex;flex-direction:column}.vessel-map-page *{box-sizing:border-box}.vessel-map-toolbar{min-height:66px;padding:12px 18px;background:#fff;border-bottom:1px solid #d8dfdc;display:flex;align-items:center;gap:20px}.vessel-map-heading h1{font-size:18px;margin:0 0 2px;font-weight:700}.vessel-map-heading p{font-size:11px;color:#64736e;margin:0}.vessel-map-metrics{display:flex;gap:14px;margin-left:auto;font-size:12px;color:#53635e}.vessel-map-metrics span{display:flex;align-items:baseline;gap:4px}.vessel-map-metrics b{font-size:16px;color:#17221f}.vessel-map-metrics .positioned b{color:#087f6f}.vessel-map-metrics .missing b{color:#b45309}.vessel-map-updated{font-size:11px;color:#6b7874;white-space:nowrap}.vessel-map-filters{padding:9px 18px;background:#f8faf9;border-bottom:1px solid #d8dfdc;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.vessel-map-filters input,.vessel-map-filters select{height:34px;border:1px solid #cbd5d1;background:#fff;color:#17221f;border-radius:6px;padding:0 10px;font-size:12px}.vessel-map-filters input{flex:1 1 260px;min-width:190px}.vessel-map-filters select{min-width:130px}.position-segment{display:flex;border:1px solid #cbd5d1;border-radius:6px;background:#fff;padding:2px}.position-segment button{height:28px;padding:0 10px;border:0;background:transparent;color:#63716c;font-size:11px;border-radius:4px;cursor:pointer}.position-segment button.active{background:#1c2d28;color:#fff}.map-refresh{height:34px;padding:0 13px;border:1px solid #0b6f63;border-radius:6px;background:#0b6f63;color:#fff;font-size:12px;font-weight:600;cursor:pointer}.map-refresh:disabled{opacity:.55;cursor:wait}.vessel-map-error{padding:9px 18px;background:#fef2f2;color:#b91c1c;border-bottom:1px solid #fecaca;font-size:12px}.vessel-map-layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;flex:1;min-height:560px}.vessel-map-stage{position:relative;min-width:0;overflow:hidden;background:#c9dce3}.vesselfinder-map-frame{display:block;width:100%;height:100%;min-height:560px;border:0;background:#c9dce3}.map-scale-note{position:absolute;z-index:2;left:14px;bottom:12px;padding:5px 8px;background:rgba(255,255,255,.88);border:1px solid rgba(100,116,109,.25);border-radius:5px;color:#52615c;font-size:10px}.map-zoom-controls{position:absolute;right:14px;top:14px;display:grid;gap:5px}.map-zoom-controls button{min-width:34px;height:34px;border:1px solid #c6d0cc;background:rgba(255,255,255,.94);color:#17221f;border-radius:6px;font-size:16px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(20,40,34,.12)}.map-zoom-controls button:last-child{padding:0 9px;font-size:10px}.map-vessel-detail{position:absolute;z-index:2;left:14px;top:14px;width:min(320px,calc(100% - 90px));padding:11px 13px;background:rgba(255,255,255,.96);border:1px solid #cbd5d1;border-radius:7px;box-shadow:0 8px 24px rgba(20,40,34,.14)}.map-detail-title{display:flex;align-items:center;gap:7px;font-size:13px}.map-detail-dot{width:9px;height:9px;border-radius:50%;flex:none}.map-entity{margin-left:auto;font-size:10px;font-weight:700;color:#52615c}.map-detail-grid{margin-top:8px;display:grid;grid-template-columns:74px 1fr;gap:3px 8px;font-size:10.5px}.map-detail-grid span{color:#71807b}.map-detail-grid b{font-weight:600;color:#263732;overflow-wrap:anywhere}.vessel-map-loading{position:absolute;z-index:3;inset:0;display:grid;place-items:center;background:rgba(201,220,227,.74);font-size:13px;font-weight:600;color:#263732}.vessel-map-list{min-width:0;background:#fff;border-left:1px solid #d8dfdc;display:flex;flex-direction:column;max-height:calc(100vh - var(--topbar-height) - 110px)}.vessel-list-head{padding:12px 13px;border-bottom:1px solid #e0e6e3;display:grid;gap:8px}.vessel-list-head>div:first-child{display:flex;justify-content:space-between;align-items:baseline}.vessel-list-head strong{font-size:13px}.vessel-list-head span{font-size:10px;color:#72807b}.entity-legend{display:flex;gap:10px}.entity-legend span{display:inline-flex;align-items:center;gap:4px}.entity-legend i{width:7px;height:7px;border-radius:50%}.vessel-list-scroll{overflow:auto;flex:1}.vessel-list-row{width:100%;min-height:55px;padding:8px 12px;border:0;border-bottom:1px solid #edf0ef;background:#fff;color:#17221f;text-align:left;display:grid;grid-template-columns:9px minmax(0,1fr) auto;gap:8px;align-items:center;cursor:pointer}.vessel-list-row:hover{background:#f4f7f6}.vessel-list-row.selected{background:#e8f3f0;box-shadow:inset 3px 0 #087f6f}.vessel-list-row.unavailable{opacity:.68}.vessel-list-dot{width:8px;height:8px;border-radius:50%}.vessel-list-copy{display:grid;gap:2px;min-width:0}.vessel-list-copy b{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vessel-list-copy small{font-size:9.5px;color:#73817c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vessel-list-position{font-family:Consolas,monospace;font-size:9px;color:#66756f;white-space:nowrap}.vessel-list-empty{padding:30px 18px;text-align:center;color:#73817c;font-size:12px}@media(max-width:900px){.vessel-map-toolbar{align-items:flex-start;flex-wrap:wrap}.vessel-map-metrics{margin-left:0}.vessel-map-updated{margin-left:auto}.vessel-map-layout{grid-template-columns:1fr;grid-template-rows:minmax(440px,62vh) 330px}.vessel-map-list{border-left:0;border-top:1px solid #d8dfdc;max-height:330px}.vesselfinder-map-frame{min-height:440px}}@media(max-width:600px){.vessel-map-page{margin:-24px -20px -32px}.vessel-map-toolbar,.vessel-map-filters{padding-left:12px;padding-right:12px}.vessel-map-metrics{width:100%;justify-content:space-between}.vessel-map-updated{margin-left:0}.position-segment{width:100%}.position-segment button{flex:1}.vessel-map-layout{grid-template-rows:minmax(390px,56vh) 330px}.vesselfinder-map-frame{min-height:390px}}
`;
