import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/pages/logistics/VesselStatus.css', import.meta.url), 'utf8');
const component = readFileSync(new URL('../src/pages/logistics/VesselStatus.jsx', import.meta.url), 'utf8');

test('fullscreen vessel table directly fills the viewport width', () => {
  assert.match(css, /\.vessel-status-table-shell\.is-presenting \.vessel-status-table-fit[\s\S]*width: calc\(100vw - 40px\)/);
  assert.match(css, /\.vessel-status-table-shell\.is-presenting \.vessel-status-table-content table[\s\S]*width: 100% !important/);
});

test('fullscreen vessel table scrolls when rows exceed the viewport', () => {
  assert.match(css, /\.vessel-status-table-shell\.is-presenting \.vessel-status-table-stage[\s\S]*overflow: auto/);
});

test('fullscreen vessel table no longer uses transform measurement scaling', () => {
  assert.doesNotMatch(component, /presentationFit|fitVesselStatusScale|useLayoutEffect/);
  assert.doesNotMatch(css, /transform-origin: top left/);
});