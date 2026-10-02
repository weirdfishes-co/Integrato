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
