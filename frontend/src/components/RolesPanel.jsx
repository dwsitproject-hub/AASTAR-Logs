import React, { useEffect, useState } from 'react';
import api from '../services/api';
import { trackHubAction } from '../services/hubSdk';
import PageAccessEditor, { describePages } from './PageAccessEditor';

// Admin -> Roles: each user has one role, and the role decides which pages they
// can open. Changing a role's pages changes them for every member at once.
const inputStyle = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, outline: 'none' };
const button = { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: '#fff', fontSize: 13, cursor: 'pointer' };
const cell = { padding: '10px 16px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' };

function RoleModal({ role, onClose, onSaved }) {
  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [access, setAccess] = useState({
    permissions: role?.permissions || [],
    tabPermissions: role?.tab_permissions || [],
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError('');
    setSaving(true);
    const payload = { name, description, permissions: access.permissions, tab_permissions: access.tabPermissions };
    try {
      if (role) await api.put(`/roles/${role.id}`, payload);
      else await api.post('/roles', payload);
      trackHubAction(role ? 'admin_role_updated' : 'admin_role_created', { pages: access.permissions.length + access.tabPermissions.length });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'The role could not be saved');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={role ? 'Edit role' : 'New role'} style={{ background: '#fff', borderRadius: 12, width: 620, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>{role ? 'Edit role' : 'New role'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 24 }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
            Role name
            <input value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="e.g. Logistics desk" style={{ ...inputStyle, marginTop: 6 }} />
          </label>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 500, margin: '14px 0 18px' }}>
            Description <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
            <input value={description} onChange={event => setDescription(event.target.value)} maxLength={200} placeholder="Who this role is for" style={{ ...inputStyle, marginTop: 6 }} />
          </label>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Pages this role can open</div>
          <PageAccessEditor permissions={access.permissions} tabPermissions={access.tabPermissions} onChange={setAccess} />
          {role?.user_count > 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Saving changes the pages of all {role.user_count} user{role.user_count === 1 ? '' : 's'} with this role.
            </p>
          )}
          {error && <div role="alert" style={{ color: '#dc2626', fontSize: 13, marginBottom: 12, background: '#fef2f2', padding: '8px 12px', borderRadius: 8, border: '1px solid #fecaca' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={{ ...button, padding: '9px 20px', fontSize: 14 }}>Cancel</button>
            <button type="button" onClick={save} disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: '#fff', fontSize: 14, fontWeight: 600 }}>
              {saving ? 'Saving…' : role ? 'Save role' : 'Create role'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function RolesPanel({ onRolesChanged }) {
  const [roles, setRoles] = useState([]);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState(null);

  const load = () => api.get('/roles').then(response => setRoles(response.data)).catch(() => setMessage({ error: true, text: 'Roles could not be loaded' }));
  useEffect(() => { load(); }, []);

  const changed = text => {
    setMessage({ error: false, text });
    load();
    onRolesChanged?.();
  };

  const remove = async role => {
    if (!window.confirm(`Delete the role "${role.name}"?`)) return;
    try {
      await api.delete(`/roles/${role.id}`);
      trackHubAction('admin_role_deleted');
      changed(`Role "${role.name}" deleted`);
    } catch (err) {
      setMessage({ error: true, text: err.response?.data?.error || 'The role could not be deleted' });
    }
  };

  return (
    <>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600 }}>Roles</h3>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>Each user has one role. A role decides which pages its users can open.</p>
        </div>
        <button type="button" onClick={() => setModal({})} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: '#fff', fontSize: 13, fontWeight: 600 }}>+ New role</button>
      </div>
      {message && (
        <div role={message.error ? 'alert' : 'status'} style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 8, fontSize: 13, background: message.error ? '#fef2f2' : '#f0fdf4', color: message.error ? '#b91c1c' : '#15803d', border: `1px solid ${message.error ? '#fecaca' : '#bbf7d0'}` }}>{message.text}</div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 720 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['Role', 'Pages', 'Users', 'Last changed', 'Actions'].map(h => (
                <th key={h} style={{ ...cell, textAlign: 'left', fontWeight: 600, color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roles.map(role => (
              <tr key={role.id}>
                <td style={cell}>
                  <div style={{ fontWeight: 600 }}>
                    {role.name}
                    {role.is_system && <span style={{ marginLeft: 8, background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>BUILT IN</span>}
                  </div>
                  {role.description && <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>{role.description}</div>}
                </td>
                <td style={{ ...cell, color: 'var(--text-muted)', maxWidth: 320 }}>
                  {role.is_admin ? 'Every page + Admin Panel' : describePages(role.permissions, role.tab_permissions)}
                </td>
                <td style={cell}>{role.user_count}</td>
                <td style={{ ...cell, color: 'var(--text-muted)', fontSize: 12 }}>
                  {role.updated_at ? new Date(role.updated_at).toLocaleString() : '—'}
                  {role.updated_by && <div>{role.updated_by}</div>}
                </td>
                <td style={cell}>
                  {role.is_system ? (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Cannot be changed</span>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={() => setModal(role)} style={button}>Edit</button>
                      <button
                        type="button"
                        onClick={() => remove(role)}
                        disabled={role.user_count > 0}
                        title={role.user_count > 0 ? 'Give its users another role first' : undefined}
                        style={{ ...button, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', opacity: role.user_count > 0 ? 0.5 : 1 }}
                      >Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal && (
        <RoleModal
          role={modal.id ? modal : null}
          onClose={() => setModal(null)}
          onSaved={() => { const name = modal.id ? 'Role saved' : 'Role created'; setModal(null); changed(name); }}
        />
      )}
    </>
  );
}
