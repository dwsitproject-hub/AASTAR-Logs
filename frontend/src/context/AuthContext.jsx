import React, { createContext, useContext, useState, useEffect } from 'react';
import api, { clearClientSession, redirectToDecoy, setCsrfToken } from '../services/api';
import { connectRealtime, disconnectRealtime } from '../services/realtime';
import { identifyHubUser, resetHubUser } from '../services/hubSdk';
import { hasSubTabs, deptOf } from '../navConfig';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const restoreSession = async () => {
      const route = window.erpDesktop ? window.location.hash.slice(1) : window.location.pathname;
      if (route === '/atlas/royal-continent') {
        if (active) setLoading(false);
        return;
      }
      try {
        const access = await api.get('/auth/access-status');
        if (access.data?.decoy) {
          redirectToDecoy(access.data.redirect);
          return;
        }
        const response = await api.get('/auth/me');
        if (!active) return;
        setCsrfToken(response.data.csrfToken);
        localStorage.setItem('erp_user', JSON.stringify(response.data.user));
        setUser(response.data.user);
        connectRealtime();
      } catch {
        clearClientSession();
        disconnectRealtime();
      } finally {
        if (active) setLoading(false);
      }
    };
    restoreSession();
    return () => { active = false; };
  }, []);

  // Cheap and idempotent: re-identify whenever the signed-in user changes.
  useEffect(() => {
    if (user) identifyHubUser(user);
  }, [user]);

  const storeSession = (data) => {
    if (data?.decoy) return data;
    const { user: nextUser, csrfToken } = data;
    setCsrfToken(csrfToken);
    localStorage.setItem('erp_user', JSON.stringify(nextUser));
    setUser(nextUser);
    connectRealtime();
    return nextUser;
  };

  const googleLogin = async (credential, remember = true) => {
    const res = await api.post('/auth/google', { credential, remember });
    return storeSession(res.data);
  };

  // Local Docker/dev stacks only; the backend returns 404 unless LOCAL_DEV_LOGIN_EMAIL is set.
  const devLogin = async () => {
    const res = await api.post('/auth/dev-login');
    return storeSession(res.data);
  };

  const logout = async () => {
    resetHubUser();
    try {
      await api.post('/auth/logout');
    } finally {
      clearClientSession();
      disconnectRealtime();
      setUser(null);
    }
  };

  // Department-level access (sidebar parent, landing page, dashboard card).
  // For departments with sub-tabs, access = holding at least one of their tabs.
  const hasPermission = (dept) => {
    if (!user) return false;
    if (user.is_admin) return true;
    if (hasSubTabs(dept)) {
      return (user.tab_permissions || []).some(p => deptOf(p) === dept);
    }
    return (user.permissions || []).includes(dept);
  };

  // Sub-tab access (individual page under Operations / Logistics).
  const hasTabAccess = (path) => {
    if (!user) return false;
    if (user.is_admin) return true;
    return (user.tab_permissions || []).includes(path);
  };

  return (
    <AuthContext.Provider value={{ user, googleLogin, devLogin, logout, hasPermission, hasTabAccess, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
