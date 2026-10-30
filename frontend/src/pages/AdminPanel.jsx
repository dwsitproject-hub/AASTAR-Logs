import React, { useEffect, useState } from 'react';
import api from '../services/api';
import { trackHubAction } from '../services/hubSdk';
import { useAuth } from '../context/AuthContext';
import { DEPARTMENTS, DEPT_LABELS, deptOf } from '../navConfig';

const ALL_DEPTS = DEPARTMENTS.map(d => d.dept);
// Departments granted whole (no sub-tabs) vs. per-sub-tab.
const NO_SUBTAB_DEPTS = DEPARTMENTS.filter(d => d.tabs.length === 0).map(d => d.dept);
const SUBTAB_DEPT_DEFS = DEPARTMENTS.filter(d => d.tabs.length > 0);

// Human-readable access summary for the users table.
function accessSummary(u) {
  if (!u.is_approved) return 'Pending approval';
  if (u.is_admin) return 'All';
  const parts = [];
  (u.permissions || []).filter(d => NO_SUBTAB_DEPTS.includes(d)).forEach(d => parts.push(DEPT_LABELS[d]));
  SUBTAB_DEPT_DEFS.forEach(def => {
    const n = (u.tab_permissions || []).filter(p => deptOf(p) === def.dept).length;
    if (n) parts.push(`${def.label} (${n}/${def.tabs.length})`);
  });
  return parts.join(', ') || 'None';
}

function UserModal({ user, canGrantAdmin, onClose, onSave }) {
  const [email, setEmail] = useState(user?.email || '');
  const [isAdmin, setIsAdmin] = useState(user?.is_admin || false);
  const isRecoveryAccount = String(user?.email || '').trim().toLowerCase() === 'matthew.chiu@kpn-corp.com';
  const [isApproved, setIsApproved] = useState(user?.is_approved || false);
  // Whole-department grants only cover departments without sub-tabs.
  const [perms, setPerms] = useState((user?.permissions || []).filter(d => d !== 'admin' && NO_SUBTAB_DEPTS.includes(d)));
  const [tabPerms, setTabPerms] = useState(user?.tab_permissions || []);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const toggleDept = (d) => setPerms(p => p.includes(d) ? p.filter(x => x !== d) : [...p, d]);
  const toggleTab = (path) => setTabPerms(t => t.includes(path) ? t.filter(x => x !== path) : [...t, path]);
  const setDeptTabs = (def, on) => setTabPerms(t => {
    const others = t.filter(p => !def.tabs.some(tb => tb.path === p));
    return on ? [...others, ...def.tabs.map(tb => tb.path)] : others;
  });

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      const payload = {
        email,
        is_admin: isAdmin,
        is_approved: isApproved,
        permissions: isAdmin ? ALL_DEPTS : perms,
        tab_permissions: isAdmin ? [] : tabPerms,
      };
      await api.put(`/users/${user.id}`, payload);
      trackHubAction('admin_user_access_updated', { approved: isApproved, admin: isAdmin });
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const inputStyle = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, outline: 'none' };
  const chip = (active) => ({
    padding: '6px 14px', borderRadius: 20, fontSize: 13, border: '1px solid', cursor: 'pointer',
    borderColor: active ? 'var(--primary)' : 'var(--border)',
    background: active ? 'var(--primary)' : '#fff',
    color: active ? '#fff' : 'var(--text-main)', fontWeight: 500,
  });
  const identityLinked = Boolean(user?.google_linked || user?.hub_linked);
  const linkedVia = [user?.hub_linked && 'DWS Hub', user?.google_linked && 'Google'].filter(Boolean).join(' + ');
  const linkBtn = { background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12, cursor: 'pointer', padding: 0 };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 520, maxHeight: '90vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Edit User</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--text-muted)', lineHeight: 1 }}>x</button>
        </div>
        <div style={{ padding: 24 }}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Username reference</label>
            <input value={user?.username || ''} disabled style={{ ...inputStyle, background: '#f5f6f6', color: 'var(--text-muted)' }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
              Sign-in email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={identityLinked || !canGrantAdmin}
              placeholder="name@kpn-corp.com"
              style={{ ...inputStyle, background: identityLinked ? '#f5f6f6' : '#fff' }}
            />
            {identityLinked && (
              <div style={{ color: '#2f7d4a', fontSize: 11, marginTop: 5 }}>{linkedVia} account linked</div>
            )}
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
              <input type="checkbox" checked={isApproved} disabled={isRecoveryAccount} onChange={e => setIsApproved(e.target.checked)} style={{ width: 16, height: 16 }} />
              <span>Approved for ERP access</span>
            </label>
          </div>
          {canGrantAdmin && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={isAdmin}
                  disabled={isRecoveryAccount || !identityLinked}
                  title={!identityLinked ? 'DWS Hub or corporate Google sign-in required first' : undefined}
                  onChange={event => {
                    setIsAdmin(event.target.checked);
                    if (event.target.checked) setIsApproved(true);
                  }}
                  style={{ width: 16, height: 16 }}
                />
                <span>Administrator: full ERP access and user approvals</span>
              </label>
            </div>
          )}
          {!isAdmin && (
            <>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Department Access</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {NO_SUBTAB_DEPTS.filter(d => d !== 'admin').map(d => (
                    <button key={d} onClick={() => toggleDept(d)} style={chip(perms.includes(d))}>{DEPT_LABELS[d]}</button>
                  ))}
                </div>
              </div>
              {SUBTAB_DEPT_DEFS.map(def => {
                const granted = def.tabs.filter(t => tabPerms.includes(t.path)).length;
                const allOn = granted === def.tabs.length;
                return (
                  <div key={def.dept} style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <label style={{ fontSize: 13, fontWeight: 600 }}>{def.label} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {granted}/{def.tabs.length} tabs</span></label>
                      <div style={{ display: 'flex', gap: 12 }}>
                        <button onClick={() => setDeptTabs(def, true)} disabled={allOn} style={{ ...linkBtn, opacity: allOn ? 0.4 : 1 }}>Select all</button>
                        <button onClick={() => setDeptTabs(def, false)} disabled={granted === 0} style={{ ...linkBtn, opacity: granted === 0 ? 0.4 : 1 }}>Clear</button>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 10px' }}>
                      {def.tabs.map(t => (
                        <label key={t.path} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                          <input type="checkbox" checked={tabPerms.includes(t.path)} onChange={() => toggleTab(t.path)} style={{ width: 15, height: 15 }} />
                          <span>{t.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}
          {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12, background: '#fef2f2', padding: '8px 12px', borderRadius: 8, border: '1px solid #fecaca' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid var(--border)', background: '#fff', fontSize: 14 }}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: '#fff', fontSize: 14, fontWeight: 600 }}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SheetsConfig() {
  const [configs, setConfigs] = useState([]);
  const [form, setForm] = useState({ sheet_id: '', sheet_name: '', tab_name: '', department: 'commercial', service_account_index: 0, range: '' });
  const [msg, setMsg] = useState(null);

  const load = () => api.get('/sheets/config').then(r => setConfigs(r.data)).catch(() => {});
  useEffect(() => { load(); }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    try {
      await api.post('/sheets/config', form);
      setMsg({ type: 'success', text: 'Sheet added' });
      setForm({ sheet_id: '', sheet_name: '', tab_name: '', department: 'commercial', service_account_index: 0, range: '' });
      load();
    } catch (err) { setMsg({ type: 'error', text: err.response?.data?.error || 'Failed' }); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Remove this sheet config?')) return;
    await api.delete('/sheets/config/' + id);
    load();
  };

  const handleRefresh = async () => {
    await api.post('/sheets/refresh');
    setMsg({ type: 'success', text: 'Cache refreshed' });
  };

  const inputStyle = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13, outline: 'none' };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>Google Sheets Configuration</h3>
        <button onClick={handleRefresh} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border)', background: '#fff', fontSize: 13 }}>Refresh Cache</button>
      </div>
      {msg && <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: msg.type === 'success' ? '#f0fdf4' : '#fef2f2', color: msg.type === 'success' ? '#16a34a' : '#dc2626', border: '1px solid ' + (msg.type === 'success' ? '#bbf7d0' : '#fecaca') }}>{msg.text}</div>}
      <form onSubmit={handleAdd} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 20, background: '#f9fafb', padding: 16, borderRadius: 10, border: '1px solid var(--border)' }}>
        <div><label style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: 'block' }}>Sheet ID</label><input required value={form.sheet_id} onChange={e => setForm(f => ({ ...f, sheet_id: e.target.value }))} placeholder="Google Sheet ID" style={inputStyle} /></div>
        <div><label style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: 'block' }}>Sheet Name</label><input required value={form.sheet_name} onChange={e => setForm(f => ({ ...f, sheet_name: e.target.value }))} placeholder="Display name" style={inputStyle} /></div>
        <div><label style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: 'block' }}>Tab Name</label><input required value={form.tab_name} onChange={e => setForm(f => ({ ...f, tab_name: e.target.value }))} placeholder="Sheet1" style={inputStyle} /></div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: 'block' }}>Department</label>
          <select value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} style={inputStyle}>
            {ALL_DEPTS.map(d => <option key={d} value={d}>{DEPT_LABELS[d]}</option>)}
          </select>
        </div>
        <div><label style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: 'block' }}>Service Account #</label><input type="number" min="0" max="7" value={form.service_account_index} onChange={e => setForm(f => ({ ...f, service_account_index: parseInt(e.target.value) }))} style={inputStyle} /></div>
        <div><label style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: 'block' }}>Range (optional)</label><input value={form.range} onChange={e => setForm(f => ({ ...f, range: e.target.value }))} placeholder="e.g. A:Z" style={inputStyle} /></div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}><button type="submit" style={{ width: '100%', padding: '8px', borderRadius: 6, background: 'var(--primary)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600 }}>+ Add Sheet</button></div>
      </form>
      {configs.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>No sheets configured yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ background: '#f9fafb' }}>
            {['Sheet Name', 'Tab', 'Range', 'Department', 'SA #', ''].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {configs.map(c => (
              <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '9px 12px' }}>{c.sheet_name}</td>
                <td style={{ padding: '9px 12px', color: 'var(--text-muted)' }}>{c.tab_name}</td>
                <td style={{ padding: '9px 12px', color: 'var(--text-muted)', fontSize: 12 }}>{c.range || '—'}</td>
                <td style={{ padding: '9px 12px' }}>{DEPT_LABELS[c.department]}</td>
                <td style={{ padding: '9px 12px' }}>{c.service_account_index}</td>
                <td style={{ padding: '9px 12px' }}><button onClick={() => handleDelete(c.id)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', fontSize: 12 }}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function IpSecurity() {
  const [blocked, setBlocked] = useState([]);
  const [allowlisted, setAllowlisted] = useState([]);
  const [currentIp, setCurrentIp] = useState('');
  const [ipAddress, setIpAddress] = useState('');
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const load = () => {
    setLoading(true);
    api.get('/auth/security/ip-rules')
      .then(response => {
        setBlocked(response.data?.blocked || []);
        setAllowlisted(response.data?.allowlisted || []);
        setCurrentIp(response.data?.current_ip || '');
      })
      .catch(error => setMessage(error.response?.data?.error || 'IP security rules could not be loaded'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const unlock = async (ipAddress) => {
    if (!window.confirm(`Unlock ${ipAddress}?`)) return;
    setMessage('');
    try {
      await api.post('/auth/security/unlock', { ip_address: ipAddress });
      setMessage(`${ipAddress} unlocked`);
      load();
    } catch (error) {
      setMessage(error.response?.data?.error || 'IP address could not be unlocked');
    }
  };

  const addAllowlist = async () => {
    setMessage('');
    try {
      await api.post('/auth/security/allowlist', { ip_address: ipAddress, label });
      setMessage(`${ipAddress} whitelisted`);
      setIpAddress('');
      setLabel('');
      load();
    } catch (error) {
      setMessage(error.response?.data?.error || 'IP address could not be whitelisted');
    }
  };

  const removeAllowlist = async (ip) => {
    if (!window.confirm(`Remove ${ip} from the whitelist?`)) return;
    setMessage('');
    try {
      await api.post('/auth/security/allowlist/remove', { ip_address: ip });
      setMessage(`${ip} removed from whitelist`);
      load();
    } catch (error) {
      setMessage(error.response?.data?.error || 'IP address could not be removed');
    }
  };

  const formatDate = value => value ? new Date(value).toLocaleString() : '-';
  const inputStyle = { padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 };

  return (
    <div>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600 }}>IP Security</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 3 }}>Whitelisted IPs remain audited but are exempt from login limits and automatic blocking.</p>
        </div>
        <button onClick={load} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 12 }}>Refresh</button>
      </div>
      {message && <div style={{ margin: '14px 20px 0', padding: '9px 12px', background: '#f4f7f5', border: '1px solid var(--border)', fontSize: 12 }}>{message}</div>}
      {loading ? (
        <div style={{ padding: 28, color: 'var(--text-muted)', textAlign: 'center' }}>Loading IP security rules...</div>
      ) : (
        <>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Whitelist an IP Address</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <input value={ipAddress} onChange={event => setIpAddress(event.target.value)} placeholder="IPv4 or IPv6 address" style={{ ...inputStyle, width: 190 }} />
              <input value={label} onChange={event => setLabel(event.target.value)} placeholder="Label (optional)" style={{ ...inputStyle, width: 220 }} />
              <button onClick={addAllowlist} disabled={!ipAddress.trim()} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #aac7b1', background: '#f0f8f2', color: '#25683a', fontSize: 12 }}>Add IP</button>
              {currentIp && <button onClick={() => setIpAddress(currentIp)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 12 }}>Use current IP: {currentIp}</button>}
            </div>
          </div>

          <div style={{ padding: '14px 20px 8px', fontSize: 13, fontWeight: 600 }}>Whitelisted IP Addresses</div>
          {allowlisted.length === 0 ? (
            <div style={{ padding: '18px 20px', color: 'var(--text-muted)', fontSize: 12, borderBottom: '1px solid var(--border)' }}>No IP addresses are whitelisted.</div>
          ) : <div style={{ overflowX: 'auto', borderBottom: '1px solid var(--border)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 700 }}>
              <thead><tr style={{ background: '#f9fafb' }}>
                {['IP Address', 'Label', 'Added', 'Added by', ''].map(header => <th key={header} style={{ padding: '10px 14px', textAlign: 'left', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 600 }}>{header}</th>)}
              </tr></thead>
              <tbody>{allowlisted.map(row => <tr key={row.ip_address} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '11px 14px', fontFamily: 'Consolas, monospace', fontWeight: 600 }}>{row.ip_address}</td>
                <td style={{ padding: '11px 14px' }}>{row.label || '-'}</td>
                <td style={{ padding: '11px 14px', color: 'var(--text-muted)' }}>{formatDate(row.created_at)}</td>
                <td style={{ padding: '11px 14px' }}>{row.created_by}</td>
                <td style={{ padding: '11px 14px' }}><button onClick={() => removeAllowlist(row.ip_address)} style={{ padding: '6px 12px', border: '1px solid #fecaca', background: '#fef2f2', color: '#b42318', borderRadius: 6, fontSize: 12 }}>Remove</button></td>
              </tr>)}</tbody>
            </table>
          </div>}

          <div style={{ padding: '14px 20px 8px', fontSize: 13, fontWeight: 600 }}>Blocked IP Addresses</div>
          {blocked.length === 0 ? (
            <div style={{ padding: '18px 20px', color: 'var(--text-muted)', fontSize: 12 }}>No IP addresses are currently blocked.</div>
          ) : <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 820 }}>
            <thead><tr style={{ background: '#f9fafb' }}>
              {['IP Address', 'Attempts', 'Last username', 'Last failure', 'Blocked', 'Reason', ''].map(header => (
                <th key={header} style={{ padding: '10px 14px', textAlign: 'left', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontWeight: 600 }}>{header}</th>
              ))}
            </tr></thead>
            <tbody>
              {blocked.map(row => (
                <tr key={row.ip_address} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '11px 14px', fontFamily: 'Consolas, monospace', fontWeight: 600 }}>{row.ip_address}</td>
                  <td style={{ padding: '11px 14px' }}>{row.failed_attempts}</td>
                  <td style={{ padding: '11px 14px' }}>{row.last_username || '-'}</td>
                  <td style={{ padding: '11px 14px', color: 'var(--text-muted)' }}>{formatDate(row.last_failed_at)}</td>
                  <td style={{ padding: '11px 14px', color: 'var(--text-muted)' }}>{formatDate(row.blocked_at)}</td>
                  <td style={{ padding: '11px 14px', color: 'var(--text-muted)' }}>{row.blocked_reason || '-'}</td>
                  <td style={{ padding: '11px 14px' }}>
                    <button onClick={() => unlock(row.ip_address)} style={{ padding: '6px 12px', border: '1px solid #aac7b1', background: '#f0f8f2', color: '#25683a', borderRadius: 6, fontSize: 12 }}>Unlock</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>}
        </>
      )}
    </div>
  );
}

export default function AdminPanel() {
  const { user } = useAuth();
  const isOwner = String(user?.email || '').toLowerCase() === 'matthew.chiu@kpn-corp.com';
  const canManageUsers = Boolean(user?.is_admin);
  const canEditUser = target => canManageUsers && (isOwner || (!target.is_admin && String(target.email || '').toLowerCase() !== 'matthew.chiu@kpn-corp.com'));
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(null);
  const [tab, setTab] = useState('users');

  const loadUsers = () => api.get('/users').then(r => setUsers(r.data)).catch(() => {});
  useEffect(() => { loadUsers(); }, []);

  const handleDelete = async (id) => {
    if (!isOwner) return;
    if (!window.confirm('Delete this user?')) return;
    await api.delete('/users/' + id);
    loadUsers();
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {['users', 'sheets', ...(isOwner ? ['security'] : [])].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', borderRadius: 20, fontSize: 13, fontWeight: 500,
            border: '1px solid', borderColor: tab === t ? 'var(--primary)' : 'var(--border)',
            background: tab === t ? 'var(--primary)' : '#fff',
            color: tab === t ? '#fff' : 'var(--text-main)'
          }}>{t === 'users' ? 'User Management' : t === 'sheets' ? 'Sheets Config' : 'IP Security'}</button>
        ))}
      </div>
      <div style={{ background: '#fff', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
        {tab === 'users' ? (
          <>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: 15, fontWeight: 600 }}>Users</h3>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ background: '#f9fafb' }}>
                {['Username', 'Sign-in Email', 'Status', 'Role', 'Access', 'Created', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '10px 16px', fontWeight: 500 }}>{u.username}</td>
                    <td style={{ padding: '10px 16px', color: 'var(--text-muted)', fontSize: 12 }}>
                      {u.email || '-'}{u.hub_linked || u.google_linked ? ' (linked)' : ''}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ background: u.is_approved ? '#edf7ef' : '#fff7e6', color: u.is_approved ? '#25683a' : '#9a5b00', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>
                        {u.is_approved ? 'APPROVED' : 'PENDING'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {u.is_admin
                        ? <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>ADMIN</span>
                        : <span style={{ background: '#eff6ff', color: '#1d4ed8', padding: '2px 8px', borderRadius: 10, fontSize: 11 }}>User</span>}
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--text-muted)', fontSize: 12 }}>
                      {accessSummary(u)}
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--text-muted)', fontSize: 12 }}>
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        {canEditUser(u) && <button onClick={() => setModal(u)} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 12 }}>Edit</button>}
                        {isOwner && u.id !== user?.id && String(u.email || '').toLowerCase() !== 'matthew.chiu@kpn-corp.com' && <button onClick={() => handleDelete(u.id)} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', fontSize: 12 }}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : tab === 'sheets' ? (
          <div style={{ padding: 24 }}><SheetsConfig /></div>
        ) : (
          <IpSecurity />
        )}
      </div>
      {modal !== null && (
        <UserModal
          user={modal?.id ? modal : null}
          canGrantAdmin={isOwner}
          onClose={() => setModal(null)}
          onSave={() => { setModal(null); loadUsers(); }}
        />
      )}
    </div>
  );
}
