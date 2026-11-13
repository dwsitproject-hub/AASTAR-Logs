'use strict';

// Pages that roles grant access to. Mirrors frontend/src/navConfig.js (the
// sidebar); test/roles.test.js fails when the two drift apart.
//
// Departments with sub-tabs are granted per tab (`tab_permissions` holds the tab
// paths); departments without sub-tabs are granted whole (`permissions` holds
// the department name). The Admin Panel comes only with the Administrator role.
const DEPARTMENTS = [
  { dept: 'commercial', label: 'Commercial', tabs: ['/commercial/open-shipments', '/commercial/kpn-export'] },
  {
    dept: 'operations',
    label: 'Operations',
    tabs: ['/operations/contract-dashboard', '/operations/vessel-contract', '/operations/tpg-gr-weekly-ops'],
  },
  {
    dept: 'logistics',
    label: 'Logistics',
    tabs: [
      '/logistics/stock-summary', '/logistics/vessel-status', '/logistics/live-vessels',
      '/logistics/export-summary', '/logistics/export-summary-total', '/logistics/vessel-update',
      '/logistics/vessel-contract', '/logistics/vessel-matching', '/logistics/contract-unlink',
      '/logistics/demurrage', '/logistics/export-planning',
    ],
  },
  { dept: 'chartering', label: 'Chartering', tabs: ['/chartering/export-planning'] },
  { dept: 'finance', label: 'Finance & Accounting', tabs: [] },
  { dept: 'admin', label: 'Admin Panel', tabs: [] },
];

const WHOLE_DEPARTMENTS = DEPARTMENTS.filter(d => d.tabs.length === 0 && d.dept !== 'admin').map(d => d.dept);
const TAB_PATHS = DEPARTMENTS.flatMap(d => d.tabs);

module.exports = { DEPARTMENTS, TAB_PATHS, WHOLE_DEPARTMENTS };
