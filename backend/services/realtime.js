const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { hasPageAccess } = require('../middleware/auth');
const { verifySessionToken } = require('./sessionAuth');
const { sessionTokenFromRequest } = require('./sessionCookie');
const { securityStatusForRequest } = require('./loginSecurity');
const { recordRealtimeConnection } = require('./userActivity');

let realtimeServer = null;
let heartbeat = null;
const editSessions = new Map();

function canReceive(user, event) {
  if (user?.is_admin) return true;
  if (!user) return false;
  const editEvent = String(event.type || '').startsWith('edit.');
  const pagePaths = {
    'vessel-update': editEvent
      ? ['/logistics/vessel-update']
      : ['/logistics/vessel-update', '/logistics/demurrage'],
    'vessel-matching': ['/logistics/vessel-matching'],
    'matching-sales': ['/logistics/vessel-matching'],
  }[event.resource];
  if (pagePaths) return pagePaths.some(pagePath => hasPageAccess(user, pagePath));
  if (!event.department) return true;
  if ((user.permissions || []).includes(event.department)) return true;
  return false;
}

function send(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function publicEditSession(session) {
  const { socket, ...publicSession } = session;
  return publicSession;
}

function broadcastEdit(message, excludedSocket = null) {
  if (!realtimeServer) return;
  for (const socket of realtimeServer.clients) {
    if (socket === excludedSocket || !socket.authenticated || !canReceive(socket.user, message)) continue;
    send(socket, message);
  }
}

function editKey(message) {
  return `${message.resource}:${message.sourceTab || ''}:${message.row}:${message.col}`;
}

function safeEditMessage(message) {
  if (!message || !['vessel-update', 'vessel-matching'].includes(message.resource) || message.department !== 'logistics') return null;
  if (!Number.isInteger(message.row) || message.row < 2) return null;
  if (!Number.isInteger(message.col) || message.col < 0 || message.col > 500) return null;
  if (typeof message.sessionId !== 'string' || !/^[a-zA-Z0-9:_-]{8,120}$/.test(message.sessionId)) return null;
  if (message.resource === 'vessel-matching' && typeof message.sourceTab !== 'string') return null;

  return {
    resource: message.resource,
    department: 'logistics',
    sessionId: message.sessionId,
    editKey: editKey(message),
    row: message.row,
    col: message.col,
    sourceTab: message.sourceTab ? String(message.sourceTab).slice(0, 80) : '',
    vslId: String(message.vslId || '').slice(0, 120),
    field: String(message.field || '').slice(0, 120),
    value: String(message.value ?? '').slice(0, 2000),
  };
}

function handleEditMessage(socket, message) {
  if (!['edit.start', 'edit.change', 'edit.end'].includes(message?.type)) return;

  if (message.type === 'edit.end') {
    const existing = editSessions.get(message.sessionId);
    if (!existing || existing.socket !== socket) return;
    editSessions.delete(message.sessionId);
    broadcastEdit({
      type: 'edit.ended',
      resource: existing.resource,
      department: existing.department,
      editKey: existing.editKey,
      sessionId: existing.sessionId,
      row: existing.row,
      col: existing.col,
      vslId: existing.vslId,
      sourceTab: existing.sourceTab,
    }, socket);
    return;
  }

  const edit = safeEditMessage(message);
  if (!edit || !canReceive(socket.user, edit)) return;
  const existing = editSessions.get(edit.sessionId);
  if (existing && existing.socket !== socket) return;

  const session = {
    ...edit,
    username: String(socket.user.username || 'User').slice(0, 80),
    startedAt: existing?.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    socket,
  };
  editSessions.set(edit.sessionId, session);
  broadcastEdit({ type: 'edit.updated', ...publicEditSession(session) }, socket);
}

function removeSocketEdits(socket) {
  for (const [sessionId, session] of editSessions) {
    if (session.socket !== socket) continue;
    editSessions.delete(sessionId);
    broadcastEdit({
      type: 'edit.ended',
      resource: session.resource,
      department: session.department,
      editKey: session.editKey,
      sessionId: session.sessionId,
      row: session.row,
      col: session.col,
      vslId: session.vslId,
      sourceTab: session.sourceTab,
    }, socket);
  }
}

function sendEditSnapshot(socket) {
  send(socket, {
    type: 'edit.snapshot',
    sessions: [...editSessions.values()]
      .filter(session => canReceive(socket.user, session))
      .map(publicEditSession),
  });
}

function attachRealtime(server, { allowedOrigins = new Set() } = {}) {
  if (realtimeServer) return realtimeServer;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  realtimeServer = wss;

  server.on('upgrade', (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }

    if (requestUrl.pathname !== '/api/ws') {
      socket.destroy();
      return;
    }

    if (securityStatusForRequest(request).isBlocked) {
      socket.destroy();
      return;
    }

    const origin = String(request.headers.origin || '').trim();
    if (origin) {
      let sameHost = false;
      try { sameHost = new URL(origin).host === String(request.headers.host || ''); } catch {}
      if (!sameHost && !allowedOrigins.has(origin)) {
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, client => {
      wss.emit('connection', client, request);
    });
  });

  wss.on('connection', (socket, request) => {
    socket.isAlive = true;
    socket.authenticated = false;

    let authTimeout = setTimeout(() => {
      if (!socket.authenticated) socket.close(4001, 'Authentication required');
    }, 10000);

    const authenticate = token => {
      try {
        const verified = verifySessionToken(token);
        socket.user = verified.user;
        socket.authenticated = true;
        clearTimeout(authTimeout);
        authTimeout = null;
        recordRealtimeConnection(socket.user, request);
        send(socket, {
          type: 'ready',
          at: new Date().toISOString(),
          userId: socket.user.id,
        });
        sendEditSnapshot(socket);
        return true;
      } catch {
        socket.close(4003, 'Invalid or expired session');
        return false;
      }
    };

    const handshakeSession = sessionTokenFromRequest(request);
    if (handshakeSession.token) authenticate(handshakeSession.token);

    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(4002, 'Invalid message');
        return;
      }

      if (socket.authenticated) {
        if (message?.type === 'edit.snapshot.request') sendEditSnapshot(socket);
        else handleEditMessage(socket, message);
        return;
      }
      if (message?.type !== 'auth' || typeof message.token !== 'string' || message.token.length > 8192) {
        socket.close(4001, 'Authentication required');
        return;
      }

      authenticate(message.token);
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
      removeSocketEdits(socket);
    });
    socket.on('error', () => {});
  });

  heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30000);
  heartbeat.unref?.();

  return wss;
}

function broadcastDataUpdated(event = {}) {
  if (!realtimeServer) return 0;

  const message = {
    type: 'data.updated',
    eventId: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...event,
  };
  let delivered = 0;

  for (const socket of realtimeServer.clients) {
    if (!socket.authenticated || !canReceive(socket.user, message)) continue;
    send(socket, message);
    delivered++;
  }
  return delivered;
}

function closeRealtime() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (realtimeServer) realtimeServer.close();
  realtimeServer = null;
}

module.exports = { attachRealtime, broadcastDataUpdated, closeRealtime };
