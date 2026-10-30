// Single source of truth for departments and their sub-tabs. Used by the sidebar,
// department landing pages, the dashboard cards, and the admin access editor.
//
// Access model (chosen 2026-07-06): departments WITH sub-tabs (Operations,
// Logistics) are granted per-sub-tab — a user's `tab_permissions` lists the exact
// sub-tab paths they can open, and they can reach the department section/landing
// if they hold at least one of its tabs. Departments WITHOUT sub-tabs
// (Commercial, Chartering, Finance, Admin) are still granted at the department
// level via `permissions`.

export const DEPARTMENTS = [
  {
    dept: 'commercial', label: 'Commercial', path: '/commercial', color: '#3498db',
    tabs: [
      { label: 'Open Shipments', path: '/commercial/open-shipments' },
      { label: 'KPN Export', path: '/commercial/kpn-export' },
    ],
  },
  {
    dept: 'operations', label: 'Operations', path: '/operations', color: '#2ecc71',
    tabs: [
      { label: 'Contract Dashboard', path: '/operations/contract-dashboard' },
      { label: 'Vessel Contract', path: '/operations/vessel-contract' },
      { label: 'TPG/GR Weekly Ops Meeting', path: '/operations/tpg-gr-weekly-ops' },
    ],
  },
  {
    dept: 'logistics', label: 'Logistics', path: '/logistics', color: '#9b59b6',
    tabs: [
      { label: 'Stock Summary', path: '/logistics/stock-summary' },
      { label: 'Vessel Status', path: '/logistics/vessel-status' },
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
    dept: 'chartering', label: 'Chartering', path: '/chartering', color: '#e67e22',
    tabs: [
      { label: 'Export Planning', path: '/chartering/export-planning' },
    ],
  },
  { dept: 'finance', label: 'Finance & Accounting', path: '/finance', color: '#e74c3c', tabs: [] },
  { dept: 'admin', label: 'Admin Panel', path: '/admin', color: '#607d8b', tabs: [] },
];

export const DEPT_LABELS = Object.fromEntries(DEPARTMENTS.map(d => [d.dept, d.label]));

// Departments that are granted at the sub-tab level (have children).
export const SUBTAB_DEPTS = DEPARTMENTS.filter(d => d.tabs.length).map(d => d.dept);

// Department a path belongs to: '/logistics/demurrage' -> 'logistics'.
export const deptOf = (path) => (path || '').split('/')[1] || '';

export const hasSubTabs = (dept) => SUBTAB_DEPTS.includes(dept);
