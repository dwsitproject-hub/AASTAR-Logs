import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import { buildVesselFinderMapUrl } from './vesselFinderMapUrl';
import { groupVesselsByLaycan } from './liveVesselsView';
import './LiveVessels.css';

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

function vesselFinderPage(vessel) {
  if (vessel.imo) return `https://www.vesselfinder.com/?imo=${encodeURIComponent(vessel.imo)}`;
  return `https://www.vesselfinder.com/?mmsi=${encodeURIComponent(vessel.mmsi)}`;
}

function TrackingModal({ vessel, onClose }) {
  const mapUrl = useMemo(() => buildVesselFinderMapUrl(vessel, {
    names: true,
    track: true,
    height: 640,
  }), [vessel]);

  useEffect(() => {
    const onKeyDown = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="lv-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="lv-modal" role="dialog" aria-modal="true" aria-labelledby="live-vessel-map-title">
        <header className="lv-modal-header">
          <div>
            <h2 id="live-vessel-map-title">{vessel.vessel}</h2>
            <p>{vessel.vslId} · {vessel.imo ? `IMO ${vessel.imo}` : `MMSI ${vessel.mmsi}`}</p>
          </div>
          <div className="lv-modal-actions">
            <a href={vesselFinderPage(vessel)} target="_blank" rel="noreferrer">Open VesselFinder</a>
            <button type="button" className="lv-icon-button" onClick={onClose} aria-label="Close vessel map" title="Close">×</button>
          </div>
        </header>
        <iframe
          className="lv-map-frame"
          src={mapUrl}
          title={`Live tracking for ${vessel.vessel}`}
          referrerPolicy="strict-origin-when-cross-origin"
          allow="fullscreen"
          allowFullScreen
        />
      </section>
    </div>
  );
}

function MatrixCell({ row, vessel }) {
  if (row.key === 'vessel') {
    return (
      <button type="button" className="lv-vessel-button" onClick={() => row.onSelect(vessel)}>
        <strong>{vessel.vessel}</strong>
        <span>{vessel.vslId}</span>
        <small>{vessel.imo ? `IMO ${vessel.imo}` : `MMSI ${vessel.mmsi}`}</small>
      </button>
    );
  }

  if (row.key === 'status') {
    return <div className="lv-status"><b>OPEN</b><span>{vessel.operations}</span></div>;
  }

  if (row.key === 'cargo') return <div className="lv-cargo">{vessel.cargo}</div>;
  return <div className={`lv-value lv-value-${row.key}`}>{vessel[row.key] || 'TBA'}</div>;
}

function PortCell({ vessel, portIndex }) {
  const port = vessel.ports[portIndex];
  if (!port) return <span className="lv-empty">-</span>;
  return (
    <div className="lv-port-cell">
      <span className="lv-port-name">{port.name}</span>
      {port.schedule && <span className="lv-port-date"><small>{port.scheduleType}</small>{port.schedule}</span>}
    </div>
  );
}

function VoyageTable({ group, onSelect }) {
  const maxPorts = group.vessels.reduce((max, vessel) => Math.max(max, vessel.ports.length), 0);
  const summaryRows = [
    { key: 'direction', label: 'Direction' },
    { key: 'vessel', label: 'Vessel', onSelect },
    { key: 'laycan', label: 'Laycan' },
    { key: 'cargo', label: 'Cargo / Qty' },
    { key: 'status', label: 'Status' },
  ];

  return (
    <section className="lv-month-section" aria-labelledby={`live-vessels-${group.key}`}>
      <header className="lv-month-header">
        <h2 id={`live-vessels-${group.key}`}>{group.label}</h2>
        <span>{group.vessels.length} {group.vessels.length === 1 ? 'vessel' : 'vessels'}</span>
      </header>
      <div className="lv-table-scroll">
        <table className="lv-table">
          <tbody>
            {summaryRows.map(row => (
              <tr key={row.key} className={`lv-summary-row lv-row-${row.key}`}>
                <th scope="row">{row.label}</th>
                {group.vessels.map(vessel => <td key={`${vessel.vslId}-${row.key}`}><MatrixCell row={row} vessel={vessel} /></td>)}
              </tr>
            ))}
            {Array.from({ length: maxPorts }, (_, portIndex) => (
              <tr key={`port-${portIndex}`} className="lv-port-row">
                <th scope="row">PORT {portIndex + 1}</th>
                {group.vessels.map(vessel => <td key={`${vessel.vslId}-port-${portIndex}`}><PortCell vessel={vessel} portIndex={portIndex} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const DEFAULT_MAP_CENTER = [12.994, 102.475];

function markerColorFor(vessel) {
  const palette = ['#087f5b', '#1864ab', '#c92a2a', '#9c36b5', '#d9480f', '#5f3dc4'];
  const seed = text(vessel.entity || vessel.vslId)
    .split('')
    .reduce((total, character) => total + character.charCodeAt(0), 0);
  return palette[seed % palette.length];
}

function vesselMapIcon(vessel, selected) {
  const color = markerColorFor(vessel);
  return L.divIcon({
    className: 'lv-osm-marker-host',
    html: `<span class="lv-osm-marker${selected ? ' is-selected' : ''}" style="--marker-color:${color}"></span>`,
    iconSize: [24, 30],
    iconAnchor: [12, 15],
    popupAnchor: [0, -13],
    tooltipAnchor: [13, 0],
  });
}

function MapViewport({ vessels, focusKey, fitRevision }) {
  const map = useMap();
  const positionsKey = vessels.map(vessel => `${vessel.vslId}:${vessel.latitude}:${vessel.longitude}`).join('|');

  useEffect(() => {
    map.invalidateSize();
    const focused = vessels.find(vessel => vessel.vslId === focusKey);
    if (focused) {
      map.flyTo([focused.latitude, focused.longitude], Math.max(map.getZoom(), 8), { duration: 0.55 });
      return;
    }
    if (vessels.length === 1) {
      map.setView([vessels[0].latitude, vessels[0].longitude], 8, { animate: false });
      return;
    }
    if (vessels.length > 1) {
      const bounds = L.latLngBounds(vessels.map(vessel => [vessel.latitude, vessel.longitude]));
      map.fitBounds(bounds.pad(0.16), { maxZoom: 7, animate: false });
      return;
    }
    map.setView(DEFAULT_MAP_CENTER, 5, { animate: false });
  }, [fitRevision, focusKey, map, positionsKey, vessels]);

  return null;
}

function openStreetMapUrl(vessel) {
  const latitude = Number(vessel.latitude).toFixed(5);
  const longitude = Number(vessel.longitude).toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=10/${latitude}/${longitude}`;
}

export function FleetMap({ vessels, selectedKey, onSelect }) {
  const [mapQuery, setMapQuery] = useState('');
  const [focusKey, setFocusKey] = useState('');
  const [fitRevision, setFitRevision] = useState(0);

  const positioned = useMemo(
    () => vessels.filter(vessel => vessel.hasDbPosition),
    [vessels],
  );

  const mapVessels = useMemo(() => {
    const needle = mapQuery.trim().toLowerCase();
    if (!needle) return positioned;
    return positioned.filter(vessel => [
      vessel.vessel, vessel.vslId, vessel.entity, vessel.imo, vessel.mmsi, vessel.direction,
    ].some(value => text(value).toLowerCase().includes(needle)));
  }, [mapQuery, positioned]);

  const selected = mapVessels.find(vessel => vessel.vslId === selectedKey)
    || mapVessels[0]
    || positioned[0];

  const focusVessel = vessel => {
    onSelect(vessel.vslId);
    setFocusKey(vessel.vslId);
  };

  const showAll = () => {
    setFocusKey('');
    setFitRevision(value => value + 1);
  };

  useEffect(() => {
    if (focusKey && !mapVessels.some(vessel => vessel.vslId === focusKey)) setFocusKey('');
  }, [focusKey, mapVessels]);

  return (
    <section className="lv-fleet-section" aria-labelledby="live-vessel-fleet-map">
      <header className="lv-fleet-header">
        <div>
          <h2 id="live-vessel-fleet-map">Open vessel map</h2>
          <p>Open DB6 vessels with recorded latitude and longitude.</p>
        </div>
        <div className="lv-ais-summary">
          <span className="is-live"><i />OpenStreetMap</span>
          <b>{positioned.length}/{vessels.length} mapped</b>
        </div>
      </header>

      <div className="lv-fleet-body">
        <aside className="lv-fleet-list-panel">
          <div className="lv-fleet-list-head">
            <span>Mapped vessels</span>
            <b>{mapVessels.length}</b>
          </div>
          <nav className="lv-fleet-list" aria-label="Open vessels on map">
            {mapVessels.map(vessel => (
              <button
                key={vessel.vslId}
                type="button"
                className={vessel.vslId === selected?.vslId ? 'is-active' : ''}
                style={{ '--marker-color': markerColorFor(vessel) }}
                onClick={() => focusVessel(vessel)}
                aria-pressed={vessel.vslId === selected?.vslId}
              >
                <i className="lv-list-marker" aria-hidden="true" />
                <span className="lv-list-copy">
                  <strong>{vessel.vessel}</strong>
                  <small>{Number(vessel.latitude).toFixed(4)}, {Number(vessel.longitude).toFixed(4)}</small>
                </span>
              </button>
            ))}
            {mapVessels.length === 0 && <div className="lv-fleet-list-empty">No mapped vessels match this search.</div>}
          </nav>
        </aside>

        <div className="lv-leaflet-map-wrap" aria-label="Open DB6 vessel positions">
          <MapContainer
            className="lv-leaflet-map"
            center={DEFAULT_MAP_CENTER}
            zoom={5}
            minZoom={2}
            maxZoom={18}
            scrollWheelZoom
            worldCopyJump
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MapViewport vessels={mapVessels} focusKey={focusKey} fitRevision={fitRevision} />
            {mapVessels.map(vessel => {
              const isSelected = vessel.vslId === selected?.vslId;
              return (
                <Marker
                  key={vessel.vslId}
                  position={[vessel.latitude, vessel.longitude]}
                  icon={vesselMapIcon(vessel, isSelected)}
                  eventHandlers={{ click: () => focusVessel(vessel) }}
                  keyboard
                  title={vessel.vessel}
                >
                  <Tooltip direction="right" permanent={isSelected} opacity={0.94}>
                    {vessel.vessel}
                  </Tooltip>
                  <Popup>
                    <div className="lv-osm-popup">
                      <strong>{vessel.vessel}</strong>
                      <span>{vessel.vslId}</span>
                      <small>{vessel.cargo} · {vessel.direction}</small>
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>

          <div className="lv-map-overlay-bar">
            <label className="lv-map-search">
              <span aria-hidden="true">⌕</span>
              <input value={mapQuery} onChange={event => setMapQuery(event.target.value)} placeholder="Search vessel, entity, IMO or MMSI" aria-label="Search mapped vessels" />
            </label>
            <div className="lv-map-live-count is-live"><i />{mapVessels.length} DB positions</div>
          </div>

          {selected && (
            <article className="lv-map-vessel-card">
              <div className="lv-map-vessel-title">
                <i style={{ '--marker-color': markerColorFor(selected) }} aria-hidden="true" />
                <div><strong>{selected.vessel}</strong><span>{selected.vslId}</span></div>
              </div>
              <dl>
                <div><dt>Latitude</dt><dd>{Number(selected.latitude).toFixed(5)}</dd></div>
                <div><dt>Longitude</dt><dd>{Number(selected.longitude).toFixed(5)}</dd></div>
                <div><dt>Entity</dt><dd>{selected.entity || '-'}</dd></div>
                <div><dt>Voyage</dt><dd>{selected.voyage || '-'}</dd></div>
                <div><dt>Direction</dt><dd>{selected.direction || '-'}</dd></div>
                <div><dt>Source</dt><dd>DB6 coordinates</dd></div>
              </dl>
              <div className="lv-map-card-actions">
                <button type="button" onClick={showAll}>View all</button>
                <a href={openStreetMapUrl(selected)} target="_blank" rel="noreferrer">OpenStreetMap</a>
              </div>
            </article>
          )}

          {positioned.length === 0 && <div className="lv-map-empty">No open vessels currently have valid latitude and longitude in DB6.</div>}
        </div>
      </div>
    </section>
  );
}

export default function LiveVessels() {
  const [data, setData] = useState(null);
  const dataRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [entity, setEntity] = useState('ALL');
  const [selectedVessel, setSelectedVessel] = useState(null);
  const [mapVesselKey, setMapVesselKey] = useState('');

  const load = async ({ silent = false, force = false, showIndicator = false } = {}) => {
    if (!silent && !dataRef.current) setLoading(true);
    if (showIndicator) setRefreshing(true);
    try {
      const response = await api.get('/sheets/live-vessels');
      const next = response.data;
      if (!force && dataRef.current?.updatedAt === next.updatedAt) return;
      dataRef.current = next;
      setData(next);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load live vessels');
    } finally {
      setLoading(false);
      if (showIndicator) setRefreshing(false);
    }
  };

  useEffect(() => { load({ force: true }); }, []);
  useEffect(() => {
    const timer = window.setInterval(() => load({ silent: true }), 15000);
    return () => window.clearInterval(timer);
  }, []);
  useDataRefresh({
    databases: ['DB6'],
    resources: ['vessel-update'],
    onRefresh: ({ reason }) => load({ silent: true, force: reason !== 'fallback' }),
  });

  const vessels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.vessels || []).filter(vessel => {
      if (entity !== 'ALL' && vessel.entity !== entity) return false;
      if (!needle) return true;
      return [
        vessel.vessel, vessel.vslId, vessel.entity, vessel.imo, vessel.mmsi,
        vessel.direction, vessel.cargo, ...vessel.ports.map(port => port.name),
      ].some(value => text(value).toLowerCase().includes(needle));
    });
  }, [data, entity, query]);

  const monthGroups = useMemo(
    () => groupVesselsByLaycan(vessels, data?.updatedAt),
    [data?.updatedAt, vessels],
  );

  useEffect(() => {
    if (!vessels.some(vessel => vessel.vslId === mapVesselKey)) {
      setMapVesselKey(vessels[0]?.vslId || '');
    }
  }, [mapVesselKey, vessels]);

  return (
    <div className="lv-page">
      <header className="lv-toolbar">
        <div className="lv-heading">
          <h1>Live Vessels</h1>
          <p>Open DB6 shipments · positions from Vessel DB coordinates</p>
        </div>
        <div className="lv-metrics" aria-label="Open vessel totals">
          <span><b>{data?.counts?.open ?? 0}</b> open</span>
          <span><b>{data?.counts?.positioned ?? 0}</b> mapped</span>
          <span><b>{data?.counts?.missingCoordinates ?? 0}</b> no coordinates</span>
          <span><b>{vessels.length}</b> shown</span>
        </div>
        <div className="lv-updated">DB6 updated {formatUpdated(data?.updatedAt)}</div>
      </header>

      <div className="lv-filters">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search vessel, port, cargo, IMO or MMSI..."
          aria-label="Search live vessels"
        />
        <select value={entity} onChange={event => setEntity(event.target.value)} aria-label="Filter by entity">
          <option value="ALL">All entities</option>
          {(data?.options?.entities || []).map(option => <option key={option} value={option}>{option}</option>)}
        </select>
        <button type="button" className="lv-refresh" onClick={() => load({ silent: true, force: true, showIndicator: true })} disabled={refreshing}>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && <div className="lv-error">{error}</div>}

      <main className="lv-board" aria-label="Open vessel voyage matrices by laycan month">
        {loading && !data ? (
          <div className="lv-state">Loading open vessels...</div>
        ) : vessels.length === 0 ? (
          <div className="lv-state">No open vessels match the current filters.</div>
        ) : (
          <>
            <div className="lv-month-list">
              {monthGroups.map(group => <VoyageTable key={group.key} group={group} onSelect={setSelectedVessel} />)}
            </div>
            <FleetMap vessels={vessels} selectedKey={mapVesselKey} onSelect={setMapVesselKey} />
          </>
        )}
      </main>

      {selectedVessel && <TrackingModal vessel={selectedVessel} onClose={() => setSelectedVessel(null)} />}
    </div>
  );
}
