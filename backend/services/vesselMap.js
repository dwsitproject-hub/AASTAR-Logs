'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB6_PATH = process.env.DATA_DATABASE_DIR
  ? path.join(process.env.DATA_DATABASE_DIR, 'DB6.db')
  : path.join(__dirname, '../data/databases/DB6.db');

let cachedSignature = null;
let cachedPayload = null;

function fileSignature() {
  const stat = fs.statSync(DB6_PATH);
  return `${stat.size}:${stat.mtimeMs}`;
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function coordinate(value, limit) {
  const raw = text(value);
  if (!raw) return null;
  const match = raw.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  let number = Number(match[0]);
  if (!Number.isFinite(number)) return null;
  if (/[SW]/i.test(raw)) number = -Math.abs(number);
  if (Math.abs(number) > limit) return null;
  return number;
}

function loadVesselMap() {
  const signature = fileSignature();
  if (cachedPayload && cachedSignature === signature) return cachedPayload;

  const db = new Database(DB6_PATH, { readonly: true, fileMustExist: true });
  try {
    const records = db.prepare(`
      SELECT
        _sheet_row, vsl_id, entity, vessel, voyage, imo, mmsi,
        status, ops, latitude, longitude, remarks
      FROM vessel_db
      WHERE UPPER(TRIM(COALESCE(status, ''))) = 'OPEN'
        AND TRIM(COALESCE(vessel, '')) <> ''
      ORDER BY CAST(_sheet_row AS INTEGER)
    `).all();
    const metadata = db.prepare('SELECT pulled_at FROM _database_meta LIMIT 1').get();

    const vessels = records.map(record => {
      const latitude = coordinate(record.latitude, 90);
      const longitude = coordinate(record.longitude, 180);
      return {
        row: Number(record._sheet_row) || record._sheet_row,
        vslId: text(record.vsl_id),
        entity: text(record.entity),
        vessel: text(record.vessel),
        voyage: text(record.voyage),
        imo: text(record.imo),
        mmsi: text(record.mmsi),
        status: text(record.status),
        ops: text(record.ops),
        remarks: text(record.remarks),
        latitude,
        longitude,
        hasPosition: latitude !== null && longitude !== null,
      };
    });

    const positioned = vessels.filter(vessel => vessel.hasPosition).length;
    cachedPayload = {
      vessels,
      updatedAt: metadata?.pulled_at || null,
      counts: {
        open: vessels.length,
        positioned,
        missing: vessels.length - positioned,
      },
      options: {
        entities: [...new Set(vessels.map(vessel => vessel.entity).filter(Boolean))].sort(),
        operations: [...new Set(vessels.map(vessel => vessel.ops).filter(Boolean))].sort(),
      },
    };
    cachedSignature = signature;
    return cachedPayload;
  } finally {
    db.close();
  }
}

module.exports = { loadVesselMap };
