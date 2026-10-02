/**
 * The document editor's live preview and character count.
 *
 * It reuses the renderer the chat uses for answers, so what you see here is
 * exactly what the Markdown will look like in a reply — one renderer, one set
 * of rules, and the escaping rules come along with it.
 */

const textarea = document.getElementById('content');
const preview = document.getElementById('editor-preview');
const count = document.getElementById('editor-count');

if (textarea && preview) {
  const version = document.querySelector('.page--editor')?.dataset.version ?? '';
  const { renderMarkdown } = await import(`./markdown.js?v=${version}`);

  const limit = Number(textarea.getAttribute('maxlength')) || 0;

  function render() {
    preview.innerHTML = renderMarkdown(textarea.value);
    if (count && limit > 0) {
      const left = limit - textarea.value.length;
      count.textContent = `${left.toLocaleString('en-US')} characters left`;
    }
  }

  /*
   * Rendering is cheap but not free, and a 20,000-character document redrawn on
   * every keystroke is felt. One frame of delay is not.
   */
  let queued = 0;
  textarea.addEventListener('input', () => {
    cancelAnimationFrame(queued);
    queued = requestAnimationFrame(render);
  });

  render();
}
