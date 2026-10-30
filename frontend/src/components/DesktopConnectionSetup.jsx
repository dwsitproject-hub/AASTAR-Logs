import React, { useState } from 'react';

export default function DesktopConnectionSetup() {
  const [apiUrl, setApiUrl] = useState('https://');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async event => {
    event.preventDefault();
    setError('');
    setSaving(true);

    try {
      await window.erpDesktop.configureApiBaseUrl(apiUrl);
    } catch (err) {
      setError(err?.message || 'The ERP server address could not be saved.');
      setSaving(false);
    }
  };

  return (
    <main className="desktop-setup">
      <section className="desktop-setup-panel" aria-labelledby="desktop-setup-title">
        <div className="desktop-setup-brand" aria-hidden="true">A</div>
        <p className="desktop-setup-eyebrow">Astar ERP desktop client</p>
        <h1 id="desktop-setup-title">Connect to your ERP server</h1>
        <p className="desktop-setup-copy">
          Enter the address of the server that hosts your Astar ERP API. This client uses the same account, permissions, and data as the web app.
        </p>

        <form onSubmit={submit}>
          <label className="desktop-setup-label" htmlFor="erp-api-url">ERP API address</label>
          <input
            id="erp-api-url"
            className="desktop-setup-input"
            type="url"
            value={apiUrl}
            onChange={event => setApiUrl(event.target.value)}
            placeholder="https://erp.example.com/api"
            autoFocus
            required
          />
          <p className="desktop-setup-hint">Example: https://erp.example.com/api</p>

          {error && <p className="desktop-setup-error" role="alert">{error}</p>}

          <button className="desktop-setup-submit" type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Connect to Astar ERP'}
          </button>
        </form>
      </section>
    </main>
  );
}
