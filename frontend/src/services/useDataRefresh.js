import { useEffect, useRef } from 'react';
import { API_BASE_URL } from './api';

const subscribers = new Set();
let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

function websocketUrl() {
  if (/^https?:\/\//i.test(API_BASE_URL)) {
    const url = new URL(API_BASE_URL);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
    url.search = '';
    return url.toString();
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/ws`;
}

function scheduleReconnect() {
  if (reconnectTimer || subscribers.size === 0) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function dispatch(message) {
  if (message?.type !== 'data.updated') return;
  for (const subscriber of subscribers) {
    const databaseMatch = Array.isArray(message.databases) && message.databases.some(name => subscriber.databases.has(name));
    const resourceMatch = subscriber.resources.has(message.resource);
    if (databaseMatch || resourceMatch) subscriber.callback(message);
  }
}

function connect() {
  if (subscribers.size === 0 || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;

  const nextSocket = new WebSocket(websocketUrl());
  socket = nextSocket;
  nextSocket.addEventListener('open', () => {
    reconnectDelay = 1000;
  });
  nextSocket.addEventListener('message', event => {
    try { dispatch(JSON.parse(event.data)); } catch { /* ignore malformed messages */ }
  });
  nextSocket.addEventListener('close', event => {
    if (socket === nextSocket) socket = null;
    if (event.code === 4001 || event.code === 4003) return;
    scheduleReconnect();
  });
  nextSocket.addEventListener('error', () => nextSocket.close());
}

function subscribe(databases, resources, callback) {
  const subscriber = { databases: new Set(databases), resources: new Set(resources), callback };
  subscribers.add(subscriber);
  connect();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket) socket.close(1000, 'No active subscribers');
      socket = null;
    }
  };
}

window.addEventListener('online', connect);

export default function useDataRefresh({ databases = [], resources = [], onRefresh, fallbackMs = 60000, enabled = true }) {
  const callbackRef = useRef(onRefresh);
  callbackRef.current = onRefresh;
  const databaseKey = [...databases].sort().join('|');
  const resourceKey = [...resources].sort().join('|');

  useEffect(() => {
    if (!enabled) return undefined;
    let pendingWhileHidden = false;
    let debounceTimer = null;

    const trigger = reason => {
      if (document.visibilityState === 'hidden') {
        pendingWhileHidden = true;
        return;
      }
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => callbackRef.current?.({ reason }), 500);
    };

    const unsubscribe = subscribe(
      databaseKey ? databaseKey.split('|') : [],
      resourceKey ? resourceKey.split('|') : [],
      () => trigger('realtime'),
    );
    const fallback = fallbackMs > 0
      ? window.setInterval(() => trigger('fallback'), fallbackMs)
      : null;
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && pendingWhileHidden) {
        pendingWhileHidden = false;
        trigger('visible');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      unsubscribe();
      if (fallback) window.clearInterval(fallback);
      if (debounceTimer) window.clearTimeout(debounceTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [databaseKey, resourceKey, fallbackMs, enabled]);
}
