import React, { useEffect, useState, useRef } from 'react';
import api from '../../services/api';
import { trackHubAction } from '../../services/hubSdk';
import useDataRefresh from '../../services/useDataRefresh';
import { useTheme } from '../../context/ThemeContext';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const PORT_HEADERS = ["#","vsl ID","Actions","L/D","Port","Shipper","Entity","Qty","Cargo","Open/Closed","Laycan","CR","ETA","ETB","ETC"];
// Column positions (0-based) within the sheet for each port field — for save
const PORT_COL_BASE = 20, PORT_COL_STRIDE = 16;
const PORT_FIELD_COL = { port_name:0, status_ld:1, shipper:2, port_entity:3, qty:4, l_cargo:5, status_oc:6, laycan:7, cr:8, eta:9, eta_time:10, etb:11, etb_time:12, etc:13, etc_time:14 };
const PORT_OFFSET_FIELD = { '-1':'vslid', 0:'port_name', 1:'status_ld', 2:'shipper', 3:'port_entity', 4:'qty', 5:'l_cargo', 6:'status_oc', 7:'laycan', 8:'cr', 9:'eta', 10:'eta_time', 11:'etb', 12:'etb_time', 13:'etc', 14:'etc_time' };
const PORT_MOVE_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const PORT_CLEAR_OFFSETS = PORT_MOVE_OFFSETS;
const PORT_FIELD_ORDER = ['status_ld','port_name','shipper','port_entity','qty','l_cargo','status_oc','laycan','cr'];
const DATE_TIME_FIELDS = [
  ['eta', 'eta_time'],
  ['etb', 'etb_time'],
  ['etc', 'etc_time'],
];

// Canonical dropdown values per spec
const OPS_OPTIONS = ['Pending Vsl','Pending Acceptance','Pending Fixture','Pending Nom','Pending SI','Done','Pending LC','Pending Payment','Pending Tender','Pending SD','Pending Arrival','Pending Sales'];
const SHIPPER_OPTIONS = ['3P','PMC','SPC','EUP','TPG','GLM','JPN','Disch'];
const ENTITY_OPTIONS = ['A*','A*JV','GR','JPN','3P'];
const LAYTIME_START_OPTIONS = ['NOR +6', 'All Fast', 'Laycan NOR+6', 'Laycan All Fast'];

// Vessel-level columns
const VESSEL_COLS = [
  ['charterer', 1, 'sel-charterer'],
  ['entity', 2, 'sel'],
  ['vessel', 4, 'text'],
  ['imo', 7, 'num'],
  ['mmsi', 8, 'num'],
  ['status', 9, 'sel-status'],
  ['ops', 10, 'sel'],
  ['demm_rate', 14, 'num'],
  ['laytime_rate', 15, 'num'],
  ['laytime_starts', 16, 'sel-laytime-starts'],
  ['remarks', 17, 'text'],
  ['nominated', 18, 'checkbox'],
];

const isoToDDMmm = (iso) => {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${parseInt(m[3])} ${MONTHS[parseInt(m[2]) - 1]}`;
};

const cleanTime = (value) => {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

export default function VesselUpdate({ embedded = false }) {
  const { isDark } = useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('open');
  const [entityFilter, setEntityFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({});
  const [dirty, setDirty] = useState({}); // { row: { 'col': value, ... } }
  const [portUndo, setPortUndo] = useState({});
  const [portRemaps, setPortRemaps] = useState({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { row, vsl_id, vessel } or null
  const [deleting, setDeleting] = useState(false);
  const searchDebounce = useRef();
  const dataRef = useRef(null);
  const dirtyRef = useRef({});
  const [pendingUpdate, setPendingUpdate] = useState(false);

  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const load = async (s = statusFilter, q = search, { silent = false, force = false } = {}) => {
    const hasData = dataRef.current !== null;
    if (!silent && !hasData) setLoading(true);
    try {
      const r = await api.get(`/sheets/vessel-update?status=${encodeURIComponent(s)}&q=${encodeURIComponent(q)}`);
      const nextData = r.data;
      const currentData = dataRef.current;
      const changed = force || !currentData || currentData.updatedAt !== nextData.updatedAt;

      // Keep an in-progress editor stable while the background DB6 sync catches up.
      if (silent && !changed) return;
      if (silent && Object.keys(dirtyRef.current).length > 0) {
        setPendingUpdate(true);
        return;
      }

      dataRef.current = nextData;
      setData(nextData);
      setPendingUpdate(false);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load');
    } finally {
      if (!silent && !hasData) setLoading(false);
    }
  };

  useEffect(() => { load(statusFilter, search); /* eslint-disable-next-line */ }, [statusFilter]);
  useDataRefresh({
    databases: ['DB6', 'DB8'],
    resources: ['vessel-update'],
    onRefresh: ({ reason }) => load(statusFilter, search, { silent: true, force: reason !== 'fallback' }),
  });

  const onSearchChange = (v) => {
    setSearch(v);
    clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => load(statusFilter, v), 300);
  };

  const showToast = (msg, kind = '') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2600);
  };

  const setCell = (row, col, value, isDate = false) => {
    setPortUndo(current => {
      if (!current[row]) return current;
      const next = { ...current };
      delete next[row];
      return next;
    });
    setDirty(d => {
      const r = { ...d[row] };
      r[col] = { value, date: isDate };
      return { ...d, [row]: r };
    });
  };

  const totalDirty = Object.values(dirty).reduce((sum, r) => sum + Object.keys(r).length, 0);

  const portCellEntry = (vessel, portIndex, offset, rowDirty = {}) => {
    const column = PORT_COL_BASE + portIndex * PORT_COL_STRIDE + offset;
    if (rowDirty[column]) return { ...rowDirty[column] };
    const field = PORT_OFFSET_FIELD[offset];
    return { value: vessel.ports[portIndex]?.[field] || '', date: false };
  };

  const stagePortAction = (vessel, portIndex, action) => {
    const rowDirty = dirty[vessel.row] || {};
    const rowRemaps = portRemaps[vessel.row] || {};
    const nextRow = { ...rowDirty };
    const nextRemaps = { ...rowRemaps };
    const affected = [portIndex];
    if (action === 'up' || action === 'down') {
      const target = portIndex + (action === 'up' ? -1 : 1);
      if (target < 0 || target >= vessel.ports.length) return;
      affected.push(target);
      for (const offset of PORT_MOVE_OFFSETS) {
        const sourceCol = PORT_COL_BASE + portIndex * PORT_COL_STRIDE + offset;
        const targetCol = PORT_COL_BASE + target * PORT_COL_STRIDE + offset;
        nextRow[sourceCol] = portCellEntry(vessel, target, offset, rowDirty);
        nextRow[targetCol] = portCellEntry(vessel, portIndex, offset, rowDirty);
      }
      const sourceVslId = vessel.ports[portIndex]?.vslid;
      const targetVslId = vessel.ports[target]?.vslid;
      if (sourceVslId && targetVslId) {
        const identities = vessel.ports.map(port => port.vslid).filter(Boolean);
        for (const identity of identities) {
          const destination = nextRemaps[identity] || identity;
          if (destination === sourceVslId) nextRemaps[identity] = targetVslId;
          else if (destination === targetVslId) nextRemaps[identity] = sourceVslId;
        }
      }
    } else if (action === 'clear') {
      for (const offset of PORT_CLEAR_OFFSETS) {
        nextRow[PORT_COL_BASE + portIndex * PORT_COL_STRIDE + offset] = { value: '', date: false };
      }
    }
    setPortUndo(undo => ({ ...undo, [vessel.row]: { before: rowDirty, remapsBefore: rowRemaps, affected } }));
    setPortRemaps(current => ({ ...current, [vessel.row]: nextRemaps }));
    setDirty(current => ({ ...current, [vessel.row]: nextRow }));
  };

  const undoPortAction = (row) => {
    const snapshot = portUndo[row];
    if (!snapshot) return;
    setDirty(current => {
      const next = { ...current };
      if (Object.keys(snapshot.before).length) next[row] = snapshot.before;
      else delete next[row];
      return next;
    });
    setPortRemaps(current => {
      const next = { ...current };
      if (Object.keys(snapshot.remapsBefore || {}).length) next[row] = snapshot.remapsBefore;
      else delete next[row];
      return next;
    });
    setPortUndo(current => { const next = { ...current }; delete next[row]; return next; });
  };

  const saveRow = async (row) => {
    const rowDirty = dirty[row];
    if (!rowDirty || Object.keys(rowDirty).length === 0) return;
    const vessel = data.vessels.find(v => v.row === row);
    if (!vessel) return;
    const updates = Object.entries(rowDirty).map(([col, { value, date }]) => ({ row, col: parseInt(col), value, date }));
    const saved = await postSave(updates, { [row]: vessel.vsl_id }, portRemapList(row));
    if (saved) {
      setDirty(d => { const nd = { ...d }; delete nd[row]; return nd; });
      setPortUndo(current => { const next = { ...current }; delete next[row]; return next; });
      setPortRemaps(current => { const next = { ...current }; delete next[row]; return next; });
    }
  };

  const saveAll = async () => {
    const updates = [];
    const expected = {};
    for (const [rowStr, cells] of Object.entries(dirty)) {
      const row = parseInt(rowStr);
      const vessel = data.vessels.find(v => v.row === row);
      if (!vessel) continue;
      expected[row] = vessel.vsl_id;
      for (const [col, { value, date }] of Object.entries(cells)) {
        updates.push({ row, col: parseInt(col), value, date });
      }
    }
    if (updates.length === 0) { showToast('Nothing to save'); return; }
    const remaps = Object.keys(dirty).flatMap(row => portRemapList(Number(row)));
    const saved = await postSave(updates, expected, remaps);
    if (saved) {
      setDirty({});
      setPortUndo({});
      setPortRemaps({});
    }
  };

  const portRemapList = (row) => Object.entries(portRemaps[row] || {})
    .filter(([from, to]) => from && to && from !== to)
    .map(([from, to]) => ({ row, from, to }));

  const postSave = async (updates, expected, slotRemaps = []) => {
    setSaving(true);
    try {
      const r = await api.post('/sheets/vessel-update/save', { updates, expected_ids: expected, slot_remaps: slotRemaps });
      const { saved, skipped, clearedMatches = 0, remappedMatches = 0 } = r.data;
      trackHubAction('vessel_update_saved', { cells: Number(saved) || 0, skipped: skipped?.length || 0 });
      if (skipped?.length) showToast(`Saved ${saved}, ${skipped.length} skipped (row shifted)`, 'warn');
      else showToast(`Saved ${saved} cell(s)${remappedMatches ? `; moved ${remappedMatches} contract match(es)` : ''}${clearedMatches ? `; released ${clearedMatches} contract match(es)` : ''}`);
      // wait a moment for the queue to flush then reload
      setTimeout(() => load(), 2000);
      return true;
    } catch (err) {
      showToast('Save failed: ' + (err.response?.data?.error || err.message), 'err');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const createEntry = async (payload) => {
    setCreating(true);
    try {
      const r = await api.post('/sheets/vessel-update/create', payload);
      showToast(`Created ${r.data.vsl_id}`);
      trackHubAction('vessel_entry_created');
      setAddOpen(false);
      setTimeout(() => load(), 1500);
    } catch (err) {
      showToast('Create failed: ' + (err.response?.data?.error || err.message), 'err');
    } finally {
      setCreating(false);
    }
  };

  const deleteEntry = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      await api.post('/sheets/vessel-update/delete', { row: deleteConfirm.row, vsl_id: deleteConfirm.vsl_id });
      showToast(`Deleted ${deleteConfirm.vsl_id || 'row ' + deleteConfirm.row}`);
      trackHubAction('vessel_entry_deleted');
      setDeleteConfirm(null);
      setTimeout(() => load(), 1500);
    } catch (err) {
      showToast('Delete failed: ' + (err.response?.data?.error || err.message), 'err');
    } finally {
      setDeleting(false);
    }
  };

  const filtered = (data?.vessels || []).filter(v => !entityFilter || v.entity === entityFilter);

  const bg = isDark ? '#0f172a' : '#f4f6f8';
  const cardBg = isDark ? '#1e293b' : '#fff';
  const textCol = isDark ? '#e2e8f0' : '#1f2933';
  const mutedCol = isDark ? '#94a3b8' : '#7b8794';
  const borderCol = isDark ? '#334155' : '#e4e7eb';
  const inputBg = isDark ? '#0f172a' : '#fff';
  const inputBorder = isDark ? '#475569' : '#cbd2d9';
  const headerBg = isDark ? '#020617' : '#1e293b';

  return (
    <div style={{ background: bg, color: textCol, minHeight: '100%', fontSize: 13, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ background: cardBg, color: textCol, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 5, borderBottom: `1px solid ${borderCol}` }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, whiteSpace: 'nowrap', color: textCol }}>Vessel Daily-Edit Dashboard</h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' }}>
          <label style={{ ...topLabel, color: mutedCol }}>STATUS</label>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={topInput(inputBg, inputBorder, textCol)}>
            <option value="open">OPEN</option>
            <option value="all">All</option>
          </select>
          <label style={{ ...topLabel, color: mutedCol }}>ENTITY</label>
          <select value={entityFilter} onChange={e => setEntityFilter(e.target.value)} style={topInput(inputBg, inputBorder, textCol)}>
            <option value="">All entities</option>
            {data?.options?.entities?.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <input value={search} onChange={e => onSearchChange(e.target.value)} placeholder="Search..." style={{ ...topInput(inputBg, inputBorder, textCol), minWidth: 140 }} />
          <button onClick={() => {
            const anyExpanded = Object.values(expanded).some(Boolean);
            const next = {}; filtered.forEach(v => next[v.row] = !anyExpanded);
            setExpanded(next);
          }} style={lightBtn(inputBg, inputBorder, textCol)}>{Object.values(expanded).some(Boolean) ? 'Collapse all' : 'Expand all'}</button>
          <button onClick={() => setAddOpen(true)} style={{ ...primaryBtn, background: '#0ea5e9' }}>+ Add Entry</button>
          <button onClick={saveAll} disabled={totalDirty === 0 || saving} style={{ ...primaryBtn, background: totalDirty > 0 ? '#16a34a' : '#94a3b8' }}>
            {saving ? 'Saving…' : `Save all${totalDirty > 0 ? ` (${totalDirty})` : ''}`}
          </button>
        </div>
      </div>

      <div style={{ padding: 14 }}>
        {error && <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e', padding: '10px 14px', borderRadius: 8, marginBottom: 12 }}>⚠ {error}</div>}
        {pendingUpdate && <div style={{ background: '#eff6ff', border: '1px solid #93c5fd', color: '#1d4ed8', padding: '10px 14px', borderRadius: 8, marginBottom: 12 }}>New Vessel DB changes are available and will be applied after the current edits are saved.</div>}
        <div style={{ fontSize: 12, color: mutedCol, marginBottom: 10 }}>
          {loading ? 'Loading…' : `${filtered.length} vessel(s) shown.`}
        </div>

        {filtered.map(v => {
          const isExp = !!expanded[v.row];
          const isOpen = v.status?.toUpperCase() === 'OPEN';
          const rowDirty = dirty[v.row] || {};
          const rowHasDirty = Object.keys(rowDirty).length > 0;
          return (
            <div key={v.row} style={{
              background: cardBg, border: `1px solid ${borderCol}`,
              borderLeft: `6px solid ${isOpen ? '#16a34a' : '#94a3b8'}`,
              borderRadius: 8, marginBottom: 10, overflow: 'hidden'
            }}>
              <div onClick={() => setExpanded(e => ({ ...e, [v.row]: !e[v.row] }))}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: isOpen ? '#16a34a' : '#94a3b8' }} />
                <span style={{ fontSize: 12, color: mutedCol, transform: isExp ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>▶</span>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{v.vessel || '(unnamed)'}</span>
                <span style={{ color: mutedCol, fontSize: 12 }}>{v.voyage} · {v.entity} · row {v.row}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button onClick={e => { e.stopPropagation(); saveRow(v.row); }} disabled={!rowHasDirty || saving}
                    style={{ ...primaryBtn, padding: '5px 12px', fontSize: 12, background: rowHasDirty ? '#2563eb' : '#94a3b8' }}>
                    Save
                  </button>
                  <button onClick={e => { e.stopPropagation(); setDeleteConfirm({ row: v.row, vsl_id: v.vsl_id, vessel: v.vessel }); }}
                    title="Delete this row"
                    style={{ padding: '5px 9px', fontSize: 14, lineHeight: 1, background: 'transparent', color: '#dc2626', border: `1px solid ${inputBorder}`, borderRadius: 5, cursor: 'pointer' }}>
                    🗑
                  </button>
                </div>
              </div>

              <div style={{ padding: '0 14px 12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '6px 10px', marginBottom: 10 }}>
                  {VESSEL_COLS.map(([field, col, kind]) => (
                    <FieldCell key={field} label={field.replace('_',' ')} value={v[field]} options={data?.options} kind={kind}
                      onChange={val => setCell(v.row, col, val)}
                      inputBg={inputBg} borderCol={inputBorder} textCol={textCol} mutedCol={mutedCol} />
                  ))}
                </div>

                {isExp && (
                  <div style={{ paddingTop: 6 }}>
                    <div style={{ fontSize: 11, color: mutedCol, textTransform: 'uppercase', letterSpacing: 0.5, margin: '6px 0 4px' }}>Loadports / Discharge ports</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, tableLayout: 'fixed' }}>
                        <colgroup>
                          {['30px','110px','120px','90px','150px','110px','90px','60px','90px','100px','110px','80px','96px','96px','96px'].map((w,i)=><col key={i} style={{ width: w }} />)}
                        </colgroup>
                        <thead>
                          <tr>{PORT_HEADERS.map(h => <th key={h} style={{ background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#cbd5e1' : '#475569', padding: '5px 6px', textAlign: 'left', fontSize: 10, fontWeight: 600, border: `1px solid ${borderCol}` }}>{h}</th>)}</tr>
                        </thead>
                        <tbody>
                          {v.ports.map((originalPort, pi) => {
                            const p = displayedPort(originalPort, pi, rowDirty);
                            const isEmpty = !p.port_name;
                            const undo = portUndo[v.row];
                            const canUndo = undo?.affected?.includes(pi);
                            return (
                              <tr key={pi} style={{ background: isEmpty ? (isDark ? '#172033' : '#fafbfc') : 'transparent' }}>
                                <td style={portTdStyle(borderCol, isEmpty, mutedCol)}>{pi + 1}</td>
                                <td style={{ ...portTdStyle(borderCol, false, mutedCol), color: mutedCol, fontFamily: 'monospace', fontSize: 10 }}>{p.vslid}</td>
                                <td style={portTdStyle(borderCol, isEmpty, mutedCol)}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'center' }}>
                                    <PortActionButton title="Move port up" disabled={pi === 0} onClick={() => stagePortAction(v, pi, 'up')}><ArrowUpIcon /></PortActionButton>
                                    <PortActionButton title="Move port down" disabled={pi === v.ports.length - 1} onClick={() => stagePortAction(v, pi, 'down')}><ArrowDownIcon /></PortActionButton>
                                    <PortActionButton title="Clear this port" danger disabled={isEmpty} onClick={() => stagePortAction(v, pi, 'clear')}><TrashIcon /></PortActionButton>
                                    <PortActionButton title="Undo last port action" disabled={!canUndo} onClick={() => undoPortAction(v.row)}><UndoIcon /></PortActionButton>
                                  </div>
                                </td>
                                {PORT_FIELD_ORDER.map(f => {
                                  const sheetCol = PORT_COL_BASE + pi * PORT_COL_STRIDE + PORT_FIELD_COL[f];
                                  const isDate = f === 'cr';
                                  return (
                                    <td key={f} style={portTdStyle(borderCol, isEmpty, mutedCol)}>
                                      <PortCellInput
                                        field={f} port={p} kind={isDate ? 'date' : 'text'}
                                        options={data?.options}
                                        onChange={(val, d) => setCell(v.row, sheetCol, val, !!d)}
                                        inputBg={inputBg} borderCol={inputBorder} textCol={textCol}
                                      />
                                    </td>
                                  );
                                })}
                                {DATE_TIME_FIELDS.map(([dateField, timeField]) => {
                                  const dateCol = PORT_COL_BASE + pi * PORT_COL_STRIDE + PORT_FIELD_COL[dateField];
                                  const timeCol = PORT_COL_BASE + pi * PORT_COL_STRIDE + PORT_FIELD_COL[timeField];
                                  return (
                                    <td key={dateField} style={portTdStyle(borderCol, isEmpty, mutedCol)}>
                                      <DateTimePortCell
                                        dateField={dateField}
                                        timeField={timeField}
                                        port={p}
                                        canEditTime={p.status_ld === 'Load'}
                                        options={data?.options}
                                        onDateChange={(val, d) => setCell(v.row, dateCol, val, !!d)}
                                        onTimeChange={(val) => setCell(v.row, timeCol, val)}
                                        inputBg={inputBg}
                                        borderCol={inputBorder}
                                        textCol={textCol}
                                        mutedCol={mutedCol}
                                      />
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: 20, right: 20,
          background: toast.kind === 'err' ? '#b91c1c' : toast.kind === 'warn' ? '#b45309' : '#1e293b',
          color: '#fff', padding: '10px 16px', borderRadius: 8, zIndex: 1000, maxWidth: 360
        }}>{toast.msg}</div>
      )}

      {addOpen && (
        <AddEntryModal
          options={data?.options}
          onClose={() => setAddOpen(false)}
          onSubmit={createEntry}
          submitting={creating}
          isDark={isDark}
        />
      )}

      {deleteConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
          <div style={{ background: cardBg, color: textCol, borderRadius: 8, padding: 22, minWidth: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Confirm Deletion?</h3>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: mutedCol }}>
              Delete row {deleteConfirm.row} ({deleteConfirm.vsl_id || '—'}, {deleteConfirm.vessel || '—'}) from the sheet? This cannot be undone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setDeleteConfirm(null)} disabled={deleting}
                style={lightBtn(inputBg, inputBorder, textCol)}>Cancel</button>
              <button onClick={deleteEntry} disabled={deleting}
                style={{ ...primaryBtn, background: '#dc2626' }}>{deleting ? 'Deleting…' : 'Yes, delete'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function displayedPort(port, portIndex, rowDirty = {}) {
  const displayed = { ...port };
  for (const [offsetKey, field] of Object.entries(PORT_OFFSET_FIELD)) {
    const offset = Number(offsetKey);
    const column = PORT_COL_BASE + portIndex * PORT_COL_STRIDE + offset;
    const staged = rowDirty[column];
    if (!staged) continue;
    displayed[field] = staged.value;
    if (['cr', 'eta', 'etb', 'etc'].includes(field)) {
      displayed[`${field}_iso`] = staged.date ? staged.value : '';
      displayed[`${field}_display`] = staged.date ? isoToDDMmm(staged.value) : staged.value;
    }
  }
  return displayed;
}

function PortActionButton({ title, disabled = false, danger = false, onClick, children }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        alignItems: 'center', background: 'transparent', border: '1px solid currentColor', borderRadius: 4,
        color: danger ? '#dc2626' : '#64748b', cursor: disabled ? 'not-allowed' : 'pointer', display: 'inline-flex',
        height: 23, justifyContent: 'center', opacity: disabled ? 0.3 : 1, padding: 0, width: 23,
      }}
    >
      {children}
    </button>
  );
}

const PortIcon = ({ children }) => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const ArrowUpIcon = () => <PortIcon><path d="m18 15-6-6-6 6" /></PortIcon>;
const ArrowDownIcon = () => <PortIcon><path d="m6 9 6 6 6-6" /></PortIcon>;
const TrashIcon = () => <PortIcon><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m19 6-1 14H6L5 6" /><path d="M10 11v5M14 11v5" /></PortIcon>;
const UndoIcon = () => <PortIcon><path d="M9 7 4 12l5 5" /><path d="M4 12h10a6 6 0 0 1 6 6" /></PortIcon>;

function FieldCell({ label, value, options, kind, onChange, inputBg, borderCol, textCol, mutedCol }) {
  const normalizedValue = kind === 'checkbox' ? !!value : (value || '');
  const [val, setVal] = useState(normalizedValue);
  useEffect(() => setVal(kind === 'checkbox' ? !!value : (value || '')), [value, kind]);
  const handle = (v) => { setVal(v); onChange(v); };
  const inp = { width: '100%', padding: '5px 7px', border: `1px solid ${borderCol}`, borderRadius: 5, fontSize: 12, background: inputBg, color: textCol };
  const lab = { display: 'block', fontSize: 10, color: mutedCol, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.3 };

  let editor;
  if (kind === 'sel' || kind === 'sel-charterer') {
    const list = kind === 'sel-charterer' ? (options?.charterers || []) : label === 'entity' ? ENTITY_OPTIONS : label === 'ops' ? OPS_OPTIONS : [];
    const choices = val && !list.includes(val) ? [val, ...list] : list;
    editor = (
      <select value={val} onChange={e => handle(e.target.value)} style={inp}>
        <option value=""></option>
        {choices.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (kind === 'sel-status') {
    editor = (
      <select value={val} onChange={e => handle(e.target.value)} style={inp}>
        <option value=""></option>
        <option value="OPEN">OPEN</option>
        <option value="CLOSED">CLOSED</option>
      </select>
    );
  } else if (kind === 'sel-laytime-starts') {
    editor = (
      <select value={val} onChange={e => handle(e.target.value)} style={inp}>
        <option value=""></option>
        {LAYTIME_START_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (kind === 'checkbox') {
    const checked = val === true || val === 'TRUE';
    editor = (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, padding: '5px 7px', border: `1px solid ${borderCol}`, borderRadius: 5, background: inputBg, color: textCol, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={e => handle(e.target.checked ? 'TRUE' : 'FALSE')}
          style={{ width: 14, height: 14, margin: 0 }}
        />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{checked ? 'TRUE' : 'FALSE'}</span>
      </label>
    );
  } else {
    editor = <input type={kind === 'num' ? 'number' : 'text'} value={val} onChange={e => handle(e.target.value)} style={inp} />;
  }
  return <div><label style={lab}>{label}</label>{editor}</div>;
}

function PortCellInput({ field, port, kind, options, onChange, inputBg, borderCol, textCol }) {
  const [val, setVal] = useState(kind === 'date' ? (port[field + '_display'] || '') : (port[field] || ''));
  const [iso, setIso] = useState(kind === 'date' ? (port[field + '_iso'] || '') : '');
  useEffect(() => {
    setVal(kind === 'date' ? (port[field + '_display'] || '') : (port[field] || ''));
    setIso(kind === 'date' ? (port[field + '_iso'] || '') : '');
  }, [port[field], port[field + '_display'], port[field + '_iso'], field, kind]);

  const inp = { width: '100%', padding: '3px 5px', fontSize: 11, background: inputBg, color: textCol, border: `1px solid ${borderCol}`, borderRadius: 4 };

  if (field === 'status_ld') {
    return (
      <select value={val} onChange={e => { setVal(e.target.value); onChange(e.target.value); }} style={inp}>
        <option value=""></option>
        <option value="Load">Load</option>
        <option value="Discharge">Discharge</option>
      </select>
    );
  }
  if (field === 'status_oc') {
    return (
      <select value={val} onChange={e => { setVal(e.target.value); onChange(e.target.value); }} style={inp}>
        <option value=""></option>
        <option value="OPEN">OPEN</option>
        <option value="CLOSED">CLOSED</option>
      </select>
    );
  }
  if (field === 'port_name' || field === 'shipper' || field === 'port_entity' || field === 'l_cargo') {
    let list;
    if (field === 'port_name') list = options?.abvPorts?.length ? options.abvPorts : options?.ports;
    else if (field === 'shipper') list = SHIPPER_OPTIONS;
    else if (field === 'port_entity') list = options?.entities?.length ? options.entities : ENTITY_OPTIONS;
    else list = options?.abvCargoes?.length ? options.abvCargoes : options?.cargos;
    if (val && !(list || []).includes(val)) list = [val, ...(list || [])];
    return (
      <select value={val} onChange={e => { setVal(e.target.value); onChange(e.target.value); }} style={inp}>
        <option value=""></option>
        {(list || []).map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (kind === 'date') {
    const hiddenRef = useRef(null);
    return (
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 2 }}>
        <input value={val} readOnly style={{ ...inp, flex: 1 }} placeholder="—" />
        <button
          type="button"
          onClick={() => {
            const el = hiddenRef.current;
            if (!el) return;
            if (typeof el.showPicker === 'function') { try { el.showPicker(); } catch { el.click(); } }
            else el.click();
          }}
          style={{ padding: '2px 5px', fontSize: 11, background: '#64748b', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}
          title="Pick a date"
        >📅</button>
        <input
          ref={hiddenRef}
          type="date"
          value={iso}
          onChange={e => {
            const newIso = e.target.value;
            setIso(newIso);
            setVal(isoToDDMmm(newIso));
            onChange(newIso, true);
          }}
          style={{ position: 'absolute', opacity: 0, width: 1, height: 1, pointerEvents: 'none' }}
        />
      </div>
    );
  }
  return <input type={kind === 'num' ? 'number' : 'text'} value={val} onChange={e => { setVal(e.target.value); onChange(e.target.value); }} style={inp} />;
}

function DateTimePortCell({ dateField, timeField, port, canEditTime, options, onDateChange, onTimeChange, inputBg, borderCol, textCol, mutedCol }) {
  const rawTime = port[timeField] || '';
  const displayTime = canEditTime ? (cleanTime(rawTime) || '00:00') : cleanTime(rawTime);
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <PortCellInput
        field={dateField}
        port={port}
        kind="date"
        options={options}
        onChange={onDateChange}
        inputBg={inputBg}
        borderCol={borderCol}
        textCol={textCol}
      />
      <TimeCell
        value={displayTime}
        disabled={!canEditTime}
        onChange={onTimeChange}
        inputBg={inputBg}
        borderCol={borderCol}
        textCol={textCol}
        mutedCol={mutedCol}
      />
    </div>
  );
}

function TimeCell({ value, disabled = false, onChange, inputBg, borderCol, textCol, mutedCol }) {
  const [val, setVal] = useState(cleanTime(value) || '00:00');
  useEffect(() => setVal(cleanTime(value) || '00:00'), [value]);
  const style = {
    width: '100%',
    height: 24,
    boxSizing: 'border-box',
    padding: '3px 5px',
    border: disabled ? '1px solid transparent' : `1px solid ${borderCol}`,
    borderRadius: 4,
    fontSize: 11,
    lineHeight: '16px',
    textAlign: 'center',
    background: disabled ? 'transparent' : inputBg,
    color: disabled ? mutedCol : textCol,
    opacity: 1,
  };
  return (
    <input
      type="time"
      step="60"
      value={val}
      disabled={disabled}
      onChange={e => {
        const next = cleanTime(e.target.value) || '00:00';
        setVal(next);
        onChange(next);
      }}
      style={style}
    />
  );
}

const topLabel = { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 };
const topInput = (bg, br, tc) => ({ padding: '5px 7px', border: `1px solid ${br}`, borderRadius: 5, fontSize: 12, background: bg, color: tc });
const lightBtn = (bg, br, tc) => ({ padding: '6px 10px', background: bg, color: tc, border: `1px solid ${br}`, borderRadius: 5, fontSize: 12, cursor: 'pointer' });
const primaryBtn = { padding: '6px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, cursor: 'pointer', fontWeight: 500 };
const portTdStyle = (border, empty, mutedCol) => ({ border: `1px solid ${border}`, padding: '3px 4px', verticalAlign: 'middle', color: empty ? mutedCol : 'inherit' });

const EMPTY_PORT = { port_name: '', status_ld: '', shipper: '', port_entity: '', qty: '', l_cargo: '', status_oc: '', laycan: '', cr: '', eta: '', eta_time: '', etb: '', etb_time: '', etc: '', etc_time: '' };

function AddEntryModal({ options, onClose, onSubmit, submitting, isDark }) {
  const [vessel, setVessel] = useState({ charterer: '', entity: '', vessel: '', voyage: '', imo: '', mmsi: '', status: 'OPEN', ops: '', demm_rate: '', laytime_rate: '', laytime_starts: '', remarks: '', nominated: false });
  const [ports, setPorts] = useState(() => Array.from({ length: 10 }, () => ({ ...EMPTY_PORT })));
  const [openPort, setOpenPort] = useState(0);

  const bg = isDark ? '#0f172a' : '#fff';
  const cardBg = isDark ? '#1e293b' : '#fff';
  const textCol = isDark ? '#e2e8f0' : '#1f2933';
  const mutedCol = isDark ? '#94a3b8' : '#7b8794';
  const borderCol = isDark ? '#334155' : '#e4e7eb';
  const inputBg = isDark ? '#0f172a' : '#fff';
  const inputBorder = isDark ? '#475569' : '#cbd2d9';

  const setV = (k, val) => setVessel(s => ({ ...s, [k]: val }));
  const setP = (i, k, val) => setPorts(arr => arr.map((p, idx) => {
    if (idx !== i) return p;
    const next = { ...p, [k]: val };
    if (k === 'status_ld' && val === 'Load') {
      next.eta_time = cleanTime(next.eta_time) || '00:00';
      next.etb_time = cleanTime(next.etb_time) || '00:00';
      next.etc_time = cleanTime(next.etc_time) || '00:00';
    }
    return next;
  }));

  const submit = () => {
    if (!vessel.vessel.trim()) { alert('Vessel name is required'); return; }
    // Only send ports that have any data
    const filledPorts = ports.map(p => {
      const any = Object.values(p).some(v => v != null && v !== '');
      return any ? p : null;
    });
    onSubmit({ vessel, ports: filledPorts.map(p => p || {}) });
  };

  const portHasData = (p) => Object.values(p).some(v => v != null && v !== '');

  const inp = { width: '100%', padding: '6px 8px', border: `1px solid ${inputBorder}`, borderRadius: 5, fontSize: 12, background: inputBg, color: textCol };
  const lab = { display: 'block', fontSize: 10, color: mutedCol, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.3 };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1050, padding: 16 }}>
      <div style={{ background: cardBg, color: textCol, borderRadius: 10, width: '100%', maxWidth: 920, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 48px rgba(0,0,0,0.4)' }}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${borderCol}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Add Vessel Entry</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: mutedCol, fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', flex: 1 }}>
          {/* Vessel fields */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px 12px', marginBottom: 16 }}>
            <div><label style={lab}>Charterer</label>
              <select value={vessel.charterer} onChange={e => setV('charterer', e.target.value)} style={inp}>
                <option value=""></option>
                {(options?.charterers || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div><label style={lab}>Entity</label>
              <select value={vessel.entity} onChange={e => setV('entity', e.target.value)} style={inp}>
                <option value=""></option>
                {ENTITY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div><label style={lab}>Vessel *</label><input value={vessel.vessel} onChange={e => setV('vessel', e.target.value)} style={inp} placeholder="e.g. MT EXAMPLE" /></div>
            <div><label style={lab}>Voyage</label><input value={vessel.voyage} onChange={e => setV('voyage', e.target.value)} style={inp} /></div>
            <div><label style={lab}>Status</label>
              <select value={vessel.status} onChange={e => setV('status', e.target.value)} style={inp}>
                <option value=""></option>
                <option value="OPEN">OPEN</option>
                <option value="CLOSED">CLOSED</option>
              </select>
            </div>
            <div><label style={lab}>IMO</label><input value={vessel.imo} onChange={e => setV('imo', e.target.value)} style={inp} /></div>
            <div><label style={lab}>MMSI</label><input value={vessel.mmsi} onChange={e => setV('mmsi', e.target.value)} style={inp} /></div>
            <div><label style={lab}>Ops</label>
              <select value={vessel.ops} onChange={e => setV('ops', e.target.value)} style={inp}>
                <option value=""></option>
                {OPS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div><label style={lab}>Demm Rate</label><input type="number" value={vessel.demm_rate} onChange={e => setV('demm_rate', e.target.value)} style={inp} placeholder="e.g. 5000" /></div>
            <div><label style={lab}>Laytime Rate</label><input type="number" value={vessel.laytime_rate} onChange={e => setV('laytime_rate', e.target.value)} style={inp} placeholder="e.g. 5000" /></div>
            <div><label style={lab}>Laytime Starts</label>
              <select value={vessel.laytime_starts} onChange={e => setV('laytime_starts', e.target.value)} style={inp}>
                <option value=""></option>
                {LAYTIME_START_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div><label style={lab}>Nominated</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 31, padding: '6px 8px', border: `1px solid ${inputBorder}`, borderRadius: 5, background: inputBg, color: textCol, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!vessel.nominated}
                  onChange={e => setV('nominated', e.target.checked)}
                  style={{ width: 14, height: 14, margin: 0 }}
                />
                <span style={{ fontSize: 12, fontWeight: 600 }}>{vessel.nominated ? 'TRUE' : 'FALSE'}</span>
              </label>
            </div>
            <div style={{ gridColumn: 'span 3' }}><label style={lab}>Remarks</label><input value={vessel.remarks} onChange={e => setV('remarks', e.target.value)} style={inp} /></div>
          </div>

          {/* Port tabs */}
          <div style={{ fontSize: 11, color: mutedCol, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Ports (fill what's known — leave the rest blank)</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
            {ports.map((p, i) => {
              const filled = portHasData(p);
              const active = openPort === i;
              return (
                <button key={i} type="button" onClick={() => setOpenPort(i)} style={{
                  padding: '5px 12px', fontSize: 12, borderRadius: 5,
                  border: `1px solid ${active ? '#2563eb' : inputBorder}`,
                  background: active ? '#2563eb' : (filled ? (isDark ? '#1e3a5f' : '#dbeafe') : inputBg),
                  color: active ? '#fff' : (filled ? (isDark ? '#bfdbfe' : '#1e40af') : textCol),
                  cursor: 'pointer', fontWeight: filled ? 600 : 400,
                }}>Port {i + 1}{filled ? ' ●' : ''}</button>
              );
            })}
          </div>

          {ports[openPort] && (
            <div style={{ border: `1px solid ${borderCol}`, borderRadius: 6, padding: 14, background: isDark ? '#0f172a' : '#fafbfc' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px 12px' }}>
                <div><label style={lab}>Port</label>
                  <select value={ports[openPort].port_name} onChange={e => setP(openPort, 'port_name', e.target.value)} style={inp}>
                    <option value=""></option>
                    {(options?.abvPorts || []).map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div><label style={lab}>L/D</label>
                  <select value={ports[openPort].status_ld} onChange={e => setP(openPort, 'status_ld', e.target.value)} style={inp}>
                    <option value=""></option>
                    <option value="Load">Load</option>
                    <option value="Discharge">Discharge</option>
                  </select>
                </div>
                <div><label style={lab}>Shipper</label>
                  <select value={ports[openPort].shipper} onChange={e => setP(openPort, 'shipper', e.target.value)} style={inp}>
                    <option value=""></option>
                    {SHIPPER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div><label style={lab}>Entity</label>
                  <select value={ports[openPort].port_entity} onChange={e => setP(openPort, 'port_entity', e.target.value)} style={inp}>
                    <option value=""></option>
                    {(options?.entities?.length ? options.entities : ENTITY_OPTIONS).map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div><label style={lab}>Qty</label><input type="number" value={ports[openPort].qty} onChange={e => setP(openPort, 'qty', e.target.value)} style={inp} /></div>
                <div><label style={lab}>L.Cargo</label>
                  <select value={ports[openPort].l_cargo} onChange={e => setP(openPort, 'l_cargo', e.target.value)} style={inp}>
                    <option value=""></option>
                    {(options?.abvCargoes || []).map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div><label style={lab}>Open/Closed</label>
                  <select value={ports[openPort].status_oc} onChange={e => setP(openPort, 'status_oc', e.target.value)} style={inp}>
                    <option value=""></option>
                    <option value="OPEN">OPEN</option>
                    <option value="CLOSED">CLOSED</option>
                  </select>
                </div>
                <div><label style={lab}>Laycan</label><input value={ports[openPort].laycan} onChange={e => setP(openPort, 'laycan', e.target.value)} style={inp} placeholder="e.g. 20 JUN - 26 JUN" /></div>
                <div><label style={lab}>CR</label><input type="date" value={ports[openPort].cr} onChange={e => setP(openPort, 'cr', e.target.value)} style={inp} /></div>
                <AddDateTimeField label="ETA" dateValue={ports[openPort].eta} timeValue={ports[openPort].eta_time} canEditTime={ports[openPort].status_ld === 'Load'} onDateChange={v => setP(openPort, 'eta', v)} onTimeChange={v => setP(openPort, 'eta_time', v)} inp={inp} lab={lab} inputBg={inputBg} inputBorder={inputBorder} textCol={textCol} mutedCol={mutedCol} />
                <AddDateTimeField label="ETB" dateValue={ports[openPort].etb} timeValue={ports[openPort].etb_time} canEditTime={ports[openPort].status_ld === 'Load'} onDateChange={v => setP(openPort, 'etb', v)} onTimeChange={v => setP(openPort, 'etb_time', v)} inp={inp} lab={lab} inputBg={inputBg} inputBorder={inputBorder} textCol={textCol} mutedCol={mutedCol} />
                <AddDateTimeField label="ETC" dateValue={ports[openPort].etc} timeValue={ports[openPort].etc_time} canEditTime={ports[openPort].status_ld === 'Load'} onDateChange={v => setP(openPort, 'etc', v)} onTimeChange={v => setP(openPort, 'etc_time', v)} inp={inp} lab={lab} inputBg={inputBg} inputBorder={inputBorder} textCol={textCol} mutedCol={mutedCol} />
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: `1px solid ${borderCol}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} disabled={submitting} style={lightBtn(inputBg, inputBorder, textCol)}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={{ ...primaryBtn, background: '#16a34a' }}>{submitting ? 'Saving…' : 'Add Entry'}</button>
        </div>
      </div>
    </div>
  );
}

function AddDateTimeField({ label, dateValue, timeValue, canEditTime, onDateChange, onTimeChange, inp, lab, inputBg, inputBorder, textCol, mutedCol }) {
  return (
    <div>
      <label style={lab}>{label}</label>
      <div style={{ display: 'grid', gap: 5 }}>
        <input type="date" value={dateValue} onChange={e => onDateChange(e.target.value)} style={inp} />
        <TimeCell
          value={canEditTime ? (cleanTime(timeValue) || '00:00') : cleanTime(timeValue)}
          disabled={!canEditTime}
          onChange={onTimeChange}
          inputBg={inputBg}
          borderCol={inputBorder}
          textCol={textCol}
          mutedCol={mutedCol}
        />
      </div>
    </div>
  );
}
