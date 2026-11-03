import React, { useState, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AnimatedCollapse from './AnimatedCollapse';
import AppLogo from './AppLogo';

const ICON = (path) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
);

const Icons = {
  dashboard: ICON(<><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></>),
  commercial: ICON(<><path d="M3 3v18h18" /><path d="M7 15l4-4 4 3 5-7" /></>),
  operations: ICON(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>),
  logistics: ICON(<><path d="M1 3h15v13H1z" /><path d="M16 8h4l3 3v5h-7" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></>),
  chartering: ICON(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h6" /></>),
  finance: ICON(<><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>),
  admin: ICON(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>),
  test: ICON(<><path d="M9 3h6" /><path d="M10 3v6l-4.5 8.5A2 2 0 0 0 7.3 21h9.4a2 2 0 0 0 1.8-3.5L14 9V3" /><path d="M7 15h10" /></>),
  collapse: ICON(<><polyline points="15 18 9 12 15 6" /></>),
  expand: ICON(<><polyline points="9 18 15 12 9 6" /></>),
  chevron: ICON(<><polyline points="6 9 12 15 18 9" /></>),
  logout: ICON(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>),
};

const NAV_ITEMS = [
  { label: 'Dashboard',            path: '/dashboard',   dept: null,         icon: Icons.dashboard },
  {
    label: 'Commercial', path: '/commercial', dept: 'commercial', icon: Icons.commercial,
    children: [
      { label: 'Open Shipments', path: '/commercial/open-shipments' },
      { label: 'KPN Export', path: '/commercial/kpn-export' },
    ],
  },
  {
    label: 'Operations', path: '/operations', dept: 'operations', icon: Icons.operations,
    children: [
      { label: 'Contract Dashboard', path: '/operations/contract-dashboard' },
      { label: 'Vessel Contract', path: '/operations/vessel-contract' },
      { label: 'TPG/GR Weekly Ops Meeting', path: '/operations/tpg-gr-weekly-ops' },
    ],
  },
  {
    label: 'Logistics', path: '/logistics', dept: 'logistics', icon: Icons.logistics,
    children: [
      { label: 'Stock Summary', path: '/logistics/stock-summary' },
      { label: 'Vessel Status', path: '/logistics/vessel-status' },
      { label: 'Vessel Map', path: '/logistics/vessel-map' },
      { label: 'Live Vessels', path: '/logistics/live-vessels' },
      { label: 'Export Summary', path: '/logistics/export-summary' },
      { label: 'Export Summary Total', path: '/logistics/export-summary-total' },
      { label: 'Vessel Update', path: '/logistics/vessel-update' },
      { label: 'Vessel Contract', path: '/logistics/vessel-contract' },
      { label: 'Vessel Matching', path: '/logistics/vessel-matching' },
      { label: 'Contract Unlink', path: '/logistics/contract-unlink' },
      { label: 'Demurrage', path: '/logistics/demurrage' },
      { label: 'Export Planning', path: '/logistics/export-planning' },
    ],
  },
  {
    label: 'Chartering', path: '/chartering', dept: 'chartering', icon: Icons.chartering,
    children: [
      { label: 'Export Planning', path: '/chartering/export-planning' },
    ],
  },
  { label: 'Finance & Accounting', path: '/finance',     dept: 'finance',    icon: Icons.finance },
  { label: 'Admin Panel',          path: '/admin',       dept: 'admin',      icon: Icons.admin },
  {
    label: 'test', path: '/test', dept: 'admin', icon: Icons.test,
    children: [
      { label: 'Data', path: '/test/data' },
      { label: 'Apps Script Sheet', path: '/test/apps-script-sheet' },
    ],
  },
];

export default function Sidebar({ collapsed, setCollapsed }) {
  const { user, logout, hasPermission, hasTabAccess } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [openItems, setOpenItems] = useState({});

  // Auto-expand any section whose parent OR a child matches the current path
  useEffect(() => {
    setOpenItems(prev => {
      const next = { ...prev };
      NAV_ITEMS.forEach(item => {
        if (item.children && location.pathname.startsWith(item.path)) {
          next[item.path] = true;
        }
      });
      return next;
    });
  }, [location.pathname]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };
  const visible = NAV_ITEMS.filter(item => !item.dept || hasPermission(item.dept));

  return (
    <aside className="app-sidebar" style={{
      width: collapsed ? 72 : 250,
      minHeight: '100vh',
      background: 'var(--bg-sidebar)',
      borderRight: '1px solid var(--border-sidebar)',
      display: 'flex',
      flexDirection: 'column',
      transition: 'width 0.2s',
      position: 'fixed',
      left: 0, top: 0, bottom: 0,
      zIndex: 100,
      overflowX: 'hidden',
      boxShadow: '2px 0 14px rgba(31,42,48,0.035)'
    }}>
      {/* Logo */}
      <div style={{
        height: 'var(--topbar-height)',
        display: 'flex',
        alignItems: 'center',
        padding: collapsed ? '0 19px' : '0 22px',
        borderBottom: '1px solid var(--border-sidebar)',
        gap: 11
      }}>
        <AppLogo size={32} />
        {!collapsed && (
          <span style={{ color: 'var(--text-sidebar)', whiteSpace: 'nowrap', lineHeight: 1.15 }}>
            <span style={{ display: 'block', fontWeight: 700, fontSize: 14, letterSpacing: 0.3 }}>AASTAR Logistic</span>
            <span style={{ display: 'block', fontSize: 11.5, opacity: 0.75 }}>(Export)</span>
          </span>
        )}
      </div>

      {/* Collapse button - long, above nav */}
      <button
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{
          margin: '14px 14px 7px',
          padding: collapsed ? '9px 0' : '9px 12px',
          background: 'transparent',
          border: '1px solid var(--border-sidebar)',
          borderRadius: 7,
          color: 'var(--text-sidebar-muted)',
          fontSize: 12,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          cursor: 'pointer',
          transition: 'background 0.15s, color 0.15s'
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-sidebar-hover)'; e.currentTarget.style.color = 'var(--text-sidebar)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-sidebar-muted)'; }}
      >
        {collapsed ? Icons.expand : (
          <>
            {Icons.collapse}
            <span>Collapse</span>
          </>
        )}
      </button>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '8px 10px', overflowY: 'auto' }}>
        {visible.map(item => {
          const visibleChildren = item.children ? item.children.filter(c => hasTabAccess(c.path)) : [];
          const hasChildren = visibleChildren.length > 0;
          const isOpen = !!openItems[item.path];
          const isActive = location.pathname === item.path;
          const childActive = hasChildren && visibleChildren.some(c => location.pathname === c.path);

          return (
            <div key={item.path} style={{ marginBottom: 2 }}>
              <NavItemRow
                item={item}
                collapsed={collapsed}
                isActive={isActive || childActive}
                isOpen={isOpen}
                hasChildren={hasChildren}
                onToggleChildren={() => setOpenItems(o => ({ ...o, [item.path]: !o[item.path] }))}
              />

              {/* Sub-items - animated accordion */}
              {hasChildren && !collapsed && (
                <AnimatedCollapse open={isOpen} duration={220}>
                  <div style={{ marginLeft: 28, paddingTop: 5 }}>
                    {visibleChildren.map(child => (
                      <NavLink
                        key={child.path}
                        to={child.path}
                        style={({ isActive }) => ({
                          display: 'block',
                          padding: '8px 13px',
                          color: isActive ? 'var(--primary)' : 'var(--text-sidebar-muted)',
                          background: isActive ? 'rgba(185,78,58,0.10)' : 'transparent',
                          borderRadius: 7,
                          fontSize: 12.5,
                          fontWeight: isActive ? 600 : 500,
                          textDecoration: 'none',
                          marginBottom: 2,
                        })}
                      >
                        {child.label}
                      </NavLink>
                    ))}
                  </div>
                </AnimatedCollapse>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ borderTop: '1px solid var(--border-sidebar)', padding: collapsed ? '12px 10px' : '14px 18px' }}>
        {!collapsed ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 9,
              background: 'var(--primary)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, fontSize: 13
            }}>{user?.username?.[0]?.toUpperCase()}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-sidebar)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.username}
              </div>
              {user?.is_admin && <div style={{ fontSize: 10, color: 'var(--primary)', fontWeight: 600, letterSpacing: 0.5 }}>ADMIN</div>}
            </div>
            <button
              onClick={handleLogout}
              title="Log out"
              style={{ background: 'transparent', border: 'none', color: 'var(--text-sidebar-muted)', padding: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', borderRadius: 6 }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-sidebar-hover)'; e.currentTarget.style.color = 'var(--primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-sidebar-muted)'; }}
            >
              {Icons.logout}
            </button>
          </div>
        ) : (
          <button
            onClick={handleLogout}
            title="Log out"
            style={{ width: '100%', background: 'transparent', border: 'none', color: 'var(--text-sidebar-muted)', padding: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 }}
          >
            {Icons.logout}
          </button>
        )}
      </div>
    </aside>
  );
}

function NavItemRow({ item, collapsed, isActive, isOpen, hasChildren, onToggleChildren }) {
  const baseStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: collapsed ? '10px 0' : '10px 12px',
    justifyContent: collapsed ? 'center' : 'flex-start',
    color: isActive ? 'var(--primary)' : 'var(--text-sidebar)',
    background: isActive ? 'var(--bg-sidebar-active)' : 'transparent',
    border: isActive ? '1px solid var(--border-sidebar)' : '1px solid transparent',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: isActive ? 600 : 500,
    textDecoration: 'none',
    boxShadow: isActive ? '0 2px 5px rgba(31,42,48,0.06)' : 'none',
    transition: 'background 0.15s, color 0.15s, box-shadow 0.15s',
    cursor: 'pointer',
    fontFamily: 'inherit'
  };
  const hoverIn = e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-sidebar-hover)'; };
  const hoverOut = e => { if (!isActive) e.currentTarget.style.background = 'transparent'; };
  const content = (
    <>
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, color: isActive ? 'var(--primary)' : 'var(--text-sidebar-muted)' }}>{item.icon}</span>
      {!collapsed && <span style={{ whiteSpace: 'nowrap', flex: 1 }}>{item.label}</span>}
    </>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggleChildren}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${item.label}`}
          style={{ ...baseStyle, width: '100%', textAlign: 'left' }}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          {content}
          {!collapsed && <span style={{ display: 'flex', alignItems: 'center', color: 'var(--text-sidebar-muted)', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s' }}>{Icons.chevron}</span>}
        </button>
      ) : (
        <NavLink
          to={item.path}
          end
          style={() => ({ ...baseStyle, flex: 1 })}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          {content}
        </NavLink>
      )}
    </div>
  );
}
