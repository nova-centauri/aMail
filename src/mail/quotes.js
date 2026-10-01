const ON_WROTE = /^On .{0,400} wrote:\s*$/i;
const ORIGINAL_MESSAGE = /^-{5,}\s*Original Message\s*-{5,}\s*$/i;
const FORWARDED_MESSAGE = /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i;
const QUOTE_LINE = /^\s*>/;

const QUOTE_SELECTORS = [
  '.gmail_quote',
  '.gmail_extra',
  '.yahoo_quoted',
  '.moz-cite-prefix',
  '#appendonsend',
  '#divRplyFwdMsg',
  'blockquote[type="cite"]',
];

function trailingQuoteStart(lines) {
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === '') end -= 1;
  if (end < 0 || !QUOTE_LINE.test(lines[end])) return -1;
  let start = end;
  while (start > 0) {
    const previous = lines[start - 1];
    const trimmed = previous.trim();
    if (trimmed === '' || QUOTE_LINE.test(previous) || ON_WROTE.test(trimmed)) {
      start -= 1;
      continue;
    }
    break;
  }
  while (start <= end && lines[start].trim() === '') start += 1;
  return lines.slice(0, start).some((line) => line.trim()) ? start : -1;
}

function outlookHeaderStart(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^From:\s+\S/.test(lines[index].trim())) continue;
    const window = lines.slice(index, index + 8).map((line) => line.trim());
    const hasSent = window.some((line) => /^(Sent|Date):\s+\S/i.test(line));
    const hasSubject = window.some((line) => /^Subject:\s+\S/i.test(line));
    if (!hasSent || !hasSubject) continue;
    if (!lines.slice(0, index).some((line) => line.trim())) continue;
    return index;
  }
  return -1;
}

/**
 * Drop the trailing reply quote so a conversation can show each message once.
 * Forwards stay intact: that text is the message, not a duplicate of an earlier card.
 * If stripping would leave the message empty, the original text is kept.
 */
export function stripQuotedPlain(text) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  if (!source.trim()) return { text: source, quoted: '', stripped: false };
  const lines = source.split('\n');
  let cut = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (FORWARDED_MESSAGE.test(trimmed)) break;
    if (ON_WROTE.test(trimmed) || ORIGINAL_MESSAGE.test(trimmed)) {
      cut = index;
      break;
    }
  }
  if (cut < 0) cut = outlookHeaderStart(lines);
  if (cut < 0) cut = trailingQuoteStart(lines);
  if (cut < 0) return { text: source, quoted: '', stripped: false };
  const kept = lines.slice(0, cut).join('\n').trim();
  const quoted = lines.slice(cut).join('\n').trim();
  if (!kept || !quoted) return { text: source, quoted: '', stripped: false };
  return { text: kept, quoted, stripped: true };
}

function collectQuoteRoots(body) {
  const matches = [];
  for (const selector of QUOTE_SELECTORS) {
    body.querySelectorAll(selector).forEach((element) => {
      if (matches.some((existing) => existing === element || existing.contains(element))) return;
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        if (element.contains(matches[index])) matches.splice(index, 1);
      }
      matches.push(element);
    });
  }
  const children = [...body.children];
  const last = [...children].reverse().find((element) => (element.textContent || '').trim());
  if (last?.tagName === 'BLOCKQUOTE' && !matches.some((existing) => existing === last || existing.contains(last))) {
    matches.push(last);
  }
  return matches;
}

function removeQuoteRoot(element) {
  const previous = element.previousElementSibling;
  const dropWrote = previous && /wrote:\s*$/i.test((previous.textContent || '').trim());
  const html = `${dropWrote ? previous.outerHTML : ''}${element.outerHTML}`;
  if (dropWrote) previous.remove();
  element.remove();
  return html;
}

/**
 * Remove trailing reply quotes from sanitized-later HTML. Returns the original
 * HTML when the remainder would be blank or the DOM is unavailable.
 */
export function stripQuotedHtml(html) {
  const source = String(html || '');
  if (!source.trim() || typeof DOMParser === 'undefined') {
    return { html: source, quotedHtml: '', stripped: false };
  }
  const documentNode = new DOMParser().parseFromString(source, 'text/html');
  const removed = collectQuoteRoots(documentNode.body).map(removeQuoteRoot);
  const keptText = (documentNode.body.textContent || '').replace(/\s+/g, ' ').trim();
  if (!removed.length || !keptText) return { html: source, quotedHtml: '', stripped: false };
  return { html: documentNode.body.innerHTML, quotedHtml: removed.join(''), stripped: true };
}

export function messageTimelineContent(message = {}) {
  const plain = stripQuotedPlain(message.body || '');
  const html = stripQuotedHtml(message.bodyHtml || '');
  return {
    body: plain.stripped ? plain.text : String(message.body || ''),
    // If HTML still contains the reply quote, prefer the stripped plain text
    // so the card does not fall back to the indented copy.
    bodyHtml: html.stripped ? html.html : (plain.stripped ? '' : String(message.bodyHtml || '')),
    quotedText: plain.quoted,
    quotedHtml: html.quotedHtml,
    stripped: plain.stripped || html.stripped,
  };
}
