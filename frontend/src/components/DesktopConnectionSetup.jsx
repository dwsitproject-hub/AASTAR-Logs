import React, { useState } from 'react';
import AppLogo, { APP_NAME } from './AppLogo';

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
        <div aria-hidden="true" style={{ marginBottom: 14 }}><AppLogo size={48} /></div>
        <p className="desktop-setup-eyebrow">{APP_NAME} desktop client</p>
        <h1 id="desktop-setup-title">Connect to your ERP server</h1>
        <p className="desktop-setup-copy">
          Enter the address of the server that hosts the {APP_NAME} API. This client uses the same account, permissions, and data as the web app.
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
            {saving ? 'Saving...' : 'Connect'}
          </button>
        </form>
      </section>
    </main>
  );
}
