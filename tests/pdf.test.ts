import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { itemsToMarkdown, pdfToMarkdown, PdfError, type TextItem } from '../src/pdf.js';
import { markdownName } from '../src/routes/pdf.js';

/** One run of text, 6 units wide per character: close enough for the grouping rules. */
function run(str: string, x: number, y: number, size = 12, bold = false): TextItem {
  return { str, x, y, width: str.length * size * 0.5, size, bold };
}

describe('itemsToMarkdown', () => {
  it('turns larger lines into headings, by rank of size', () => {
    const md = itemsToMarkdown([
      [run('Title', 50, 700, 24), run('Section', 50, 650, 18), run('Body text of the page goes here.', 50, 620)],
    ]);

    expect(md).toContain('# Title');
    expect(md).toContain('## Section');
    expect(md).toContain('Body text of the page goes here.');
  });

  it('rejoins a hard-wrapped paragraph and undoes hyphenation', () => {
    const md = itemsToMarkdown([
      [run('This sentence was split by the infor-', 50, 700), run('mation on the page width.', 50, 686)],
    ]);

    expect(md.trim()).toBe('This sentence was split by the information on the page width.');
  });

  it('starts a new paragraph at a larger gap', () => {
    const md = itemsToMarkdown([[run('First paragraph.', 50, 700), run('Second paragraph.', 50, 650)]]);

    expect(md.trim()).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('keeps bullets as one list', () => {
    const md = itemsToMarkdown([
      [run('Intro line.', 50, 720), run('• one', 60, 690), run('• two', 60, 676), run('• three', 60, 662)],
    ]);

    expect(md).toContain('- one\n- two\n- three');
  });

  it('drops a running header and page numbers that repeat on most pages', () => {
    const pages = [1, 2, 3, 4].map((n) => [
      run('ACME Handbook', 50, 780),
      run(`Real content on page ${n}, a body line that is long enough to not be a footer at all.`, 50, 700),
      run(String(n), 300, 30),
    ]);
    const md = itemsToMarkdown(pages);

    expect(md).not.toContain('ACME');
    expect(md).toContain('page 3');
    expect(md).not.toMatch(/^4$/m);
  });

  it('builds a table from rows that share columns', () => {
    const md = itemsToMarkdown([
      [
        run('Body line above.', 50, 740),
        run('Name', 50, 700), run('Days', 200, 700),
        run('Junior', 50, 686), run('25', 200, 686),
        run('Senior', 50, 672), run('28', 200, 672),
      ],
    ]);

    expect(md).toContain('| Name | Days |\n| --- | --- |\n| Junior | 25 |\n| Senior | 28 |');
  });

  it('returns nothing for a page with no text', () => {
    expect(itemsToMarkdown([[]])).toBe('');
  });
});

describe('pdfToMarkdown', () => {
  it('converts a real PDF: headings, paragraph, list and table', async () => {
    const { markdown, pages } = await pdfToMarkdown(readFileSync('tests/fixtures/handbook.pdf'));

    expect(pages).toBe(1);
    expect(markdown).toContain('# Employee Handbook');
    expect(markdown).toContain('## Leave policy');
    expect(markdown).toContain('- Request leave at least two weeks ahead\n- Sick leave needs no approval');
    expect(markdown).toContain('| Junior | 25 | Standard |');
    // The paragraph wrapped over several lines on the page and is one line here.
    expect(markdown).toMatch(/^This handbook explains .* rejoined\.$/m);
  });

  it('refuses what is not a PDF, with a sentence for the user', async () => {
    await expect(pdfToMarkdown(Buffer.from('just text'))).rejects.toThrow(PdfError);
    await expect(pdfToMarkdown(Buffer.from('just text'))).rejects.toThrow('not a PDF');
  });

  it('reports a damaged PDF rather than crashing', async () => {
    await expect(pdfToMarkdown(Buffer.from('%PDF-1.4\ngarbage'))).rejects.toThrow(PdfError);
  });
});

describe('markdownName', () => {
  it('yields a name the knowledge base accepts', () => {
    expect(markdownName('Jaarverslag 2024 (def).pdf')).toBe('Jaarverslag-2024-def.md');
    expect(markdownName('café.PDF')).toBe('cafe.md');
    expect(markdownName('../../etc/passwd.pdf')).toBe('etc-passwd.md');
    expect(markdownName('')).toBe('document.md');
    expect(markdownName(`${'a'.repeat(200)}.pdf`)).toMatch(/^[A-Za-z0-9_-]{1,64}\.md$/);
  });
});
