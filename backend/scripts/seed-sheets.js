#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getDb, initDb } = require('../db/database');

const CONFIGS = [
  // vesselvscontract20 (SA #7) — Sheet: 1mF8twQ64KUYnGHhf_6Y9qFjGIdPRfBliBfs_JKDnOWQ
  { sheet_id: '1mF8twQ64KUYnGHhf_6Y9qFjGIdPRfBliBfs_JKDnOWQ', sheet_name: 'Vessel vs Contract', tab_name: 'Matching',    department: 'logistics',   sa: 7, range: 'A:AZ' },
  { sheet_id: '1mF8twQ64KUYnGHhf_6Y9qFjGIdPRfBliBfs_JKDnOWQ', sheet_name: 'Vessel vs Contract', tab_name: 'Matching',    department: 'operations',  sa: 7, range: 'A:AZ' },
  { sheet_id: '1mF8twQ64KUYnGHhf_6Y9qFjGIdPRfBliBfs_JKDnOWQ', sheet_name: 'Vessel vs Contract', tab_name: 'VESSEL DB',   department: 'logistics',   sa: 7, range: 'A:EF' },
  { sheet_id: '1mF8twQ64KUYnGHhf_6Y9qFjGIdPRfBliBfs_JKDnOWQ', sheet_name: 'Vessel vs Contract', tab_name: 'VESSEL DB',   department: 'operations',  sa: 7, range: 'A:EF' },
  { sheet_id: '1mF8twQ64KUYnGHhf_6Y9qFjGIdPRfBliBfs_JKDnOWQ', sheet_name: 'Vessel vs Contract', tab_name: 'VESSEL DB',   department: 'chartering',  sa: 7, range: 'A:EF' },
  { sheet_id: '1mF8twQ64KUYnGHhf_6Y9qFjGIdPRfBliBfs_JKDnOWQ', sheet_name: 'Vessel vs Contract', tab_name: 'ABV',         department: 'logistics',   sa: 7, range: 'A:G'  },
  { sheet_id: '1mF8twQ64KUYnGHhf_6Y9qFjGIdPRfBliBfs_JKDnOWQ', sheet_name: 'Vessel vs Contract', tab_name: 'EOM',         department: 'logistics',   sa: 7, range: 'A:Z'  },
  // aastarsales (SA #1) — Sheet: 1X6OvPtLKVGHF9xRXI4e_tdc4r9pmEaIAK9Zn39y3dyQ
  { sheet_id: '1X6OvPtLKVGHF9xRXI4e_tdc4r9pmEaIAK9Zn39y3dyQ', sheet_name: 'Aastar Sales',      tab_name: 'AASTAR SALES',     department: 'logistics',  sa: 1, range: 'A:AS' },
  { sheet_id: '1X6OvPtLKVGHF9xRXI4e_tdc4r9pmEaIAK9Zn39y3dyQ', sheet_name: 'Aastar Sales',      tab_name: 'AASTAR SALES',     department: 'operations', sa: 1, range: 'A:AS' },
  // aastarpurchase (SA #0)
  { sheet_id: '1X6OvPtLKVGHF9xRXI4e_tdc4r9pmEaIAK9Zn39y3dyQ', sheet_name: 'Aastar Purchase',   tab_name: 'AASTAR PURCHASE',  department: 'logistics',  sa: 0, range: 'A:AH' },
  { sheet_id: '1X6OvPtLKVGHF9xRXI4e_tdc4r9pmEaIAK9Zn39y3dyQ', sheet_name: 'Aastar Purchase',   tab_name: 'AASTAR PURCHASE',  department: 'operations', sa: 0, range: 'A:AH' },
  // kimarasales (SA #4)
  { sheet_id: '1X6OvPtLKVGHF9xRXI4e_tdc4r9pmEaIAK9Zn39y3dyQ', sheet_name: 'Kimara Sales',      tab_name: 'KIMARA SALES',     department: 'logistics',  sa: 4, range: 'A:AN' },
  { sheet_id: '1X6OvPtLKVGHF9xRXI4e_tdc4r9pmEaIAK9Zn39y3dyQ', sheet_name: 'Kimara Sales',      tab_name: 'KIMARA SALES',     department: 'operations', sa: 4, range: 'A:AN' },
  // kimarapurchase (SA #3)
  { sheet_id: '1X6OvPtLKVGHF9xRXI4e_tdc4r9pmEaIAK9Zn39y3dyQ', sheet_name: 'Kimara Purchase',   tab_name: 'KIMARA PURCHASE',  department: 'logistics',  sa: 3, range: 'A:AK' },
  { sheet_id: '1X6OvPtLKVGHF9xRXI4e_tdc4r9pmEaIAK9Zn39y3dyQ', sheet_name: 'Kimara Purchase',   tab_name: 'KIMARA PURCHASE',  department: 'operations', sa: 3, range: 'A:AK' },
  // grsalesandpurchase (SA #2) — Sheet: 13XZPJzG8TeTplzhQr7KdhlGtOc26R-stiwgESX9Djfs
  { sheet_id: '13XZPJzG8TeTplzhQr7KdhlGtOc26R-stiwgESX9Djfs', sheet_name: 'GR Shipment', tab_name: 'MAIN SHIPMENT FILE', department: 'logistics',  sa: 2, range: 'A:BL' },
  { sheet_id: '13XZPJzG8TeTplzhQr7KdhlGtOc26R-stiwgESX9Djfs', sheet_name: 'GR Shipment', tab_name: 'MAIN SHIPMENT FILE', department: 'operations', sa: 2, range: 'A:BL' },
  { sheet_id: '13XZPJzG8TeTplzhQr7KdhlGtOc26R-stiwgESX9Djfs', sheet_name: 'GR Shipment', tab_name: 'SHPT SPECS',         department: 'logistics',  sa: 2, range: 'A:HD' },
  { sheet_id: '13XZPJzG8TeTplzhQr7KdhlGtOc26R-stiwgESX9Djfs', sheet_name: 'GR Shipment', tab_name: 'SHPT SPECS',         department: 'operations', sa: 2, range: 'A:HD' },
  { sheet_id: '13XZPJzG8TeTplzhQr7KdhlGtOc26R-stiwgESX9Djfs', sheet_name: 'GR Shipment', tab_name: 'SHPT FILE',          department: 'logistics',  sa: 2, range: 'A:AB' },
  { sheet_id: '13XZPJzG8TeTplzhQr7KdhlGtOc26R-stiwgESX9Djfs', sheet_name: 'GR Shipment', tab_name: 'SHPT FILE',          department: 'operations', sa: 2, range: 'A:AB' },
  // tpgsalesandpurchase (SA #6) — Sheet: 1bnAaz4GO6jU4j-13HL_v4PT4evY5lFauhBT1aZ3LVfk
  { sheet_id: '1bnAaz4GO6jU4j-13HL_v4PT4evY5lFauhBT1aZ3LVfk', sheet_name: 'TPG', tab_name: 'TPG LOCAL PURCHASE', department: 'logistics',  sa: 6, range: 'A:AD' },
  { sheet_id: '1bnAaz4GO6jU4j-13HL_v4PT4evY5lFauhBT1aZ3LVfk', sheet_name: 'TPG', tab_name: 'TPG LOCAL PURCHASE', department: 'operations', sa: 6, range: 'A:AD' },
  { sheet_id: '1bnAaz4GO6jU4j-13HL_v4PT4evY5lFauhBT1aZ3LVfk', sheet_name: 'TPG', tab_name: 'TPG LOCAL SALES',    department: 'logistics',  sa: 6, range: 'A:AD' },
  { sheet_id: '1bnAaz4GO6jU4j-13HL_v4PT4evY5lFauhBT1aZ3LVfk', sheet_name: 'TPG', tab_name: 'TPG LOCAL SALES',    department: 'operations', sa: 6, range: 'A:AD' },
  // palmshptfile (SA #5) — Sheet: 18ernaHHSRqYZu8CbPiAsnnYdwm2feDW8OjVkDGzSMD0
  { sheet_id: '18ernaHHSRqYZu8CbPiAsnnYdwm2feDW8OjVkDGzSMD0', sheet_name: 'Palm Shipment', tab_name: 'Shpt Details', department: 'logistics',  sa: 5, range: 'A:BB' },
  { sheet_id: '18ernaHHSRqYZu8CbPiAsnnYdwm2feDW8OjVkDGzSMD0', sheet_name: 'Palm Shipment', tab_name: 'Shpt Details', department: 'operations', sa: 5, range: 'A:BB' },
  { sheet_id: '18ernaHHSRqYZu8CbPiAsnnYdwm2feDW8OjVkDGzSMD0', sheet_name: 'Palm Shipment', tab_name: 'Shpt Details', department: 'finance',    sa: 5, range: 'A:BB' },
];

initDb();
const db = getDb();
const existing = db.prepare('SELECT COUNT(*) as c FROM sheets_config').get();
if (existing.c > 0) {
  console.log(`sheets_config already has ${existing.c} rows. Skipping seed.`);
  console.log('To re-seed, run: DELETE FROM sheets_config; then re-run this script.');
  process.exit(0);
}

const insert = db.prepare(
  'INSERT INTO sheets_config (sheet_id, sheet_name, tab_name, department, service_account_index, range) VALUES (?, ?, ?, ?, ?, ?)'
);
const seedAll = db.transaction(() => {
  for (const c of CONFIGS) {
    insert.run(c.sheet_id, c.sheet_name, c.tab_name, c.department, c.sa, c.range);
  }
});
seedAll();
console.log(`Seeded ${CONFIGS.length} sheet configurations successfully.`);

