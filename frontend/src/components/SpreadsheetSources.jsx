import React, { useEffect, useState } from 'react';
import api from '../services/api';
import { trackHubAction } from '../services/hubSdk';

// Admin -> Sheets Config: the Google Sheets the ERP syncs. Each spreadsheet's
// link, service account and on/off switch are stored on the server; the tabs and
// column ranges are fixed in code because the pages depend on exact columns.

const sheetUrl = id => `https://docs.google.com/spreadsheets/d/${id}/edit`;
const formatTime = value => (value ? new Date(value).toLocaleString() : '—');
const FIELD_LABELS = { sheet_id: 'Spreadsheet', service_account_email: 'Service account', enabled: 'Synced' };

const cell = { padding: '8px 10px', borderBottom: '1px solid var(--border)', verticalAlign: 'top', fontSize: 12.5 };
const headCell = { ...cell, fontWeight: 600, color: 'var(--text-muted)', background: '#f9fafb', textAlign: 'left' };
const inputStyle = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13, outline: 'none' };
const buttonStyle = { padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: '#fff', fontSize: 13, cursor: 'pointer' };

function Badge({ tone, children, title }) {
  const tones = {
    green: { background: '#f0fdf4', color: '#15803d', border: '#bbf7d0' },
    amber: { background: '#fffbeb', color: '#b45309', border: '#fde68a' },
    red: { background: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
    grey: { background: '#f3f4f6', color: '#4b5563', border: '#e5e7eb' },
  }[tone];
  return (
    <span title={title} style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
      background: tones.background, color: tones.color, border: `1px solid ${tones.border}`, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function sheetStatus(sheet) {
  if (sheet.blockedByCopiesOnly) return { tone: 'red', label: 'Blocked: production spreadsheet', title: 'This environment only syncs copies' };
  if (!sheet.syncing) return { tone: 'grey', label: 'Not synced' };
  const failing = sheet.databases.filter(database => database.sync && !database.sync.ok);
  if (failing.length) return { tone: 'red', label: 'Sync error', title: failing[0].sync.error };
  if (sheet.databases.some(database => !database.sync)) return { tone: 'grey', label: 'Waiting for first sync' };
  return { tone: 'green', label: 'Syncing' };
}

function EditForm({ sheet, serviceAccounts, onSaved, onCancel }) {
  const [form, setForm] = useState({
    sheetId: sheet.sheetId,
    serviceAccountEmail: sheet.serviceAccountEmail,
    enabled: sheet.enabled,
  });
  const [busy, setBusy] = useState('');
  const [check, setCheck] = useState(null);
  const [error, setError] = useState('');
  const accounts = serviceAccounts.includes(form.serviceAccountEmail) || !form.serviceAccountEmail
    ? serviceAccounts
    : [form.serviceAccountEmail, ...serviceAccounts];

  const run = async (kind) => {
    setBusy(kind);
    setError('');
    setCheck(null);
    try {
      if (kind === 'check') {
        const response = await api.post(`/spreadsheet-sources/${sheet.key}/check`, form);
        setCheck(response.data);
      } else {
        const response = await api.put(`/spreadsheet-sources/${sheet.key}`, form);
        trackHubAction('admin_spreadsheet_source_updated', { spreadsheet: sheet.key, enabled: form.enabled });
        onSaved(response.data.spreadsheet);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'The request failed');
      if (err.response?.data?.result) setCheck(err.response.data.result);
    } finally {
      setBusy('');
    }
  };

  const changesSheet = form.enabled && form.sheetId.trim() && form.sheetId.trim() !== sheet.sheetId;
  const confirmSave = () => {
    const message = !form.enabled
      ? `Stop syncing ${sheet.label}? Its pages keep the last data they pulled.`
      : changesSheet
        ? `Point ${sheet.label} at a different spreadsheet? The ERP will read from it and ${sheet.access === 'read-write' ? 'write to it' : 'only read it'} from now on.`
        : `Save the settings for ${sheet.label}?`;
    if (window.confirm(message)) run('save');
  };

  return (
    <div style={{ marginTop: 12, padding: 14, borderRadius: 10, background: '#f9fafb', border: '1px solid var(--border)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 500 }}>
          Spreadsheet link or ID
          <input value={form.sheetId} onChange={event => setForm(f => ({ ...f, sheetId: event.target.value }))}
            placeholder="https://docs.google.com/spreadsheets/d/…" style={{ ...inputStyle, marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, fontWeight: 500 }}>
          Service account
          <select value={form.serviceAccountEmail} onChange={event => setForm(f => ({ ...f, serviceAccountEmail: event.target.value }))}
            style={{ ...inputStyle, marginTop: 4 }}>
            {!form.serviceAccountEmail && <option value="">Choose an account</option>}
            {accounts.map(email => (
              <option key={email} value={email}>{email}{serviceAccounts.includes(email) ? '' : ' (no key on server)'}</option>
            ))}
          </select>
        </label>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13 }}>
        <input type="checkbox" checked={form.enabled} onChange={event => setForm(f => ({ ...f, enabled: event.target.checked }))} />
        Sync this spreadsheet
      </label>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
        The account needs Editor access to the spreadsheet{sheet.access === 'read' ? ' (Viewer is enough: the ERP only reads it)' : ''}. Saving checks that it can open the spreadsheet and that every tab below exists.
      </p>
      {error && <div role="alert" style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }}>{error}</div>}
      {check && !error && (
        <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>
          {check.enabled ? <>Connected to “{check.title}”: every tab the ERP reads is there.</> : 'Ready to switch off.'}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" disabled={Boolean(busy) || !form.enabled} onClick={() => run('check')} style={buttonStyle}>
          {busy === 'check' ? 'Checking…' : 'Check connection'}
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={confirmSave}
          style={{ ...buttonStyle, background: 'var(--primary)', color: '#fff', border: 'none', fontWeight: 600 }}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={onCancel} style={buttonStyle}>Cancel</button>
      </div>
    </div>
  );
}

function SpreadsheetCard({ sheet, serviceAccounts, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const status = sheetStatus(sheet);

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 16, background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{sheet.label}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>{sheet.description}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {sheet.access === 'read-write'
            ? <Badge tone="amber" title="The ERP writes to some tabs of this spreadsheet">Read &amp; write</Badge>
            : <Badge tone="grey" title="The ERP never writes to this spreadsheet">Read only</Badge>}
          <Badge tone={status.tone} title={status.title}>{status.label}</Badge>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8, marginTop: 12, fontSize: 12.5 }}>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>Spreadsheet</div>
          {sheet.sheetId
            ? <a href={sheetUrl(sheet.sheetId)} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{sheet.sheetId} ↗</a>
            : <span>Not set</span>}
          {sheet.isProductionSheet && <div style={{ marginTop: 2 }}><Badge tone="amber">Production spreadsheet</Badge></div>}
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>Service account</div>
          <div style={{ wordBreak: 'break-all' }}>{sheet.serviceAccountEmail || 'Not set'}</div>
          {sheet.serviceAccountEmail && !serviceAccounts.includes(sheet.serviceAccountEmail) && (
            <div style={{ marginTop: 2 }}><Badge tone="red">No key on server</Badge></div>
          )}
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>Last changed</div>
          <div>{formatTime(sheet.updatedAt)}{sheet.updatedBy ? ` by ${sheet.updatedBy}` : ''}</div>
        </div>
      </div>

      <div style={{ overflowX: 'auto', marginTop: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>{['Database', 'Tab and columns', 'What the ERP does', 'Rows', 'Data last changed', 'Status'].map(h => <th key={h} style={headCell}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {sheet.databases.map(database => (
              <tr key={database.name}>
                <td style={{ ...cell, fontWeight: 600 }}>{database.name}</td>
                <td style={cell}>{database.tabs.map(tab => <div key={tab.tab}>{tab.tab} <span style={{ color: 'var(--text-muted)' }}>{tab.range}</span></div>)}</td>
                <td style={cell}>
                  {database.tabs.map(tab => (
                    <div key={tab.tab} style={{ marginBottom: 2 }}>
                      {tab.writes.length
                        ? <><Badge tone="amber">Reads &amp; writes</Badge> <span style={{ color: 'var(--text-muted)' }}>{tab.tab}: {tab.writes.join('; ')}</span></>
                        : <><Badge tone="grey">Reads</Badge> <span style={{ color: 'var(--text-muted)' }}>{tab.tab}</span></>}
                    </div>
                  ))}
                </td>
                <td style={cell}>{database.stored.rows ?? '—'}</td>
                <td style={cell}>
                  {formatTime(database.stored.pulledAt)}
                  {database.stored.fromSheetId && sheet.sheetId && database.stored.fromSheetId !== sheet.sheetId && (
                    <div style={{ color: '#b45309' }}>From the previous spreadsheet</div>
                  )}
                </td>
                <td style={cell}>
                  {!sheet.syncing ? <Badge tone="grey">Off</Badge>
                    : !database.sync ? <Badge tone="grey">Waiting</Badge>
                      : database.sync.ok
                        ? (database.stored.rows === 0 ? <Badge tone="amber" title="The tab has no rows">Empty</Badge> : <Badge tone="green">OK</Badge>)
                        : <Badge tone="red" title={database.sync.error}>Error</Badge>}
                  {database.sync && !database.sync.ok && sheet.syncing && (
                    <div style={{ color: '#b91c1c', marginTop: 2, maxWidth: 240 }}>{database.sync.error}</div>
                  )}
                  {database.sync && sheet.syncing && (
                    <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>Checked {new Date(database.sync.at).toLocaleTimeString()}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {!editing && <button type="button" onClick={() => setEditing(true)} style={buttonStyle}>Edit connection</button>}
        {sheet.changes.length > 0 && (
          <button type="button" onClick={() => setShowHistory(value => !value)} style={buttonStyle}>
            {showHistory ? 'Hide' : 'Show'} change history ({sheet.changes.length})
          </button>
        )}
      </div>
      {editing && (
        <EditForm sheet={sheet} serviceAccounts={serviceAccounts}
          onCancel={() => setEditing(false)}
          onSaved={updated => { setEditing(false); onSaved(updated); }} />
      )}
      {showHistory && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
          <thead><tr>{['When', 'Who', 'Setting', 'From', 'To'].map(h => <th key={h} style={headCell}>{h}</th>)}</tr></thead>
          <tbody>
            {sheet.changes.map((change, index) => (
              <tr key={index}>
                <td style={cell}>{formatTime(change.changed_at)}</td>
                <td style={cell}>{change.changed_by}</td>
                <td style={cell}>{FIELD_LABELS[change.field] || change.field}</td>
                <td style={{ ...cell, wordBreak: 'break-all' }}>{change.field === 'enabled' ? (change.old_value === '1' ? 'Yes' : 'No') : change.old_value || '—'}</td>
                <td style={{ ...cell, wordBreak: 'break-all' }}>{change.field === 'enabled' ? (change.new_value === '1' ? 'Yes' : 'No') : change.new_value || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function SpreadsheetSources() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.get('/spreadsheet-sources')
    .then(response => { setData(response.data); setError(''); })
    .catch(err => setError(err.response?.data?.error || 'The spreadsheet list could not be loaded'));

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  const replace = updated => setData(current => ({
    ...current,
    spreadsheets: current.spreadsheets.map(sheet => (sheet.key === updated.key ? updated : sheet)),
  }));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600 }}>Google Sheets</h3>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4, maxWidth: 720 }}>
            The spreadsheets the ERP copies into its own database every 15 seconds. Pages read that copy; edits made in the ERP are written to the spreadsheet first.
            You can change which spreadsheet and service account each one uses. The tabs and columns are fixed because the pages depend on them.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {data?.copiesOnly && <Badge tone="amber" title="SHEETS_COPIES_ONLY: production spreadsheets are refused here">Copies only</Badge>}
          <button type="button" onClick={load} style={buttonStyle}>Refresh</button>
        </div>
      </div>
      {error && <div role="alert" style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }}>{error}</div>}
      {!data && !error && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>}
      {data?.serviceAccounts.length === 0 && (
        <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a' }}>
          No service-account keys are installed on the server, so nothing can sync.
        </div>
      )}
      {data?.spreadsheets.map(sheet => (
        <SpreadsheetCard key={sheet.key} sheet={sheet} serviceAccounts={data.serviceAccounts} onSaved={replace} />
      ))}
    </div>
  );
}
