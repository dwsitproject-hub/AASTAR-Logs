import test from 'node:test';
import assert from 'node:assert/strict';
import {
  balancePresentationRows,
  buildWeeklyOpsCards,
  buildWeeklyOpsPresentationCards,
  fitPresentationScale,
  relativeCardIndex,
} from '../src/pages/operations/weeklyOpsPresentation.js';

test('balancePresentationRows preserves line order across balanced presentation columns', () => {
  const rows = ['one', 'two', 'three', 'four', 'five'];
  assert.deepEqual(balancePresentationRows(rows, 2), [
    ['one', 'two', 'three'],
    ['four', 'five'],
  ]);
  assert.deepEqual(balancePresentationRows(['one'], 2), [['one']]);
  assert.deepEqual(balancePresentationRows([], 2), [[]]);
});

test('buildWeeklyOpsCards omits empty tables and keeps visible card order', () => {
  const data = {
    tpgLocalDeliveries: [{ id: 'local-1' }],
    glmLocalDeliveries: [],
    tpgImports: [],
    glmImports: [{ id: 'import-1' }],
    exports: {
      tpgGlm: [{ id: 'tpg-export-1' }],
      gr: { executed: [], open: [{ id: 'gr-open-1' }], upcoming: [] },
    },
  };

  assert.deepEqual(
    buildWeeklyOpsCards(data).map(card => card.id),
    ['tpg-local-deliveries', 'glm-imports', 'tpg-glm-exports', 'gr-open-exports'],
  );
});

test('buildWeeklyOpsCards supports legacy response aliases', () => {
  const cards = buildWeeklyOpsCards({
    localDeliveries: [{ id: 'legacy-local' }],
    evac: [{ id: 'legacy-import' }],
    exports: { tpg: [{ id: 'legacy-export' }] },
  });

  assert.deepEqual(cards.map(card => card.id), [
    'tpg-local-deliveries',
    'tpg-imports',
    'tpg-glm-exports',
  ]);
});

test('buildWeeklyOpsCards places unmatched GR vessels after upcoming contracts', () => {
  const cards = buildWeeklyOpsCards({
    exports: {
      gr: {
        executed: [],
        open: [],
        upcoming: [{ id: 'upcoming-1' }],
      },
    },
    grUnmatchedVessels: [{ id: 'vsl_26_1000_1' }],
  });

  assert.deepEqual(cards.map(card => card.id), [
    'gr-upcoming-exports',
    'gr-unmatched-vessels',
  ]);
  assert.equal(cards[1].kind, 'unmatched-vessel');
  assert.equal(cards[1].gapBefore, true);
});

test('buildWeeklyOpsPresentationCards creates one demurrage slide per vessel', () => {
  const cards = [
    { id: 'imports', title: 'Imports', kind: 'import', rows: [{ id: 'import-1' }] },
    {
      id: 'demurrage',
      title: 'Demurrage',
      kind: 'demurrage',
      rows: [
        { id: 'vessel-1', vessel: 'MT FIRST' },
        { id: 'vessel-2', vessel: 'MT SECOND' },
      ],
    },
  ];

  const slides = buildWeeklyOpsPresentationCards(cards);

  assert.deepEqual(slides.map(slide => slide.title), [
    'Imports',
    'Demurrage - MT FIRST',
    'Demurrage - MT SECOND',
  ]);
  assert.deepEqual(slides.map(slide => slide.rows.length), [1, 1, 1]);
});

test('relativeCardIndex wraps in both directions', () => {
  assert.equal(relativeCardIndex(3, 1, 4), 0);
  assert.equal(relativeCardIndex(0, -1, 4), 3);
  assert.equal(relativeCardIndex(0, 1, 0), -1);
});

test('fitPresentationScale enlarges up to 150% and shrinks to fit both axes', () => {
  assert.equal(fitPresentationScale(1800, 900, 1000, 500), 1.5);
  assert.equal(fitPresentationScale(1200, 900, 2400, 500), 0.5);
  assert.equal(fitPresentationScale(1800, 500, 1200, 1000), 0.5);
  assert.equal(fitPresentationScale(0, 900, 1200, 500), 1);
});
