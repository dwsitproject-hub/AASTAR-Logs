// Read-only: vessels and their port-block "slots" (loadport + vsl_id) from the
// SQLite DB6 vessel database, for the vessel/loadport dropdowns on the Vessel Matching tab.
const express = require('express');
const { loadVesselDatabase } = require('../services/vesselUpdate');
const { hasPageAccess, requireAuth } = require('../middleware/auth');

const router = express.Router();
const V = {
  vessel: 4,
  entity: 2,
  base: 19,
  stride: 16,
  blocks: 10,
  vesselOff: { demmRate: 14, laytimeRate: 15, laytimeStarts: 16, remarks: 17, nominated: 18 },
  off: { vslid: 0, port: 1, statusLd: 2, shipper: 3, qty: 5, lCargo: 6, laycan: 8, cr: 9, eta: 10, etb: 12, etc: 14 }
};
const s = (v) => (v == null ? '' : String(v).trim());
const checked = (v) => ['true', 'yes', 'y', '1', 'checked'].includes(s(v).toLowerCase());
function buildVesselSlots(data) {
  const vessels = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!Array.isArray(r)) continue;
    const vessel = s(r[V.vessel]);
    if (!vessel) continue;
    const slots = [];
    const vesselDetails = {
      demmRate: s(r[V.vesselOff.demmRate]),
      laytimeRate: s(r[V.vesselOff.laytimeRate]),
      laytimeStarts: s(r[V.vesselOff.laytimeStarts]),
      remarks: s(r[V.vesselOff.remarks]),
      nominated: checked(r[V.vesselOff.nominated]),
    };
    for (let b = 0; b < V.blocks; b++) {
      const base = V.base + b * V.stride;
      const vslid = s(r[base + V.off.vslid]);
      const loadport = s(r[base + V.off.port]);
      const statusLd = s(r[base + V.off.statusLd]).toLowerCase();
      if (!vslid || !loadport || statusLd !== 'load') continue;
      slots.push({
        loadport,
        vslid,
        qty: s(r[base + V.off.qty]),
        lCargo: s(r[base + V.off.lCargo]),
        shipper: s(r[base + V.off.shipper]),
        laycan: s(r[base + V.off.laycan]),
        cr: s(r[base + V.off.cr]),
        eta: s(r[base + V.off.eta]),
        etb: s(r[base + V.off.etb]),
        etc: s(r[base + V.off.etc]),
      });
    }
    if (slots.length) vessels.push({ vessel, entity: s(r[V.entity]), ...vesselDetails, slots });
  }
  return vessels;
}

router.get('/', requireAuth, (req, res) => {
  if (!hasPageAccess(req.user, '/logistics/vessel-matching')) return res.status(403).json({ error: 'Access denied' });
  const snapshot = loadVesselDatabase();
  const vessels = buildVesselSlots(snapshot.rows || []);
  res.json({ available: true, updatedAt: snapshot.updatedAt || null, source: 'DB6', vessels });
});

module.exports = router;
module.exports.buildVesselSlots = buildVesselSlots;
