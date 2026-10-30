import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AnimatedCollapse from '../components/AnimatedCollapse';

const ICON = (path) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
);
const Icons = {
  commercial: ICON(<><path d="M3 3v18h18" /><path d="M7 15l4-4 4 3 5-7" /></>),
  operations: ICON(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>),
  logistics: ICON(<><path d="M1 3h15v13H1z" /><path d="M16 8h4l3 3v5h-7" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></>),
  chartering: ICON(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h6" /></>),
  finance: ICON(<><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>),
  admin: ICON(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>),
  chevron: ICON(<><polyline points="6 9 12 15 18 9" /></>),
  arrow: ICON(<><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></>),
};

const DEPT_CARDS = [
  { label: 'Commercial', path: '/commercial', dept: 'commercial', icon: Icons.commercial, color: '#3498db', children: [] },
  { label: 'Operations', path: '/operations', dept: 'operations', icon: Icons.operations, color: '#2ecc71', children: [
    { label: 'Contract Dashboard', path: '/operations/contract-dashboard' },
    { label: 'TPG/GR Weekly Ops Meeting', path: '/operations/tpg-gr-weekly-ops' },
  ] },
  { label: 'Logistics', path: '/logistics', dept: 'logistics', icon: Icons.logistics, color: '#9b59b6', children: [
    { label: 'Export Summary', path: '/logistics/export-summary' },
    { label: 'Export Summary Total', path: '/logistics/export-summary-total' },
    { label: 'Vessel Update', path: '/logistics/vessel-update' },
  ] },
  { label: 'Chartering', path: '/chartering', dept: 'chartering', icon: Icons.chartering, color: '#e67e22', children: [] },
  { label: 'Finance & Accounting', path: '/finance', dept: 'finance', icon: Icons.finance, color: '#1abc9c', children: [] },
  { label: 'Admin Panel', path: '/admin', dept: 'admin', icon: Icons.admin, color: '#c0392b', children: [] },
];

export default function Dashboard() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState({});
  const accessible = DEPT_CARDS.filter(c => hasPermission(c.dept));

  const handleCardClick = (card) => {
    setExpanded(prev => ({ ...prev, [card.path]: !prev[card.path] }));
  };

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-main)' }}>Welcome back, {user?.username}</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 4 }}>Select a department to get started.</p>
      </div>

      {accessible.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 'var(--radius)', padding: 32, textAlign: 'center', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 14 }}>
          No departments have been assigned to your account yet. Contact an administrator.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 18 }}>
          {accessible.map(card => {
            const isExpanded = !!expanded[card.path];
            const hasChildren = card.children.length > 0;
            return (
              <div key={card.path} style={{
                background: '#fff', borderRadius: 12,
                boxShadow: 'var(--shadow)',
                borderLeft: `4px solid ${card.color}`,
                transition: 'box-shadow 0.15s, transform 0.15s',
                overflow: 'hidden'
              }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-lg)'; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow)'; }}
              >
                <button
                  onClick={() => hasChildren ? handleCardClick(card) : navigate(card.path)}
                  style={{
                    width: '100%', textAlign: 'left',
                    display: 'flex', alignItems: 'center', gap: 14,
                    padding: '18px 20px',
                    background: 'transparent', border: 'none', cursor: 'pointer'
                  }}
                >
                  <div style={{ color: card.color, display: 'flex', flexShrink: 0 }}>{card.icon}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-main)' }}>{card.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      {hasChildren ? `${card.children.length} section${card.children.length === 1 ? '' : 's'}` : 'Open'}
                    </div>
                  </div>
                  <div style={{
                    color: 'var(--text-muted)', display: 'flex', flexShrink: 0,
                    transform: hasChildren && isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s'
                  }}>
                    {hasChildren ? Icons.chevron : Icons.arrow}
                  </div>
                </button>

                {hasChildren && (
                  <AnimatedCollapse open={isExpanded} duration={260}>
                    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 14px 12px' }}>
                      <Link to={card.path} style={subItemStyle(card.color, true)}>
                        <span>{card.label} overview</span>
                        <span style={{ color: 'var(--text-muted)', display: 'flex' }}>{Icons.arrow}</span>
                      </Link>
                      {card.children.map(child => (
                        <Link key={child.path} to={child.path} style={subItemStyle(card.color, false)}>
                          <span>{child.label}</span>
                          <span style={{ color: 'var(--text-muted)', display: 'flex' }}>{Icons.arrow}</span>
                        </Link>
                      ))}
                    </div>
                  </AnimatedCollapse>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const subItemStyle = (color, isOverview) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '9px 12px',
  textDecoration: 'none',
  color: 'var(--text-main)',
  fontSize: 13,
  fontWeight: isOverview ? 500 : 500,
  fontStyle: isOverview ? 'italic' : 'normal',
  borderRadius: 6,
  marginBottom: 2,
  transition: 'background 0.15s'
});
