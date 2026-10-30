import { API_BASE_URL } from './api';

const listeners = new Set();
let socket = null;
let reconnectTimer = null;
let shouldReconnect = false;
let reconnectAttempt = 0;
let status = 'offline';
let hasEditSnapshot = false;
let activeEditSessions = new Map();

function notify(message) {
  if (message.type === 'edit.snapshot') {
    activeEditSessions = new Map((message.sessions || []).map(session => [session.sessionId, session]));
    hasEditSnapshot = true;
  } else if (message.type === 'edit.updated') {
    activeEditSessions.set(message.sessionId, message);
  } else if (message.type === 'edit.ended') {
    activeEditSessions.delete(message.sessionId);
  }
  listeners.forEach(listener => listener(message));
}

function setStatus(nextStatus) {
  if (status === nextStatus) return;
  status = nextStatus;
  notify({ type: 'connection.status', status });
}

function websocketUrl() {
  if (/^https?:\/\//i.test(API_BASE_URL)) {
    const url = new URL(API_BASE_URL);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
    url.search = '';
    return url.toString();
  }

  const basePath = `/${API_BASE_URL.replace(/^\/+|\/+$/g, '')}`;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${basePath}/ws`;
}

function scheduleReconnect() {
  if (!shouldReconnect || reconnectTimer) return;
  const delay = Math.min(15000, 1000 * (2 ** Math.min(reconnectAttempt, 4)));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, delay);
}

function openSocket() {
  if (!shouldReconnect || typeof WebSocket === 'undefined') return;
  setStatus('connecting');

  let activeSocket;
  try {
    activeSocket = new WebSocket(websocketUrl());
  } catch {
    setStatus('error');
    scheduleReconnect();
    return;
  }

  socket = activeSocket;
  activeSocket.onopen = () => {
    if (socket !== activeSocket) return;
    reconnectAttempt = 0;
  };

  activeSocket.onmessage = event => {
    if (socket !== activeSocket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'ready') setStatus('online');
    notify(message);
  };

  activeSocket.onerror = () => {
    if (socket === activeSocket) setStatus('error');
  };

  activeSocket.onclose = event => {
    if (socket !== activeSocket) return;
    socket = null;
    if (event.code === 4001 || event.code === 4003) {
      shouldReconnect = false;
      setStatus('error');
      return;
    }
    if (shouldReconnect) {
      setStatus('offline');
      scheduleReconnect();
    }
  };
}

export function subscribeRealtime(listener) {
  listeners.add(listener);
  if (hasEditSnapshot) {
    const snapshot = { type: 'edit.snapshot', sessions: [...activeEditSessions.values()] };
    const defer = typeof queueMicrotask === 'function' ? queueMicrotask : setTimeout;
    defer(() => listener(snapshot));
  }
  return () => listeners.delete(listener);
}

export function getRealtimeStatus() {
  return status;
}

export function sendRealtime(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

export function connectRealtime() {
  shouldReconnect = true;
  if (socket && socket.readyState !== WebSocket.CLOSED) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  openSocket();
}

export function disconnectRealtime() {
  shouldReconnect = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const activeSocket = socket;
  socket = null;
  if (activeSocket) {
    activeSocket.onclose = null;
    activeSocket.close();
  }
  setStatus('offline');
}
