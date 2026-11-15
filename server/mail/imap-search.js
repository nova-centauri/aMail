/**
 * Map a parsed mailbox query to IMAP SEARCH / Gmail X-GM-RAW.
 * Local-only operators (is:analyzed, person flags, smart views) are never sent.
 */
export const IMAP_SEARCH_UID_CAP = 200;
export const IMAP_ENVELOPE_FETCH_CAP = 50;
export const IMAP_SEARCH_MAILBOX_CAP = 4;
export const IMAP_DEEP_SEARCH_UID_CAP = 2_000;
export const IMAP_DEEP_ENVELOPE_BATCH = 40;
export const IMAP_DEEP_MAILBOX_CAP = 24;
export const IMAP_DEEP_ACCOUNT_GAP_MS = 400;
export const IMAP_DEEP_MAILBOX_GAP_MS = 150;
export const IMAP_DEEP_BATCH_GAP_MS = 80;
const SKIP_DEEP_ROLES = new Set(['trash', 'spam', 'drafts']);

/** True when leftover text or operators can be sent as IMAP SEARCH / X-GM-RAW. */
export function imapSearchIsSelective(parsed) {
  if (!parsed) return false;
  return Boolean(
    parsed.text
    || parsed.from[0]
    || parsed.to[0]
    || parsed.subject[0]
    || parsed.after
    || parsed.before
    || parsed.isUnread != null
    || parsed.isStarred != null
  );
}

export function canMapToImapSearch(parsed, { allowAttachmentOnly = false } = {}) {
  if (!parsed || parsed.isAnalyzed != null) return false;
  if (imapSearchIsSelective(parsed)) return true;
  return Boolean(allowAttachmentOnly && parsed.hasAttachment != null);
}

export function shouldDeepSearchProvider(parsed, { folder = 'inbox' } = {}) {
  if (folder === 'drafts' || folder === 'snoozed') return false;
  return canMapToImapSearch(parsed, { allowAttachmentOnly: true });
}

export function shouldSearchProvider(parsed, { source = 'human', folder = 'inbox' } = {}) {
  if (parsed?.isAnalyzed != null) return false;
  if (folder === 'drafts' || folder === 'snoozed') return false;
  if (source === 'deep') return shouldDeepSearchProvider(parsed, { folder });
  if (!parsed?.text) return false;
  if (source === 'mcp') return Boolean(parsed.anywhere);
  // Fast human listing stays on the local cache. Provider SEARCH is the
  // streaming deep-search job so typing does not block or hammer IMAP.
  return false;
}

function imapDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date;
}

function quoteRaw(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '')}"` : text;
}

/** Portable ImapFlow search object. Leftover text uses TEXT (headers + body). */
export function toImapSearchQuery(parsed) {
  if (!parsed) return null;
  const query = {};
  if (parsed.text) query.text = parsed.text;
  if (parsed.from[0]) query.from = parsed.from[0];
  if (parsed.to[0]) query.to = parsed.to[0];
  if (parsed.subject[0]) query.subject = parsed.subject[0];
  if (parsed.after) {
    const since = imapDate(parsed.after);
    if (since) query.since = since;
  }
  if (parsed.before) {
    const before = imapDate(parsed.before);
    if (before) query.before = before;
  }
  if (parsed.isUnread === true) query.seen = false;
  if (parsed.isUnread === false) query.seen = true;
  if (parsed.isStarred === true) query.flagged = true;
  if (parsed.isStarred === false) query.flagged = false;
  if (parsed.notFrom[0]) query.not = { ...(query.not || {}), from: parsed.notFrom[0] };
  if (parsed.notTo[0]) query.not = { ...(query.not || {}), to: parsed.notTo[0] };
  if (parsed.notSubject[0]) query.not = { ...(query.not || {}), subject: parsed.notSubject[0] };
  return Object.keys(query).length ? query : null;
}

/** Gmail web `q` for X-GM-RAW. Never includes is:analyzed. */
export function toGmailRawQuery(parsed) {
  if (!parsed) return '';
  const parts = [];
  for (const value of parsed.from) parts.push(`from:${quoteRaw(value)}`);
  for (const value of parsed.to) parts.push(`to:${quoteRaw(value)}`);
  for (const value of parsed.subject) parts.push(`subject:${quoteRaw(value)}`);
  for (const value of parsed.notFrom) parts.push(`-from:${quoteRaw(value)}`);
  for (const value of parsed.notTo) parts.push(`-to:${quoteRaw(value)}`);
  for (const value of parsed.notSubject) parts.push(`-subject:${quoteRaw(value)}`);
  if (parsed.hasAttachment === true) parts.push('has:attachment');
  if (parsed.hasAttachment === false) parts.push('-has:attachment');
  if (parsed.after) {
    const date = new Date(parsed.after);
    if (!Number.isNaN(date.valueOf())) {
      parts.push(`after:${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`);
    }
  }
  if (parsed.before) {
    const date = new Date(parsed.before);
    if (!Number.isNaN(date.valueOf())) {
      parts.push(`before:${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`);
    }
  }
  if (parsed.isUnread === true) parts.push('is:unread');
  if (parsed.isUnread === false) parts.push('is:read');
  if (parsed.isStarred === true) parts.push('is:starred');
  if (parsed.isStarred === false) parts.push('is:unstarred');
  if (parsed.text) parts.push(parsed.text);
  return parts.join(' ').trim();
}

export function canUseGmraw(account, client) {
  if (account?.provider === 'gmail') return true;
  const capabilities = client?.capabilities;
  if (capabilities && typeof capabilities.has === 'function') return capabilities.has('X-GM-EXT-1');
  return false;
}

export function mailboxesForSearch(descriptors, folder) {
  const list = Array.isArray(descriptors) ? descriptors.filter(Boolean) : [];
  if (!list.length) return [];
  if (folder === 'inbox') return list.filter((item) => item.role === 'inbox').slice(0, 1);
  if (folder === 'sent') return list.filter((item) => item.role === 'sent').slice(0, 1);
  if (folder === 'archive') return list.filter((item) => item.role === 'archive').slice(0, 1);
  if (folder === 'trash') return list.filter((item) => item.role === 'trash').slice(0, 1);
  if (folder === 'spam') return list.filter((item) => item.role === 'spam').slice(0, 1);
  if (folder === 'drafts') return list.filter((item) => item.role === 'drafts').slice(0, 1);
  if (folder === 'starred' || folder === 'all') {
    const allMail = list.find((item) => item.allMailMirror);
    if (folder === 'all' && allMail) return [allMail];
    return list.slice(0, IMAP_SEARCH_MAILBOX_CAP);
  }
  return list.filter((item) => item.role === 'inbox').slice(0, 1);
}

function uniqueMailboxes(items, cap) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.mailbox || seen.has(item.mailbox)) continue;
    seen.add(item.mailbox);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Deep search prefers thoroughness: inbox also covers archive/All Mail, Sent,
 * and custom folders. Gmail's All Mail mirror still collapses `in:anywhere`.
 */
export function mailboxesForDeepSearch(descriptors, folder) {
  const list = Array.isArray(descriptors) ? descriptors.filter(Boolean) : [];
  if (!list.length) return [];
  if (folder === 'sent') return uniqueMailboxes(list.filter((item) => item.role === 'sent'), 1);
  if (folder === 'archive') return uniqueMailboxes(list.filter((item) => item.role === 'archive'), 2);
  if (folder === 'trash') return uniqueMailboxes(list.filter((item) => item.role === 'trash'), 1);
  if (folder === 'spam') return uniqueMailboxes(list.filter((item) => item.role === 'spam'), 1);
  if (folder === 'drafts') return uniqueMailboxes(list.filter((item) => item.role === 'drafts'), 1);
  if (folder === 'starred' || folder === 'all') {
    const allMail = list.find((item) => item.allMailMirror);
    if (folder === 'all' && allMail) return [allMail];
    return uniqueMailboxes(list.filter((item) => !SKIP_DEEP_ROLES.has(item.role)), IMAP_DEEP_MAILBOX_CAP);
  }
  const inbox = list.filter((item) => item.role === 'inbox');
  const archive = list.filter((item) => item.role === 'archive' || item.allMailMirror);
  const sent = list.filter((item) => item.role === 'sent');
  const custom = list.filter((item) => !['inbox', 'sent', 'archive', ...SKIP_DEEP_ROLES].includes(item.role) && !item.allMailMirror);
  return uniqueMailboxes([...inbox.slice(0, 1), ...archive, ...sent, ...inbox.slice(1), ...custom], IMAP_DEEP_MAILBOX_CAP);
}

export function newestUids(uids, cap = IMAP_SEARCH_UID_CAP) {
  return [...new Set((uids || []).map(Number).filter((uid) => Number.isInteger(uid) && uid > 0))]
    .sort((left, right) => right - left)
    .slice(0, cap);
}

function bodyStructureLeaves(node, out = [], path = '') {
  if (!node) return out;
  const children = node.childNodes || node.childParts || [];
  if (Array.isArray(children) && children.length) {
    children.forEach((child, index) => bodyStructureLeaves(child, out, path ? `${path}.${index + 1}` : String(index + 1)));
    return out;
  }
  // A single-part message has no part number of its own; IMAP calls its body 1.
  out.push({ node, part: String(node.part || path || '1') });
  return out;
}

function leafFilename(node) {
  return String(node.dispositionParameters?.filename || node.parameters?.name || node.filename || '');
}

function leafIsAttachment(node) {
  const filename = leafFilename(node);
  const disposition = String(node.disposition || '').toLowerCase();
  return Boolean(filename && disposition !== 'inline') || disposition === 'attachment';
}

/**
 * Attachments named by an IMAP BODYSTRUCTURE, in the same order as
 * bodyStructureFilenames, with the part number that downloads each one.
 * size is the encoded size the server reports; estimatedSize is the decoded
 * size it implies (base64 carries 3 bytes in 4, plus line breaks).
 */
export function bodyStructureAttachments(node) {
  return bodyStructureLeaves(node)
    .filter(({ node: leaf }) => leafIsAttachment(leaf))
    .map(({ node: leaf, part }) => {
      const encodedSize = Number.isSafeInteger(Number(leaf.size)) && Number(leaf.size) >= 0 ? Number(leaf.size) : null;
      const encoding = String(leaf.encoding || '').toLowerCase() || null;
      return {
        filename: leafFilename(leaf) || 'attachment',
        part,
        contentType: String(leaf.type || 'application/octet-stream').toLowerCase(),
        encoding,
        encodedSize,
        estimatedSize: estimateDecodedSize(encodedSize, encoding),
        contentId: leaf.id || null,
      };
    });
}

/** A typical decoded size, for display. Quoted-printable can shrink a lot. */
export function estimateDecodedSize(encodedSize, encoding) {
  if (!Number.isSafeInteger(encodedSize) || encodedSize < 0) return 0;
  if (encoding === 'base64') return Math.floor(encodedSize * (76 / 78) * 0.75);
  return encodedSize;
}

/**
 * The smallest the decoded part can be, for refusing a file early only when
 * it is surely over a limit. Base64 allows for lines as short as 48
 * characters; quoted-printable for every byte written as =XX.
 */
export function minDecodedSize(encodedSize, encoding) {
  const size = Number(encodedSize);
  if (!Number.isSafeInteger(size) || size < 0) return 0;
  const name = String(encoding || '').toLowerCase();
  if (name === 'base64') return Math.floor(size * 0.72);
  if (name === 'quoted-printable') return Math.floor(size / 3);
  return size;
}

/** The first text/plain and text/html body parts that are not attachments. */
export function bodyStructureTextParts(node) {
  const found = {};
  for (const { node: leaf, part } of bodyStructureLeaves(node)) {
    if (leafIsAttachment(leaf)) continue;
    const type = String(leaf.type || '').toLowerCase();
    if (type === 'text/plain' && !found.text) found.text = { part, size: Number(leaf.size) || 0 };
    if (type === 'text/html' && !found.html) found.html = { part, size: Number(leaf.size) || 0 };
  }
  return found;
}

export function bodyStructureFilenames(node, out = []) {
  for (const item of bodyStructureAttachments(node)) {
    out.push(item.filename);
  }
  return out;
}
