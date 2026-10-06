import { smartCategoryMetadata } from './classify.js';
import { normalizePerson } from './people.js';

export { formatRecipients, normalizePerson, recipientArray } from './people.js';
export { formatAttachmentSize, formatListDate, formatMessageDate, initials } from './dates.js';
export { inferSmartCategory, smartCategoryMetadata } from './classify.js';

export function getArray(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

export function normalizeMessage(raw, index = 0) {
  const from = normalizePerson(raw.from || raw.sender || raw.fromAddress, { color: raw.color });
  const classification = smartCategoryMetadata(raw, { from });
  return {
    id: String(raw.latestMessageId || raw.id || raw.messageId || `message-${index}`),
    accountId: (raw.accountId || raw.account_id) ? String(raw.accountId || raw.account_id) : null,
    rfcMessageId: raw.messageId || raw.rfcMessageId || null,
    from,
    to: raw.to || raw.recipients || raw.toAddresses || [],
    cc: raw.cc || [],
    bcc: raw.bcc || [],
    replyTo: raw.replyTo || raw.reply_to || [],
    isSent: Boolean(raw.isSent ?? raw.is_sent),
    timestamp: raw.timestamp || raw.date || raw.sentAt || raw.receivedAt || new Date().toISOString(),
    body: raw.textBody || raw.bodyText || raw.text || raw.body || raw.snippet || '',
    bodyHtml: raw.htmlBody || raw.bodyHtml || raw.html || '',
    attachments: (raw.attachments || []).map((attachment) => ({
      ...attachment,
      name: attachment.name || attachment.filename || 'Attachment',
      url: attachment.url || null,
    })),
    remoteContentBlocked: Boolean(raw.remoteContentBlocked || raw.trackerBlocked || raw.hasRemoteContent || raw.remoteImageCount > 0),
    remoteContentLoaded: Boolean(raw.remoteContentLoaded),
    ...classification,
  };
}

export function inferFolder(raw = {}) {
  if (raw.folder) return String(raw.folder).toLowerCase();
  if (raw.isDraft || raw.draftId || raw.draft_id) return 'drafts';
  if (raw.isSent) return 'sent';
  if (raw.isTrashed) return 'trash';
  if (raw.isSpam) return 'spam';
  const snoozedUntil = raw.snoozedUntil || raw.snoozed_until;
  if (snoozedUntil) {
    const until = new Date(snoozedUntil);
    if (!Number.isNaN(until.valueOf()) && until > new Date()) return 'snoozed';
  }
  if (raw.isArchived) return 'archive';
  const mailbox = String(raw.mailbox || 'inbox').toLowerCase();
  if (/sent/.test(mailbox)) return 'sent';
  if (/(trash|deleted)/.test(mailbox)) return 'trash';
  if (/draft/.test(mailbox)) return 'drafts';
  if (/(spam|junk)/.test(mailbox)) return 'spam';
  if (/(archive|all mail)/.test(mailbox)) return 'archive';
  return 'inbox';
}

export function normalizeThread(raw, index = 0) {
  const messages = getArray(raw, ['messages', 'items']).map(normalizeMessage);
  const latest = messages.at(-1) || normalizeMessage(raw, index);
  const from = normalizePerson(raw.from || raw.sender || latest.from, latest.from);
  const classification = smartCategoryMetadata(raw, latest);
  return {
    id: String(raw.id || raw.threadId || raw.conversationId || `thread-${index}`),
    draftId: raw.draftId || raw.draft_id || null,
    accountId: (raw.accountId || raw.account_id || latest.accountId) ? String(raw.accountId || raw.account_id || latest.accountId) : null,
    threadId: String(raw.threadId || raw.id || raw.conversationId || `thread-${index}`),
    subject: raw.subject || latest.subject || '(no subject)',
    snippet: raw.snippet || raw.preview || latest.body.replace(/\s+/g, ' ').slice(0, 170),
    from,
    to: raw.to || latest.to || [],
    cc: raw.cc || latest.cc || [],
    bcc: raw.bcc || latest.bcc || [],
    replyTo: raw.replyTo || latest.replyTo || [],
    isSent: Boolean(raw.isSent ?? latest.isSent),
    participants: raw.participants || raw.people || [],
    timestamp: raw.timestamp || raw.latestAt || raw.updatedAt || raw.sentAt || raw.receivedAt || raw.date || latest.timestamp,
    unread: Boolean(raw.unread ?? raw.isUnread ?? (raw.unreadCount !== undefined ? Number(raw.unreadCount) > 0 : raw.isRead === false)),
    // The agent's read/unread. Preview threads and drafts default to analyzed
    // so only real, unprocessed mail shows the "needs analysis" marker.
    analyzed: raw.isAnalyzed !== undefined || raw.analyzed !== undefined
      ? Boolean(raw.isAnalyzed ?? raw.analyzed)
      : raw.unanalyzedCount !== undefined ? Number(raw.unanalyzedCount) === 0 : true,
    unanalyzedCount: Number(raw.unanalyzedCount) || 0,
    analyzedBy: raw.analyzedBy || null,
    analyzedAt: raw.analyzedAt || null,
    starred: Boolean(raw.starred ?? raw.isStarred),
    labels: raw.labels || raw.tags || [],
    folder: inferFolder(raw),
    messageCount: raw.messageCount || raw.count || messages.length || 1,
    hasAttachments: Boolean(raw.hasAttachments || raw.attachments?.length || messages.some((message) => message.attachments.length)),
    sourceImported: raw.sourceImported !== false,
    providerHit: raw.sourceImported === false,
    rfcMessageId: raw.messageId || raw.rfcMessageId || latest.rfcMessageId || null,
    messages: messages.length ? messages : [latest],
    ...classification,
  };
}

export function normalizeAccount(raw, index = 0) {
  const person = normalizePerson(raw);
  return {
    id: String(raw.id || raw.accountId || raw.email || `account-${index}`),
    name: raw.name || raw.displayName || person.name,
    email: raw.email || raw.address || person.email,
    avatarUrl: raw.avatarUrl || raw.avatar || raw.photoUrl,
    color: raw.color || ['#8e24aa', '#0b57d0', '#e8710a', '#00897b'][index % 4],
    signature: raw.signature || '',
    connected: raw.connected !== false && raw.status !== 'error',
    provider: raw.provider || 'custom',
    status: raw.status || (raw.connected === false ? 'error' : 'connected'),
    lastSyncedAt: raw.lastSyncedAt || raw.last_synced_at || null,
  };
}
