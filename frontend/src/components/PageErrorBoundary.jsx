import React from 'react';

// Keeps one broken page from blanking the whole ERP. The error is re-dispatched
// as a global error event so the DWS Hub SDK records it (with breadcrumbs) for
// Sentinel, the same as an uncaught error.
export default class PageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    try {
      if (typeof window.reportError === 'function') window.reportError(error);
    } catch {}
  }

  componentDidUpdate(previousProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const canReportBug = typeof window.DwsHub?.openBugReport === 'function';
    const button = {
      padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
      border: '1px solid var(--border)', background: '#fff', color: 'var(--text-main)',
    };
    return (
      <div role="alert" style={{ maxWidth: 520, margin: '60px auto', textAlign: 'center' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>This page could not be displayed</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 20 }}>
          The problem has been recorded. Reload the page, or open another page from the menu.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button type="button" onClick={() => window.location.reload()} style={{ ...button, background: 'var(--primary)', color: '#fff', border: 'none' }}>
            Reload page
          </button>
          {canReportBug && (
            <button type="button" onClick={() => window.DwsHub.openBugReport()} style={button}>
              Report a bug
            </button>
          )}
        </div>
      </div>
    );
  }
}
