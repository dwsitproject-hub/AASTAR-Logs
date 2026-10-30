import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import useDataRefresh from '../../services/useDataRefresh';
import './AppsScriptSheet.css';

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/13jC69FfyHuhbcM5Vcu_Dgcj1a5kKWxXuLC98IRLTnEo/edit?gid=0#gid=0';
const FALLBACK_HEADERS = ['No.', 'buyer', 'contract', 'incoterm', 'price'];
const EMPTY_ROW = ['', '', '', '', ''];
// Push model: sheet edits arrive over the realtime WebSocket; this is only the
// safety-net re-read cadence when no push events are flowing.
const FALLBACK_REFRESH_MS = 60000;

function Icon({ name, size = 16 }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18.5 9A7 7 0 0 0 6 6.5L4 9" /><path d="M5.5 15A7 7 0 0 0 18 17.5l2-2.5" /></>,
    external: <><path d="M14 3h7v7" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    grip: <><circle cx="9" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="9" cy="17" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="17" r="1" fill="currentColor" stroke="none" /></>,
    rows: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16" /></>,
    fields: <><path d="M4 7h16M4 12h16M4 17h10" /><circle cx="2" cy="7" r=".5" fill="currentColor" /><circle cx="2" cy="12" r=".5" fill="currentColor" /><circle cx="2" cy="17" r=".5" fill="currentColor" /></>,
    activity: <><path d="M3 12h4l2-7 4 14 2-7h6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    chevronLeft: <path d="m15 18-6-6 6-6" />,
    chevronRight: <path d="m9 18 6-6-6-6" />,
  };

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function MetricCard({ icon, label, value, detail, tone }) {
  return (
    <div className="sheet-metric-card">
      <span className={`sheet-metric-icon ${tone || ''}`}><Icon name={icon} size={18} /></span>
      <span className="sheet-metric-copy">
        <span className="sheet-metric-label">{label}</span>
        <strong>{value}</strong>
        <span className="sheet-metric-detail">{detail}</span>
      </span>
    </div>
  );
}

function reorderRows(rows, sourceRecordId, targetRecordId, position) {
  const sourceIndex = rows.findIndex(row => row.recordId === sourceRecordId);
  const originalTargetIndex = rows.findIndex(row => row.recordId === targetRecordId);
  if (sourceIndex < 0 || originalTargetIndex < 0 || sourceIndex === originalTargetIndex) return rows;

  const rowNumbers = rows.map(row => row.rowNumber);
  const reordered = [...rows];
  const [source] = reordered.splice(sourceIndex, 1);
  const targetIndex = reordered.findIndex(row => row.recordId === targetRecordId);
  reordered.splice(targetIndex + (position === 'after' ? 1 : 0), 0, source);
  return reordered.map((row, index) => ({ ...row, rowNumber: rowNumbers[index] }));
}

function RecordModal({ title, subtitle, headers, values, onChange, onClose, onSave, saving, saveLabel }) {
  return (
    <div className="sheet-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="sheet-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="sheet-modal-header">
          <div>
            <span className="sheet-modal-kicker">Google Sheet record</span>
            <h3>{title}</h3>
            <p>{subtitle}</p>
          </div>
          <button type="button" className="sheet-icon-button" onClick={onClose} disabled={saving} aria-label="Close dialog">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="sheet-form-grid">
          {headers.map((header, index) => (
            <label className="sheet-form-field" key={`${header}-${index}`}>
              <span>{header || `Column ${index + 1}`}</span>
              <input
                value={values[index] || ''}
                onChange={event => onChange(index, event.target.value)}
                placeholder={`Enter ${header || `column ${index + 1}`}`}
                autoFocus={index === 0}
              />
            </label>
          ))}
        </div>

        <footer className="sheet-modal-footer">
          <button type="button" className="sheet-button secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="sheet-button primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : saveLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

export default function AppsScriptSheet() {
  const [sheet, setSheet] = useState({ headers: [], rows: [], updatedAt: null });
  const [cacheInfo, setCacheInfo] = useState(null);
  const [query, setQuery] = useState('');
  const [editingCell, setEditingCell] = useState(null);
  const [savingCellKey, setSavingCellKey] = useState('');
  const [adding, setAdding] = useState(false);
  const [insertAfter, setInsertAfter] = useState(null);
  const [newRow, setNewRow] = useState(EMPTY_ROW);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [draggedRecordId, setDraggedRecordId] = useState('');
  const [dropTarget, setDropTarget] = useState(null);
  const [error, setError] = useState('');
  const requestInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const loadSheetRef = useRef(null);
  const cellSavesInFlight = useRef(new Set());
  const mounted = useRef(true);

  const headers = sheet.headers.length ? sheet.headers : FALLBACK_HEADERS;

  const loadSheet = useCallback(async (showRefresh = false) => {
    if (requestInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    requestInFlight.current = true;
    if (showRefresh && mounted.current) setRefreshing(true);

    try {
      const response = await api.get('/test/apps-script-sheet/rows');
      if (!mounted.current) return;
      setSheet({
        headers: response.data.headers || [],
        rows: response.data.rows || [],
        updatedAt: response.data.updatedAt || null,
      });
      setCacheInfo(response.data.cache || null);
      setError('');
    } catch (requestError) {
      if (mounted.current) {
        setError(requestError.response?.data?.error || 'Could not read the Apps Script test sheet');
      }
    } finally {
      requestInFlight.current = false;
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
      if (mounted.current && refreshQueued.current) {
        refreshQueued.current = false;
        setTimeout(() => loadSheetRef.current?.(), 0);
      }
    }
  }, []);

  useEffect(() => {
    loadSheetRef.current = loadSheet;
  }, [loadSheet]);

  useEffect(() => {
    mounted.current = true;
    loadSheet();
    return () => {
      mounted.current = false;
      refreshQueued.current = false;
    };
  }, [loadSheet]);

  // Sheet edits arrive as `data.updated` events over the realtime WebSocket
  // (Apps Script onEdit → VPS /events → broadcast). The fallback interval is
  // only a reconciliation safety net; useDataRefresh pauses it while hidden.
  useDataRefresh({
    resources: ['apps-script-sheet'],
    onRefresh: () => loadSheet(),
    fallbackMs: FALLBACK_REFRESH_MS,
  });

  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sheet.rows;
    return sheet.rows.filter(row => (
      String(row.rowNumber).includes(normalized)
      || row.values.some(value => String(value ?? '').toLowerCase().includes(normalized))
    ));
  }, [query, sheet.rows]);

  const beginCellEdit = (row, columnIndex) => {
    const value = String(row.values[columnIndex] ?? '');
    const key = `${row.recordId || row.rowNumber}:${columnIndex + 1}`;
    setEditingCell({
      key,
      recordId: row.recordId,
      rowNumber: row.rowNumber,
      column: columnIndex + 1,
      original: value,
      value,
    });
  };

  const saveCellEdit = async cell => {
    if (!cell || cellSavesInFlight.current.has(cell.key)) return;
    if (cell.value === cell.original) {
      setEditingCell(current => current?.key === cell.key ? null : current);
      return;
    }

    cellSavesInFlight.current.add(cell.key);
    setSavingCellKey(cell.key);
    setError('');
    try {
      await api.post('/test/apps-script-sheet/cells', {
        recordId: cell.recordId,
        row: cell.rowNumber,
        changes: [{ column: cell.column, value: cell.value }],
      });
      setSheet(current => ({
        ...current,
        rows: current.rows.map(row => {
          const matches = cell.recordId
            ? row.recordId === cell.recordId
            : row.rowNumber === cell.rowNumber;
          if (!matches) return row;
          const values = [...row.values];
          values[cell.column - 1] = cell.value;
          return { ...row, values };
        }),
      }));
      setEditingCell(current => current?.key === cell.key ? null : current);
      await loadSheet();
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not save the cell');
    } finally {
      cellSavesInFlight.current.delete(cell.key);
      setSavingCellKey(current => current === cell.key ? '' : current);
    }
  };

  const openNewRow = (afterRow = null) => {
    setNewRow(EMPTY_ROW);
    setInsertAfter(afterRow ? {
      recordId: afterRow.recordId,
      rowNumber: afterRow.rowNumber,
    } : null);
    setAdding(true);
  };

  const closeNewRow = () => {
    setAdding(false);
    setInsertAfter(null);
    setNewRow(EMPTY_ROW);
  };

  const saveNewRow = async () => {
    if (!newRow.some(value => String(value).trim())) return;

    setSaving(true);
    setError('');
    try {
      await api.post('/test/apps-script-sheet/rows', {
        values: newRow,
        ...(insertAfter ? {
          afterRecordId: insertAfter.recordId,
          afterRow: insertAfter.rowNumber,
        } : {}),
      });
      closeNewRow();
      await loadSheet(true);
    } catch (requestError) {
      setError(requestError.response?.data?.error || `Could not ${insertAfter ? 'insert' : 'add'} the record`);
    } finally {
      setSaving(false);
    }
  };

  const lastRead = sheet.updatedAt
    ? new Date(sheet.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'Waiting…';
  const pushInfo = cacheInfo?.push;
  const hybridMode = cacheInfo?.mode === 'hybrid';
  const pendingWrites = Number(cacheInfo?.pendingWrites) || 0;
  const rowMovePending = Boolean(cacheInfo?.reorderPending);
  const reorderBlocked = reordering
    || pendingWrites > 0
    || sheet.rows.some(row => row.pending)
    || Boolean(editingCell)
    || Boolean(savingCellKey);
  const lastPush = pushInfo?.lastPushAt
    ? new Date(pushInfo.lastPushAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'None yet';

  const clearDragState = () => {
    setDraggedRecordId('');
    setDropTarget(null);
  };

  const moveRow = async (sourceRecordId, targetRecordId, position) => {
    if (!sourceRecordId || !targetRecordId || sourceRecordId === targetRecordId) return;
    setSheet(current => ({
      ...current,
      rows: reorderRows(current.rows, sourceRecordId, targetRecordId, position),
    }));
    setReordering(true);
    setError('');
    try {
      await api.post('/test/apps-script-sheet/rows/reorder', {
        recordId: sourceRecordId,
        targetRecordId,
        position,
      });
      await loadSheet();
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Could not move the row');
      await loadSheet(true);
    } finally {
      setReordering(false);
      clearDragState();
    }
  };

  const beginRowDrag = (event, row) => {
    if (reorderBlocked) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.recordId);
    setDraggedRecordId(row.recordId);
    setDropTarget(null);
  };

  const updateDropTarget = (event, row) => {
    if (!draggedRecordId || draggedRecordId === row.recordId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < bounds.top + (bounds.height / 2) ? 'before' : 'after';
    setDropTarget(current => (
      current?.recordId === row.recordId && current.position === position
        ? current
        : { recordId: row.recordId, position }
    ));
  };

  const finishRowDrop = (event, row) => {
    event.preventDefault();
    const sourceRecordId = draggedRecordId || event.dataTransfer.getData('text/plain');
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < bounds.top + (bounds.height / 2) ? 'before' : 'after';
    clearDragState();
    void moveRow(sourceRecordId, row.recordId, position);
  };

  return (
    <div className="apps-script-workspace">
      <div className="sheet-page-heading">
        <div>
          <div className="sheet-breadcrumb"><span>Test workspace</span><b>/</b><span>Google Sheet bridge</span></div>
          <h2>Sheet records</h2>
          <p>Live read/write workspace for the isolated Apps Script proof of concept.</p>
        </div>
        <div className="sheet-connection-badge">
          <span className={`sheet-connection-dot ${error ? 'error' : ''}`} />
          <span>
            <b>{error ? 'Connection issue' : hybridMode ? 'Hybrid sync connected' : 'Apps Script fallback active'}</b>
            <small>Sheet1 · SQLite + push sync</small>
          </span>
        </div>
      </div>

      <div className="sheet-metrics">
        <MetricCard icon="rows" label="Live records" value={sheet.rows.length} detail="Rows served from SQLite" tone="blue" />
        <MetricCard icon="fields" label="Data fields" value={headers.length} detail="Editable Sheet1 columns" tone="violet" />
        <MetricCard icon="activity" label="Sync mode" value={hybridMode ? 'Hybrid' : 'Fallback'} detail={`${pushInfo?.count || 0} push event(s) · ${pendingWrites} queued`} tone="green" />
        <MetricCard icon="clock" label="Last push" value={lastPush} detail={`Last read ${lastRead}`} tone="amber" />
      </div>

      {error && <div className="sheet-error-banner">{error}</div>}

      <section className="sheet-record-card">
        <header className="sheet-record-header">
          <div>
            <h3>Sheet1 data</h3>
            <p>Live Sheet1 records synchronized through the ERP cache.</p>
          </div>
          <div className="sheet-record-actions">
            <a className="sheet-button secondary" href={SHEET_URL} target="_blank" rel="noreferrer">
              <Icon name="external" /> Open Sheet
            </a>
            <button type="button" className="sheet-button primary" onClick={() => openNewRow()} disabled={reordering || rowMovePending}>
              <Icon name="plus" /> New record
            </button>
          </div>
        </header>

        <div className="sheet-toolbar">
          <label className="sheet-search-field">
            <Icon name="search" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search row, buyer, contract…" />
          </label>
          <div className="sheet-toolbar-meta">
            <span className="sheet-live-pill"><span /> Live</span>
            <span>{filteredRows.length} of {sheet.rows.length} records</span>
            <button type="button" className="sheet-icon-button" onClick={() => loadSheet(true)} disabled={refreshing} aria-label="Refresh records" title="Refresh records">
              <span className={refreshing ? 'sheet-spin' : ''}><Icon name="refresh" /></span>
            </button>
          </div>
        </div>

        <div className="sheet-table-scroll">
          <table className="sheet-data-table">
            <thead>
              <tr>
                <th className="sheet-drag-column"><span className="sheet-visually-hidden">Reorder</span></th>
                <th className="sheet-row-number">Row</th>
                {headers.map((header, index) => <th key={`${header}-${index}`}>{header || `Column ${index + 1}`}</th>)}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="sheet-empty-state" colSpan={headers.length + 2}>Reading the local Sheet1 mirror…</td></tr>
              ) : filteredRows.length ? filteredRows.map(row => (
                <tr
                  key={row.recordId || row.rowNumber}
                  className={`${draggedRecordId === row.recordId ? 'sheet-row-dragging' : ''}${dropTarget?.recordId === row.recordId ? ` sheet-drop-${dropTarget.position}` : ''}`}
                  onDragOver={event => updateDropTarget(event, row)}
                  onDrop={event => finishRowDrop(event, row)}
                >
                  <td className="sheet-drag-column">
                    <button
                      type="button"
                      className="sheet-drag-handle"
                      draggable={!reorderBlocked}
                      disabled={reorderBlocked}
                      onDragStart={event => beginRowDrag(event, row)}
                      onDragEnd={clearDragState}
                      aria-label={`Drag Sheet row ${row.rowNumber} to reorder`}
                      aria-grabbed={draggedRecordId === row.recordId}
                      title={reorderBlocked ? 'Finish pending changes before reordering' : 'Drag to reorder row'}
                    >
                      <Icon name="grip" size={17} />
                    </button>
                  </td>
                  <td className="sheet-row-number">
                    <span>{row.rowNumber}</span>
                    <button
                      type="button"
                      className="sheet-insert-row-button"
                      onClick={() => openNewRow(row)}
                      disabled={row.pending || reordering || rowMovePending}
                      aria-label={`Insert a row below Sheet row ${row.rowNumber}`}
                      title={row.pending || reordering || rowMovePending ? 'Waiting for row changes to sync' : 'Insert row below'}
                    >
                      <Icon name="plus" size={13} />
                    </button>
                  </td>
                  {headers.map((header, index) => {
                    const value = row.values[index];
                    const cellKey = `${row.recordId || row.rowNumber}:${index + 1}`;
                    const isEditing = editingCell?.key === cellKey;
                    return (
                      <td
                        className={`sheet-editable-cell${isEditing ? ' is-editing' : ''}`}
                        key={`${row.rowNumber}-${index}`}
                        title={isEditing ? undefined : String(value ?? '')}
                        tabIndex={isEditing ? -1 : 0}
                        onDoubleClick={() => beginCellEdit(row, index)}
                        onKeyDown={event => {
                          if (event.currentTarget !== event.target) return;
                          if (event.key === 'Enter' || event.key === 'F2') {
                            event.preventDefault();
                            beginCellEdit(row, index);
                          }
                        }}
                      >
                        {isEditing ? (
                          <input
                            className="sheet-cell-input"
                            value={editingCell.value}
                            onChange={event => setEditingCell(current => current?.key === cellKey
                              ? { ...current, value: event.target.value }
                              : current)}
                            onBlur={event => {
                              if (event.currentTarget.dataset.cancelled !== 'true') saveCellEdit(editingCell);
                            }}
                            onFocus={event => event.currentTarget.select()}
                            onKeyDown={event => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                event.currentTarget.blur();
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                event.currentTarget.dataset.cancelled = 'true';
                                event.currentTarget.blur();
                                setEditingCell(current => current?.key === cellKey ? null : current);
                              }
                            }}
                            aria-label={`Edit ${header || `column ${index + 1}`} in Sheet row ${row.rowNumber}`}
                            disabled={savingCellKey === cellKey}
                            autoFocus
                          />
                        ) : index === 3 && value ? (
                          <span className="sheet-value-tag">{String(value)}</span>
                        ) : (
                          <span className={value === '' || value == null ? 'sheet-empty-value' : ''}>{String(value ?? '—') || '—'}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              )) : (
                <tr><td className="sheet-empty-state" colSpan={headers.length + 2}>No records match “{query}”.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <footer className="sheet-table-footer">
          <span>Showing {filteredRows.length ? 1 : 0}–{filteredRows.length} of {filteredRows.length}</span>
          <div className="sheet-pagination">
            <button type="button" disabled aria-label="Previous page"><Icon name="chevronLeft" size={15} /></button>
            <span>1</span>
            <button type="button" disabled aria-label="Next page"><Icon name="chevronRight" size={15} /></button>
          </div>
        </footer>
      </section>

      {adding && (
        <RecordModal
          title={insertAfter ? `Insert row below ${insertAfter.rowNumber}` : 'Create new record'}
          subtitle={insertAfter
            ? 'The new record will be inserted at this position in Google Sheet1.'
            : 'A new row will be appended to Google Sheet1.'}
          headers={headers}
          values={newRow}
          onChange={(index, value) => setNewRow(current => current.map((cell, cellIndex) => cellIndex === index ? value : cell))}
          onClose={closeNewRow}
          onSave={saveNewRow}
          saving={saving}
          saveLabel={insertAfter ? 'Insert row' : 'Create record'}
        />
      )}
    </div>
  );
}
