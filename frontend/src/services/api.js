import axios from 'axios';

const desktopApiBase = typeof window !== 'undefined'
  ? window.erpDesktop?.apiBaseUrl
  : undefined;

export const API_BASE_URL = desktopApiBase || import.meta.env.VITE_API_BASE_URL || '/api';

let csrfToken = '';
try {
  csrfToken = sessionStorage.getItem('erp_csrf') || '';
  localStorage.removeItem('erp_token');
} catch {}

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  withCredentials: true,
});

export function setCsrfToken(value = '') {
  csrfToken = String(value || '');
  try {
    if (csrfToken) sessionStorage.setItem('erp_csrf', csrfToken);
    else sessionStorage.removeItem('erp_csrf');
  } catch {}
}

export function clearClientSession() {
  setCsrfToken('');
  localStorage.removeItem('erp_token');
  localStorage.removeItem('erp_user');
  delete api.defaults.headers.common['Authorization'];
}

api.interceptors.request.use(config => {
  const method = String(config.method || 'get').toUpperCase();
  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    config.headers ||= {};
    config.headers['X-ERP-CSRF'] = csrfToken;
  }
  return config;
});

export function redirectToDecoy(path = '/atlas/royal-continent') {
  clearClientSession();
  if (window.erpDesktop) {
    window.location.hash = `#${path}`;
  } else {
    window.location.replace(path);
  }
}

function redirectToLogin() {
  const currentRoute = window.erpDesktop
    ? window.location.hash.slice(1)
    : window.location.pathname;
  if (currentRoute === '/login') return;

  if (window.erpDesktop) {
    window.location.hash = '#/login';
  } else {
    window.location.replace('/login');
  }
}

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.data?.decoy) {
      redirectToDecoy(err.response.data.redirect);
      return Promise.reject(err);
    }
    const requestPath = String(err.config?.url || '');
    const isSignInRequest = requestPath.endsWith('/auth/login') || requestPath.endsWith('/auth/google');
    const isSessionProbe = requestPath.endsWith('/auth/me');
    if (err.response?.status === 401 && !isSignInRequest) {
      clearClientSession();
      // AuthProvider handles an expected unauthenticated session probe. Reloading
      // /login here would immediately run the same probe and create a redirect loop.
      if (!isSessionProbe) redirectToLogin();
    }
    return Promise.reject(err);
  }
);

export default api;
