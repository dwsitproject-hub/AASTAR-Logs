import React from 'react';
import { DEPARTMENTS, DEPT_LABELS } from '../navConfig';

// Page picker for a role: departments without sub-tabs are granted whole,
// departments with sub-tabs per tab. The Admin Panel is never offered here; it
// comes only with the built-in Administrator role.
const WHOLE_DEPTS = DEPARTMENTS.filter(d => d.tabs.length === 0 && d.dept !== 'admin').map(d => d.dept);
const TABBED_DEPTS = DEPARTMENTS.filter(d => d.tabs.length > 0);

const chip = active => ({
  padding: '6px 14px', borderRadius: 20, fontSize: 13, border: '1px solid', cursor: 'pointer',
  borderColor: active ? 'var(--primary)' : 'var(--border)',
  background: active ? 'var(--primary)' : '#fff',
  color: active ? '#fff' : 'var(--text-main)', fontWeight: 500,
});
const linkBtn = { background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12, cursor: 'pointer', padding: 0 };

export default function PageAccessEditor({ permissions, tabPermissions, onChange, disabled = false }) {
  const setPerms = next => onChange({ permissions: next, tabPermissions });
  const setTabs = next => onChange({ permissions, tabPermissions: next });
  const toggleDept = dept => setPerms(permissions.includes(dept) ? permissions.filter(d => d !== dept) : [...permissions, dept]);
  const toggleTab = path => setTabs(tabPermissions.includes(path) ? tabPermissions.filter(p => p !== path) : [...tabPermissions, path]);
  const setDeptTabs = (def, on) => {
    const others = tabPermissions.filter(p => !def.tabs.some(tab => tab.path === p));
    setTabs(on ? [...others, ...def.tabs.map(tab => tab.path)] : others);
  };

  return (
    <fieldset disabled={disabled} style={{ border: 'none', padding: 0, margin: 0 }}>
      {WHOLE_DEPTS.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Departments</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {WHOLE_DEPTS.map(dept => (
              <button type="button" key={dept} onClick={() => toggleDept(dept)} style={chip(permissions.includes(dept))}>{DEPT_LABELS[dept]}</button>
            ))}
          </div>
        </div>
      )}
      {TABBED_DEPTS.map(def => {
        const granted = def.tabs.filter(tab => tabPermissions.includes(tab.path)).length;
        const allOn = granted === def.tabs.length;
        return (
          <div key={def.dept} style={{ marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {def.label} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {granted}/{def.tabs.length} pages</span>
              </span>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" onClick={() => setDeptTabs(def, true)} disabled={allOn} style={{ ...linkBtn, opacity: allOn ? 0.4 : 1 }}>Select all</button>
                <button type="button" onClick={() => setDeptTabs(def, false)} disabled={granted === 0} style={{ ...linkBtn, opacity: granted === 0 ? 0.4 : 1 }}>Clear</button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '6px 10px' }}>
              {def.tabs.map(tab => (
                <label key={tab.path} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={tabPermissions.includes(tab.path)} onChange={() => toggleTab(tab.path)} style={{ width: 15, height: 15 }} />
                  <span>{tab.label}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

// "Logistics (3 pages) + Finance & Accounting" for tables and role cards.
export function describePages(permissions = [], tabPermissions = []) {
  const parts = [];
  for (const def of DEPARTMENTS) {
    if (def.tabs.length) {
      const granted = def.tabs.filter(tab => tabPermissions.includes(tab.path)).length;
      if (granted === def.tabs.length) parts.push(def.label);
      else if (granted) parts.push(`${def.label} (${granted} page${granted === 1 ? '' : 's'})`);
    } else if (permissions.includes(def.dept)) {
      parts.push(def.label);
    }
  }
  return parts.join(' + ') || 'No pages';
}
