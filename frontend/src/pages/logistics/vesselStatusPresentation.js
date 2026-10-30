export function fitVesselStatusScale(containerWidth, contentWidth, maxScale = 1.5) {
  const dimensions = [containerWidth, contentWidth, maxScale].map(Number);
  if (dimensions.some(value => !Number.isFinite(value) || value <= 0)) return 1;
  return Math.min(maxScale, containerWidth / contentWidth);
}