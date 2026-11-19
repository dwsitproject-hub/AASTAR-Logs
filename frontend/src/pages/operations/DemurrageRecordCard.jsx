import React from 'react';

function valueOrDash(value) {
  const text = value == null ? '' : String(value).trim();
  return text || '-';
}

function joined(values) {
  return values?.filter(Boolean).join(', ') || '-';
}

function Detail({ label, value }) {
  return (
    <div className="demm-detail">
      <dt>{label}</dt>
      <dd>{valueOrDash(value)}</dd>
    </div>
  );
}

function PortSchedule({ ports }) {
  if (!ports.length) return <p className="demm-no-ports">No port calls recorded.</p>;
  return (
    <div className="demm-port-scroll">
      <table className="demm-port-table">
        <thead>
          <tr><th>Rot.</th><th>L / D</th><th>Port</th><th>Shipper</th><th>Cargo / Qty</th><th>Port Status</th><th>Laycan</th><th>CR</th><th>ETA</th><th>ETB</th><th>ETC</th></tr>
        </thead>
        <tbody>
          {ports.map(port => (
            <tr key={`${port.rotation}-${port.port}-${port.type}`}>
              <td>{port.rotation}</td>
              <td><span className={`demm-port-type is-${port.type.toLowerCase()}`}>{valueOrDash(port.type)}</span></td>
              <td className="demm-port-name">{valueOrDash(port.port)}</td>
              <td>{valueOrDash(port.shipper)}</td>
              <td>{[port.quantity, port.cargo].filter(Boolean).join(' ') || '-'}</td>
              <td>{valueOrDash(port.status)}</td>
              <td>{valueOrDash(port.laycan)}</td>
              <td>{valueOrDash(port.cr)}</td>
              <td>{valueOrDash(port.eta)}</td>
              <td>{valueOrDash(port.etb)}</td>
              <td>{valueOrDash(port.etc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DemurrageRecordCard({ record, editor, saveState, onChange, onStatusChange, onShowChange, onNilChange, onSave }) {
  const dirty = editor.value !== editor.baseline
    || editor.status !== editor.statusBaseline
    || editor.show !== editor.showBaseline
    || editor.nil !== editor.nilBaseline;
  const statusClass = String(record.status || '').toLowerCase() === 'open' ? 'is-open' : 'is-closed';

  return (
    <article className="demm-card">
      <header className="demm-card-header">
        <div className="demm-card-title">
          <div>
            <h2>{record.vessel}</h2>
            <span>{record.vslId}</span>
          </div>
          <span className={`demm-status ${statusClass}`}>{valueOrDash(record.status)}</span>
        </div>
        <div className="demm-card-tags">
          {record.entity ? <span>{record.entity}</span> : null}
          {record.charterer ? <span>{record.charterer}</span> : null}
          {record.nominated ? <span>Nominated</span> : null}
        </div>
      </header>

      <dl className="demm-details">
        <Detail label="Voyage" value={record.voyage} />
        <Detail label="Loadport" value={joined(record.loadports)} />
        <Detail label="Cargo" value={joined(record.cargos)} />
        <Detail label="Shipper" value={joined(record.shippers)} />
        <Detail label="Demm Rate PDPR" value={record.demurrageRate} />
        <Detail label="Load Rate" value={record.laytimeRate} />
        <Detail label="Laytime Starts" value={record.laytimeStarts} />
        <Detail label="Est Demm" value={record.estimatedDemurrage} />
        <Detail label="Ops" value={record.ops} />
        <Detail label="Remarks" value={record.remarks} />
      </dl>

      <PortSchedule ports={record.ports} />

      <div className="demm-editor">
        <div className="demm-editor-heading">
          <label htmlFor={`demm-record-${record.row}`}>Demurrage record</label>
          <div className="demm-editor-checks">
            <label className="demm-settled-control">
              <input
                type="checkbox"
                checked={editor.show}
                onChange={event => onShowChange(event.target.checked)}
              />
              <span>Show Demurrage</span>
            </label>
            <label className="demm-settled-control">
              <input
                type="checkbox"
                checked={editor.status}
                onChange={event => onStatusChange(event.target.checked)}
              />
              <span>Settled</span>
            </label>
            <label className="demm-settled-control">
              <input
                type="checkbox"
                checked={editor.nil}
                onChange={event => onNilChange(event.target.checked)}
              />
              <span>Nil Demurrage</span>
            </label>
          </div>
        </div>
        <textarea
          id={`demm-record-${record.row}`}
          value={editor.value}
          maxLength={20000}
          onChange={event => onChange(event.target.value)}
          placeholder="Record notices, calculations, claims, supporting documents and follow-up here."
        />
        <div className="demm-editor-footer">
          <div aria-live="polite">
            {saveState.error ? <span className="demm-save-error">{saveState.error}</span> : null}
            {!saveState.error && saveState.saved ? <span className="demm-save-success">Saved to Vessel DB</span> : null}
            {!saveState.error && !saveState.saved && dirty ? <span>Unsaved changes</span> : null}
          </div>
          <button type="button" onClick={onSave} disabled={!dirty || saveState.saving}>
            {saveState.saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </article>
  );
}
