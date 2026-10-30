'use strict';

// Sources sharing the same spreadsheet and service account are combined into
// one batchGet per refresh cycle, even when they are stored as separate DBs.
// These databases are independent from backend/data/erp.db.
const AASTAR_SALES_SHEET = '1X6OvPtLKVGHF9xRXI4e_tdc4r9pmEaIAK9Zn39y3dyQ';
const GR_SHEET = '13XZPJzG8TeTplzhQr7KdhlGtOc26R-stiwgESX9Djfs';
const VESSEL_SHEET = '1mF8twQ64KUYnGHhf_6Y9qFjGIdPRfBliBfs_JKDnOWQ';
const STOCK_SHEET = '1XrLZ0oV7U1LCljdxk3wXbPBoxKOxos0Uj6uAl5XD1gA';
const SHIPMENT_DETAILS_SHEET = '18ernaHHSRqYZu8CbPiAsnnYdwm2feDW8OjVkDGzSMD0';
const TPG_OPERATIONS_SHEET = '1bnAaz4GO6jU4j-13HL_v4PT4evY5lFauhBT1aZ3LVfk';

const VESSEL_LINK_CONFIG = {
  parent: {
    database: 'DB6',
    table: 'vessel_db',
    rowColumn: '_sheet_row',
    columns: ['vslid_1', 'vslid_2', 'vslid_3', 'vslid_4', 'vslid_5', 'vslid_6', 'vslid_7', 'vslid_8', 'vslid_9', 'vslid_10'],
  },
  children: [
    { database: 'DB1', table: 'aastar_sales_with_shadow', rowColumn: '_sales_row', column: 'sales_vsl_id', matchIdColumn: 'sales_erp_match_id', sourceTab: 'AASTAR SALES' },
    { database: 'DB2', table: 'aastar_purchase_with_shadow', rowColumn: '_purchase_row', column: 'purchase_vsl_id', matchIdColumn: 'purchase_erp_match_id', sourceTab: 'AASTAR PURCHASE' },
    { database: 'DB3', table: 'kimara_sales_with_shadow', rowColumn: '_kimara_sales_row', column: 'kimara_sales_vsl_id', matchIdColumn: 'kimara_sales_erp_match_id', sourceTab: 'KIMARA SALES' },
    { database: 'DB4', table: 'kimara_purchase_with_shadow', rowColumn: '_kimara_purchase_row', column: 'kimara_purchase_vsl_id', matchIdColumn: 'kimara_purchase_erp_match_id', sourceTab: 'KIMARA PURCHASE' },
    { database: 'DB5', table: 'main_shipment_file_with_shadow_gr', rowColumn: '_main_row', column: 'main_vsl_id_2', matchIdColumn: 'main_erp_match_id', sourceTab: 'MAIN SHIPMENT FILE' },
  ],
};

const DERIVED_DATABASES = [
  { name: 'VESSEL_LINKS', fileName: 'vessel_links.db', kind: 'derived', layout: 'graph', sources: [] },
];

const DATA_DATABASES = [
  {
    name: 'DB1',
    sheetId: AASTAR_SALES_SHEET,
    serviceAccountEmail: 'aastar-sales@robust-chess-498206-r3.iam.gserviceaccount.com',
    layout: 'side-by-side',
    combinedTable: 'AASTAR_SALES_WITH_SHADOW',
    fillDown: { from: 'sales_shpt_year', to: 'sales_partial_qty', exclude: ['sales_vsl_id'] },
    identifierColumns: ['sales_vsl_id'],
    displayOrder: 'desc',
    displayOrderColumn: '_sales_row',
    sources: [
      { table: 'AASTAR_SALES', tab: 'AASTAR SALES', range: 'A:AU', prefix: 'sales_', matchIdColumn: 'sales_erp_match_id', legacyVslColumn: 'sales_vsl_id' },
      { table: 'SHADOW', tab: 'Shadow', range: 'A:C', prefix: 'shadow_' },
    ],
  },
  {
    name: 'DB2',
    sheetId: AASTAR_SALES_SHEET,
    serviceAccountEmail: 'aastar-sales@robust-chess-498206-r3.iam.gserviceaccount.com',
    layout: 'side-by-side',
    combinedTable: 'AASTAR_PURCHASE_WITH_SHADOW',
    fillDown: { from: 'purchase_shpt_year', to: 'purchase_partial_qty', exclude: ['purchase_vsl_id'] },
    identifierColumns: ['purchase_vsl_id'],
    displayOrder: 'desc',
    displayOrderColumn: '_purchase_row',
    sources: [
      { table: 'AASTAR_PURCHASE', tab: 'AASTAR PURCHASE', range: 'A:AK', prefix: 'purchase_', matchIdColumn: 'purchase_erp_match_id', legacyVslColumn: 'purchase_vsl_id' },
      { table: 'SHADOW', tab: 'Shadow', range: 'D:F', prefix: 'shadow_' },
    ],
  },
  {
    name: 'DB3',
    sheetId: AASTAR_SALES_SHEET,
    serviceAccountEmail: 'aastar-sales@robust-chess-498206-r3.iam.gserviceaccount.com',
    layout: 'side-by-side',
    combinedTable: 'KIMARA_SALES_WITH_SHADOW',
    fillDown: { from: 'kimara_sales_year', to: 'kimara_sales_partial_qty', exclude: ['kimara_sales_vsl_id'] },
    identifierColumns: ['kimara_sales_vsl_id'],
    displayOrder: 'desc',
    displayOrderColumn: '_kimara_sales_row',
    sources: [
      { table: 'KIMARA_SALES', tab: 'KIMARA SALES', range: 'A:AQ', prefix: 'kimara_sales_', matchIdColumn: 'kimara_sales_erp_match_id', legacyVslColumn: 'kimara_sales_vsl_id' },
      { table: 'SHADOW', tab: 'Shadow', range: 'G:I', prefix: 'shadow_' },
    ],
  },
  {
    name: 'DB4',
    sheetId: AASTAR_SALES_SHEET,
    serviceAccountEmail: 'aastar-sales@robust-chess-498206-r3.iam.gserviceaccount.com',
    layout: 'side-by-side',
    combinedTable: 'KIMARA_PURCHASE_WITH_SHADOW',
    fillDown: { from: 'kimara_purchase_year', to: 'kimara_purchase_partial_qty', exclude: ['kimara_purchase_vsl_id'] },
    identifierColumns: ['kimara_purchase_vsl_id'],
    displayOrder: 'desc',
    displayOrderColumn: '_kimara_purchase_row',
    sources: [
      { table: 'KIMARA_PURCHASE', tab: 'KIMARA PURCHASE', range: 'A:AK', prefix: 'kimara_purchase_', matchIdColumn: 'kimara_purchase_erp_match_id', legacyVslColumn: 'kimara_purchase_vsl_id' },
      { table: 'SHADOW', tab: 'Shadow', range: 'J:L', prefix: 'shadow_' },
    ],
  },
  {
    name: 'DB5',
    sheetId: GR_SHEET,
    serviceAccountEmail: 'grsalesandpurchase@robust-chess-498206-r3.iam.gserviceaccount.com',
    layout: 'side-by-side',
    combinedTable: 'MAIN_SHIPMENT_FILE_WITH_SHADOW_GR',
    fillDown: { from: 'main_year', to: 'main_partial_qty', exclude: ['main_ref', 'main_vsl_id', 'main_vsl_id_2'] },
    identifierColumns: ['main_vsl_id_2'],
    displayOrder: 'desc',
    displayOrderColumn: '_main_row',
    sources: [
      { table: 'MAIN_SHIPMENT_FILE', tab: 'MAIN SHIPMENT FILE', range: 'A:BN', prefix: 'main_', matchIdColumn: 'main_erp_match_id', legacyVslColumn: 'main_vsl_id_2' },
      { table: 'SHADOW_GR', tab: 'Shadow GR', range: 'A:E', prefix: 'shadow_gr_' },
    ],
  },
  {
    name: 'DB6',
    sheetId: VESSEL_SHEET,
    serviceAccountEmail: 'vessel-vs-contract-2-0@robust-chess-498206-r3.iam.gserviceaccount.com',
    identifierColumns: ['vslid_1', 'vslid_2', 'vslid_3', 'vslid_4', 'vslid_5', 'vslid_6', 'vslid_7', 'vslid_8', 'vslid_9', 'vslid_10'],
    sources: [{ table: 'VESSEL_DB', tab: 'VESSEL DB', range: 'A:FX' }],
  },
  {
    name: 'DB7',
    sheetId: VESSEL_SHEET,
    serviceAccountEmail: 'vessel-vs-contract-2-0@robust-chess-498206-r3.iam.gserviceaccount.com',
    sources: [{ table: 'EOM', tab: 'EOM', range: 'A:R' }],
  },
  {
    name: 'DB8',
    sheetId: VESSEL_SHEET,
    serviceAccountEmail: 'vessel-vs-contract-2-0@robust-chess-498206-r3.iam.gserviceaccount.com',
    sources: [{ table: 'ABV', tab: 'ABV', range: 'A:C' }],
  },
  {
    name: 'DB9',
    sheetId: STOCK_SHEET,
    serviceAccountEmail: 'kpn-stock@second-kiln-500409-a0.iam.gserviceaccount.com',
    layout: 'raw-grid',
    sources: [{ table: 'STOCK_MONTHLY', tab: 'Monthly', range: 'A:N' }],
  },
  {
    // The durable source of truth for contract-to-vessel assignments. It lives
    // alongside the Aastar contract tabs so the same service account can
    // maintain it without introducing another polling group.
    name: 'DB10',
    sheetId: AASTAR_SALES_SHEET,
    serviceAccountEmail: 'aastar-sales@robust-chess-498206-r3.iam.gserviceaccount.com',
    sources: [{ table: 'VESSEL_LINKS_SOURCE', tab: 'Vessel Links', range: 'A:J' }],
  },
  {
    name: 'DB11',
    sheetId: SHIPMENT_DETAILS_SHEET,
    serviceAccountEmail: 'tpgsalesandpurchase@robust-chess-498206-r3.iam.gserviceaccount.com',
    sources: [{ table: 'SHPT_DETAILS', tab: 'Shpt Details', range: 'A:BC' }],
  },
  {
    name: 'DB12',
    sheetId: TPG_OPERATIONS_SHEET,
    serviceAccountEmail: 'palmshptfile@robust-chess-498206-r3.iam.gserviceaccount.com',
    sources: [{ table: 'TPG_IMPORTS', tab: 'TPG IMPORTS', range: 'A:V' }],
  },
  {
    name: 'DB13',
    sheetId: TPG_OPERATIONS_SHEET,
    serviceAccountEmail: 'palmshptfile@robust-chess-498206-r3.iam.gserviceaccount.com',
    sources: [{ table: 'TPG_LOCAL_PURCHASE', tab: 'TPG LOCAL PURCHASE', range: 'A:AM' }],
  },
  {
    name: 'DB14',
    sheetId: TPG_OPERATIONS_SHEET,
    serviceAccountEmail: 'palmshptfile@robust-chess-498206-r3.iam.gserviceaccount.com',
    sources: [{ table: 'TPG_LOCAL_SALES', tab: 'TPG LOCAL SALES', range: 'A:AD' }],
  },
  {
    name: 'DB15',
    sheetId: TPG_OPERATIONS_SHEET,
    serviceAccountEmail: 'palmshptfile@robust-chess-498206-r3.iam.gserviceaccount.com',
    sources: [{ table: 'GLM_IMPORTS', tab: 'GLM IMPORTS', range: 'A:L' }],
  },
  {
    name: 'DB16',
    sheetId: TPG_OPERATIONS_SHEET,
    serviceAccountEmail: 'palmshptfile@robust-chess-498206-r3.iam.gserviceaccount.com',
    sources: [{ table: 'GLM_LOCAL_PURCHASE', tab: 'GLM LOCAL PURCHASE', range: 'A:AM' }],
  },
  {
    name: 'DB17',
    sheetId: TPG_OPERATIONS_SHEET,
    serviceAccountEmail: 'palmshptfile@robust-chess-498206-r3.iam.gserviceaccount.com',
    sources: [{ table: 'GLM_LOCAL_SALES', tab: 'GLM LOCAL SALES', range: 'A:AD' }],
  },
];

const BULK_SYNC_INTERVAL_MS = 15 * 1000;

module.exports = { DATA_DATABASES, DERIVED_DATABASES, VESSEL_LINK_CONFIG, BULK_SYNC_INTERVAL_MS };
