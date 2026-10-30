// Shared VESSEL DB editing primitives — column maps, option lists, and the cell
// editor components used by the Vessels Updates and ETA Updates survey pages.
// These mirror the field/column conventions in VesselUpdate.jsx (left untouched
// on purpose — it's live production). All three write via the same generic
// POST /sheets/vessel-update/save endpoint (row/col cell updates, row-shift safe).
import React, { useEffect, useRef, useState } from 'react';

export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// 0-based sheet columns. Port blocks start at 20, stride 16.
export const PORT_COL_BASE = 20, PORT_COL_STRIDE = 16;
export const PORT_FIELD_COL = { port_name:0, status_ld:1, shipper:2, qty:4, l_cargo:5, status_oc:6, laycan:7, cr:8, eta:9, eta_time:10, etb:11, etb_time:12, etc:13, etc_time:14 };
export const PORT_FIELD_ORDER = ['status_ld','port_name','shipper','qty','l_cargo','status_oc','laycan','cr'];
export const DATE_TIME_FIELDS = [['eta','eta_time'], ['etb','etb_time'], ['etc','etc_time']];
export const PORT_HEADERS = ["#","vsl ID","L/D","Port","Shipper","Qty","Cargo","Open/Closed","Laycan","CR","ETA","ETB","ETC"];

// Vessel-level columns: [field, sheetCol, editorKind]
export const VESSEL_COLS = [
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
export const NOMINATED_COL = 18;
export const STATUS_COL = 9; // vessel-level OPEN/CLOSED

export const OPS_OPTIONS = ['Pending Vsl','Pending Acceptance','Pending Fixture','Pending Nom','Pending SI','Done','Pending LC','Pending Payment','Pending Tender','Pending SD','Pending Arrival','Pending Sales'];
export const SHIPPER_OPTIONS = ['3P','PMC','SPC','EUP','TPG','GLM','JPN','Disch'];
export const ENTITY_OPTIONS = ['A*','A*JV','GR','JPN','3P'];
export const LAYTIME_START_OPTIONS = ['NOR +6', 'All Fast', 'Laycan NOR+6', 'Laycan All Fast'];

export const isoToDDMmm = (iso) => {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${parseInt(m[3])} ${MONTHS[parseInt(m[2]) - 1]}`;
};

export const cleanTime = (value) => {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

export const portTdStyle = (border, empty, mutedCol) => ({ border: `1px solid ${border}`, padding: '3px 4px', verticalAlign: 'middle', color: empty ? mutedCol : 'inherit' });

// Vessel-level field editor (entity/vessel/imo/mmsi/status/ops/rates/remarks/nominated).
export function FieldCell({ label, value, kind, onChange, inputBg, borderCol, textCol, mutedCol }) {
  const normalizedValue = kind === 'checkbox' ? !!value : (value || '');
  const [val, setVal] = useState(normalizedValue);
  useEffect(() => setVal(kind === 'checkbox' ? !!value : (value || '')), [value, kind]);
  const handle = (v) => { setVal(v); onChange(v); };
  const inp = { width: '100%', padding: '5px 7px', border: `1px solid ${borderCol}`, borderRadius: 5, fontSize: 12, background: inputBg, color: textCol };
  const lab = { display: 'block', fontSize: 10, color: mutedCol, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.3 };

  let editor;
  if (kind === 'sel') {
    const list = label === 'entity' ? ENTITY_OPTIONS : label === 'ops' ? OPS_OPTIONS : [];
    editor = (
      <select value={val} onChange={e => handle(e.target.value)} style={inp}>
        <option value=""></option>
        {(list || []).map(o => <option key={o} value={o}>{o}</option>)}
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
        <input type="checkbox" checked={checked} onChange={e => handle(e.target.checked ? 'TRUE' : 'FALSE')} style={{ width: 14, height: 14, margin: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{checked ? 'TRUE' : 'FALSE'}</span>
      </label>
    );
  } else {
    editor = <input type={kind === 'num' ? 'number' : 'text'} value={val} onChange={e => handle(e.target.value)} style={inp} />;
  }
  return <div><label style={lab}>{label}</label>{editor}</div>;
}

// Per-port field editor (dropdowns for port/shipper/cargo/status, hidden-native date picker for date fields).
export function PortCellInput({ field, port, kind, options, onChange, inputBg, borderCol, textCol }) {
  const hiddenRef = useRef(null);
  const [val, setVal] = useState(kind === 'date' ? (port[field + '_display'] || '') : (port[field] || ''));
  const [iso, setIso] = useState(kind === 'date' ? (port[field + '_iso'] || '') : '');
  useEffect(() => {
    setVal(kind === 'date' ? (port[field + '_display'] || '') : (port[field] || ''));
    setIso(kind === 'date' ? (port[field + '_iso'] || '') : '');
  }, [port, field, kind]);

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
  if (field === 'port_name' || field === 'shipper' || field === 'l_cargo') {
    let list;
    if (field === 'port_name') list = options?.abvPorts?.length ? options.abvPorts : options?.ports;
    else if (field === 'shipper') list = SHIPPER_OPTIONS;
    else list = options?.abvCargoes?.length ? options.abvCargoes : options?.cargos;
    return (
      <select value={val} onChange={e => { setVal(e.target.value); onChange(e.target.value); }} style={inp}>
        <option value=""></option>
        {(list || []).map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (kind === 'date') {
    return (
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 2 }}>
        <input value={val} readOnly style={{ ...inp, flex: 1 }} placeholder="—" />
        <button type="button"
          onClick={() => {
            const el = hiddenRef.current;
            if (!el) return;
            if (typeof el.showPicker === 'function') { try { el.showPicker(); } catch { el.click(); } }
            else el.click();
          }}
          style={{ padding: '2px 5px', fontSize: 11, background: '#64748b', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}
          title="Pick a date">📅</button>
        <input ref={hiddenRef} type="date" value={iso}
          onChange={e => { const newIso = e.target.value; setIso(newIso); setVal(isoToDDMmm(newIso)); onChange(newIso, true); }}
          style={{ position: 'absolute', opacity: 0, width: 1, height: 1, pointerEvents: 'none' }} />
      </div>
    );
  }
  return <input type={kind === 'num' ? 'number' : 'text'} value={val} onChange={e => { setVal(e.target.value); onChange(e.target.value); }} style={inp} />;
}

// Stacked date + time editor for ETA/ETB/ETC. Time is only editable for Load ports (mirrors VesselUpdate).
export function DateTimePortCell({ dateField, timeField, port, canEditTime, options, onDateChange, onTimeChange, inputBg, borderCol, textCol, mutedCol }) {
  const rawTime = port[timeField] || '';
  const displayTime = canEditTime ? (cleanTime(rawTime) || '00:00') : cleanTime(rawTime);
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <PortCellInput field={dateField} port={port} kind="date" options={options} onChange={onDateChange}
        inputBg={inputBg} borderCol={borderCol} textCol={textCol} />
      <TimeCell value={displayTime} disabled={!canEditTime} onChange={onTimeChange}
        inputBg={inputBg} borderCol={borderCol} textCol={textCol} mutedCol={mutedCol} />
    </div>
  );
}

export function TimeCell({ value, disabled = false, onChange, inputBg, borderCol, textCol, mutedCol }) {
  const [val, setVal] = useState(cleanTime(value) || '00:00');
  useEffect(() => setVal(cleanTime(value) || '00:00'), [value]);
  const style = {
    width: '100%', height: 24, boxSizing: 'border-box', padding: '3px 5px',
    border: disabled ? '1px solid transparent' : `1px solid ${borderCol}`, borderRadius: 4,
    fontSize: 11, lineHeight: '16px', textAlign: 'center',
    background: disabled ? 'transparent' : inputBg, color: disabled ? mutedCol : textCol, opacity: 1,
  };
  return (
    <input type="time" step="60" value={val} disabled={disabled}
      onChange={e => { const next = cleanTime(e.target.value) || '00:00'; setVal(next); onChange(next); }}
      style={style} />
  );
}

// Theme color set shared by the survey pages (matches VesselUpdate's palette).
export function useEditTheme(isDark) {
  return {
    bg: isDark ? '#0f172a' : '#f4f6f8',
    cardBg: isDark ? '#1e293b' : '#fff',
    textCol: isDark ? '#e2e8f0' : '#1f2933',
    mutedCol: isDark ? '#94a3b8' : '#7b8794',
    borderCol: isDark ? '#334155' : '#e4e7eb',
    inputBg: isDark ? '#0f172a' : '#fff',
    inputBorder: isDark ? '#475569' : '#cbd2d9',
  };
}

export const topLabel = { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 };
export const topInput = (bg, br, tc) => ({ padding: '5px 7px', border: `1px solid ${br}`, borderRadius: 5, fontSize: 12, background: bg, color: tc });
export const lightBtn = (bg, br, tc) => ({ padding: '6px 10px', background: bg, color: tc, border: `1px solid ${br}`, borderRadius: 5, fontSize: 12, cursor: 'pointer' });
export const primaryBtn = { padding: '6px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, cursor: 'pointer', fontWeight: 500 };
