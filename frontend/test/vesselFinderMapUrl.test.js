import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVesselFinderMapUrl } from '../src/pages/logistics/vesselFinderMapUrl.js';

test('focuses VesselFinder by IMO before MMSI', () => {
  const url = new URL(buildVesselFinderMapUrl({ imo: '9412725', mmsi: '123456789' }));
  assert.equal(url.searchParams.get('imo'), '9412725');
  assert.equal(url.searchParams.has('mmsi'), false);
  assert.equal(url.searchParams.get('track'), 'false');
  assert.equal(url.searchParams.get('lat'), 'undefined');
});

test('uses MMSI when no valid IMO is available', () => {
  const url = new URL(buildVesselFinderMapUrl({ imo: '', mmsi: '566 554 000' }));
  assert.equal(url.searchParams.get('mmsi'), '566554000');
});

test('uses DB6 coordinates when identifiers are unavailable', () => {
  const url = new URL(buildVesselFinderMapUrl({ hasPosition: true, latitude: 1.234567, longitude: 103.987654 }));
  assert.equal(url.searchParams.get('lat'), '1.23457');
  assert.equal(url.searchParams.get('lon'), '103.98765');
  assert.equal(url.searchParams.get('zoom'), '8');
});

test('mirrors VesselFinder required embed parameters for the world map', () => {
  const url = new URL(buildVesselFinderMapUrl(null));
  assert.equal(url.origin, 'https://www.vesselfinder.com');
  assert.equal(url.pathname, '/aismap');
  assert.equal(url.searchParams.get('lat'), '0.00');
  assert.equal(url.searchParams.get('lon'), '0.00');
  assert.equal(url.searchParams.get('zoom'), '3');
  assert.equal(url.searchParams.get('width'), '100%');
  assert.equal(url.searchParams.get('height'), '600');
  assert.equal(url.searchParams.get('names'), 'false');
  assert.equal(url.searchParams.get('fleet'), 'false');
  assert.equal(url.searchParams.get('clicktoact'), 'false');
  assert.equal(url.searchParams.get('store_pos'), 'true');
});

test('enables vessel names and 24-hour track for the live vessel panel', () => {
  const url = new URL(buildVesselFinderMapUrl({ imo: '9506291' }, {
    names: true,
    track: true,
    height: 560,
  }));

  assert.equal(url.searchParams.get('imo'), '9506291');
  assert.equal(url.searchParams.get('names'), 'true');
  assert.equal(url.searchParams.get('track'), 'true');
  assert.equal(url.searchParams.get('height'), '560');
});
