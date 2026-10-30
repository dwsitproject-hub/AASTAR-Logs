// Pure helpers + constants shared between StockSummary and the lazy-loaded
// StockChartCard. Kept free of recharts/React so it stays in the light chunk
// and doesn't pull the chart library into the main StockSummary bundle.

export const PALETTE = [
  '#2563eb', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6',
  '#06b6d4', '#ef4444', '#14b8a6', '#a855f7', '#f97316',
  '#22c55e', '#0ea5e9', '#d946ef', '#84cc16', '#6366f1',
  '#dc2626', '#0891b2', '#65a30d', '#7c3aed', '#db2777',
];
export const DEFAULT_STOCK_CARGOES = ['R.POME', 'POMEFAD', 'PFAD', 'ROL', 'CG', 'RG', 'RPOME'];
export const COMBINED_PFAD_PORTS = ['EUP Bontang, ID', 'EUP Tanjung Pura, ID'];
export const COMBINED_PFAD_CARGOES = ['PFAD', 'POMEFAD'];

export function colorFor(key, allKeys) {
  const idx = allKeys.indexOf(key);
  return PALETTE[idx >= 0 ? idx % PALETTE.length : 0];
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Normalize port name for fuzzy matching (stock uses "EUP Bontang, ID"; vessels may use "Bontang")
export function normPort(s) {
  return (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}
export function portsMatch(stockPort, vesselPort) {
  const a = normPort(stockPort), b = normPort(vesselPort);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}
const STOCK_SHIPPERS = new Set(['EUP', 'SPC', 'PMC', 'TPG', 'GLM', 'JPN']);
export function stockPortShipper(stockPort) {
  const first = (stockPort || '').toString().trim().split(/\s+/)[0] || '';
  const shipper = first.replace(/[^a-z0-9]/gi, '').toUpperCase();
  return STOCK_SHIPPERS.has(shipper) ? shipper : '';
}
export function shippersMatch(stockPort, vesselShipper) {
  const expected = stockPortShipper(stockPort);
  if (!expected) return true;
  return (vesselShipper || '').toString().trim().toUpperCase() === expected;
}
// Cargo names can differ in punctuation (e.g. "R.POME" vs "RPOME"). Match on alphanumeric only.
export function normCargo(s) {
  return (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}
export function cargoesMatch(stockCargo, vesselCargo) {
  return normCargo(stockCargo) === normCargo(vesselCargo);
}
export function shouldCombinePfadCargo(portName, cargoName) {
  return COMBINED_PFAD_PORTS.some(port => normPort(port) === normPort(portName))
    && COMBINED_PFAD_CARGOES.some(cargo => normCargo(cargo) === normCargo(cargoName));
}
