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
