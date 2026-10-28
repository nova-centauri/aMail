import { NotFoundError, ValidationError } from '../errors.js';
import { mergeDraftAttachments, normalizeComposeAttachments } from './compose-attachments.js';
import { sanitizeComposeHtml } from '../utils/signature.js';

export function providerDraft(repos, id) {
  const message = repos.messages.get(id);
  if (!message?.isDraft || message.isTrashed || message.isSpam) return null;
  return {
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
  return JSON.stringify(value);
}

/** Persist a local working copy only. Never sends mail or writes to IMAP. */
export function saveDraft(repos, input = {}, id = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Draft must be an object.');
  }
  const local = id ? repos.drafts.get(id) : null;
  const existing = local || (id ? providerDraft(repos, id) : null);
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
  }
  const attachments = input.attachments ?? existing?.attachments ?? [];
  const record = {
    account_id: accountId,
    thread_id: threadId || null,
    to_json: draftRecipients(input.to ?? existing?.to ?? [], 'To'),
    cc_json: draftRecipients(input.cc ?? existing?.cc ?? [], 'Cc'),
    bcc_json: draftRecipients(input.bcc ?? existing?.bcc ?? [], 'Bcc'),
    subject: String(input.subject ?? existing?.subject ?? '').slice(0, 998),
    html_body: sanitizeComposeHtml(input.htmlBody ?? existing?.htmlBody).slice(0, 1_000_000),
    text_body: String(input.textBody ?? existing?.textBody ?? '').slice(0, 1_000_000),
    attachments_json: JSON.stringify(existing
      ? mergeDraftAttachments(attachments, existing.attachments)
      : normalizeComposeAttachments(attachments)),
  };
  const draft = local ? repos.drafts.update(local.id, record) : repos.drafts.create(record);
  return { draft, created: !local };
}
