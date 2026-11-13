'use strict';
// Converts the project's Markdown documents (the subset they use) into styled .docx files.
// Usage: node md2docx.js <input.md> <output.docx> "<header text>"
const fs = require('fs');
const path = require('path');
const {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, Header, HeadingLevel, ImageRun,
  LevelFormat, Packer, PageOrientation, PageBreak, PageNumber, Paragraph, ShadingType, Table, TableCell, TableOfContents,
  TableRow, TextRun, VerticalAlign, WidthType,
} = require('docx');

const [, , input, output, headerText = ''] = process.argv;
const baseDir = path.dirname(input);
const lines = fs.readFileSync(input, 'utf8').replace(/\r\n/g, '\n').split('\n');

const NAVY = '1F3A5F';
const MUTED = '5B6B7C';
const BORDER = 'B8C4D0';
const HEADER_FILL = 'DCE6F0';
const ZEBRA = 'F5F8FB';
const PAGE_W = 11906;               // A4
const MARGIN = 1000;
const CONTENT_W = PAGE_W - 2 * MARGIN; // 9906 DXA
const BODY_FONT = 'Calibri';
const MONO = 'Consolas';

// ---------------------------------------------------------------------------
// Inline markdown -> runs
// ---------------------------------------------------------------------------
const ESC_STAR = '\u0001';
const ESC_PIPE = '\u0002';
function inline(text, base = {}) {
  const src = String(text).replace(/\\\*/g, ESC_STAR).replace(/\\\|/g, ESC_PIPE).replace(/<br\s*\/?>/gi, '\n');
  const pattern = /(\*\*[^*]+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*]*?\*)/g;
  const out = [];
  let last = 0;
  const restore = s => s.replace(new RegExp(ESC_STAR, 'g'), '*').replace(new RegExp(ESC_PIPE, 'g'), '|');
  const plain = (s, extra = {}) => {
    const parts = restore(s).split('\n');
    parts.forEach((part, i) => out.push(new TextRun({ text: part, break: i > 0 ? 1 : 0, ...base, ...extra })));
  };
  for (const m of src.matchAll(pattern)) {
    if (m.index > last) plain(src.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      // nested code inside bold is rare; treat as bold text
      plain(tok.slice(2, -2).replace(/`/g, ''), { bold: true });
    } else if (tok.startsWith('`')) {
      out.push(new TextRun({ text: restore(tok.slice(1, -1)), font: MONO, size: Math.max(14, (base.size || 21) - 2), color: '7A2E2E', ...(base.bold ? { bold: true } : {}) }));
    } else if (tok.startsWith('[')) {
      const [, label, href] = tok.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (/^https?:/.test(href)) {
        out.push(new ExternalHyperlink({ link: href, children: [new TextRun({ text: restore(label), style: 'Hyperlink', ...base })] }));
      } else {
        plain(label.replace(/`/g, ''), { color: NAVY, underline: {} });
      }
    } else {
      plain(tok.slice(1, -1), { italics: true });
    }
    last = m.index + tok.length;
  }
  if (last < src.length) plain(src.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------
function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
const visibleLength = s => String(s).replace(/\*\*|`|\\/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').length;

function pngSize(file) {
  const buf = fs.readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), data: buf };
}

const border = { style: BorderStyle.SINGLE, size: 4, color: BORDER };
const cellBorders = { top: border, bottom: border, left: border, right: border };

function buildTable(rows) {
  const header = rows[0];
  const body = rows.slice(2);
  const cols = header.length;
  const small = cols >= 6;
  const size = small ? 16 : 18;
  // Column widths proportional to content (sqrt-damped), with a floor.
  const weights = header.map((h, c) => {
    const longest = Math.max(visibleLength(h), ...body.map(r => visibleLength(r[c] || '')));
    const avg = (visibleLength(h) + body.reduce((sum, r) => sum + visibleLength(r[c] || ''), 0)) / (body.length + 1);
    return Math.max(4, Math.sqrt(longest) * 0.6 + Math.sqrt(avg) * 1.4);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let widths = weights.map(w => Math.max(700, Math.round((w / total) * CONTENT_W)));
  const scale = CONTENT_W / widths.reduce((a, b) => a + b, 0);
  widths = widths.map(w => Math.floor(w * scale));
  widths[widths.length - 1] += CONTENT_W - widths.reduce((a, b) => a + b, 0);

  const cell = (text, c, { head = false, zebra = false } = {}) => new TableCell({
    width: { size: widths[c], type: WidthType.DXA },
    borders: cellBorders,
    shading: head ? { fill: HEADER_FILL, type: ShadingType.CLEAR, color: 'auto' } : zebra ? { fill: ZEBRA, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    verticalAlign: VerticalAlign.TOP,
    children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: inline(text || '', { size, bold: head, color: head ? NAVY : undefined }) })],
  });
  const blankHeader = header.every(h => !h.trim());
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      ...(blankHeader ? [] : [new TableRow({ tableHeader: true, children: header.map((h, c) => cell(h, c, { head: true })) })]),
      ...body.map((r, i) => new TableRow({ cantSplit: true, children: header.map((_, c) => cell(r[c] || '', c, { zebra: i % 2 === 1 })) })),
    ],
  });
}

let children = [];
const sections = [];
const LANDSCAPE = /(erd-|seq-|deployment)/;
const LAND_W = 16838 - 2 * MARGIN;   // landscape content width (DXA)
const LAND_H = PAGE_W - 2100;        // landscape content height (DXA)
let blockCount = 0;
let lastHeading = null;   // heading paragraph pushed immediately before the current block
function closeSection(landscape = false) {
  if (children.length) sections.push({ landscape, children });
  children = [];
}
let title = '';
let numberedInstance = 0;
let i = 0;
let sawTitle = false;
let coverDone = false;

function para(runs, opts = {}) {
  blockCount++;
  lastHeading = null;
  children.push(new Paragraph({ spacing: { after: 100, line: 276 }, ...opts, children: runs }));
}

while (i < lines.length) {
  const line = lines[i];
  const trimmed = line.trim();

  if (!trimmed || trimmed === '---') { i++; continue; }

  // Headings
  const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
  if (h) {
    const level = h[1].length;
    const text = h[2];
    if (level === 1 && !sawTitle) {
      sawTitle = true;
      title = text.replace(/\*\*/g, '');
      const [main, sub] = title.split(/:\s+/);
      children.push(new Paragraph({ spacing: { before: 2600, after: 120 }, children: [new TextRun({ text: 'ASTAR ERP', size: 24, bold: true, color: MUTED, characterSpacing: 60 })] }));
      children.push(new Paragraph({ spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: NAVY, space: 8 } }, children: [new TextRun({ text: sub || main, size: 56, bold: true, color: NAVY })] }));
      i++;
      continue;
    }
    if (!coverDone) {
      coverDone = true;
      children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(new Paragraph({ style: 'TOCHeading', children: [new TextRun('Contents')] }));
      children.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-3' }));
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
    blockCount++;
    const headingText = text;
    const heading = { 2: HeadingLevel.HEADING_1, 3: HeadingLevel.HEADING_2, 4: HeadingLevel.HEADING_3 }[level] || HeadingLevel.HEADING_1;
    const headingParagraph = new Paragraph({ heading, keepNext: true, pageBreakBefore: level === 2 && blockCount > 6 && children.length > 0, children: inline(headingText) });
    children.push(headingParagraph);
    lastHeading = { paragraph: headingParagraph, heading, text: headingText };
    i++;
    continue;
  }

  // Code block
  if (trimmed.startsWith('```')) {
    const block = [];
    i++;
    while (i < lines.length && !lines[i].trim().startsWith('```')) { block.push(lines[i]); i++; }
    i++;
    block.forEach((codeLine, idx) => children.push(new Paragraph({
      spacing: { before: idx === 0 ? 80 : 0, after: idx === block.length - 1 ? 140 : 0, line: 240 },
      shading: { fill: 'F3F5F7', type: ShadingType.CLEAR, color: 'auto' },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: BORDER, space: 6 } },
      indent: { left: 120 },
      children: [new TextRun({ text: codeLine.length ? codeLine : ' ', font: MONO, size: 15 })],
    })));
    continue;
  }

  // Image
  const img = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (img) {
    const file = path.join(baseDir, img[2]);
    const { width, height, data } = pngSize(file);
    if (LANDSCAPE.test(img[2])) {
      // Carry a heading that directly precedes the figure onto the landscape page.
      let carried = null;
      if (lastHeading && children[children.length - 1] === lastHeading.paragraph) {
        children.pop();
        carried = new Paragraph({ heading: lastHeading.heading, keepNext: true, children: inline(lastHeading.text) });
      }
      closeSection(false);
      if (carried) children.push(carried);
      const maxW = Math.floor(LAND_W / 15);       // DXA -> px at 96 dpi
      const maxH = Math.floor(LAND_H / 15) - (carried ? 95 : 40);  // room for heading and caption
      const scale = Math.min(maxW / width, maxH / height);
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 0, after: 40 }, children: [new ImageRun({ type: 'png', data, transformation: { width: Math.round(width * scale), height: Math.round(height * scale) }, altText: { title: img[1], description: img[1], name: img[1] } })] }));
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Figure: ${img[1]}`, italics: true, size: 18, color: MUTED })] }));
      closeSection(true);
      i++;
      continue;
    }
    const w = 650;
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 40 }, keepNext: true, children: [new ImageRun({ type: 'png', data, transformation: { width: w, height: Math.round((height / width) * w) }, altText: { title: img[1], description: img[1], name: img[1] } })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: `Figure: ${img[1]}`, italics: true, size: 18, color: MUTED })] }));
    i++;
    continue;
  }

  // Table
  if (trimmed.startsWith('|')) {
    const rows = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
    lastHeading = null;
    if (rows.length >= 2) {
      children.push(buildTable(rows));
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
    }
    continue;
  }

  // Blockquote
  if (trimmed.startsWith('>')) {
    const quote = [];
    while (i < lines.length && lines[i].trim().startsWith('>')) { quote.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
    para(inline(quote.join(' '), { italics: true, color: '33475B' }), {
      shading: { fill: 'EEF3F8', type: ShadingType.CLEAR, color: 'auto' },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: NAVY, space: 8 } },
      indent: { left: 200 },
      spacing: { before: 80, after: 160, line: 276 },
    });
    continue;
  }

  // Lists (bulleted / numbered, nested by two-space indent)
  const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
  if (listMatch) {
    const numbered = /\d+\./.test(listMatch[2]);
    numberedInstance += numbered ? 1 : 0;
    const instance = numberedInstance;
    // Indented, non-empty lines that are not a new item, a code fence or a table
    // continue the item above (Markdown soft-wraps long items).
    const isContinuation = text => text.trim() && /^\s{2,}/.test(text) && !/^\s*([-*]|\d+\.)\s/.test(text)
      && !text.trim().startsWith('|') && !text.trim().startsWith('```');
    while (i < lines.length) {
      const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (!m) {
        // A stray continuation (e.g. after a fenced block inside the list).
        if (isContinuation(lines[i])) {
          para(inline(lines[i].trim()), { indent: { left: 720 }, spacing: { after: 60 } });
          i++;
          continue;
        }
        break;
      }
      const level = Math.min(2, Math.floor(m[1].length / 2));
      const isNum = /\d+\./.test(m[2]);
      const text = [m[3]];
      i++;
      while (i < lines.length && isContinuation(lines[i])) {
        text.push(lines[i].trim());
        i++;
      }
      para(inline(text.join(' ')), {
        numbering: isNum ? { reference: 'numbered', level, instance } : { reference: 'bullets', level },
        spacing: { after: 60, line: 264 },
      });
    }
    continue;
  }

  // Paragraph (merge consecutive text lines)
  const buf = [trimmed];
  i++;
  while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\||>|!\[|\s*([-*]|\d+\.)\s)/.test(lines[i]) && lines[i].trim() !== '---') {
    buf.push(lines[i].trim());
    i++;
  }
  para(inline(buf.join(' ')));
}

const doc = new Document({
  creator: 'Astar ERP project',
  title,
  description: title,
  features: { updateFields: process.env.UPDATE_FIELDS === '1' },
  styles: {
    default: { document: { run: { font: BODY_FONT, size: 21, color: '1D2733' } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, color: NAVY }, paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 26, bold: true, color: NAVY }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 22, bold: true, color: '2F4F6F' }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2 } },
      { id: 'TOCHeading', name: 'TOC Heading', basedOn: 'Normal', run: { size: 32, bold: true, color: NAVY }, paragraph: { spacing: { after: 200 } } },
    ],
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [0, 1, 2].map(level => ({ level, format: LevelFormat.BULLET, text: ['•', '◦', '▪'][level], alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 + level * 360, hanging: 260 } } } })) },
      { reference: 'numbered', levels: [0, 1, 2].map(level => ({ level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level], text: `%${level + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400 + level * 360, hanging: 300 } } } })) },
    ],
  },
  sections: (closeSection(false), sections).map((section, index) => ({
    properties: {
      page: {
        size: { width: PAGE_W, height: 16838, orientation: section.landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
        margin: { top: 1100, bottom: 1000, left: MARGIN, right: MARGIN },
      },
      titlePage: index === 0,
    },
    headers: {
      default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER, space: 4 } }, children: [new TextRun({ text: headerText || title, size: 16, color: MUTED })] })] }),
      first: new Header({ children: [new Paragraph({ children: [] })] }),
    },
    footers: {
      default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 16, color: MUTED })] })] }),
      first: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Internal — Confidential', size: 16, color: MUTED })] })] }),
    },
    children: section.children,
  })),
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(output, buffer);
  console.log('wrote', output, Math.round(buffer.length / 1024), 'KB,', sections.length, 'sections');
});
