import React from 'react';
import { useAuth } from '../context/AuthContext';

export default function Settings() {
  const { user } = useAuth();
  const rows = [
    ['Username reference', user?.username || '-'],
    ['Sign-in email', user?.email || '-'],
    ['Authentication', user?.hub_sub ? 'DWS Hub' : 'Corporate Google'],
    ['Access status', user?.is_approved ? 'Approved' : 'Pending'],
  ];

  return (
    <div style={{ maxWidth: 520 }}>
      <div style={{ background: '#fff', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Account Settings</h2>
        </div>
        <dl style={{ margin: 0 }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'grid', gridTemplateColumns: '160px minmax(0, 1fr)', gap: 18, padding: '14px 24px', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
              <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
              <dd style={{ margin: 0, fontWeight: 500, overflowWrap: 'anywhere' }}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
