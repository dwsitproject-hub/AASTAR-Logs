const cleanDigits = value => String(value ?? '').replace(/\D/g, '');

const BASE_OPTIONS = {
  width: '100%',
  height: '600',
  names: 'false',
  track: 'false',
  fleet: 'false',
  fleet_name: 'false',
  fleet_hide_old_positions: 'false',
  clicktoact: 'false',
  store_pos: 'true',
  ra: 'https://erp-aastar-trading-sg.trade/',
};

export function buildVesselFinderMapUrl(vessel, options = {}) {
  const params = new URLSearchParams(BASE_OPTIONS);
  const imo = cleanDigits(vessel?.imo);
  const mmsi = cleanDigits(vessel?.mmsi);

  if (options.names != null) params.set('names', String(Boolean(options.names)));
  if (options.track != null) params.set('track', String(Boolean(options.track)));
  if (options.height != null) params.set('height', String(options.height));

  if (/^\d{7}$/.test(imo) && imo !== '0000000') {
    params.set('zoom', 'undefined');
    params.set('lat', 'undefined');
    params.set('lon', 'undefined');
    params.set('imo', imo);
  } else if (/^\d{9}$/.test(mmsi) && mmsi !== '000000000') {
    params.set('zoom', 'undefined');
    params.set('lat', 'undefined');
    params.set('lon', 'undefined');
    params.set('mmsi', mmsi);
  } else if (vessel?.hasPosition && Number.isFinite(Number(vessel.latitude)) && Number.isFinite(Number(vessel.longitude))) {
    params.set('zoom', '8');
    params.set('lat', Number(vessel.latitude).toFixed(5));
    params.set('lon', Number(vessel.longitude).toFixed(5));
  } else {
    params.set('zoom', '3');
    params.set('lat', '0.00');
    params.set('lon', '0.00');
  }

  return `https://www.vesselfinder.com/aismap?${params.toString()}`;
}
