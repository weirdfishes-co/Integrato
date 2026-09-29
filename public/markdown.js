/**
 * Markdown for the answers, rendered in the browser.
 *
 * Models write Markdown whether or not you ask them to, so an answer shown as
 * plain text reads as `**Jan Janssen**` and `### Heading`. This turns the
 * subset they actually emit into HTML.
 *
 * The safety rule is the order of operations: the text is **HTML-escaped
 * first**, and every transform below runs on already-escaped text. Nothing the
 * model writes can become a tag, because by the time these rules see it, a `<`
 * is already `&lt;`. Do not reorder that — it is the whole defence, and it is
 * why this needs no sanitizer library.
 *
 * Links are the one place an attribute is built, so the scheme is checked and
 * the URL is escaped like everything else.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/** A model can invent a `javascript:` URL; only these three may become a link. */
function link(href, label) {
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return label;
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/**
 * Inline markers, inside one block of text.
 *
 * Code spans are lifted out first and put back last, so a `**` inside
 * backticks stays what the model typed.
 */
function inline(text) {
  const spans = [];

  let out = escapeHtml(text).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, body) => {
    spans.push(body.trim());
    return `\u0000${spans.length - 1}\u0000`;
  });

  // An image is shown as its own alt text: this is a chat, not a document, and
  // a remote image would be a request to somewhere we did not choose.
  out = out.replace(/!\[([^\]]*)\]\([^)\s]*\)/g, '$1');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => link(href, label));

  out = out.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([\s\S]+?)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Underscores only at a word boundary, so snake_case_names survive.
  out = out.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');

  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${spans[Number(index)]}</code>`);
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function isListItem(line) {
  return BULLET.test(line) || NUMBER.test(line);
}

function isBlank(line) {
  return line.trim().length === 0;
}

/** Splits `| a | b |` into its cells, ignoring the outer pipes. */
function cells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * One run of list items, which may nest. Indentation decides the level, so a
 * two-space indent under a bullet becomes a nested list rather than a sibling.
 */
function renderList(lines, start) {
  const first = BULLET.exec(lines[start]) ?? NUMBER.exec(lines[start]);
  const indent = first[1].length;
  const ordered = NUMBER.test(lines[start]);
  const items = [];

  let index = start;
  while (index < lines.length) {
    const line = lines[index];

    if (isBlank(line)) {
      // A blank line ends the list unless another item follows it.
      if (index + 1 < lines.length && isListItem(lines[index + 1])) {
        index += 1;
        continue;
      }
      break;
    }

    const match = BULLET.exec(line) ?? NUMBER.exec(line);
    if (!match || match[1].length < indent) break;

    if (match[1].length > indent) {
      const [nested, next] = renderList(lines, index);
      items[items.length - 1] = `${items[items.length - 1]}${nested}`;
      index = next;
      continue;
    }

    items.push(inline(match[2]));
    index += 1;
  }

  const tag = ordered ? 'ol' : 'ul';
  return [`<${tag}>${items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`, index];
}

/**
 * Markdown to HTML, for the subset a chat model writes: headings, lists,
 * quotes, fenced code, tables, rules, and the inline markers.
 *
 * It is called again on every streamed chunk, so it has to cope with a
 * half-written document — an unclosed `**` simply stays literal until its
 * partner arrives.
 */
export function renderMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // the closing fence, or the end of a stream that has none yet
      const language = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : '';
      html.push(`<pre><code${language}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (RULE.test(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // Answers sit inside the page, so their headings start a step down: a
      // model's `#` is a section of an answer, not a title for the screen.
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(QUOTE.exec(lines[index])[1]);
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    if (isListItem(line)) {
      const [markup, next] = renderList(lines, index);
      html.push(markup);
      index = next;
      continue;
    }

    // A table is only a table once its divider row has arrived; while a stream
    // is mid-header it falls through and renders as a paragraph.
    if (line.includes('|') && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1])) {
      const head = cells(line);
      index += 2;
      const body = [];
      while (index < lines.length && lines[index].includes('|') && !isBlank(lines[index])) {
        body.push(cells(lines[index]));
        index += 1;
      }
      const headRow = head.map((cell) => `<th>${inline(cell)}</th>`).join('');
      const bodyRows = body
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
        .join('');
      html.push(
        `<table class="md-table"><thead><tr>${headRow}</tr></thead><tbody>${bodyRows}</tbody></table>`,
      );
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length &&
      !isBlank(lines[index]) &&
      !FENCE.test(lines[index]) &&
      !HEADING.test(lines[index]) &&
      !RULE.test(lines[index]) &&
      !QUOTE.test(lines[index]) &&
      !isListItem(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    // A single newline inside a paragraph is a line break, not a space: models
    // use it to lay out an address or a short list of points.
    html.push(`<p>${paragraph.map((part) => inline(part)).join('<br>')}</p>`);
  }

  return html.join('');
}
