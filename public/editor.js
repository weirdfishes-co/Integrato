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

  // Start from a PDF: the server converts it, the text lands here to be edited.
  const pdfInput = document.getElementById('pdf');
  const pdfStatus = document.getElementById('pdf-status');
  const pdfUrl = document.querySelector('.page--editor')?.dataset.pdf;
  if (pdfInput && pdfStatus && pdfUrl) {
    pdfInput.addEventListener('change', async () => {
      const file = pdfInput.files?.[0];
      if (!file) return;
      if (textarea.value.trim() !== '' && !window.confirm('Replace the text in the editor with this PDF?')) {
        pdfInput.value = '';
        return;
      }
      pdfStatus.textContent = 'Converting…';
      try {
        const response = await fetch(`${pdfUrl}?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf', Accept: 'application/json' },
          body: file,
        });
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error ?? `Conversion failed (${response.status})`);

        textarea.value = result.markdown;
        const nameField = document.getElementById('name');
        if (nameField && nameField.value.trim() === '') nameField.value = result.name.replace(/\.md$/, '').replace(/-/g, ' ');
        render();
        pdfStatus.textContent =
          limit > 0 && result.markdown.length > limit
            ? `${result.pages} page(s) converted, but the text is ${(result.markdown.length - limit).toLocaleString('en-US')} characters over the limit. Shorten it before saving.`
            : `${result.pages} page(s) converted. Check the text before saving.`;
      } catch (error) {
        pdfStatus.textContent = error.message;
      } finally {
        pdfInput.value = '';
      }
    });
  }
}
