export function fitExportSummaryScale(containerWidth, containerHeight, contentWidth, contentHeight, maxScale = 1.5) {
  const dimensions = [containerWidth, containerHeight, contentWidth, contentHeight, maxScale].map(Number);
  if (dimensions.some(value => !Number.isFinite(value) || value <= 0)) return 1;
  return Math.min(maxScale, containerWidth / contentWidth, containerHeight / contentHeight);
}