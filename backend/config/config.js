const jwtSecret = String(process.env.JWT_SECRET || '');
if (jwtSecret.length < 32 || jwtSecret === 'erp-secret-change-in-production') {
  throw new Error('JWT_SECRET must be a unique random value of at least 32 characters');
}

module.exports = {
  jwtSecret,
  jwtExpiry: process.env.JWT_EXPIRY || '8h',
  cacheRefreshInterval: 15 * 1000, // 15 seconds - eases per-SA quota pressure
  departments: ['commercial', 'operations', 'logistics', 'chartering', 'finance', 'admin']
};
