'use strict';
// Generates the app icons from the chosen design (concept B, "Outbound tanker").
//   node build-icons.js   (needs docs/tools: npm install there once)
//
// concept-b-tanker-small.svg -> tab sizes (favicon.svg, favicon-32.png): bigger shapes, no fine detail.
// concept-b-tanker.svg       -> 180 px and up, and the DWS Hub tile.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('../../tools/node_modules/@resvg/resvg-js');

const PUBLIC_DIR = path.join(__dirname, '../../../frontend/public');
const full = fs.readFileSync(path.join(__dirname, 'concept-b-tanker.svg'), 'utf8');
const small = fs.readFileSync(path.join(__dirname, 'concept-b-tanker-small.svg'), 'utf8');

// Square, full-bleed variant: iOS and Android round the corners themselves
// (transparent corners would turn black on iOS).
const square = svg => svg.replace(/<rect width="512" height="512" rx="\d+"/, '<rect width="512" height="512" rx="0"');
// Maskable: full-bleed background, artwork scaled into the central 80 % safe zone.
const maskable = svg => {
  const tile = svg.match(/<rect width="512" height="512"[^>]*\/>/)[0];
  const [head, rest] = svg.split(tile);
  const artwork = rest.replace('</svg>', '');
  return `${head}${tile.replace(/rx="\d+"/, 'rx="0"')}<g transform="translate(51.2 51.2) scale(0.8)">${artwork}</g></svg>`;
};

function png(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

const outputs = [
  [path.join(PUBLIC_DIR, 'favicon.svg'), Buffer.from(small)],
  [path.join(PUBLIC_DIR, 'favicon-32.png'), png(small, 32)],
  [path.join(PUBLIC_DIR, 'apple-touch-icon.png'), png(square(full), 180)],
  [path.join(PUBLIC_DIR, 'icon-192.png'), png(full, 192)],
  [path.join(PUBLIC_DIR, 'icon-512.png'), png(full, 512)],
  [path.join(PUBLIC_DIR, 'icon-maskable-512.png'), png(maskable(full), 512)],
  // Upload this in DWS Hub Admin -> Applications -> AASTAR Logistic (Export) -> icon.
  [path.join(__dirname, 'dws-hub-tile-512.png'), png(full, 512)],
];

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
for (const [file, data] of outputs) {
  fs.writeFileSync(file, data);
  console.log(`wrote ${path.relative(path.join(__dirname, '../../..'), file)} (${data.length} bytes)`);
}
