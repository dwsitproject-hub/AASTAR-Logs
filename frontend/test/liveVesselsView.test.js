import test from 'node:test';
import assert from 'node:assert/strict';

import { getLaycanMonthGroup, groupVesselsByLaycan } from '../src/pages/logistics/liveVesselsView.js';

test('groups vessels by the first month in the laycan range', () => {
  const groups = groupVesselsByLaycan([
    { vslId: 'NOV', laycan: '2 NOV - 8 NOV' },
    { vslId: 'SEP', laycan: '28 SEP - 5 OCT' },
    { vslId: 'OCT', laycan: '10 OCT - 15 OCT' },
  ], '2026-10-07T00:00:00Z');

  assert.deepEqual(groups.map(group => group.label), ['SEP', 'OCT', 'NOV']);
  assert.deepEqual(groups.map(group => group.vessels[0].vslId), ['SEP', 'OCT', 'NOV']);
});

test('sorts a new-year January laycan after December', () => {
  const groups = groupVesselsByLaycan([
    { vslId: 'JAN', laycan: '5 JAN - 10 JAN' },
    { vslId: 'DEC', laycan: '12 DEC - 18 DEC' },
  ], '2026-10-07T00:00:00Z');

  assert.deepEqual(groups.map(group => group.label), ['DEC', 'JAN 2027']);
});

test('places missing laycan values in a final TBA group', () => {
  const group = getLaycanMonthGroup('', '2026-10-07T00:00:00Z');
  assert.equal(group.key, 'TBA');
  assert.equal(group.label, 'TBA');
});
