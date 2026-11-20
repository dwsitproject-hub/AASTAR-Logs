export function buildWeeklyOpsCards(data) {
  const cards = [
    { id: 'tpg-local-deliveries', title: 'TPG Local Deliveries', note: 'Open local purchase and sales commitments', kind: 'local', rows: data?.tpgLocalDeliveries || data?.localDeliveries || [] },
    { id: 'glm-local-deliveries', title: 'GLM Local Deliveries', note: 'Open local purchase and sales commitments', kind: 'local', rows: data?.glmLocalDeliveries || [] },
    { id: 'tpg-imports', title: 'TPG Imports', note: 'Open import and evacuation movements', kind: 'import', rows: data?.tpgImports || data?.evac || [] },
    { id: 'glm-imports', title: 'GLM Imports', note: 'Open import and evacuation movements', kind: 'import', rows: data?.glmImports || [] },
    { id: 'tpg-glm-exports', title: 'TPG/GLM Exports', note: 'Shipments allocated to TPG and GLM loadports in Vessel DB', kind: 'export', rows: data?.exports?.tpgGlm || data?.exports?.tpg || [], showStage: true },
    { id: 'gr-executed-exports', title: 'GR Exports: Executed Contracts', note: 'EUP and PMC shipments executed in the last 30 days', kind: 'export', rows: data?.exports?.gr?.executed || [] },
    { id: 'gr-open-exports', title: 'GR Exports: Open Contracts', note: 'Open EUP and PMC shipment contracts', kind: 'export', rows: data?.exports?.gr?.open || [] },
    { id: 'gr-upcoming-exports', title: 'GR Exports: Upcoming Contracts', note: 'Upcoming EUP and PMC shipment contracts', kind: 'export', rows: data?.exports?.gr?.upcoming || [] },
    { id: 'gr-unmatched-vessels', title: 'GR Vessels Pending Contract Matching', note: 'Open GR loadports with no active contract links', kind: 'unmatched-vessel', rows: data?.grUnmatchedVessels || [], gapBefore: true },
    { id: 'demurrage', title: 'Demurrage', note: 'GR vessels selected for demurrage review in Vessel DB', kind: 'demurrage', rows: data?.demurrage || [] },
  ];

  return cards.filter(card => card.rows.length > 0);
}

export function buildWeeklyOpsPresentationCards(cards) {
  return cards.flatMap(card => {
    if (card.kind !== 'demurrage') return [card];

    return card.rows.map((row, index) => ({
      ...card,
      id: `${card.id}-${index}-${row.id || row.vslId || 'vessel'}`,
      title: `Demurrage - ${row.vessel || row.vslId || 'TBN'}`,
      rows: [row],
    }));
  });
}

export function relativeCardIndex(currentIndex, direction, length) {
  if (length <= 0) return -1;
  return (currentIndex + direction + length) % length;
}

export function balancePresentationRows(rows, requestedColumns = 2) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return [[]];
  const parsedColumns = Math.floor(Number(requestedColumns));
  const columnCount = Math.max(1, Math.min(Number.isFinite(parsedColumns) ? parsedColumns : 1, items.length));
  const rowsPerColumn = Math.ceil(items.length / columnCount);
  return Array.from({ length: columnCount }, (_, index) => (
    items.slice(index * rowsPerColumn, (index + 1) * rowsPerColumn)
  )).filter(column => column.length);
}

export function fitPresentationScale(containerWidth, containerHeight, contentWidth, contentHeight, maxScale = 1.5) {
  const dimensions = [containerWidth, containerHeight, contentWidth, contentHeight, maxScale].map(Number);
  if (dimensions.some(value => !Number.isFinite(value) || value <= 0)) return 1;
  return Math.min(maxScale, containerWidth / contentWidth, containerHeight / contentHeight);
}
