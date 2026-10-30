import test from 'node:test';
import assert from 'node:assert/strict';
import { fitExportSummaryScale } from '../src/pages/logistics/exportSummaryPresentation.js';

test('enlarges a small table only to the presentation cap', () => {
  assert.equal(fitExportSummaryScale(1600, 900, 600, 300), 1.5);
});

test('fits a wide table to the available width', () => {
  assert.equal(fitExportSummaryScale(900, 700, 1800, 400), 0.5);
});

test('fits a tall table to the available height', () => {
  assert.equal(fitExportSummaryScale(1400, 500, 700, 1000), 0.5);
});

test('never returns a scale that overflows either dimension', () => {
  const scale = fitExportSummaryScale(1110, 640, 1500, 1200);
  assert.ok(1500 * scale <= 1110);
  assert.ok(1200 * scale <= 640);
});

test('falls back to one for invalid dimensions', () => {
  assert.equal(fitExportSummaryScale(0, 600, 1000, 400), 1);
  assert.equal(fitExportSummaryScale(1000, 600, Number.NaN, 400), 1);
});