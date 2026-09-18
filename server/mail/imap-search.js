/**
 * Map a parsed mailbox query to IMAP SEARCH / Gmail X-GM-RAW.
 * Local-only operators (is:analyzed, person flags, smart views) are never sent.
 */
export const IMAP_SEARCH_UID_CAP = 200;
export const IMAP_ENVELOPE_FETCH_CAP = 50;
export const IMAP_SEARCH_MAILBOX_CAP = 4;

export function shouldSearchProvider(parsed, { source = 'human', folder = 'inbox' } = {}) {
  if (!parsed?.text) return false;
  if (parsed.isAnalyzed != null) return false;
  if (folder === 'drafts' || folder === 'snoozed') return false;
  if (source === 'mcp') return Boolean(parsed.anywhere);
  return source === 'human';
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
  if (folder === 'starred' || folder === 'all') {
    const allMail = list.find((item) => item.allMailMirror);
    if (folder === 'all' && allMail) return [allMail];
    return list.slice(0, IMAP_SEARCH_MAILBOX_CAP);
  }
  return list.filter((item) => item.role === 'inbox').slice(0, 1);
}

export function newestUids(uids, cap = IMAP_SEARCH_UID_CAP) {
  return [...new Set((uids || []).map(Number).filter((uid) => Number.isInteger(uid) && uid > 0))]
    .sort((left, right) => right - left)
    .slice(0, cap);
}

export function bodyStructureFilenames(node, out = []) {
  if (!node) return out;
  const children = node.childNodes || node.childParts || [];
  if (Array.isArray(children) && children.length) {
    for (const child of children) bodyStructureFilenames(child, out);
    return out;
  }
  const filename = node.dispositionParameters?.filename
    || node.parameters?.name
    || node.filename
    || '';
  const disposition = String(node.disposition || '').toLowerCase();
  if (filename && disposition !== 'inline') out.push(String(filename));
  else if (disposition === 'attachment') out.push(String(filename || 'attachment'));
  return out;
}
