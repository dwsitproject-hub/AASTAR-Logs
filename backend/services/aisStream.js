'use strict';

const WebSocket = require('ws');
const { loadVesselDatabase, VESSEL_COL } = require('./vesselUpdate');

const STREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const DIGITRAFFIC_LOCATIONS_URL = 'https://meri.digitraffic.fi/api/ais/v1/locations';
const DIGITRAFFIC_VESSELS_URL = 'https://meri.digitraffic.fi/api/ais/v1/vessels';
const WORLD_BOUNDS = [[[-90, -180], [90, 180]]];
const REFRESH_MS = Math.max(Number(process.env.AISSTREAM_FILTER_REFRESH_MS) || 15000, 5000);
const POSITION_MAX_AGE_MS = Math.max(Number(process.env.AISSTREAM_POSITION_MAX_AGE_MS) || 24 * 60 * 60 * 1000, 60000);
const DIGITRAFFIC_REFRESH_MS = Math.max(Number(process.env.DIGITRAFFIC_REFRESH_MS) || 60000, 30000);
const DIGITRAFFIC_METADATA_REFRESH_MS = Math.max(Number(process.env.DIGITRAFFIC_METADATA_REFRESH_MS) || 10 * 60 * 1000, 60000);
const DIGITRAFFIC_TIMEOUT_MS = Math.max(Number(process.env.DIGITRAFFIC_TIMEOUT_MS) || 20000, 5000);
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;

let socket = null;
let refreshTimer = null;
let reconnectTimer = null;
let digitrafficTimer = null;
let digitrafficController = null;
let digitrafficInFlight = false;
let reconnectDelay = RECONNECT_MIN_MS;
let started = false;
let stopped = false;
let desiredMmsi = [];
let desiredImo = [];
let desiredKey = '';
let subscribedKey = '';
let status = 'idle';
let lastConnectedAt = '';
let lastMessageAt = '';
let lastError = '';
let digitrafficStatus = 'idle';
let lastDigitrafficRefreshAt = '';
let lastDigitrafficMessageAt = '';
let lastDigitrafficMetadataAt = '';
let lastDigitrafficError = '';
const positions = new Map();
const digitrafficPositions = new Map();
const digitrafficMetadataByMmsi = new Map();
const digitrafficMmsiByImo = new Map();

function text(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeMmsi(value) {
  const result = text(value).replace(/\D/g, '');
  return /^\d{9}$/.test(result) && result !== '000000000' ? result : '';
}

function normalizeImo(value) {
  const result = text(value).replace(/\D/g, '');
  return /^\d{7}$/.test(result) && result !== '0000000' ? result : '';
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getOpenIdentifiersFromRows(rows) {
  const mmsiValues = new Set();
  const imoValues = new Set();
  for (let index = 1; index < (rows || []).length; index += 1) {
    const row = rows[index] || [];
    if (text(row[VESSEL_COL.status]).toUpperCase() !== 'OPEN') continue;
    const mmsi = normalizeMmsi(row[VESSEL_COL.mmsi]);
    const imo = normalizeImo(row[VESSEL_COL.imo]);
    if (mmsi) mmsiValues.add(mmsi);
    if (imo) imoValues.add(imo);
  }
  return {
    mmsi: Array.from(mmsiValues).sort(),
    imo: Array.from(imoValues).sort(),
  };
}

function getOpenMmsiFromRows(rows) {
  return getOpenIdentifiersFromRows(rows).mmsi.slice(0, 200);
}

function getOpenImoFromRows(rows) {
  return getOpenIdentifiersFromRows(rows).imo.slice(0, 200);
}

function buildSubscription(apiKey, mmsiValues) {
  return {
    APIKey: apiKey,
    BoundingBoxes: WORLD_BOUNDS,
    FiltersShipMMSI: Array.from(new Set((mmsiValues || []).map(normalizeMmsi).filter(Boolean))).slice(0, 200),
    FilterMessageTypes: ['PositionReport'],
  };
}

function extractPositionEvent(event, receivedAt = new Date().toISOString()) {
  if (!event || event.MessageType !== 'PositionReport') return null;
  const report = event.Message?.PositionReport || {};
  const metadata = event.MetaData || {};
  const mmsi = normalizeMmsi(metadata.MMSI ?? metadata.Mmsi ?? report.UserID);
  const latitude = finiteNumber(report.Latitude ?? metadata.latitude ?? metadata.Latitude);
  const longitude = finiteNumber(report.Longitude ?? metadata.longitude ?? metadata.Longitude);
  if (!mmsi || latitude == null || longitude == null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const rawSpeed = finiteNumber(report.Sog);
  const rawCourse = finiteNumber(report.Cog);
  const rawHeading = finiteNumber(report.TrueHeading);
  return {
    mmsi,
    imo: normalizeImo(metadata.IMO ?? metadata.Imo),
    latitude,
    longitude,
    speedKnots: rawSpeed != null && rawSpeed >= 0 && rawSpeed < 102.3 ? rawSpeed : null,
    courseDegrees: rawCourse != null && rawCourse >= 0 && rawCourse < 360 ? rawCourse : null,
    headingDegrees: rawHeading != null && rawHeading >= 0 && rawHeading <= 359 ? rawHeading : null,
    navigationalStatus: finiteNumber(report.NavigationalStatus),
    shipName: text(metadata.ShipName),
    callSign: text(metadata.CallSign),
    destination: text(metadata.Destination),
    source: 'aisstream',
    sourceTimestamp: text(metadata.time_utc ?? metadata.Time_utc ?? metadata.timeUtc),
    receivedAt,
  };
}

function extractDigitrafficPosition(feature, metadata = {}, fetchedAt = new Date().toISOString()) {
  const properties = feature?.properties || {};
  const coordinates = feature?.geometry?.coordinates;
  const mmsi = normalizeMmsi(feature?.mmsi ?? properties.mmsi ?? metadata.mmsi);
  const longitude = finiteNumber(coordinates?.[0]);
  const latitude = finiteNumber(coordinates?.[1]);
  if (!mmsi || latitude == null || longitude == null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const rawSpeed = finiteNumber(properties.sog);
  const rawCourse = finiteNumber(properties.cog);
  const rawHeading = finiteNumber(properties.heading);
  const externalTimestamp = finiteNumber(properties.timestampExternal);
  const externalDate = externalTimestamp != null ? new Date(externalTimestamp) : null;
  const receivedAt = externalDate && Number.isFinite(externalDate.getTime())
    ? externalDate.toISOString()
    : fetchedAt;

  return {
    mmsi,
    imo: normalizeImo(metadata.imo),
    latitude,
    longitude,
    speedKnots: rawSpeed != null && rawSpeed >= 0 && rawSpeed < 102.3 ? rawSpeed : null,
    courseDegrees: rawCourse != null && rawCourse >= 0 && rawCourse < 360 ? rawCourse : null,
    headingDegrees: rawHeading != null && rawHeading >= 0 && rawHeading <= 359 ? rawHeading : null,
    navigationalStatus: finiteNumber(properties.navStat),
    shipName: text(metadata.name),
    callSign: text(metadata.callSign),
    destination: text(metadata.destination),
    source: 'digitraffic',
    sourceTimestamp: receivedAt,
    receivedAt,
    fetchedAt,
  };
}

function parseMessage(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  } catch (_error) {
    return null;
  }
}

function positionTime(position) {
  const sourceTime = Date.parse(position?.sourceTimestamp);
  if (Number.isFinite(sourceTime)) return sourceTime;
  const receivedTime = Date.parse(position?.receivedAt);
  return Number.isFinite(receivedTime) ? receivedTime : 0;
}

function mergePositionCollections(...collections) {
  const merged = new Map();
  for (const collection of collections) {
    for (const position of collection || []) {
      if (!position?.mmsi) continue;
      const current = merged.get(position.mmsi);
      const nextTime = positionTime(position);
      const currentTime = positionTime(current);
      const winsTie = nextTime === currentTime && position.source === 'aisstream' && current?.source !== 'aisstream';
      if (!current || nextTime > currentTime || winsTie) merged.set(position.mmsi, position);
    }
  }
  return Array.from(merged.values());
}

function prunePositionMap(map, allowed, now) {
  for (const [mmsi, position] of map) {
    const received = positionTime(position);
    if (!allowed.has(mmsi) || !received || now - received > POSITION_MAX_AGE_MS) map.delete(mmsi);
  }
}

function prunePositions(now = Date.now()) {
  const allowed = new Set(desiredMmsi);
  prunePositionMap(positions, allowed, now);
  prunePositionMap(digitrafficPositions, allowed, now);
}

function refreshDesiredMmsi() {
  try {
    const { rows } = loadVesselDatabase();
    const identifiers = getOpenIdentifiersFromRows(rows);
    desiredImo = identifiers.imo.slice(0, 200);
    const mapped = desiredImo.map(imo => digitrafficMmsiByImo.get(imo)).filter(Boolean);
    const next = Array.from(new Set([...identifiers.mmsi, ...mapped])).sort().slice(0, 200);
    const nextKey = next.join(',');
    desiredMmsi = next;
    prunePositions();
    if (nextKey === desiredKey) return false;
    desiredKey = nextKey;
    return true;
  } catch (error) {
    lastError = `DB6 MMSI refresh failed: ${error.message}`;
    return false;
  }
}

function sendSubscription() {
  const apiKey = text(process.env.AISSTREAM_API_KEY);
  if (!apiKey || !desiredMmsi.length || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(buildSubscription(apiKey, desiredMmsi)));
  subscribedKey = desiredKey;
  status = 'subscribing';
}

function scheduleReconnect() {
  if (stopped || reconnectTimer || !text(process.env.AISSTREAM_API_KEY)) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectTimer.unref?.();
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function connect() {
  if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  if (!text(process.env.AISSTREAM_API_KEY)) {
    status = 'disabled';
    return;
  }

  refreshDesiredMmsi();
  if (!desiredMmsi.length) {
    status = 'waiting-for-mmsi';
    scheduleReconnect();
    return;
  }

  status = 'connecting';
  socket = new WebSocket(STREAM_URL, { perMessageDeflate: true, handshakeTimeout: 15000 });

  socket.on('open', () => {
    reconnectDelay = RECONNECT_MIN_MS;
    lastConnectedAt = new Date().toISOString();
    lastError = '';
    sendSubscription();
  });

  socket.on('message', data => {
    const event = parseMessage(data);
    if (!event) return;
    if (event.MessageType === 'SubscriptionConfirmation') {
      status = 'connected';
      return;
    }

    const position = extractPositionEvent(event);
    if (!position || !desiredMmsi.includes(position.mmsi)) return;
    positions.set(position.mmsi, position);
    lastMessageAt = position.receivedAt;
    status = 'connected';
  });

  socket.on('error', error => {
    lastError = text(error?.message).slice(0, 240) || 'AISStream connection error';
    status = 'error';
  });

  socket.on('close', () => {
    socket = null;
    subscribedKey = '';
    if (!stopped) status = 'disconnected';
    scheduleReconnect();
  });
}

async function fetchDigitrafficJson(url, controller) {
  const clientName = text(process.env.DIGITRAFFIC_USER) || 'erp-aastar-trading-sg.trade/live-vessels';
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      Accept: 'application/json',
      'Digitraffic-User': clientName,
      'User-Agent': clientName,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function updateDigitrafficMetadata(records) {
  digitrafficMetadataByMmsi.clear();
  digitrafficMmsiByImo.clear();
  for (const record of records || []) {
    const mmsi = normalizeMmsi(record?.mmsi);
    const imo = normalizeImo(record?.imo);
    if (!mmsi) continue;
    digitrafficMetadataByMmsi.set(mmsi, record);
    if (imo) digitrafficMmsiByImo.set(imo, mmsi);
  }
}

async function refreshDigitraffic() {
  if (stopped || digitrafficInFlight) return;
  digitrafficInFlight = true;
  digitrafficStatus = 'connecting';
  const controller = new AbortController();
  digitrafficController = controller;
  const timeout = setTimeout(() => controller.abort(), DIGITRAFFIC_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const now = Date.now();
    const metadataAge = now - (Date.parse(lastDigitrafficMetadataAt) || 0);
    if (!lastDigitrafficMetadataAt || metadataAge >= DIGITRAFFIC_METADATA_REFRESH_MS) {
      const records = await fetchDigitrafficJson(DIGITRAFFIC_VESSELS_URL, controller);
      if (!Array.isArray(records)) throw new Error('Unexpected vessel metadata response');
      updateDigitrafficMetadata(records);
      lastDigitrafficMetadataAt = new Date().toISOString();
      const changed = refreshDesiredMmsi();
      if (changed && socket?.readyState === WebSocket.OPEN && subscribedKey !== desiredKey) sendSubscription();
    }

    const payload = await fetchDigitrafficJson(DIGITRAFFIC_LOCATIONS_URL, controller);
    if (!Array.isArray(payload?.features)) throw new Error('Unexpected location response');
    const fetchedAt = new Date().toISOString();
    const allowed = new Set(desiredMmsi);
    let newest = '';
    for (const feature of payload.features) {
      const mmsi = normalizeMmsi(feature?.mmsi ?? feature?.properties?.mmsi);
      if (!allowed.has(mmsi)) continue;
      const position = extractDigitrafficPosition(feature, digitrafficMetadataByMmsi.get(mmsi), fetchedAt);
      if (!position) continue;
      digitrafficPositions.set(mmsi, position);
      if (positionTime(position) > positionTime({ receivedAt: newest })) newest = position.receivedAt;
    }
    lastDigitrafficRefreshAt = fetchedAt;
    if (newest) lastDigitrafficMessageAt = newest;
    lastDigitrafficError = '';
    digitrafficStatus = 'connected';
    prunePositions();
  } catch (error) {
    lastDigitrafficError = error?.name === 'AbortError'
      ? 'Digitraffic request timed out'
      : `Digitraffic refresh failed: ${text(error?.message).slice(0, 200)}`;
    digitrafficStatus = 'error';
  } finally {
    clearTimeout(timeout);
    if (digitrafficController === controller) digitrafficController = null;
    digitrafficInFlight = false;
  }
}

function startDigitraffic() {
  if (digitrafficTimer) return;
  refreshDigitraffic();
  digitrafficTimer = setInterval(refreshDigitraffic, DIGITRAFFIC_REFRESH_MS);
  digitrafficTimer.unref?.();
}

function refreshSubscription() {
  const changed = refreshDesiredMmsi();
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    connect();
  } else if (changed && socket.readyState === WebSocket.OPEN && subscribedKey !== desiredKey) {
    sendSubscription();
  }
}

function startAisStream() {
  if (started) return;
  started = true;
  stopped = false;
  refreshDesiredMmsi();
  startDigitraffic();
  refreshTimer = setInterval(refreshSubscription, REFRESH_MS);
  refreshTimer.unref?.();

  if (!text(process.env.AISSTREAM_API_KEY)) {
    status = 'disabled';
    console.warn('AISStream listener disabled: AISSTREAM_API_KEY is not configured; Digitraffic remains enabled');
    return;
  }
  connect();
}

function stopAisStream() {
  stopped = true;
  if (refreshTimer) clearInterval(refreshTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (digitrafficTimer) clearInterval(digitrafficTimer);
  refreshTimer = null;
  reconnectTimer = null;
  digitrafficTimer = null;
  digitrafficController?.abort();
  digitrafficController = null;
  socket?.close();
  socket = null;
  status = 'stopped';
  digitrafficStatus = 'stopped';
}

function getAisSnapshot() {
  prunePositions();
  const mergedPositions = mergePositionCollections(positions.values(), digitrafficPositions.values());
  const newestPosition = mergedPositions.reduce((latest, position) => (
    positionTime(position) > positionTime({ receivedAt: latest }) ? position.receivedAt : latest
  ), '');
  const aisstreamConnected = status === 'connected';
  const digitrafficConnected = digitrafficStatus === 'connected';
  const connected = aisstreamConnected || digitrafficConnected;
  const errors = [lastError, lastDigitrafficError].filter(Boolean).join(' | ');

  return {
    updatedAt: newestPosition || lastMessageAt || lastDigitrafficMessageAt,
    positions: mergedPositions,
    health: {
      status: aisstreamConnected ? 'connected' : (digitrafficConnected ? 'regional-connected' : status),
      connected,
      subscribed: desiredMmsi.length,
      positioned: mergedPositions.length,
      lastConnectedAt: lastConnectedAt || lastDigitrafficRefreshAt,
      lastMessageAt: newestPosition || lastMessageAt || lastDigitrafficMessageAt,
      error: errors,
      sources: {
        aisstream: {
          status,
          connected: aisstreamConnected,
          positioned: positions.size,
          lastConnectedAt,
          lastMessageAt,
          error: lastError,
        },
        digitraffic: {
          status: digitrafficStatus,
          connected: digitrafficConnected,
          positioned: digitrafficPositions.size,
          lastRefreshAt: lastDigitrafficRefreshAt,
          lastMessageAt: lastDigitrafficMessageAt,
          metadataAt: lastDigitrafficMetadataAt,
          error: lastDigitrafficError,
        },
      },
    },
  };
}

module.exports = {
  buildSubscription,
  extractDigitrafficPosition,
  extractPositionEvent,
  getAisSnapshot,
  getOpenImoFromRows,
  getOpenMmsiFromRows,
  mergePositionCollections,
  startAisStream,
  stopAisStream,
};