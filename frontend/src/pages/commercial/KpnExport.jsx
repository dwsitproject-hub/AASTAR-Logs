import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import { trackHubAction } from '../../services/hubSdk';
import useDataRefresh from '../../services/useDataRefresh';
import './KpnExport.css';

const STORAGE_KEY = 'kpn-export-layout-v1';
const COLUMNS = [
  { id: 'month', label: 'Month', type: 'text' },
  { id: 'entity', label: 'Entity', type: 'text' },
  { id: 'shipper', label: 'Shipper', type: 'text' },
  { id: 'vessel', label: 'Vessel', type: 'text' },
  { id: 'port', label: 'Port', type: 'text' },
  { id: 'cargo', label: 'Cargo', type: 'text', value: row => `${formatNumber(row.quantity)}${row.cargo ? ` ${row.cargo}` : ''}` },
  { id: 'demmurage', label: 'Demurrage Rate PDPR', type: 'number' },
  { id: 'laytimeRate', label: 'Laytime Rate', type: 'number' },
  { id: 'laytimeStarts', label: 'Laytime Starts', type: 'text' },
  { id: 'laycan', label: 'Laycan', type: 'date' },
  { id: 'cargoReadiness', label: 'Cargo Readiness', type: 'date' },
  { id: 'eta', label: 'ETA', type: 'date' },
  { id: 'etb', label: 'ETB', type: 'date' },
  { id: 'etc', label: 'ETC', type: 'date' },
  { id: 'remarks', label: 'Remarks', type: 'text' },
];
const COLUMN_MAP = Object.fromEntries(COLUMNS.map(column => [column.id, column]));
const DEFAULT_LAYOUT = { order: COLUMNS.map(column => column.id), hidden: [], sortId: 'eta', sortDirection: 'asc' };

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US', { maximumFractionDigits: 0 }) : (value || '');
}

function loadLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const known = (saved.order || []).filter(id => COLUMN_MAP[id]);
    const missing = DEFAULT_LAYOUT.order.filter(id => !known.includes(id));
    return { ...DEFAULT_LAYOUT, ...saved, order: [...known, ...missing], hidden: (saved.hidden || []).filter(id => COLUMN_MAP[id]) };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function rawValue(row, column) {
  return column.value ? column.value(row) : (row[column.id] ?? '');
}

function sortableValue(row, column) {
  const value = rawValue(row, column);
  if (column.type === 'number') {
    const parsed = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (column.type === 'date') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return String(value).toLowerCase();
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export default function KpnExport() {
  const [payload, setPayload] = useState({ vessels: [], shippers: [], entities: [], ports: [], cargoes: [], updatedAt: null });
  const payloadRef = useRef(payload);
  const [layout, setLayout] = useState(loadLayout);
  const [filters, setFilters] = useState({ query: '', shipper: '', entity: '', port: '', cargo: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dragged, setDragged] = useState('');

  useEffect(() => { payloadRef.current = payload; }, [payload]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); }, [layout]);

  const load = async ({ silent = false, force = false } = {}) => {
    try {
      const response = await api.get('/sheets/kpn-export');
      if (silent && !force && payloadRef.current.updatedAt === response.data.updatedAt) return;
      payloadRef.current = response.data;
      setPayload(response.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'KPN Export data could not be loaded');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  useDataRefresh({
    databases: ['DB6'], resources: ['vessel-update'],
    onRefresh: ({ reason }) => load({ silent: true, force: reason !== 'fallback' }),
  });

  const visibleColumns = useMemo(() => layout.order.filter(id => !layout.hidden.includes(id)).map(id => COLUMN_MAP[id]), [layout]);
  const rows = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    const filtered = payload.vessels.filter(row =>
      (!filters.shipper || row.shipper === filters.shipper) &&
      (!filters.entity || row.entity === filters.entity) &&
      (!filters.port || row.port === filters.port) &&
      (!filters.cargo || row.cargo === filters.cargo) &&
      (!query || Object.values(row).join(' ').toLowerCase().includes(query))
    );
    const column = COLUMN_MAP[layout.sortId] || COLUMNS[0];
    return [...filtered].sort((left, right) => {
      const a = sortableValue(left, column);
      const b = sortableValue(right, column);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      const result = typeof a === 'number' ? a - b : a.localeCompare(b);
      return layout.sortDirection === 'desc' ? -result : result;
    });
  }, [payload.vessels, filters, layout.sortId, layout.sortDirection]);

  const toggleColumn = id => setLayout(current => {
    const hidden = current.hidden.includes(id) ? current.hidden.filter(value => value !== id) : [...current.hidden, id];
    return hidden.length === COLUMNS.length ? current : { ...current, hidden };
  });

  const dropColumn = target => {
    if (!dragged || dragged === target) return;
    setLayout(current => {
      const order = current.order.filter(id => id !== dragged);
      order.splice(order.indexOf(target), 0, dragged);
      return { ...current, order };
    });
    setDragged('');
  };

  const downloadCsv = () => {
    const content = [
      visibleColumns.map(column => csvCell(column.label)).join(','),
      ...rows.map(row => visibleColumns.map(column => csvCell(rawValue(row, column))).join(',')),
    ].join('\r\n');
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kpn-export-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    trackHubAction('kpn_export_csv_downloaded', { rows: rows.length });
  };

  return (
    <div className="kpn-export-page">
      <header className="kpn-export-header">
        <div><h2>KPN Export</h2><p>DB6 vessel schedule</p></div>
        <div className="kpn-export-header-actions">
          <span>{payload.updatedAt ? `Updated ${new Date(payload.updatedAt).toLocaleString('en-SG')}` : 'Waiting for refresh'}</span>
          <button type="button" onClick={downloadCsv} disabled={!rows.length} title="Download the configured table as CSV"><DownloadIcon />Export CSV</button>
        </div>
      </header>

      <div className="kpn-export-layout">
        <main className="kpn-export-main">
          <div className="kpn-export-filters">
            <label className="kpn-search"><span>Search</span><input value={filters.query} onChange={event => setFilters(current => ({ ...current, query: event.target.value }))} placeholder="Vessel, port, cargo..." /></label>
            <Filter label="Shipper" value={filters.shipper} options={payload.shippers} onChange={value => setFilters(current => ({ ...current, shipper: value }))} />
            <Filter label="Entity" value={filters.entity} options={payload.entities} onChange={value => setFilters(current => ({ ...current, entity: value }))} />
            <Filter label="Port" value={filters.port} options={payload.ports} onChange={value => setFilters(current => ({ ...current, port: value }))} />
            <Filter label="Cargo" value={filters.cargo} options={payload.cargoes} onChange={value => setFilters(current => ({ ...current, cargo: value }))} />
          </div>

          {loading ? <div className="kpn-export-state">Loading vessel data...</div> : null}
          {error ? <div className="kpn-export-state is-error">{error}<button type="button" onClick={() => load()}>Retry</button></div> : null}
          {!loading && !error ? (
            <div className="kpn-export-table-wrap">
              <table><thead><tr>{visibleColumns.map(column => <th key={column.id}>{column.label}</th>)}</tr></thead>
                <tbody>{rows.map((row, index) => <tr key={`${row.rowId}-${row.port}-${row.cargo}-${index}`}>{visibleColumns.map(column => <td key={column.id} className={`is-${column.id}`}>{rawValue(row, column) || '-'}</td>)}</tr>)}</tbody>
              </table>
              {!rows.length ? <div className="kpn-export-empty">No rows match the current configuration.</div> : null}
              <footer>Showing {rows.length} of {payload.vessels.length} rows · {visibleColumns.length} visible columns</footer>
            </div>
          ) : null}
        </main>

        <aside className="kpn-fields-panel" aria-label="Table configuration">
          <div className="kpn-panel-heading"><div><h3>Table fields</h3><p>Column order and visibility</p></div><button type="button" title="Reset table layout" onClick={() => setLayout(DEFAULT_LAYOUT)}><ResetIcon /></button></div>
          <div className="kpn-field-list">
            {layout.order.map(id => {
              const column = COLUMN_MAP[id];
              const visible = !layout.hidden.includes(id);
              return <div key={id} draggable onDragStart={() => setDragged(id)} onDragEnd={() => setDragged('')} onDragOver={event => event.preventDefault()} onDrop={() => dropColumn(id)} className={`kpn-field-row ${dragged === id ? 'is-dragging' : ''}`}>
                <GripIcon /><input type="checkbox" checked={visible} onChange={() => toggleColumn(id)} aria-label={`Show ${column.label}`} /><span>{column.label}</span>
              </div>;
            })}
          </div>
          <div className="kpn-sort-panel"><h4>Sort</h4><label>Sort by<select value={layout.sortId} onChange={event => setLayout(current => ({ ...current, sortId: event.target.value }))}>{layout.order.map(id => <option key={id} value={id}>{COLUMN_MAP[id].label}</option>)}</select></label>
            <div className="kpn-sort-direction"><button type="button" className={layout.sortDirection === 'asc' ? 'is-active' : ''} onClick={() => setLayout(current => ({ ...current, sortDirection: 'asc' }))}>Ascending</button><button type="button" className={layout.sortDirection === 'desc' ? 'is-active' : ''} onClick={() => setLayout(current => ({ ...current, sortDirection: 'desc' }))}>Descending</button></div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Filter({ label, value, options = [], onChange }) {
  return <label><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}><option value="">All</option>{options.map(option => <option key={option} value={option}>{option}</option>)}</select></label>;
}

const Icon = ({ children }) => <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
const DownloadIcon = () => <Icon><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14" /></Icon>;
const ResetIcon = () => <Icon><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Icon>;
const GripIcon = () => <Icon><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></Icon>;
