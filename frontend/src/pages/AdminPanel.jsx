import React, { useEffect, useState } from 'react';
import api from '../services/api';
import { trackHubAction } from '../services/hubSdk';
import { useAuth } from '../context/AuthContext';
import SpreadsheetSources from '../components/SpreadsheetSources';
import RolesPanel from '../components/RolesPanel';
import { describePages } from '../components/PageAccessEditor';

const inputStyle = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, outline: 'none' };
const smallButton = { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: '#fff', fontSize: 12, cursor: 'pointer' };

// Pages a user can open, from their role (written onto the account).
function accessSummary(u) {
  if (!u.is_approved) return 'No access until approved';
  if (u.is_admin) return 'Every page + Admin Panel';
  return describePages(u.permissions, u.tab_permissions);
}

// Add a user (before their first sign-in) or edit one. Their pages come from the role.
function UserModal({ user, roles, currentUserId, onClose, onSave }) {
  const isNew = !user;
  const [username, setUsername] = useState(user?.username || '');
  const [email, setEmail] = useState(user?.email || '');
  const [roleId, setRoleId] = useState(user?.role_id ?? '');
  const [isApproved, setIsApproved] = useState(isNew ? true : Boolean(user?.is_approved));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const identityLinked = Boolean(user?.google_linked || user?.hub_linked);
  const linkedVia = [user?.hub_linked && 'DWS Hub', user?.google_linked && 'Google'].filter(Boolean).join(' + ');
  // The recovery account and your own account keep the Administrator role and approval.
  const locked = Boolean(user?.is_recovery) || user?.id === currentUserId;
  const role = roles.find(item => item.id === Number(roleId));

  const handleSave = async () => {
    setError('');
    setSaving(true);
    const payload = { username, email, role_id: roleId === '' ? null : Number(roleId), is_approved: isApproved };
    try {
      if (isNew) await api.post('/users', payload);
      else await api.put(`/users/${user.id}`, payload);
      trackHubAction(isNew ? 'admin_user_added' : 'admin_user_updated', { approved: isApproved, admin: Boolean(role?.is_admin) });
      onSave(isNew ? 'User added' : 'User saved');
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const label = { display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 16 };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={isNew ? 'Add user' : 'Edit user'} style={{ background: '#fff', borderRadius: 12, width: 480, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>{isNew ? 'Add user' : 'Edit user'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 24 }}>
          <label style={label}>
            Name
            <input value={username} onChange={e => setUsername(e.target.value)} maxLength={120} placeholder="Full name (defaults to the email)" style={{ ...inputStyle, marginTop: 6 }} />
          </label>
          <label style={label}>
            Sign-in email
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={identityLinked}
              placeholder="name@company.com"
              style={{ ...inputStyle, marginTop: 6, background: identityLinked ? '#f5f6f6' : '#fff' }}
            />
            <span style={{ display: 'block', fontSize: 11.5, marginTop: 5, color: identityLinked ? '#2f7d4a' : 'var(--text-muted)', fontWeight: 400 }}>
              {identityLinked
                ? `${linkedVia} account linked; the email cannot change`
                : 'The email they sign in with (DWS Hub or corporate Google). Their first sign-in links the account.'}
            </span>
          </label>
          <label style={label}>
            Role
            <select value={roleId} onChange={e => setRoleId(e.target.value)} disabled={locked} style={{ ...inputStyle, marginTop: 6 }}>
              <option value="">No role yet</option>
              {roles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <span style={{ display: 'block', fontSize: 11.5, marginTop: 5, color: 'var(--text-muted)', fontWeight: 400 }}>
              {locked
                ? (user?.is_recovery ? 'The recovery administrator always keeps the Administrator role.' : 'You cannot change your own role.')
                : role ? (role.is_admin ? 'Every page, plus the Admin Panel.' : describePages(role.permissions, role.tab_permissions)) : 'Pages come from the role (Roles tab).'}
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: locked ? 'default' : 'pointer', fontSize: 14, marginBottom: 18 }}>
            <input type="checkbox" checked={isApproved} disabled={locked} onChange={e => setIsApproved(e.target.checked)} style={{ width: 16, height: 16 }} />
            <span>Approved: can sign in and open the role's pages</span>
          </label>
          {error && <div role="alert" style={{ color: '#dc2626', fontSize: 13, marginBottom: 12, background: '#fef2f2', padding: '8px 12px', borderRadius: 8, border: '1px solid #fecaca' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid var(--border)', background: '#fff', fontSize: 14 }}>Cancel</button>
            <button type="button" onClick={handleSave} disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: '#fff', fontSize: 14, fontWeight: 600 }}>
              {saving ? 'Saving…' : isNew ? 'Add user' : 'Save'}
            </button>
          </div>
        </div>
      </div>
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
  const isRecovery = Boolean(user?.is_recovery);
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [modal, setModal] = useState(null);
  const [tab, setTab] = useState('users');
  const [message, setMessage] = useState(null);

  const loadUsers = () => api.get('/users').then(r => setUsers(r.data)).catch(() => {});
  const loadRoles = () => api.get('/roles').then(r => setRoles(r.data)).catch(() => {});
  useEffect(() => { loadUsers(); loadRoles(); }, []);

  const canDelete = target => target.id !== user?.id && !target.is_recovery;

  const handleDelete = async target => {
    if (!window.confirm(`Delete ${target.username}? They lose access immediately.`)) return;
    try {
      await api.delete('/users/' + target.id);
      trackHubAction('admin_user_deleted');
      setMessage({ error: false, text: `${target.username} deleted` });
      loadUsers();
    } catch (err) {
      setMessage({ error: true, text: err.response?.data?.error || 'The user could not be deleted' });
    }
  };

  const tabs = [['users', 'User Management'], ['roles', 'Roles'], ['sheets', 'Sheets Config'], ...(isRecovery ? [['security', 'IP Security']] : [])];
  const th = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' };
  const td = { padding: '10px 16px' };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        {tabs.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: '8px 20px', borderRadius: 20, fontSize: 13, fontWeight: 500,
            border: '1px solid', borderColor: tab === key ? 'var(--primary)' : 'var(--border)',
            background: tab === key ? 'var(--primary)' : '#fff',
            color: tab === key ? '#fff' : 'var(--text-main)'
          }}>{label}</button>
        ))}
      </div>
      <div style={{ background: '#fff', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
        {tab === 'users' ? (
          <>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600 }}>Users</h3>
                <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>Add people before they sign in, or approve those who signed in with DWS Hub.</p>
              </div>
              <button type="button" onClick={() => { setMessage(null); setModal({}); }} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: '#fff', fontSize: 13, fontWeight: 600 }}>+ Add user</button>
            </div>
            {message && (
              <div role={message.error ? 'alert' : 'status'} style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 8, fontSize: 13, background: message.error ? '#fef2f2' : '#f0fdf4', color: message.error ? '#b91c1c' : '#15803d', border: `1px solid ${message.error ? '#fecaca' : '#bbf7d0'}` }}>{message.text}</div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 820 }}>
                <thead><tr style={{ background: '#f9fafb' }}>
                  {['Name', 'Sign-in Email', 'Status', 'Role', 'Access', 'Created', 'Actions'].map(h => <th key={h} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ ...td, fontWeight: 500 }}>
                        {u.username}
                        {u.id === user?.id && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (you)</span>}
                      </td>
                      <td style={{ ...td, color: 'var(--text-muted)', fontSize: 12 }}>
                        {u.email || '-'}{u.hub_linked || u.google_linked ? ' (linked)' : ''}
                      </td>
                      <td style={td}>
                        <span style={{ background: u.is_approved ? '#edf7ef' : '#fff7e6', color: u.is_approved ? '#25683a' : '#9a5b00', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>
                          {u.is_approved ? 'APPROVED' : 'PENDING'}
                        </span>
                      </td>
                      <td style={td}>
                        {u.role_name
                          ? <span style={u.is_admin
                            ? { background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }
                            : { background: '#eff6ff', color: '#1d4ed8', padding: '2px 8px', borderRadius: 10, fontSize: 11 }}>{u.role_name}</span>
                          : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No role</span>}
                      </td>
                      <td style={{ ...td, color: 'var(--text-muted)', fontSize: 12 }}>{accessSummary(u)}</td>
                      <td style={{ ...td, color: 'var(--text-muted)', fontSize: 12 }}>{new Date(u.created_at).toLocaleDateString()}</td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button type="button" onClick={() => { setMessage(null); setModal(u); }} style={smallButton}>Edit</button>
                          {canDelete(u) && <button type="button" onClick={() => handleDelete(u)} style={{ ...smallButton, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626' }}>Delete</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : tab === 'roles' ? (
          <RolesPanel onRolesChanged={() => { loadRoles(); loadUsers(); }} />
        ) : tab === 'sheets' ? (
          <div style={{ padding: 24 }}><SpreadsheetSources /></div>
        ) : (
          <IpSecurity />
        )}
      </div>
      {modal !== null && (
        <UserModal
          user={modal?.id ? modal : null}
          roles={roles}
          currentUserId={user?.id}
          onClose={() => setModal(null)}
          onSave={text => { setModal(null); setMessage({ error: false, text }); loadUsers(); loadRoles(); }}
        />
      )}
    </div>
  );
}
