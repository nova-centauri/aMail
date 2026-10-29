import { NotFoundError, ValidationError } from '../errors.js';
import { mergeDraftAttachments, normalizeComposeAttachments } from './compose-attachments.js';
import { sanitizeComposeHtml } from '../utils/signature.js';

/*
 * Drafts live on the mail server, in each account's own Drafts mailbox. The
 * local `messages` row (is_draft = 1) is only the synced copy of that server
 * draft, so a draft saved here shows up in Gmail, Apple Mail, Outlook and any
 * other client of the same account. The old `drafts` table held aMail-only
 * working copies; it is read solely to move those copies to the server
 * (see mail-service saveDraft / migrateLocalDrafts). Nothing writes to it.
 */

function rawAttachments(repos, message) {
  let raw = [];
  try {
    raw = JSON.parse(repos.messages.getRaw?.(message.id)?.attachments_json || '[]');
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];
  // Public metadata plus the bytes aMail itself stored when it wrote the draft.
  return (message.attachments || []).map((meta) => {
    const stored = raw.find((item, position) => (Number.isInteger(item?.index) ? item.index : position) === meta.index);
    return typeof stored?.content === 'string' && stored.content ? { ...meta, content: stored.content } : meta;
  });
}

export function providerDraft(repos, id) {
  const message = repos.messages.get(id);
  if (!message?.isDraft || message.isTrashed || message.isSpam) return null;
  return {
    id: message.id,
    accountId: message.accountId,
    threadId: message.threadId,
    mailbox: message.mailbox,
    uid: message.uid ?? null,
    messageId: message.messageId || null,
    inReplyTo: message.inReplyTo || null,
    references: message.references || [],
    to: message.to || [],
    cc: message.cc || [],
    bcc: message.bcc || [],
    subject: message.subject === '(no subject)' ? '' : (message.subject || ''),
    htmlBody: message.htmlBody || '',
    textBody: message.textBody || '',
    attachments: rawAttachments(repos, message),
    updatedAt: message.receivedAt || message.sentAt || message.updatedAt,
    createdAt: message.createdAt || message.receivedAt || message.sentAt,
  };
}

function draftRecipients(value, field) {
  if (!Array.isArray(value) || value.some((person) => (
    typeof person !== 'string' && (!person || typeof person.email !== 'string'
      || (person.name !== undefined && typeof person.name !== 'string'))
  ))) throw new ValidationError(`${field} recipients must be an array of addresses or { name, email } objects.`);
  // Drafts can be incomplete; address validity is checked when sending.
  return value.map((person) => {
    if (typeof person !== 'string') return { name: String(person.name || ''), email: person.email.trim() };
    const raw = person.trim();
    const match = raw.match(/^(?:"?([^<"]+)"?\s*)?<([^>]+)>$/);
    return match ? { name: match[1]?.trim() || '', email: match[2].trim() } : { name: '', email: raw };
  }).filter((person) => person.email);
}

const CONTROL = /[\u0000-\u001f\u007f]/;

function rfcId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > 998 || CONTROL.test(text)) throw new ValidationError('Message-ID values must be a single header line.');
  return text.startsWith('<') ? text : `<${text}>`;
}

/**
 * Validate a save and merge it over the draft it updates. Pure: no I/O, no
 * writes. `existing` is the server draft (a messages row) or, for a draft
 * saved before drafts moved to the server, the old local working copy.
 */
export function prepareDraft(repos, input = {}, id = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Draft must be an object.');
  }
  const legacy = id ? repos.drafts.get(id) : null;
  const server = !legacy && id ? providerDraft(repos, id) : null;
  const existing = legacy || server;
  if (id && !existing) throw new NotFoundError('Draft not found.');

  const accountId = existing?.accountId || input.accountId;
  if (!accountId) throw new ValidationError('An accountId is required for a new draft.');
  if (input.accountId && input.accountId !== accountId) {
    throw new ValidationError('A saved draft stays with its original account.');
  }
  if (!repos.accounts.get(accountId)) throw new NotFoundError('Mail account not found.');
  const threadId = input.threadId !== undefined ? input.threadId : (existing?.threadId || null);
  if (threadId) {
    const thread = repos.threads.get(threadId);
    if (!thread) throw new NotFoundError('Thread not found.');
    if (thread.accountId && thread.accountId !== accountId) {
      throw new ValidationError('A draft can only reply within its own account.');
    }
  }

  // Reply headers: an explicit parent wins, then what the draft already
  // carries, then the newest real message of the linked thread. Without them
  // the provider files the draft as a new conversation.
  let parent = null;
  if (input.replyToMessageId) {
    parent = repos.messages.findByRfcId(accountId, rfcId(input.replyToMessageId));
    if (!parent) throw new NotFoundError('The message being replied to was not found in this account.');
  }
  let inReplyTo = parent?.messageId || (input.inReplyTo !== undefined ? rfcId(input.inReplyTo) : (server?.inReplyTo || null));
  let references = parent
    ? [...new Set([...(parent.references || []), parent.messageId].filter(Boolean))]
    : (server?.references || []);
  if (!inReplyTo && threadId && typeof repos.messages.forThread === 'function') {
    const latest = repos.messages.forThread(threadId)
      .filter((message) => !message.isDraft && message.messageId)
      .at(-1);
    if (latest) {
      inReplyTo = latest.messageId;
      references = [...new Set([...(latest.references || []), latest.messageId].filter(Boolean))];
    }
  }

  const incomingAttachments = input.attachments ?? existing?.attachments ?? [];
  return {
    legacy,
    server,
    accountId,
    threadId: threadId || null,
    inReplyTo: inReplyTo || null,
    references,
    to: draftRecipients(input.to ?? existing?.to ?? [], 'To'),
    cc: draftRecipients(input.cc ?? existing?.cc ?? [], 'Cc'),
    bcc: draftRecipients(input.bcc ?? existing?.bcc ?? [], 'Bcc'),
    subject: String(input.subject ?? existing?.subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 998),
    htmlBody: sanitizeComposeHtml(input.htmlBody ?? existing?.htmlBody).slice(0, 1_000_000),
    textBody: String(input.textBody ?? existing?.textBody ?? '').slice(0, 1_000_000),
    attachments: existing
      ? mergeDraftAttachments(incomingAttachments, existing.attachments)
      : normalizeComposeAttachments(incomingAttachments),
    incomingAttachments,
  };
}

/** What a local-only draft would become; used by the migration dry run. */
export function legacyDraftSummary(repos, draft) {
  const account = repos.accounts.get(draft.accountId);
  return {
    id: draft.id,
    accountId: draft.accountId,
    accountEmail: account?.email || null,
    subject: draft.subject || '',
    recipients: (draft.to?.length || 0) + (draft.cc?.length || 0) + (draft.bcc?.length || 0),
    attachments: draft.attachments?.length || 0,
    threadId: draft.threadId || null,
    updatedAt: draft.updatedAt,
  };
}
