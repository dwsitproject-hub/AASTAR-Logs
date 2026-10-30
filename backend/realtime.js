const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');
const { jwtSecret } = require('../config/config');

let realtimeServer = null;
let heartbeat = null;

function canReceive(user, event) {
  if (!event.department || user?.is_admin) return true;
  if (!user) return false;
  if ((user.permissions || []).includes(event.department)) return true;
  return (user.tab_permissions || []).some(path => (path || '').split('/')[1] === event.department);
}

function send(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function attachRealtime(server) {
  if (realtimeServer) return realtimeServer;

  const wss = new WebSocketServer({ noServer: true });
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

    wss.handleUpgrade(request, socket, head, client => {
      wss.emit('connection', client, request);
    });
  });

  wss.on('connection', socket => {
    socket.isAlive = true;
    socket.authenticated = false;

    const authTimeout = setTimeout(() => {
      if (!socket.authenticated) socket.close(4001, 'Authentication required');
    }, 10000);

    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(4002, 'Invalid message');
        return;
      }

      if (socket.authenticated) return;
      if (message?.type !== 'auth' || !message.token) {
        socket.close(4001, 'Authentication required');
        return;
      }

      try {
        socket.user = jwt.verify(message.token, jwtSecret);
        socket.authenticated = true;
        clearTimeout(authTimeout);
        send(socket, {
          type: 'ready',
          at: new Date().toISOString(),
          userId: socket.user.id,
        });
      } catch {
        socket.close(4003, 'Invalid or expired token');
      }
    });

    socket.on('close', () => clearTimeout(authTimeout));
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
