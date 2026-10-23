/**
 * PDF to Markdown, in this process.
 *
 * A PDF has no paragraphs, headings or lists: it is glyphs placed at
 * coordinates. What a model wants is the structure a person sees, so this reads
 * the glyphs with their position and font size and rebuilds it:
 *
 *   - the most common font size is the body; clearly larger lines are headings
 *   - lines that sit close together are one paragraph, and the hard wrap that
 *     the page forced on them is undone (including "hyphen-\nation")
 *   - bullets and numbers become list items
 *   - lines that repeat on most pages (running headers, page numbers) are dropped
 *   - cells that sit on a shared set of columns become a table
 *
 * Microsoft's markitdown was the obvious candidate and was not used: it is a
 * Python package, and its PDF path is pdfminer text with no heading detection,
 * so it would bring a second runtime for a flatter result. This is the same
 * trade the anonymizer made against Presidio.
 *
 * Limits, stated rather than hidden: there is no OCR, so a scanned PDF yields
 * nothing and says so; multi-column layouts are read in the order the file
 * stores them; images are dropped.
 */

export class PdfError extends Error {}

/** One run of text as the PDF placed it. Origin is bottom-left, as in PDF. */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  /** Width of the run in page units. */
  width: number;
  size: number;
  bold: boolean;
}

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;

interface Line {
  items: TextItem[];
  text: string;
  x: number;
  y: number;
  size: number;
  bold: boolean;
  page: number;
}

const BULLET = /^([•◦▪■●○‣∙·\-–*])\s+/;
const NUMBERED = /^(\d{1,3}[.)])\s+/;

/** Groups items that share a baseline into lines, top of the page first. */
function toLines(items: readonly TextItem[], page: number): Line[] {
  const filtered = items.filter((item) => item.str.trim() !== '' || item.width > 0);
  const sorted = [...filtered].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const item of sorted) {
    const row = rows.at(-1);
    const tolerance = Math.max(item.size, 1) * 0.4;
    if (row && Math.abs(row[0]!.y - item.y) <= tolerance) row.push(item);
    else rows.push([item]);
  }

  return rows.flatMap((row) => {
    row.sort((a, b) => a.x - b.x);
    let text = '';
    let end = row[0]!.x;
    for (const item of row) {
      const gap = item.x - end;
      // A visible gap is a space even when the PDF stored none.
      if (text !== '' && gap > item.size * 0.15 && !text.endsWith(' ') && !item.str.startsWith(' ')) text += ' ';
      text += item.str;
      end = item.x + item.width;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text === '') return [];
    const visible = row.filter((item) => item.str.trim() !== '');
    const size = Math.max(...visible.map((item) => item.size));
    return [
      {
        items: row,
        text,
        x: row[0]!.x,
        y: row[0]!.y,
        size,
        bold: visible.every((item) => item.bold),
        page,
      },
    ];
  });
}

/** The value that occurs most often, weighted by characters, not by runs. */
function bodySize(lines: readonly Line[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + line.text.length);
  }
  let best = 12;
  let most = 0;
  for (const [size, count] of weight) {
    if (count > most) {
      best = size;
      most = count;
    }
  }
  return best;
}

/** Drops lines that appear (nearly) identically on most pages: headers, footers, page numbers. */
function withoutRepeats(pages: Line[][]): Line[][] {
  if (pages.length < 3) return pages;
  // Page numbers vary per page, so digits are folded; but only in short lines, which headers and footers are.
  const normalise = (line: Line) => (line.text.length <= 60 ? line.text.replace(/\d+/g, '#') : line.text).toLowerCase();
  const seen = new Map<string, Set<number>>();
  for (const [index, lines] of pages.entries()) {
    // Only the outer lines of a page can be a header or footer.
    for (const line of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      const key = normalise(line);
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key)!.add(index);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.6));
  const repeated = new Set([...seen].filter(([, set]) => set.size >= threshold).map(([key]) => key));
  return pages.map((lines) =>
    lines.filter((line, i) => {
      const outer = i < 2 || i >= lines.length - 2;
      return !(outer && repeated.has(normalise(line)));
    }),
  );
}

/** Words that a hard wrap split with a hyphen are put back together. */
function join(previous: string, next: string): string {
  if (/[a-zà-ÿ]-$/.test(previous) && /^[a-zà-ÿ]/.test(next)) return previous.slice(0, -1) + next;
  return `${previous} ${next}`;
}

/** Column x-positions of cells in a line, when it has the gaps of a table row. */
function cells(line: Line): { x: number; text: string }[] | null {
  const result: { x: number; text: string }[] = [];
  let current: { x: number; text: string; end: number } | null = null;
  // Table padding often arrives as a wide run of spaces, not as a coordinate gap.
  let broken = false;
  for (const item of line.items) {
    if (item.str.trim() === '') {
      if (item.width > line.size * 0.5) broken = true;
      continue;
    }
    if (current && !broken && item.x - current.end < line.size * 1.5) {
      current.text += (item.x - current.end > line.size * 0.15 ? ' ' : '') + item.str;
      current.end = item.x + item.width;
    } else {
      if (current) result.push({ x: current.x, text: current.text.trim() });
      current = { x: item.x, text: item.str, end: item.x + item.width };
      broken = false;
    }
  }
  if (current) result.push({ x: current.x, text: current.text.trim() });
  // A marker and its text are a list item, however wide the gap between them.
  if (result.length >= 2 && (BULLET.test(`${result[0]!.text} `) || NUMBERED.test(`${result[0]!.text} `))) return null;
  return result.length >= 2 ? result : null;
}

// Generous, because a header is often centred over its column.
const sameColumns = (a: { x: number }[], b: { x: number }[], size: number) =>
  a.length === b.length && a.every((cell, i) => Math.abs(cell.x - b[i]!.x) <= size * 1.2);

const escapeCell = (text: string) => text.replace(/\|/g, '\\|');

/**
 * Pure: text items per page in, Markdown out. Kept apart from pdf.js so the
 * rules can be tested without a PDF.
 */
export function itemsToMarkdown(pageItems: readonly (readonly TextItem[])[]): string {
  const pages = withoutRepeats(pageItems.map((items, index) => toLines(items, index)));
  const all = pages.flat();
  if (all.length === 0) return '';

  const body = bodySize(all);
  // Heading levels come from the distinct larger sizes actually used, biggest first.
  const sizes = [...new Set(all.filter((l) => l.size >= body * 1.15).map((l) => Math.round(l.size)))].sort(
    (a, b) => b - a,
  );
  const levelOf = (line: Line, tabular = false): number => {
    if (line.text.length > 120) return 0;
    if (line.size >= body * 1.15) return Math.min(sizes.indexOf(Math.round(line.size)) + 1, 4) || 0;
    // Short bold line at body size: a run-in subheading.
    if (!tabular && line.bold && line.text.length <= 80 && !/[.:,;]$/.test(line.text)) return 4;
    return 0;
  };

  const out: string[] = [];
  let paragraph = '';
  let item = '';
  const flush = () => {
    if (item) out.push(item);
    else if (paragraph) out.push(paragraph);
    paragraph = '';
    item = '';
  };

  let previous: Line | null = null;
  let table: { x: number; text: string }[][] = [];
  const flushTable = () => {
    if (table.length >= 2) {
      const [head, ...rest] = table;
      const row = (r: { text: string }[]) => `| ${r.map((c) => escapeCell(c.text)).join(' | ')} |`;
      out.push([row(head!), `|${head!.map(() => ' --- ').join('|')}|`, ...rest.map(row)].join('\n'));
    } else {
      for (const r of table) out.push(r.map((c) => c.text).join(' '));
    }
    table = [];
  };

  for (const line of all) {
    const row = cells(line);
    if (row && levelOf(line, true) === 0 && (table.length === 0 || sameColumns(table[0]!, row, body))) {
      if (table.length === 0) flush();
      table.push(row);
      previous = line;
      continue;
    }
    if (table.length > 0) flushTable();

    const level = levelOf(line);
    if (level > 0) {
      flush();
      // Consecutive heading lines of one size are one heading that wrapped.
      const last = out.at(-1);
      if (previous && levelOf(previous) === level && last?.startsWith('#') && previous.page === line.page) {
        out[out.length - 1] = `${last} ${line.text}`;
      } else {
        out.push(`${'#'.repeat(level)} ${line.text}`);
      }
      previous = line;
      continue;
    }

    const bullet = BULLET.exec(line.text);
    const numbered = NUMBERED.exec(line.text);
    const gap = previous && previous.page === line.page ? previous.y - line.y : Infinity;
    const newBlock = gap > line.size * 1.9;

    if (bullet || numbered) {
      flush();
      item = bullet ? `- ${line.text.slice(bullet[0].length)}` : line.text;
    } else if (item && !newBlock && line.x > (previous?.x ?? 0) - 1) {
      item = join(item, line.text); // continuation of a wrapped list item
    } else if (paragraph && !newBlock) {
      paragraph = join(paragraph, line.text);
    } else {
      flush();
      paragraph = line.text;
    }
    previous = line;
  }
  if (table.length > 0) flushTable();
  flush();

  // A list is one block, not a paragraph per item.
  const merged: string[] = [];
  for (const block of out) {
    const last = merged.at(-1);
    const isItem = /^(- |\d{1,3}[.)] )/.test(block) && !block.includes('\n');
    if (isItem && last !== undefined && /^(- |\d{1,3}[.)] )/.test(last.split('\n').at(-1)!) && !last.startsWith('|')) {
      merged[merged.length - 1] = `${last}\n${block}`;
    } else {
      merged.push(block);
    }
  }
  return `${merged.join('\n\n')}\n`;
}

/** Reads a PDF and returns Markdown. Throws PdfError with a sentence fit to show the user. */
export async function pdfToMarkdown(data: Uint8Array): Promise<{ markdown: string; pages: number }> {
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new PdfError(`The PDF is too large (${Math.round(data.byteLength / 1024 / 1024)} MB, limit ${MAX_PDF_BYTES / 1024 / 1024} MB).`);
  }
  if (new TextDecoder().decode(data.subarray(0, 5)) !== '%PDF-') {
    throw new PdfError('This file is not a PDF.');
  }

  // Loaded on first use: pdf.js is large and most requests never need it.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
      // pdf.js transfers (detaches) the buffer it is given.
      data: new Uint8Array(data),
      useSystemFonts: false,
      verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'PasswordException') throw new PdfError('The PDF is password-protected.');
    throw new PdfError('The PDF could not be read. It may be damaged.');
  }

  try {
    if (doc.numPages > MAX_PDF_PAGES) {
      throw new PdfError(`The PDF has ${doc.numPages} pages; the limit is ${MAX_PDF_PAGES}.`);
    }
    const pages: TextItem[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const styles = content.styles as Record<string, { fontFamily?: string }>;
      const items: TextItem[] = [];
      for (const raw of content.items) {
        if (!('str' in raw)) continue;
        const [a, b, , , e, f] = raw.transform as number[];
        const family = styles[raw.fontName]?.fontFamily ?? '';
        items.push({
          str: raw.str,
          x: e!,
          y: f!,
          width: raw.width,
          size: Math.hypot(a!, b!) || raw.height,
          bold: /bold|black|heavy/i.test(`${raw.fontName} ${family}`),
        });
      }
      pages.push(items);
      page.cleanup();
    }

    const markdown = itemsToMarkdown(pages);
    if (markdown.trim() === '') {
      throw new PdfError(
        'No text found in this PDF. It is probably a scan, and scans need OCR, which is not available.',
      );
    }
    return { markdown, pages: doc.numPages };
  } finally {
    await task.destroy();
  }
}
