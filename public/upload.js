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
      const page = document.querySelector('[data-upload]');
      const pdfUrl = page?.dataset.pdf ?? '/admin/content/pdf';

      // A PDF is converted on the server and then travels the same way as a
      // .md file, so there is one place that writes to the knowledge base.
      async function read(file) {
        if (!/\.pdf$/i.test(file.name)) return { name: file.name, content: await file.text() };
        const converted = await fetch(`${pdfUrl}?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf', Accept: 'application/json' },
          body: file,
        });
        if (converted.status === 401) {
          window.location.href = '/login';
          throw new Error('Signed out.');
        }
        const result = await converted.json().catch(() => ({}));
        if (!converted.ok) throw new Error(`${file.name}: ${result.error ?? `conversion failed (${converted.status})`}`);
        return { name: result.name, content: result.markdown };
      }

      status.textContent = `Converting and uploading ${files.length} file(s)…`;
      const payload = [];
      for (const file of files) payload.push(await read(file));

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
