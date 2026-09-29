import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../public/markdown.js';

/*
 * The renderer runs in the browser, where it writes into innerHTML. That makes
 * the escaping rules load-bearing, so they are tested here rather than left to
 * a reviewer's eye.
 */
describe('renderMarkdown', () => {
  it('renders the bold a model actually writes', () => {
    expect(renderMarkdown('a deeper look at **Jan Janssen** today')).toBe(
      '<p>a deeper look at <strong>Jan Janssen</strong> today</p>',
    );
  });

  it('renders headings a step down, since an answer sits inside the page', () => {
    expect(renderMarkdown('### Section')).toBe('<h5>Section</h5>');
    expect(renderMarkdown('# Title')).toBe('<h3>Title</h3>');
  });

  it('renders both kinds of list', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
  });

  it('nests a list by its indentation', () => {
    expect(renderMarkdown('- one\n  - deeper\n- two')).toBe(
      '<ul><li>one<ul><li>deeper</li></ul></li><li>two</li></ul>',
    );
  });

  it('renders a fenced code block, contents untouched', () => {
    expect(renderMarkdown('```js\nconst a = 1;\n```')).toBe(
      '<pre><code class="language-js">const a = 1;</code></pre>',
    );
  });

  it('renders a table', () => {
    const html = renderMarkdown('| Name | Role |\n| --- | --- |\n| Ann | Coach |');

    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td>Coach</td>');
  });

  it('renders a blockquote and a rule', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
    expect(renderMarkdown('---')).toBe('<hr>');
  });

  it('treats a single newline as a line break, the way models use it', () => {
    expect(renderMarkdown('first\nsecond')).toBe('<p>first<br>second</p>');
  });

  it('leaves markers inside code alone', () => {
    expect(renderMarkdown('use `**not bold**` here')).toBe(
      '<p>use <code>**not bold**</code> here</p>',
    );
  });

  it('does not turn snake_case into italics', () => {
    expect(renderMarkdown('the user_name_here field')).toBe('<p>the user_name_here field</p>');
  });

  // ---- escaping: the part that must not regress -------------------------

  it('escapes html rather than rendering it', () => {
    const html = renderMarkdown('<script>alert(1)</script>');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes an attribute-style injection', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });

  it('escapes html inside a code block too', () => {
    expect(renderMarkdown('```\n<b>x</b>\n```')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('refuses a link scheme other than http, https or mailto', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');

    expect(html).not.toContain('<a');
    expect(html).toContain('click');
  });

  it('links an ordinary url, in a new tab and without referrer', () => {
    expect(renderMarkdown('[guide](https://example.com/a)')).toBe(
      '<p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer">guide</a></p>',
    );
  });

  it('cannot be broken out of an href by a quote in the url', () => {
    const html = renderMarkdown('[x](https://example.com/"onmouseover="alert(1))');

    expect(html).not.toContain('onmouseover="alert');
    expect(html).toContain('&quot;');
  });

  it('shows an image as its alt text, so no remote request is made', () => {
    expect(renderMarkdown('![a cat](https://example.com/cat.png)')).toBe('<p>a cat</p>');
  });

  // ---- streaming: it is re-run on every chunk ---------------------------

  it('leaves an unfinished marker literal until its partner arrives', () => {
    expect(renderMarkdown('a look at **Jan Jans')).toBe('<p>a look at **Jan Jans</p>');
  });

  it('renders an unclosed code fence as far as it has arrived', () => {
    expect(renderMarkdown('```js\nconst a = 1')).toBe(
      '<pre><code class="language-js">const a = 1</code></pre>',
    );
  });

  it('returns nothing for nothing', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('\n\n')).toBe('');
  });
});
