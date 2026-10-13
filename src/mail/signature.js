export const SIGNATURE_MAX_LENGTH = 200_000;
export const COMPOSE_MAX_LENGTH = 1_000_000;
export const SIGNATURE_HTML_UPLOAD_MAX_BYTES = 400_000;
export const SIGNATURE_IMAGE_MAX_BYTES = 80_000;

const HTML_TAG = /<\/?(?:html|head|body|a|abbr|b|blockquote|br|caption|center|code|div|em|figcaption|figure|font|h[1-6]|hr|i|img|li|ol|p|pre|s|small|span|strong|sub|sup|table|tbody|td|tfoot|th|thead|tr|u|ul)\b[^>]*>/i;
const ALLOWED_TAGS = new Set([
  'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CAPTION', 'CENTER', 'CODE', 'DIV', 'EM',
  'FIGCAPTION', 'FIGURE', 'FONT', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I',
  'IMG', 'LI', 'OL', 'P', 'PRE', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'U', 'UL',
]);
const FORBIDDEN_TAGS = new Set([
  'SCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'FORM', 'IFRAME', 'OBJECT', 'EMBED',
  'VIDEO', 'AUDIO', 'SVG', 'MATH', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'CANVAS', 'APPLET',
]);
const ALLOWED_STYLES = new Set([
  'color', 'background-color', 'font-size', 'font-family', 'font-weight', 'font-style',
  'text-align', 'text-decoration', 'line-height', 'letter-spacing', 'width', 'height',
  'max-width', 'min-width', 'margin', 'margin-top', 'margin-right', 'margin-bottom',
  'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-width',
  'border-style', 'border-color', 'border-radius', 'border-collapse', 'vertical-align',
  'white-space', 'display',
]);
const SAFE_HREF = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const DIMENSION = /^(?:\d{1,4}(?:\.\d+)?(?:px|%)?)$/i;
const COLORISH = /^(?:#(?:[0-9a-f]{3,8})|[a-z]{3,20})$/i;

export function looksLikeHtml(value) {
  return HTML_TAG.test(String(value || ''));
}

export function escapeSignatureText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function extractHtmlDocumentBody(raw) {
  const source = String(raw || '').replace(/^\uFEFF/, '');
  if (!source.trim()) return '';
  if (typeof DOMParser === 'undefined') return source.trim();
  const documentNode = new DOMParser().parseFromString(source, 'text/html');
  return (documentNode.body?.innerHTML || source).trim();
}

function sanitizeStyleAttribute(value) {
  return String(value || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf(':');
      if (index < 1) return '';
      const property = part.slice(0, index).trim().toLowerCase();
      const raw = part.slice(index + 1).trim();
      if (!ALLOWED_STYLES.has(property) || !raw) return '';
      if (/url\s*\(|expression\s*\(|javascript:|@import|-moz-binding/i.test(raw)) return '';
      if (property === 'display' && !/^(inline|inline-block|block|none|table|table-cell|table-row)$/i.test(raw)) return '';
      return `${property}: ${raw.slice(0, 200)}`;
    })
    .filter(Boolean)
    .join('; ');
}

function isSafeHref(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return SAFE_HREF.has(parsed.protocol);
  } catch {
    return false;
  }
}

function isSafeImageSrc(value) {
  const src = String(value || '').trim();
  if (DATA_IMAGE.test(src) && src.length <= 180_000) return true;
  try {
    const parsed = new URL(src);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanAttributes(element) {
  [...element.attributes].forEach((attribute) => {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (name.startsWith('on') || name === 'srcset' || name === 'poster' || name === 'background' || name.startsWith('data-')) {
      element.removeAttribute(attribute.name);
      return;
    }
    if (name === 'style') {
      const cleaned = sanitizeStyleAttribute(value);
      if (cleaned) element.setAttribute('style', cleaned);
      else element.removeAttribute('style');
      return;
    }
    if (element.tagName === 'A' && name === 'href') {
      if (isSafeHref(value)) {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      } else {
        element.removeAttribute('href');
      }
      return;
    }
    if (element.tagName === 'IMG' && name === 'src') {
      if (!isSafeImageSrc(value)) element.removeAttribute('src');
      return;
    }
    if (['width', 'height', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'size'].includes(name)) {
      if (!DIMENSION.test(value) && !/^\d{1,4}$/.test(value)) element.removeAttribute(attribute.name);
      return;
    }
    if (['color', 'bgcolor'].includes(name) && !COLORISH.test(value)) {
      element.removeAttribute(attribute.name);
      return;
    }
    if (!['href', 'src', 'alt', 'title', 'name', 'target', 'rel', 'align', 'valign', 'dir', 'face', 'color', 'bgcolor', 'width', 'height', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'size'].includes(name)) {
      element.removeAttribute(attribute.name);
    }
  });
}

function cleanNode(node) {
  if (node.nodeType === Node.COMMENT_NODE) {
    node.remove();
    return;
  }
  if (node.nodeType === Node.TEXT_NODE) return;
  if (node.nodeType !== Node.ELEMENT_NODE) {
    node.remove();
    return;
  }
  if (FORBIDDEN_TAGS.has(node.tagName)) {
    node.remove();
    return;
  }
  [...node.childNodes].forEach((child) => cleanNode(child));
  if (!ALLOWED_TAGS.has(node.tagName)) {
    node.replaceWith(...node.childNodes);
    return;
  }
  cleanAttributes(node);
}

export function sanitizeSignatureHtml(value) {
  if (!value || typeof DOMParser === 'undefined') return '';
  const documentNode = new DOMParser().parseFromString(String(value), 'text/html');
  const body = documentNode.body;
  if (!body) return '';
  [...body.childNodes].forEach((child) => cleanNode(child));
  return body.innerHTML.trim();
}

export function storedSignatureToEditorHtml(value) {
  const raw = String(value || '');
  if (!raw.trim()) return '';
  if (looksLikeHtml(raw)) return sanitizeSignatureHtml(extractHtmlDocumentBody(raw));
  return escapeSignatureText(raw).replace(/\r?\n/g, '<br>');
}

export function editorHtmlToStored(html) {
  const cleaned = sanitizeSignatureHtml(html);
  const textish = cleaned.replace(/<\/?(?:div|p|span|br)\b[^>]*>|&nbsp;|\s/gi, '');
  if (!textish) return '';
  return cleaned;
}

export function signaturePreviewHtml(value) {
  return storedSignatureToEditorHtml(value);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('The HTML file could not be read.'));
    reader.readAsText(file);
  });
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.readAsDataURL(file);
  });
}

export function validateSignatureLength(value, maxLength = SIGNATURE_MAX_LENGTH) {
  const length = String(value || '').length;
  const cap = Number(maxLength) || SIGNATURE_MAX_LENGTH;
  if (length > cap) {
    return `Content is too long (${length.toLocaleString()} characters; max ${cap.toLocaleString()}).`;
  }
  return '';
}

export function htmlToPlainText(value) {
  const raw = String(value || '')
    .replace(/&nbsp;/gi, '\u00a0')
    .replace(/&#0*160;/g, '\u00a0')
    .replace(/&#x0*a0;/gi, '\u00a0');
  if (!raw.trim()) return '';
  if (!looksLikeHtml(raw) && typeof DOMParser === 'undefined') return raw.replace(/\r\n/g, '\n').trim();
  if (typeof DOMParser === 'undefined') {
    return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const cleaned = looksLikeHtml(raw) ? sanitizeSignatureHtml(extractHtmlDocumentBody(raw)) : escapeSignatureText(raw);
  const documentNode = new DOMParser().parseFromString(cleaned, 'text/html');
  const body = documentNode.body;
  if (!body) return raw.replace(/\s+/g, ' ').trim();
  body.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
  body.querySelectorAll('p, div, tr, h1, h2, h3, h4, h5, h6, li, blockquote').forEach((node) => node.append('\n'));
  return (body.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function storedComposeToEditorHtml(value) {
  return storedSignatureToEditorHtml(value);
}
