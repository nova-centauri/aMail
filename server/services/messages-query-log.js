import { mailboxQueryIsActive, parseMailboxQuery } from '../mail/search-query.js';
import { isSmartCategory } from './smart-filter.js';
import { parseNumber, parsePageSize } from './inbox.js';

const FOLDERS = new Set(['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'all', 'trash', 'spam', 'archive']);

export const SLOW_MESSAGES_MS = 500;

function normalizeLoggedFolder(value) {
  const folder = String(value || 'inbox').toLowerCase();
  return FOLDERS.has(folder) ? folder : 'inbox';
}

/**
 * Allowlisted /api/messages query shape for slow-path logs. Search text,
 * addresses, and raw query strings stay out.
 */
export function sanitizeMessagesQuery(query = {}) {
  const raw = String(query?.q ?? query?.query ?? '');
  const parsed = parseMailboxQuery(raw.slice(0, 800));
  const category = String(query?.category || '').trim().toLowerCase();
  const mailbox = String(query?.mailbox || '').trim();
  const operators = [];
  if (parsed.from.length || parsed.notFrom.length) operators.push('from');
  if (parsed.to.length || parsed.notTo.length) operators.push('to');
  if (parsed.subject.length || parsed.notSubject.length) operators.push('subject');
  if (parsed.hasAttachment != null) operators.push('has');
  if (parsed.after) operators.push('after');
  if (parsed.before) operators.push('before');
  if (parsed.isUnread != null) operators.push('is:read');
  if (parsed.isStarred != null) operators.push('is:starred');
  if (parsed.isAnalyzed != null) operators.push('is:analyzed');
  if (parsed.folder || parsed.anywhere) operators.push('in');
  if (parsed.text) operators.push('text');
  return {
    folder: normalizeLoggedFolder(parsed.folder || query?.folder),
    page: parseNumber(query?.page, 1, 1, 100_000),
    pageSize: parsePageSize(query?.pageSize || query?.limit),
    category: category && isSmartCategory(category) ? category : (category ? 'other' : null),
    hasQuery: mailboxQueryIsActive(parsed),
    queryChars: raw.length,
    operators,
    hasFlag: Boolean(query?.flag || query?.personFlag),
    hasAccountId: Boolean(query?.accountId),
    mailbox: mailbox ? (mailbox === 'INBOX' ? 'INBOX' : 'other') : null,
  };
}
