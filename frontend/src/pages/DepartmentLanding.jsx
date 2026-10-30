import React from 'react';
import { Link } from 'react-router-dom';

export default function DepartmentLanding({ department, label, color, subTabs = [] }) {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-main)' }}>{label}</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 4 }}>
          {subTabs.length > 0
            ? `Select a sub-section to view ${label.toLowerCase()} data.`
            : `No sub-sections set up yet for ${label}.`}
        </p>
      </div>

      {subTabs.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 16
        }}>
          {subTabs.map(sub => (
            <Link key={sub.path} to={sub.path} style={{ textDecoration: 'none' }}>
              <div style={{
                background: '#fff',
                borderRadius: 12,
                boxShadow: 'var(--shadow)',
                padding: '22px 22px',
                borderLeft: `4px solid ${color}`,
                transition: 'transform 0.15s, box-shadow 0.15s',
                cursor: 'pointer'
              }}
                onMouseEnter={e => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = 'var(--shadow-lg)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'var(--shadow)';
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-main)' }}>{sub.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Open →</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
