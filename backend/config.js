module.exports = {
  jwtSecret: process.env.JWT_SECRET || 'erp-secret-change-in-production',
  jwtExpiry: '8h',
  cacheRefreshInterval: 15 * 1000, // 15 seconds - eases per-SA quota pressure
  departments: ['commercial', 'operations', 'logistics', 'chartering', 'finance', 'admin']
};
