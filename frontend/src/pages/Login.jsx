import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api, { API_BASE_URL, redirectToDecoy } from '../services/api';

const GOOGLE_SCRIPT_ID = 'google-identity-services';

// Messages for /login?sso_error=… set by the backend DWS Hub callback.
const HUB_SSO_ERRORS = {
  pending: 'Your DWS Hub account is verified and awaiting ERP access approval. Please ask an ERP administrator to approve your access.',
  review_required: 'This DWS Hub account needs administrator review before it can be used here.',
  identity_not_allowed: 'This DWS Hub account is not allowed to use Astar ERP.',
  session_expired: 'Your sign-in took too long or was started elsewhere. Please sign in again.',
  token_invalid: 'DWS Hub sign-in could not be verified. Please try again.',
  hub_denied: 'Sign-in was cancelled or refused by DWS Hub.',
  hub_unavailable: 'DWS Hub is not reachable right now. Please try again in a few minutes.',
  rate_limited: 'Too many sign-in attempts. Please try again later.',
  access_denied: 'Sign-in is unavailable from this IP. Please contact your ERP administrator.',
  sso_disabled: 'DWS Hub sign-in is not enabled for this ERP.',
};

function HubSignIn({ nextPath, disabled }) {
  const href = `${API_BASE_URL}/auth/sso/login?next=${encodeURIComponent(nextPath)}`;
  return (
    <a
      href={href}
      aria-disabled={disabled}
      onClick={event => { if (disabled) event.preventDefault(); }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        width: '100%', padding: 11, borderRadius: 8, boxSizing: 'border-box',
        background: disabled ? '#e5e7eb' : 'var(--primary)',
        color: disabled ? 'var(--text-muted)' : '#fff',
        fontSize: 15, fontWeight: 600, textDecoration: 'none',
      }}
    >
      Sign in with DWS Hub
    </a>
  );
}

function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(GOOGLE_SCRIPT_ID);
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.id = GOOGLE_SCRIPT_ID;
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function GoogleSignIn({ clientId, onCredential, onError }) {
  const buttonRef = useRef(null);

  useEffect(() => {
    let active = true;
    loadGoogleIdentity().then(() => {
      if (!active || !buttonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: response => onCredential(response.credential),
      });
      buttonRef.current.replaceChildren();
      window.google.accounts.id.renderButton(buttonRef.current, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        shape: 'rectangular',
        width: 318,
      });
    }).catch(() => {
      if (active) onError('Google sign-in could not be loaded.');
    });
    return () => { active = false; };
  }, [clientId, onCredential, onError]);

  return <div ref={buttonRef} style={{ minHeight: 44, display: 'flex', justifyContent: 'center' }} />;
}

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(true);
  const [googleConfig, setGoogleConfig] = useState(null);
  const [hubSsoEnabled, setHubSsoEnabled] = useState(false);
  const { googleLogin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const nextPath = typeof location.state?.from === 'string' ? location.state.from : '/dashboard';

  useEffect(() => {
    const code = new URLSearchParams(location.search).get('sso_error');
    if (code) setError(HUB_SSO_ERRORS[code] || 'DWS Hub sign-in failed. Please try again.');
  }, [location.search]);

  useEffect(() => {
    let active = true;
    api.post('/auth/page-visit', { page: 'login', referrer: document.referrer }).catch(() => {});
    api.get('/auth/access-status').then(response => {
      if (!active) return;
      if (response.data?.decoy) return redirectToDecoy(response.data.redirect);
      setGoogleConfig(response.data?.google || null);
      // The desktop shell cannot complete a browser redirect flow, so it keeps Google sign-in.
      setHubSsoEnabled(Boolean(response.data?.hubSso?.enabled) && !window.erpDesktop);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const completeLogin = useCallback((result) => {
    if (result?.decoy) return redirectToDecoy(result.redirect);
    navigate('/dashboard');
  }, [navigate]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await api.post('/auth/login', { username, password });
      if (response.data?.decoy) return redirectToDecoy(response.data.redirect);
      setError('Invalid credentials');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleCredential = useCallback(async (credential) => {
    setError('');
    setLoading(true);
    try {
      completeLogin(await googleLogin(credential, remember));
    } catch (err) {
      setError(err.response?.data?.error || 'Google sign-in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [completeLogin, googleLogin, remember]);

  const inputStyle = {
    width: '100%', padding: '10px 14px', borderRadius: 8,
    border: '1px solid var(--border)', fontSize: 14,
    outline: 'none', transition: 'border-color 0.15s',
  };

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg-app)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{
        background: '#fff', borderRadius: 10, boxShadow: 'var(--shadow-lg)',
        padding: '42px 40px', width: '100%', maxWidth: 400,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            width: 54, height: 54, borderRadius: 10,
            background: 'var(--primary)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 23, margin: '0 auto 12px',
          }}>A</div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-main)' }}>Astar ERP</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 4 }}>Sign in to your account</p>
        </div>

        {hubSsoEnabled && (
          <>
            <HubSignIn nextPath={nextPath} disabled={loading} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '22px 0 16px', color: '#8a9398', fontSize: 12 }}>
              <span style={{ height: 1, background: 'var(--border)', flex: 1 }} />
              <span>or</span>
              <span style={{ height: 1, background: 'var(--border)', flex: 1 }} />
            </div>
          </>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Username</label>
            <input
              type="text" value={username} onChange={event => setUsername(event.target.value)}
              required autoFocus autoComplete="username" placeholder="Enter username" style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Password</label>
            <input
              type="password" value={password} onChange={event => setPassword(event.target.value)}
              required autoComplete="current-password" placeholder="Enter password" style={inputStyle}
            />
          </div>

          {error && (
            <div role="alert" style={{
              background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626',
              borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16,
            }}>{error}</div>
          )}

          <button type="submit" disabled={loading} style={{
            width: '100%', padding: 11, borderRadius: 8,
            background: loading ? '#e5e7eb' : 'var(--primary)',
            color: loading ? 'var(--text-muted)' : '#fff', border: 'none',
            fontSize: 15, fontWeight: 600,
          }}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        {googleConfig?.enabled && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '22px 0 16px', color: '#8a9398', fontSize: 12 }}>
              <span style={{ height: 1, background: 'var(--border)', flex: 1 }} />
              <span>or</span>
              <span style={{ height: 1, background: 'var(--border)', flex: 1 }} />
            </div>
            <label style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              color: 'var(--text-muted)', fontSize: 13, marginBottom: 14, cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={remember}
                onChange={event => setRemember(event.target.checked)}
                style={{ width: 16, height: 16, accentColor: 'var(--primary)' }}
              />
              Keep me signed in for 30 days
            </label>
            <GoogleSignIn
              clientId={googleConfig.clientId}
              onCredential={handleGoogleCredential}
              onError={setError}
            />
          </>
        )}
      </div>
    </div>
  );
}
