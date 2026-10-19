import { mailboxQueryIsActive, parseMailboxQuery } from '../mail/search-query.js';
import { isSmartCategory } from './smart-filter.js';
import { parseNumber, parsePageSize } from './inbox.js';

const FOLDERS = new Set(['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'all', 'trash', 'spam', 'archive']);

export const SLOW_MESSAGES_MS = 500;

const PHASE_CACHE = new Set(['etag', 'list', 'miss']);

export function emptyMessagesPhases() {
  return {
    cache: 'miss',
    cacheHit: false,
    stampMs: 0,
    searchMs: 0,
    pageSqlMs: 0,
    categorySqlMs: 0,
    countSqlMs: 0,
    folderCountsMs: 0,
    hydrateMs: 0,
    typesenseMs: 0,
    providerSearchMs: 0,
  };
}

function roundedMs(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

/**
 * Allowlisted /api/messages phase timings. No SQL text, subjects, or ids.
 */
export function sanitizeMessagesPhases(phases = {}) {
  return {
    cache: PHASE_CACHE.has(phases?.cache) ? phases.cache : 'miss',
    cacheHit: Boolean(phases?.cacheHit),
    stampMs: roundedMs(phases?.stampMs),
    searchMs: roundedMs(phases?.searchMs),
    pageSqlMs: roundedMs(phases?.pageSqlMs),
    categorySqlMs: roundedMs(phases?.categorySqlMs),
    countSqlMs: roundedMs(phases?.countSqlMs),
    folderCountsMs: roundedMs(phases?.folderCountsMs),
    hydrateMs: roundedMs(phases?.hydrateMs),
    typesenseMs: roundedMs(phases?.typesenseMs),
    providerSearchMs: roundedMs(phases?.providerSearchMs),
  };
}

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
