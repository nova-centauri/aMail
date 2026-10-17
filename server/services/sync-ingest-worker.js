import { parentPort, workerData } from 'node:worker_threads';
import { simpleParser } from 'mailparser';
import { createDatabase, createRepositories, stringify } from '../db.js';
import { sanitizeEmailHtml, textSnippet, toSafeHtmlFromText } from './message-html.js';
import {
  addressList,
  folderForMailbox,
  hasReplyPrefix,
  normalizeMessageIds,
  normalizeSubject,
} from '../utils/mail.js';

function asIso(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : new Date().toISOString();
}

function setValues(value) {
  return value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
}

function serializeAddresses(value) {
  return stringify(addressList(value));
}

function sender(value) {
  return addressList(value)[0] || { name: '', email: '' };
}

function attachmentMetadata(attachments = []) {
  return attachments.map((attachment, index) => ({
    index,
    filename: attachment.filename || 'attachment',
    contentType: attachment.contentType || 'application/octet-stream',
    size: Number(attachment.size || attachment.content?.length || 0),
    contentId: attachment.cid || attachment.contentId || null,
  }));
}

function resolveThread(repos, { accountId, subject, inReplyTo, references }) {
  const candidates = [inReplyTo, ...[...references].reverse()].filter(Boolean);
  for (const messageId of candidates) {
    const parent = repos.messages.findByRfcId(accountId, messageId);
    if (parent?.threadId) return repos.threads.get(parent.threadId);
  }
  const normalizedSubject = normalizeSubject(subject);
  const looksLikeReply = hasReplyPrefix(subject) || Boolean(inReplyTo) || candidates.length > 0;
  if (normalizedSubject && looksLikeReply) {
    const existing = repos.threads.findBySubject?.(accountId, normalizedSubject);
    if (existing) return existing;
  }
  return repos.threads.create({
    account_id: accountId,
    subject: subject || '(no subject)',
    normalized_subject: normalizedSubject,
    latest_at: new Date().toISOString(),
  });
}

function buildPayload({ repos, account, mailbox, role, allMailMirror, message, parsed }) {
  const envelope = message.envelope || {};
  const messageId = parsed.messageId || envelope.messageId || null;
  const references = normalizeMessageIds(parsed.references || envelope.references);
  const inReplyTo = normalizeMessageIds(parsed.inReplyTo || envelope.inReplyTo)[0] || null;
  const subject = parsed.subject || envelope.subject || '(no subject)';
  const parsedFrom = parsed.from || envelope.from;
  const parsedTo = parsed.to || envelope.to;
  const parsedCc = parsed.cc || envelope.cc;
  const parsedBcc = parsed.bcc || envelope.bcc;
  const flags = new Set(setValues(message.flags));
  const labels = setValues(message.labels).map(String);
  const mailboxRole = role || folderForMailbox(mailbox);
  const isSent = mailboxRole === 'sent';
  const isDraft = mailboxRole === 'drafts';
  if (allMailMirror && messageId) {
    const existing = repos.messages.findByRfcId(account.id, messageId);
    if (existing && existing.mailbox !== mailbox) return null;
  }
  const thread = resolveThread(repos, { accountId: account.id, subject, inReplyTo, references });
  const receivedAt = asIso(message.internalDate || parsed.date || envelope.date);
  const sanitized = parsed.html
    ? sanitizeEmailHtml(parsed.html)
    : sanitizeEmailHtml(toSafeHtmlFromText(parsed.text || ''));
  const plainText = parsed.text || textSnippet(parsed.html || '');
  return {
    account_id: account.id,
    thread_id: thread.id,
    mailbox,
    uid: Number.isInteger(message.uid) ? message.uid : null,
    rfc_message_id: messageId,
    in_reply_to: inReplyTo,
    references_json: stringify(references),
    subject,
    from_name: sender(parsedFrom).name,
    from_email: sender(parsedFrom).email,
    to_json: serializeAddresses(parsedTo),
    cc_json: serializeAddresses(parsedCc),
    bcc_json: serializeAddresses(parsedBcc),
    reply_to_json: stringify(addressList(parsed.replyTo || envelope.replyTo), null),
    sent_at: asIso(parsed.date || envelope.date || message.internalDate),
    received_at: receivedAt,
    html_body: sanitized.html,
    text_body: plainText,
    snippet: textSnippet(plainText || parsed.html),
    attachments_json: stringify(attachmentMetadata(parsed.attachments)),
    labels_json: stringify(labels),
    is_read: flags.has('\\Seen') ? 1 : 0,
    is_starred: flags.has('\\Flagged') ? 1 : 0,
    is_archived: mailboxRole === 'archive' ? 1 : 0,
    is_trashed: mailboxRole === 'trash' ? 1 : 0,
    is_spam: mailboxRole === 'spam' ? 1 : 0,
    snoozed_until: null,
    is_sent: isSent ? 1 : 0,
    is_draft: isDraft ? 1 : 0,
    source_imported: 1,
  };
}

const db = createDatabase({
  dataDir: workerData.dataDir,
  dbPath: workerData.dbPath,
  databaseKey: workerData.databaseKey || null,
  encryptDatabase: Boolean(workerData.encryptDatabase),
  keyMode: workerData.keyMode || 'env',
}, { checkpoint: false });
const repos = createRepositories(db);

parentPort.on('message', async (msg) => {
  if (msg?.type === 'close') {
    try { repos.close(); } catch { /* shutdown */ }
    parentPort.postMessage({ type: 'closed' });
    return;
  }
  if (msg?.type !== 'ingest') return;
  try {
    const source = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source);
    const parsed = await simpleParser(source);
    const payload = buildPayload({
      repos,
      account: msg.account,
      mailbox: msg.mailbox,
      role: msg.role,
      allMailMirror: Boolean(msg.allMailMirror),
      message: msg.message || {},
      parsed,
    });
    let imported = false;
    if (payload) {
      if (typeof repos.runWriteBatch === 'function') {
        repos.runWriteBatch(() => {
          imported = Boolean(repos.messages.upsert(payload));
        });
      } else {
        imported = Boolean(repos.messages.upsert(payload));
      }
    }
    parentPort.postMessage({ id: msg.id, ok: true, imported });
  } catch (error) {
    parentPort.postMessage({ id: msg.id, ok: false, imported: false, error: String(error?.message || error) });
  }
});
