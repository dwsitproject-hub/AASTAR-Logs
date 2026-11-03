'use strict';
// Builds preview.png: every concept at real sizes and in context (browser tab, DWS Hub tile).
//   node build-preview.js   (needs docs/tools: npm install there once)
const fs = require('fs');
const path = require('path');
const { Resvg } = require('../../tools/node_modules/@resvg/resvg-js');

const CONCEPTS = [
  { file: 'concept-a-wave-a.svg', name: 'A · Outbound A', note: 'Brand terracotta. The A’s crossbar is a sea wave leaving the letter as an export arrow.' },
  { file: 'concept-b-tanker.svg', name: 'B · Outbound tanker', note: 'Teal sea. A product tanker heading out, with the export arrow. Most literal.' },
  { file: 'concept-c-route-a.svg', name: 'C · Route A', note: 'Charcoal. The A starts at a home port; a dotted sea lane leaves it as an arrow. Blends into dark backgrounds such as the Hub.' },
];

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
const dataUri = buffer => `data:image/png;base64,${buffer.toString('base64')}`;
const img = (uri, x, y, size, pixelated = false) =>
  `<image href="${uri}" x="${x}" y="${y}" width="${size}" height="${size}"${pixelated ? ' image-rendering="optimizeSpeed"' : ''}/>`;
const text = (x, y, value, size = 14, weight = 400, fill = '#20282d', anchor = 'start') =>
  `<text x="${x}" y="${y}" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${value}</text>`;

const ROW = 250;
const TOP = 96;
const WIDTH = 1580;
const parts = [
  `<rect width="${WIDTH}" height="${TOP + ROW * CONCEPTS.length + 24}" fill="#f3f5f6"/>`,
  text(32, 46, 'AASTAR Logistic (Export) — app icon concepts', 26, 700),
  text(32, 74, 'Each shown large, at 64 / 32 / 16 px (16 px also magnified 4×), in a browser tab and as a DWS Hub tile.', 14, 400, '#5b666c'),
];
for (const label of [['64 px', 316], ['32 px', 404], ['16 px', 470], ['16 px × 4', 548], ['Browser tab', 760], ['DWS Hub tile', 1180]]) {
  parts.push(text(label[1], TOP + 6, label[0], 12, 600, '#5b666c', 'middle'));
}

CONCEPTS.forEach((concept, index) => {
  const svg = fs.readFileSync(path.join(__dirname, concept.file), 'utf8');
  const y = TOP + 22 + index * ROW;
  const big = dataUri(png(svg, 360));
  const s64 = dataUri(png(svg, 64));
  const s32 = dataUri(png(svg, 32));
  const s16 = dataUri(png(svg, 16));
  const s96 = dataUri(png(svg, 160));
  parts.push(`<line x1="32" y1="${y - 10}" x2="${WIDTH - 32}" y2="${y - 10}" stroke="#dde3e6"/>`);
  parts.push(img(big, 32, y, 180));
  parts.push(img(s64, 284, y + 58, 64));
  parts.push(img(s32, 388, y + 74, 32));
  parts.push(img(s16, 462, y + 82, 16));
  parts.push(img(s16, 516, y + 58, 64, true));
  // browser tab (light chrome)
  parts.push(`<rect x="620" y="${y + 52}" width="300" height="76" rx="10" fill="#dfe4e8"/>`);
  parts.push(`<path d="M 636 ${y + 128} L 636 ${y + 72} Q 636 ${y + 62} 646 ${y + 62} L 862 ${y + 62} Q 872 ${y + 62} 872 ${y + 72} L 872 ${y + 128} Z" fill="#ffffff"/>`);
  parts.push(img(s16, 650, y + 76, 16));
  parts.push(text(676, y + 89, 'AASTAR Logistic (Export)', 13, 400, '#20282d'));
  parts.push(text(858, y + 89, '×', 14, 400, '#5b666c', 'end'));
  // DWS Hub tile (dark card)
  parts.push(`<rect x="1080" y="${y}" width="200" height="190" rx="18" fill="#1b2227"/>`);
  parts.push(img(s96, 1140, y + 24, 80));
  parts.push(text(1180, y + 136, 'AASTAR Logistic', 15, 600, '#edf1f2', 'middle'));
  parts.push(text(1180, y + 158, '(Export)', 13, 400, '#9aa6ac', 'middle'));
  parts.push(text(1310, y + 70, concept.name, 16, 700));
  concept.note.match(/.{1,34}(\s|$)/g).forEach((line, lineIndex) => parts.push(text(1310, y + 96 + lineIndex * 18, line.trim(), 12, 400, '#5b666c')));
});

const height = TOP + ROW * CONCEPTS.length + 24;
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">${parts.join('')}</svg>`;
fs.writeFileSync(path.join(__dirname, 'preview.png'), new Resvg(sheet, { font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' } }).render().asPng());
console.log('wrote preview.png');
