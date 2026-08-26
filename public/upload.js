/**
 * Upload of .md files on the knowledge base page.
 * The files are read as text in the browser and sent as JSON, so the server
 * needs no multipart handling.
 */

const form = document.getElementById('upload-form');
const input = document.getElementById('upload');
const status = document.getElementById('upload-status');

if (form && input && status) {
  form.addEventListener('submit', (event) => event.preventDefault());

  input.addEventListener('change', async () => {
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;

    status.textContent = `Uploading ${files.length} file(s)…`;

    try {
      const payload = await Promise.all(
        files.map(async (file) => ({ name: file.name, content: await file.text() })),
      );

      const page = document.querySelector('[data-upload]');
      const uploadUrl = page?.dataset.upload ?? '/admin/content/upload';
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ files: payload }),
      });

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `Upload failed (${response.status})`);

      if (result.failed?.length > 0) {
        const reasons = result.failed.map((item) => `${item.name}: ${item.reason}`).join(' — ');
        status.textContent = `${result.saved.length} saved, ${result.failed.length} skipped. ${reasons}`;
        // Still reload: the successful files must show up in the list.
        window.setTimeout(() => window.location.reload(), 4000);
        return;
      }

      const base = page?.dataset.base ?? '/admin/content';
      window.location.href = `${base}?ok=${encodeURIComponent(`${result.saved.length} file(s) uploaded.`)}`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      input.value = '';
    }
  });
}
