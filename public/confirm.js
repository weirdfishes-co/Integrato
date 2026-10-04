/**
 * "Are you sure?" on any form carrying data-confirm.
 *
 * This exists so no page has to write `onsubmit="return confirm('...')"`. That
 * attribute is a *JavaScript* context inside an HTML attribute, and HTML
 * escaping is the wrong escaping for it: the parser turns `&#39;` back into a
 * real quote before the handler is compiled, so a name containing an
 * apostrophe broke out of the string literal and ran. That was a proven hole,
 * not a theory — a document name was enough.
 *
 * data-confirm is read as text through `dataset`, never compiled, so ordinary
 * HTML escaping is exactly right for it. Keeping the markup free of inline
 * handlers is also what makes a strict Content-Security-Policy possible.
 */
document.addEventListener('submit', (event) => {
  const form = event.target instanceof Element ? event.target.closest('form[data-confirm]') : null;
  if (!form) return;
  if (!window.confirm(form.dataset.confirm)) event.preventDefault();
});
