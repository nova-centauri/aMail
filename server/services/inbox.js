import {
  isHiddenDefaultCategory,
  isSmartCategory,
  SMART_CATEGORY_SLUGS,
} from './smart-filter.js';
import { getPersonFlag, loadPersonFlags, messageMatchesPersonFlag, publicPersonFlag } from './person-flags.js';
import { toFtsMatchQuery } from './fts.js';
import {
  conversationMatchesMailboxQuery,
  mailboxQueryIsActive,
  parseMailboxQuery,
} from '../mail/search-query.js';
import { publicAttachmentMeta } from './compose-attachments.js';
import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '../errors.js';
import { shouldSearchProvider } from '../mail/imap-search.js';
import { listCacheToken } from './change-version.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
const LIST_CACHE_LIMIT = 16;
const FOLDER_COUNT_CACHE_LIMIT = 8;
const cachesByRepos = new WeakMap();

function cachesFor(repos) {
  let entry = cachesByRepos.get(repos);
  if (!entry) {
    entry = { list: new Map(), folders: new Map() };
    cachesByRepos.set(repos, entry);
  }
  return entry;
}

export const parseNumber = (value, fallback, min, max) => {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};

export const parsePageSize = (value, fallback = DEFAULT_PAGE_SIZE) => {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, number));
};

/**
 * Listing/ETag version. Sync-cursor bumps (`sync_state.synced_at`) do not
 * change the inbox, so pollers that never send If-None-Match can still hit
 * the in-process cache after a 45s POST /api/sync.
 */
export function listContentStamp(stamp = {}) {
  if (stamp == null) return '';
  if (typeof stamp === 'string') return stamp;
  const times = [stamp.messageAt, stamp.accountAt].filter(Boolean).sort();
  return times.at(-1) || '';
}

export { listCacheToken };

export function conversationListEtag(changedAt, input = {}) {
  const raw = JSON.stringify({
    v: changedAt || '',
    accountId: input.accountId || null,
    folder: input.folder || 'inbox',
    category: input.category || '',
    personFlag: input.personFlag || input.flag || '',
    page: input.page || 1,
    pageSize: input.pageSize || DEFAULT_PAGE_SIZE,
    query: input.query || input.q || '',
    mailbox: input.mailbox || 'INBOX',
  });
  return `W/"${createHash('sha1').update(raw).digest('base64url')}"`;
}

function normalizeEtag(value) {
  let text = String(value || '').trim();
  if (text.startsWith('W/') || text.startsWith('w/')) text = text.slice(2).trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  return text;
}

/** Weak/strong ETags and comma-lists, so Node `fetch` without cookies can 304. */
export function ifNoneMatchHits(header, etag) {
  const raw = String(header || '').trim();
  if (!raw || !etag) return false;
  if (raw === '*') return true;
  const wanted = normalizeEtag(etag);
  if (!wanted) return false;
  return raw.split(',').some((part) => normalizeEtag(part) === wanted);
}

export function clearConversationListCache(repos = null) {
  if (repos) {
    cachesByRepos.delete(repos);
    return;
  }
}

function remember(cache, key, value, limit) {
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
  return value;
}

export const normalizeFolder = (value) => {
  const folder = String(value || 'inbox').toLowerCase();
  return ['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'all', 'trash', 'spam', 'archive'].includes(folder) ? folder : 'inbox';
};

export const normalizeCategory = (value) => {
  const category = String(value || '').trim().toLowerCase();
  if (!category || category === 'all') return '';
  // ops_quiet is intentionally not selectable as a smart-view chip; it only
  // exists so routine digests can be excluded from the default inbox.
  if (category === 'ops_quiet') {
    throw new ValidationError('Ops digests without errors are hidden. Use Ops errors for failures.');
  }
  if (!isSmartCategory(category) || isHiddenDefaultCategory(category)) {
    throw new ValidationError(`Unknown smart filter. Choose one of: ${SMART_CATEGORY_SLUGS.filter((slug) => !isHiddenDefaultCategory(slug)).join(', ')}.`);
  }
  return category;
};

export const normalizePersonFlag = (value, flags = []) => {
  const flagId = String(value || '').trim().toLowerCase();
  if (!flagId) return null;
  const flag = getPersonFlag(flags, flagId);
  if (!flag) {
    const choices = flags.map((item) => item.id).join(', ');
    throw new ValidationError(choices
      ? `Unknown person flag. Choose one of: ${choices}.`
      : 'No person flags are configured. Add one in Settings or with PUT /api/flags.');
  }
  return flag;
};

const emptyCategoryCounts = () => Object.fromEntries(
  SMART_CATEGORY_SLUGS
    .filter((category) => !isHiddenDefaultCategory(category))
    .map((category) => [category, 0]),
);

const emptyFolderCounts = () => ({ inbox: 0, starred: 0, snoozed: 0, drafts: 0, unanalyzed: 0 });

/**
 * Typesense ranks leftover text. Provider hits that never matched locally are
 * prefixed onto the page. Any engine failure falls back to SQLite FTS.
 */
async function conversationSearch(repos, listArgs, { page, pageSize, extraThreadIds }) {
  const engine = repos.searchEngine;
  if (engine?.enabled && listArgs.parsed?.text) {
    try {
      const eligibleExtras = extraThreadIds.length
        ? repos.messages.searchConversations({
          ...listArgs,
          ftsQuery: '',
          extraThreadIds: [],
          restrictThreadIds: extraThreadIds,
          limit: extraThreadIds.length,
          offset: 0,
        }).threadIds
        : [];
      const matchedExtras = eligibleExtras.length
        ? await engine.matchingThreadIds({
          accountIds: listArgs.accountIds,
          folder: listArgs.folder,
          mailbox: listArgs.mailbox,
          parsed: listArgs.parsed,
          category: listArgs.category,
          personEmails: listArgs.personEmails,
          hideQuiet: listArgs.hideQuiet,
          threadIds: eligibleExtras,
        })
        : new Set();
      const extraOnly = eligibleExtras.filter((id) => !matchedExtras.has(id));
      const start = (page - 1) * pageSize;
      const prefix = extraOnly.slice(start, start + pageSize);
      const rankedOffset = Math.max(0, start - extraOnly.length);
      const rankedLimit = pageSize - prefix.length;
      const ranked = await engine.searchConversations({
        accountIds: listArgs.accountIds,
        folder: listArgs.folder,
        mailbox: listArgs.mailbox,
        parsed: listArgs.parsed,
        category: listArgs.category,
        personEmails: listArgs.personEmails,
        hideQuiet: listArgs.hideQuiet,
        offset: rankedLimit > 0 ? rankedOffset : 0,
        limit: rankedLimit > 0 ? rankedLimit : 1,
      });
      if (rankedLimit <= 0) ranked.threadIds = [];
      const seen = new Set(prefix);
      return {
        threadIds: [...prefix, ...ranked.threadIds.filter((id) => !seen.has(id))],
        total: (ranked.total || 0) + extraOnly.length,
        categoryCounts: ranked.categoryCounts || [],
      };
    } catch {
      // The cache listing below is the same path used when Typesense is off.
    }
  }
  return repos.messages.searchConversations(listArgs);
}

export const sumFolderCounts = (accounts, repos, changedAt = null) => {
  const ids = accounts.map((account) => account.id).filter(Boolean);
  const token = changedAt || listCacheToken(repos.changes?.stamp?.() || {}) || listContentStamp(repos.changes?.stamp?.() || {});
  const cacheKey = `${token}:${[...ids].sort().join(',')}`;
  const folderCache = cachesFor(repos).folders;
  const cached = folderCache.get(cacheKey);
  if (cached) return cached;
  if (typeof repos.messages.folderCountsForAccounts === 'function') {
    return remember(folderCache, cacheKey, repos.messages.folderCountsForAccounts(ids), FOLDER_COUNT_CACHE_LIMIT);
  }
  const totals = ids.reduce((sum, accountId) => {
    const counts = repos.messages.folderCounts(accountId);
    return {
      inbox: sum.inbox + counts.inbox,
      starred: sum.starred + counts.starred,
      snoozed: sum.snoozed + counts.snoozed,
      drafts: sum.drafts + counts.drafts,
      unanalyzed: sum.unanalyzed + (counts.unanalyzed || 0),
    };
  }, emptyFolderCounts());
  return remember(folderCache, cacheKey, totals, FOLDER_COUNT_CACHE_LIMIT);
};

export function listStoredDrafts(repos, accountIds = null) {
  const accounts = accountIds
    ? accountIds.map((id) => repos.accounts.get(id)).filter(Boolean)
    : repos.accounts.list();
  const seen = new Set();
  const items = [];
  const push = (draft, account) => {
    const id = String(draft?.id || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    items.push({ draft, account });
  };
  for (const account of accounts) {
    for (const draft of repos.drafts.list(account.id)) push(draft, account);
  }
  for (const account of accounts) {
    const messages = typeof repos.messages.listDrafts === 'function'
      ? repos.messages.listDrafts(account.id)
      : [];
    for (const message of messages) {
      push({
        id: message.id,
        accountId: message.accountId,
        threadId: message.threadId,
        to: message.to || [],
        cc: message.cc || [],
        bcc: message.bcc || [],
        subject: message.subject === '(no subject)' ? '' : (message.subject || ''),
        htmlBody: message.htmlBody || '',
        textBody: message.textBody || '',
        attachments: message.attachments || [],
        sourceImported: message.sourceImported !== false,
        updatedAt: message.receivedAt || message.sentAt || message.updatedAt,
        createdAt: message.createdAt || message.receivedAt || message.sentAt,
      }, account);
    }
  }
  return items;
}

export function draftListItem(draft, account) {
  const id = `draft:${draft.id}`;
  return {
    id,
    threadId: id,
    latestMessageId: id,
    draftId: draft.id,
    isDraft: true,
    accountId: draft.accountId,
    mailbox: 'Drafts',
    folder: 'drafts',
    subject: draft.subject || '(no subject)',
    from: { name: account?.displayName || account?.email || '', email: account?.email || '' },
    to: draft.to || [],
    cc: draft.cc || [],
    bcc: draft.bcc || [],
    participants: draft.to || [],
    htmlBody: draft.htmlBody || '',
    textBody: draft.textBody || '',
    snippet: String(draft.textBody || draft.htmlBody || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    sentAt: draft.updatedAt,
    receivedAt: draft.updatedAt,
    latestAt: draft.updatedAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    isRead: true,
    isStarred: false,
    isArchived: false,
    isTrashed: false,
    isSpam: false,
    isSent: false,
    isAnalyzed: true,
    unanalyzedCount: 0,
    messageCount: 1,
    unreadCount: 0,
    labels: ['Draft'],
    sourceImported: draft.sourceImported !== false,
    attachments: (draft.attachments || []).map((attachment, index) => publicAttachmentMeta(attachment, index)),
    hasAttachments: Boolean((draft.attachments || []).length),
  };
}

/**
 * Unified conversation listing used by the REST API and MCP tools.
 * Returns the same shape as GET /api/messages.
 */
export async function listConversations(repos, {
  accountId = null,
  folder: folderInput = 'inbox',
  category: categoryInput = '',
  personFlag: personFlagInput = '',
  page: pageInput = 1,
  pageSize: pageSizeInput = DEFAULT_PAGE_SIZE,
  query: queryInput = '',
  mailbox = 'INBOX',
  mailService = null,
  searchSource = 'cache',
  signal = null,
  extraThreadIds: extraThreadIdsInput = null,
  forceLegacy = false,
  changedAt: changedAtInput = null,
} = {}) {
  const parsedQuery = parseMailboxQuery(String(queryInput || '').trim().slice(0, 800));
  const folder = normalizeFolder(parsedQuery.folder || folderInput);
  const category = normalizeCategory(categoryInput);
  const personFlag = normalizePersonFlag(personFlagInput, loadPersonFlags(repos));
  const page = parseNumber(pageInput, 1, 1, 100_000);
  const pageSize = parsePageSize(pageSizeInput, DEFAULT_PAGE_SIZE);
  const changedAt = changedAtInput
    || listCacheToken(repos.changes?.stamp?.() || {})
    || listContentStamp(repos.changes?.stamp?.() || {});
  const resultCacheKey = JSON.stringify({
    changedAt,
    accountId,
    folder,
    category,
    personFlag: personFlag?.id || '',
    page,
    pageSize,
    query: parsedQuery.raw,
    mailbox,
    forceLegacy,
  });
  const resultCache = cachesFor(repos).list;
  const canCache = !extraThreadIdsInput && !mailboxQueryIsActive(parsedQuery) && !category && !personFlag;
  if (canCache && resultCache.has(resultCacheKey)) {
    return resultCache.get(resultCacheKey);
  }
  const query = parsedQuery.raw;
  const searchActive = mailboxQueryIsActive(parsedQuery);
  const ftsQuery = parsedQuery.text ? toFtsMatchQuery(parsedQuery.text) : '';
  const accounts = accountId ? [repos.accounts.get(accountId)].filter(Boolean) : repos.accounts.list();
  if (accountId && !accounts.length) throw new NotFoundError('Mail account not found.');

  let extraThreadIds = Array.isArray(extraThreadIdsInput) ? extraThreadIdsInput.filter(Boolean) : [];
  if (
    !Array.isArray(extraThreadIdsInput)
    && mailService?.searchAndMaterialize
    && shouldSearchProvider(parsedQuery, { source: searchSource, folder })
  ) {
    try {
      const provider = await mailService.searchAndMaterialize({
        accounts,
        parsed: parsedQuery,
        folder,
        signal,
      });
      extraThreadIds = provider?.threadIds || [];
    } catch {
      // Local cache results are still returned if provider search fails.
    }
  }

  if (folder === 'drafts') {
    const drafts = listStoredDrafts(repos, accounts.map((account) => account.id))
      .map(({ draft, account }) => draftListItem(draft, account))
      .filter((draft) => {
        if (personFlag && !messageMatchesPersonFlag(draft, personFlag)) return false;
        if (!searchActive) return true;
        return conversationMatchesMailboxQuery(draft, parsedQuery);
      })
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const start = (page - 1) * pageSize;
    const draftResult = {
      messages: category ? [] : drafts.slice(start, start + pageSize),
      total: category ? 0 : drafts.length,
      page,
      pageSize,
      categoryCounts: emptyCategoryCounts(),
      folderCounts: sumFolderCounts(accounts, repos, changedAt),
      personFlag: personFlag?.id || null,
      personFlagMeta: personFlag ? publicPersonFlag(personFlag) : null,
    };
    return canCache ? remember(resultCache, resultCacheKey, draftResult, LIST_CACHE_LIMIT) : draftResult;
  }

  const listArgs = {
    accountIds: accounts.map((account) => account.id),
    folder,
    mailbox: String(mailbox || 'INBOX'),
    parsed: searchActive ? parsedQuery : null,
    ftsQuery,
    category,
    personEmails: personFlag?.emails || [],
    hideQuiet: !searchActive && !category && !personFlag,
    extraThreadIds,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    forceLegacy,
  };
  const search = await conversationSearch(repos, listArgs, { page, pageSize, extraThreadIds });
  const latestByThread = typeof repos.messages.latestForThreads === 'function'
    ? repos.messages.latestForThreads(search.threadIds, {
      folder,
      mailbox: String(mailbox || 'INBOX'),
    })
    : new Map();
  if (!latestByThread.size && search.threadIds.length) {
    for (const message of repos.messages.forThreads(search.threadIds, {
      folder,
      mailbox: String(mailbox || 'INBOX'),
      includeBodies: false,
    })) {
      const existing = latestByThread.get(message.threadId);
      const messageTime = String(message.sentAt || message.receivedAt || message.createdAt);
      const existingTime = String(existing?.sentAt || existing?.receivedAt || existing?.createdAt || '');
      if (!existing || messageTime > existingTime) latestByThread.set(message.threadId, message);
    }
  }
  const categoryCounts = emptyCategoryCounts();
  for (const row of search.categoryCounts) {
    if (Object.hasOwn(categoryCounts, row.category)) categoryCounts[row.category] = Number(row.count) || 0;
  }
  const threadsById = typeof repos.threads.getMany === 'function'
    ? repos.threads.getMany(search.threadIds)
    : new Map(search.threadIds.map((id) => [id, repos.threads.get(id)]));
  // Visible rows use the stored thread aggregates. Latest-message envelopes
  // skip attachment blobs so SQLCipher does not decrypt inline parts.
  const pageItems = search.threadIds.map((threadId) => {
    const latestMessage = latestByThread.get(threadId);
    if (!latestMessage) return null;
    const thread = threadsById.get(latestMessage.threadId);
    const latestAt = latestMessage.sentAt || latestMessage.receivedAt || latestMessage.createdAt;
    return {
      ...latestMessage,
      // Gmail's list is made of conversations. The thread id is intentionally
      // the row id so every toolbar action can target all messages in it.
      id: latestMessage.threadId,
      threadId: latestMessage.threadId,
      latestMessageId: latestMessage.id,
      messageCount: thread?.messageCount || 1,
      unreadCount: thread?.unreadCount || 0,
      unanalyzedCount: thread?.unanalyzedCount || 0,
      participants: thread?.participants || [latestMessage.from],
      latestAt,
      snippet: latestMessage.snippet,
      hasAttachments: Boolean(latestMessage.hasAttachments || latestMessage.attachments?.length),
      isRead: (thread?.unreadCount || 0) === 0,
      isAnalyzed: (thread?.unanalyzedCount || 0) === 0,
      isStarred: thread?.isStarred ?? latestMessage.isStarred,
      ...(folder === 'snoozed' ? { folder: 'snoozed' } : {}),
    };
  }).filter(Boolean);
  const result = {
    messages: pageItems,
    total: search.total,
    page,
    pageSize,
    categoryCounts,
    folderCounts: sumFolderCounts(accounts, repos, changedAt),
    personFlag: personFlag?.id || null,
    personFlagMeta: personFlag ? publicPersonFlag(personFlag) : null,
  };
  return canCache ? remember(resultCache, resultCacheKey, result, LIST_CACHE_LIMIT) : result;
}
