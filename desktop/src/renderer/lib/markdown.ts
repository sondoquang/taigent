// Descriptions are Markdown written by an agent: rendered with marked, then sanitized with DOMPurify before they
// reach the DOM (components/markdown.tsx). Links never navigate the window; they open in the system browser (App
// handles `a[data-external]`, main checks http/https).

import DOMPurify from 'dompurify';
import { marked } from 'marked';

// GFM task lists (`- [ ] …`) render as checkboxes, as on Taiga: an <input> survives only as a disabled checkbox.
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'input' && node instanceof Element && (node.getAttribute('type') !== 'checkbox' || !node.hasAttribute('disabled'))) {
    node.remove();
  }
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    node.removeAttribute('target');
    node.setAttribute('data-external', href);
    node.setAttribute('rel', 'noreferrer');
    node.setAttribute('title', href);
  }
});

/** Sanitized HTML of Markdown `text` (GFM, line breaks kept). */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: true, async: false });
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed', 'select', 'textarea'],
    FORBID_ATTR: ['style'],
  });
}
