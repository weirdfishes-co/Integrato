import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The stylesheet has no build step and no linter, so nothing between an editor
 * and the browser notices a syntax error — and CSS does not fail loudly. A
 * stray `}` puts the parser into error recovery and it silently discards the
 * *next* rule.
 *
 * That is not hypothetical: a palette edit once left an extra brace before
 * `* { box-sizing: border-box }`, which swallowed it. Every padded box in the
 * app quietly became content-box, and the chat composer grew 597px past the
 * viewport. These two checks cost nothing and would have caught it.
 */
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

describe('public/styles.css', () => {
  it('has balanced braces', () => {
    const unbalanced: number[] = [];
    let depth = 0;
    let line = 1;

    for (const character of css) {
      if (character === '\n') line += 1;
      if (character === '{') depth += 1;
      if (character === '}') {
        depth -= 1;
        if (depth < 0) {
          unbalanced.push(line);
          depth = 0;
        }
      }
    }

    expect(unbalanced, 'a closing brace with nothing open: it will eat the next rule').toEqual([]);
    expect(depth, 'a block left open at the end of the file').toBe(0);
  });

  /*
   * A table has no margin of its own and its last row draws a rule, so anything
   * placed after one sits on that line. A paragraph escapes by its default
   * margin; a button, a link row and a form do not. Two pages had it — the
   * access form's Save button and the document list's "write a new document"
   * link — and nothing failed, because touching is not an error. Measured at
   * 0px in a browser, which is the only way to see it.
   */
  it('spaces whatever follows a table inside a panel', () => {
    const rule = /\.panel \.table \+ [^{]*\{[^}]*\}/s.exec(css)?.[0] ?? '';

    expect(rule).toContain('margin-top');
    for (const after of ['button', '.row', 'form']) {
      expect(rule, `a ${after} after a table would touch the rule`).toContain(after);
    }
  });

  /*
   * Named explicitly because its absence is invisible until a padded element
   * is measured, and by then the symptom looks like a layout bug somewhere
   * else entirely.
   */
  it('still sets border-box on everything', () => {
    expect(css).toMatch(/\*\s*\{[^}]*box-sizing:\s*border-box/);
  });
});

/*
 * The favicon is a drawn glyph rather than a font or a bitmap, so it is worth
 * a couple of assertions: a letter made of rects is easy to break silently,
 * and the transparent background is the whole reason the dark-mode rule exists.
 */
describe('public/favicon.svg', () => {
  const svg = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');

  it('draws the I in the brand green', () => {
    expect(svg).toContain('#2e4b36');
    // The colour comes from the class, so the theme rule below can override it.
    expect(svg).not.toMatch(/<rect[^>]*fill=/);
  });

  /* No full-bleed rect: the tab strip shows through, which is the point. */
  it('paints no background', () => {
    expect(svg).not.toMatch(/<rect[^>]*width="32"[^>]*height="32"/);
    expect(svg).not.toMatch(/<rect[^>]*height="32"[^>]*width="32"/);
  });

  /* A dark tab strip would all but swallow the forest green. */
  it('lightens the glyph for a dark tab strip', () => {
    expect(svg).toMatch(/@media \(prefers-color-scheme: dark\)[^}]*#8a9e86/s);
  });

  it('is three bars, which is what makes it read as a letter', () => {
    expect(svg.match(/<rect/g)).toHaveLength(3);
  });
});
