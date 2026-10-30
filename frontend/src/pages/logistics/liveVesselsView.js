const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_PATTERN = /\b(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\b/i;
const HALF_YEAR_MS = 183 * 24 * 60 * 60 * 1000;

const clean = value => (value == null ? '' : String(value).trim());

export function getLaycanMonthGroup(laycan, referenceValue) {
  const value = clean(laycan).toUpperCase();
  const reference = new Date(referenceValue || Date.now());
  const safeReference = Number.isNaN(reference.getTime()) ? new Date() : reference;
  const match = MONTH_PATTERN.exec(value);

  if (!match) {
    return { key: 'TBA', label: 'TBA', sortValue: Number.MAX_SAFE_INTEGER };
  }

  const month = match[1].slice(0, 3);
  const monthIndex = MONTHS.indexOf(month);
  const dayMatch = value.slice(0, match.index).match(/(\d{1,2})\s*$/);
  const day = Math.min(Math.max(Number(dayMatch?.[1]) || 1, 1), 28);
  const explicitYearMatch = value.match(/\b(20\d{2})\b/);
  const hasExplicitYear = Boolean(explicitYearMatch);
  let year = hasExplicitYear ? Number(explicitYearMatch[1]) : safeReference.getUTCFullYear();
  let dateValue = Date.UTC(year, monthIndex, day);

  if (!hasExplicitYear && dateValue < safeReference.getTime() - HALF_YEAR_MS) {
    year += 1;
    dateValue = Date.UTC(year, monthIndex, day);
  }

  return {
    key: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    label: year === safeReference.getUTCFullYear() ? month : `${month} ${year}`,
    sortValue: dateValue,
  };
}

export function groupVesselsByLaycan(vessels, referenceValue) {
  const groups = new Map();

  for (const vessel of vessels || []) {
    const month = getLaycanMonthGroup(vessel.laycan, referenceValue);
    if (!groups.has(month.key)) groups.set(month.key, { ...month, vessels: [] });
    groups.get(month.key).vessels.push(vessel);
  }

  return Array.from(groups.values()).sort((left, right) => left.sortValue - right.sortValue);
}
