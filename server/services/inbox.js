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
import { NotFoundError, ValidationError } from '../errors.js';
import { shouldSearchProvider } from '../mail/imap-search.js';

export const parseNumber = (value, fallback, min, max) => {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};

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

export const sumFolderCounts = (accounts, repos) => accounts.reduce((totals, account) => {
  const counts = repos.messages.folderCounts(account.id);
  return {
    inbox: totals.inbox + counts.inbox,
    starred: totals.starred + counts.starred,
    snoozed: totals.snoozed + counts.snoozed,
    drafts: totals.drafts + counts.drafts,
    unanalyzed: totals.unanalyzed + (counts.unanalyzed || 0),
  };
}, emptyFolderCounts());

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
  pageSize: pageSizeInput = 50,
  query: queryInput = '',
  mailbox = 'INBOX',
  mailService = null,
  searchSource = 'cache',
  signal = null,
} = {}) {
  const parsedQuery = parseMailboxQuery(String(queryInput || '').trim().slice(0, 800));
  const folder = normalizeFolder(parsedQuery.folder || folderInput);
  const category = normalizeCategory(categoryInput);
  const personFlag = normalizePersonFlag(personFlagInput, loadPersonFlags(repos));
  const page = parseNumber(pageInput, 1, 1, 100_000);
  const pageSize = parseNumber(pageSizeInput, 50, 1, 200);
  const query = parsedQuery.raw;
  const searchActive = mailboxQueryIsActive(parsedQuery);
  const ftsQuery = parsedQuery.text ? toFtsMatchQuery(parsedQuery.text) : '';
  const accounts = accountId ? [repos.accounts.get(accountId)].filter(Boolean) : repos.accounts.list();
  if (accountId && !accounts.length) throw new NotFoundError('Mail account not found.');

  let extraThreadIds = [];
  if (
    mailService?.searchAndMaterialize
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
    const drafts = accounts.flatMap((account) => repos.drafts.list(account.id)
      .map((draft) => draftListItem(draft, account))
      .filter((draft) => {
        if (personFlag && !messageMatchesPersonFlag(draft, personFlag)) return false;
        if (!searchActive) return true;
        return conversationMatchesMailboxQuery(draft, parsedQuery);
      })
    ).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const start = (page - 1) * pageSize;
    return {
      messages: category ? [] : drafts.slice(start, start + pageSize),
      total: category ? 0 : drafts.length,
      page,
      pageSize,
      categoryCounts: emptyCategoryCounts(),
      folderCounts: sumFolderCounts(accounts, repos),
      personFlag: personFlag?.id || null,
      personFlagMeta: personFlag ? publicPersonFlag(personFlag) : null,
    };
  }

  const search = repos.messages.searchConversations({
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
  });
  const byThread = new Map();
  for (const message of repos.messages.forThreads(search.threadIds, {
    folder,
    mailbox: String(mailbox || 'INBOX'),
    includeBodies: false,
  })) {
    const existing = byThread.get(message.threadId);
    const messageTime = String(message.sentAt || message.receivedAt || message.createdAt);
    const existingTime = String(existing?.latest?.sentAt || existing?.latest?.receivedAt || existing?.latest?.createdAt || '');
    if (!existing) {
      byThread.set(message.threadId, { latest: message, messages: [message] });
    } else {
      existing.messages.push(message);
      if (messageTime > existingTime) existing.latest = message;
    }
  }
  const categoryCounts = emptyCategoryCounts();
  for (const row of search.categoryCounts) {
    if (Object.hasOwn(categoryCounts, row.category)) categoryCounts[row.category] = Number(row.count) || 0;
  }
  // Filtering still uses all candidate messages in each conversation. Only
  // visible rows need their stored, whole-thread unread/analyzed aggregates.
  const pageItems = search.threadIds.map((threadId) => {
    const grouped = byThread.get(threadId);
    if (!grouped) return null;
    const { latest: latestMessage, messages } = grouped;
    const thread = repos.threads.get(latestMessage.threadId);
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
      unanalyzedCount: thread ? thread.unanalyzedCount : messages.filter((message) => !message.isAnalyzed).length,
      participants: thread?.participants || [latestMessage.from],
      latestAt,
      snippet: latestMessage.snippet,
      hasAttachments: Boolean(latestMessage.attachments?.length) || messages.some((message) => message.attachments?.length),
      isRead: (thread?.unreadCount || 0) === 0,
      isAnalyzed: thread ? thread.unanalyzedCount === 0 : messages.every((message) => message.isAnalyzed),
      isStarred: thread?.isStarred ?? latestMessage.isStarred,
      ...(folder === 'snoozed' ? { folder: 'snoozed' } : {}),
    };
  }).filter(Boolean);
  return {
    messages: pageItems,
    total: search.total,
    page,
    pageSize,
    categoryCounts,
    folderCounts: sumFolderCounts(accounts, repos),
    personFlag: personFlag?.id || null,
    personFlagMeta: personFlag ? publicPersonFlag(personFlag) : null,
  };
}
