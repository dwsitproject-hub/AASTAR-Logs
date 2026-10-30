'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { getVesselMatchingData, saveVesselMatching } = require('./vesselMatching');
const { loadVesselDatabase } = require('./vesselUpdate');

const DATA_DIR = process.env.DATA_DATABASE_DIR || path.join(__dirname, '../data/databases');
const PORT_BASE = 19;
const PORT_STRIDE = 16;
const PORT_COUNT = 10;

function str(value) { return value == null ? '' : String(value).trim(); }
function canonical(value) { return str(value).replace(/\u00a0/g, ' ').replace(/\s+/g, '').toUpperCase(); }
function realVslId(value) {
  const id = canonical(value);
  return id && id !== 'VSL_00_0000' ? id : '';
}
function active(value) {
  return ['true', 'yes', 'y', '1', 'active'].includes(str(value).toLowerCase());
}

function vesselSlots(rows) {
  const result = new Map();
  for (const row of (rows || []).slice(1)) {
    if (!Array.isArray(row)) continue;
    const vessel = str(row[4]);
    const entity = str(row[2]);
    for (let index = 0; index < PORT_COUNT; index += 1) {
      const base = PORT_BASE + index * PORT_STRIDE;
      const vslId = realVslId(row[base]);
      if (!vslId) continue;
      result.set(vslId, {
        vessel,
        entity,
        loadport: str(row[base + 1]),
        shipper: str(row[base + 3]),
        vesselCargo: str(row[base + 6]),
      });
    }
  }
  return result;
}

function latestLedgerRows(rows) {
  const latest = new Map();
  for (const row of [...(rows || [])].sort((a, b) => Number(a._sheet_row) - Number(b._sheet_row))) {
    const matchId = canonical(row.match_id);
    if (matchId) latest.set(matchId, row);
  }
  return latest;
}

function buildActiveContractLinks(matchingData, vesselRows, ledgerRows, { q = '', offset = 0, limit = 100 } = {}) {
  const slots = vesselSlots(vesselRows);
  const ledger = latestLedgerRows(ledgerRows);
  const query = str(q).toLowerCase();
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const safeLimit = Math.min(500, Math.max(20, Number.parseInt(limit, 10) || 100));
  const allRows = [];

  for (const [sourceTab, tab] of Object.entries(matchingData?.tabs || {})) {
    for (const row of tab.rows || []) {
      const vslId = realVslId(row.vsl_id);
      const matchId = str(row.match_id);
      const matchKey = canonical(matchId);
      const assignment = ledger.get(matchKey);
      if (!vslId || !matchKey || !assignment || !active(assignment.active) || realVslId(assignment.vsl_id) !== vslId) continue;
      const slot = slots.get(vslId) || {};
      const isPartial = str(row.partial).toUpperCase().includes('PARTIAL');
      const record = {
        key: `${sourceTab}:${matchKey}`,
        sourceTab,
        sourceRow: Number(row._row) || 0,
        matchId,
        ref: str(row.ref),
        contractNo: str(row.contract_no),
        counterparty: str(row.buyer),
        cargo: str(row.cargo) || slot.vesselCargo || '',
        qty: str(isPartial && row.partial_qty ? row.partial_qty : row.qty),
        status: str(row.status),
        intentionVessel: str(row.intention_vessel),
        vessel: slot.vessel || str(row.intention_vessel) || 'Unknown vessel',
        entity: slot.entity || '',
        vslId,
        loadport: slot.loadport || str(row.load_port),
        shipper: slot.shipper || '',
        isPartial,
        linkedAt: str(assignment.updated_at || assignment.created_at),
        linkedBy: str(assignment.updated_by),
      };
      const haystack = Object.values(record).join(' ').toLowerCase();
      if (!query || haystack.includes(query)) allRows.push(record);
    }
  }

  allRows.sort((a, b) => String(b.linkedAt).localeCompare(String(a.linkedAt))
    || b.sourceRow - a.sourceRow || a.sourceTab.localeCompare(b.sourceTab));
  const sourceCounts = allRows.reduce((counts, row) => {
    counts[row.sourceTab] = (counts[row.sourceTab] || 0) + 1;
    return counts;
  }, {});
  const page = allRows.slice(safeOffset, safeOffset + safeLimit);
  return {
    rows: page,
    sourceCounts,
    updatedAt: matchingData?.updatedAt || null,
    pagination: {
      offset: safeOffset,
      limit: safeLimit,
      total: allRows.length,
      nextOffset: safeOffset + page.length < allRows.length ? safeOffset + page.length : null,
      hasMore: safeOffset + page.length < allRows.length,
    },
  };
}

function readLedgerRows() {
  const db = new Database(path.join(DATA_DIR, 'DB10.db'), { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT * FROM vessel_links_source ORDER BY CAST(_sheet_row AS INTEGER)').all();
  } finally {
    db.close();
  }
}

function listActiveContractLinks(options) {
  const matching = getVesselMatchingData();
  const vessel = loadVesselDatabase();
  return buildActiveContractLinks(matching, vessel.rows || [], readLedgerRows(), options);
}

async function unlinkActiveContract({ matchId, expectedVslId }) {
  const id = canonical(matchId);
  const expected = realVslId(expectedVslId);
  if (!id || !expected) throw Object.assign(new Error('Contract link identity is required'), { statusCode: 400 });
  const current = buildActiveContractLinks(getVesselMatchingData(), loadVesselDatabase().rows || [], readLedgerRows(), { q: id, limit: 20 });
  const link = current.rows.find(row => canonical(row.matchId) === id);
  if (!link) throw Object.assign(new Error('This contract is no longer actively linked. Refresh and try again.'), { statusCode: 409 });
  if (link.vslId !== expected) throw Object.assign(new Error('This contract was reassigned. Refresh before unlinking.'), { statusCode: 409 });
  const result = await saveVesselMatching({
    tab: link.sourceTab,
    row: link.sourceRow,
    value: '',
    expectedRef: link.ref,
    expectedMatchId: link.matchId,
    expectedAssignedVslId: expected,
  });
  return { ...result, contract: link.contractNo || link.ref, previousVslId: expected };
}

module.exports = { buildActiveContractLinks, listActiveContractLinks, unlinkActiveContract };
