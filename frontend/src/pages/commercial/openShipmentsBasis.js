const normalize = value => (value == null ? '' : String(value).trim().toUpperCase());

export function getShipmentBasis(row) {
  const dischargePorts = Array.isArray(row?.dischargePorts) ? row.dischargePorts : [];
  const hasFobDischarge = dischargePorts.some(discharge => {
    const port = discharge && typeof discharge === 'object' ? discharge.port : discharge;
    return normalize(port) === 'FOB';
  });

  return hasFobDischarge ? 'FOB' : 'CIF';
}
