import React, { useEffect, useRef, useState } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import api from '../services/api';
import './TopBar.css';

const TITLES = {
  '/dashboard':  'Dashboard',
  '/commercial': 'Commercial',
  '/commercial/open-shipments': 'Commercial · Open Shipments',
  '/commercial/kpn-export': 'Commercial · KPN Export',
  '/operations': 'Operations',
  '/operations/vessel-contract': 'Operations - Vessel Contract',
  '/operations/contract-dashboard': 'Operations · Contract Dashboard',
  '/operations/tpg-gr-weekly-ops': 'Operations · TPG/GR Weekly Ops Meeting',
  '/logistics':  'Logistics',
  '/logistics/vessel-matching': 'Logistics - Vessel Matching',
  '/logistics/contract-unlink': 'Logistics · Contract Unlink',
  '/logistics/stock-summary': 'Logistics · Stock Summary',
  '/logistics/vessel-status': 'Logistics · Vessel Status',
  '/logistics/vessel-contract': 'Logistics · Vessel Contract',
  '/logistics/demurrage': 'Logistics · Demurrage',
  '/logistics/export-summary': 'Logistics · Export Summary',
  '/logistics/export-summary-total': 'Logistics · Export Summary Total',
  '/logistics/vessel-update': 'Logistics · Vessel Update',
  '/chartering': 'Chartering',
  '/finance':    'Finance & Accounting',
  '/admin':      'Admin Panel',
  '/settings':   'Settings',
};

const SunIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);
const MoonIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);
const LogsIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M8 13h8M8 17h6" />
  </svg>
);

export default function TopBar({ sidebarWidth }) {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { isDark, toggle } = useTheme();
  const title = TITLES[pathname] || 'ERP';
  const [logsState, setLogsState] = useState('idle');
  const logsResetTimer = useRef(null);
  const canSendLogs = Boolean(user?.is_recovery);

  useEffect(() => () => {
    if (logsResetTimer.current) clearTimeout(logsResetTimer.current);
  }, []);

  const sendLogs = async () => {
    if (logsState === 'sending') return;
    setLogsState('sending');
    try {
      await api.post('/auth/activity-report');
      setLogsState('sent');
    } catch (error) {
      console.error('Could not email activity logs:', error);
      setLogsState('error');
    }
    if (logsResetTimer.current) clearTimeout(logsResetTimer.current);
    logsResetTimer.current = setTimeout(() => setLogsState('idle'), 4000);
  };

  const logsLabel = {
    idle: 'Logs',
    sending: 'Sending',
    sent: 'Sent',
    error: 'Retry',
  }[logsState];

  return (
    <header className="app-topbar" style={{
      position: 'fixed',
      top: 0,
      left: sidebarWidth,
      right: 0,
      height: 'var(--topbar-height)',
      background: 'var(--bg-topbar)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 clamp(10px, 2.2vw, 28px)',
      zIndex: 99,
      transition: 'left 0.2s, background 0.2s',
      boxShadow: '0 1px 10px rgba(31,42,48,0.035)',
      backdropFilter: 'blur(12px)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0 }} />
        <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-main)', letterSpacing: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</h1>
      </div>
      <div className="topbar-actions">
        {canSendLogs && (
          <button
            type="button"
            className={`topbar-logs-button is-${logsState}`}
            onClick={sendLogs}
            disabled={logsState === 'sending'}
            title={logsState === 'sent'
              ? 'Activity report emailed'
              : logsState === 'error'
                ? 'Email failed. Click to retry.'
                : 'Email the current activity shift report'}
          >
            {LogsIcon}
            <span>{logsLabel}</span>
          </button>
        )}
        <button
          onClick={toggle}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: '50%',
            width: 34, height: 34,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            transition: 'background 0.15s, color 0.15s'
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-app)'; e.currentTarget.style.color = 'var(--text-main)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          {isDark ? SunIcon : MoonIcon}
        </button>
        <Link to="/settings" style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--bg-app)', border: '1px solid var(--border)',
          borderRadius: 9, padding: '4px 9px 4px 5px', fontSize: 12.5,
          color: 'var(--text-main)', transition: 'background 0.15s'
        }}>
          <span style={{
            width: 27, height: 27, borderRadius: 8,
            background: 'var(--primary)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: 12
          }}>
            {user?.username?.[0]?.toUpperCase()}
          </span>
          <span className="topbar-account-name">{user?.username}</span>
          {user?.is_admin && (
            <span className="topbar-admin-badge" style={{
              background: '#f39c12', color: '#fff',
              fontSize: 10, padding: '2px 6px', borderRadius: 10, fontWeight: 600
            }}>ADMIN</span>
          )}
        </Link>
      </div>
    </header>
  );
}
