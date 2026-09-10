import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { decryptJson } from './crypto.js';
import { sanitizeEmailHtml, textSnippet, toSafeHtmlFromText } from './message-html.js';
import {
  addressList,
  accountConnection,
  appendSignature,
  buildAuth,
  folderForMailbox,
  isEmail,
  normalizeMessageIds,
  normalizeSubject,
  recipientList,
  recipientsToHeader,
} from '../utils/mail.js';
import { NotFoundError, ServiceUnavailableError, ValidationError } from '../errors.js';
import { sanitizeComposeHtml } from '../utils/signature.js';
import { stringify } from '../db.js';
import { scrubLogText } from '../logging.js';
import {
  attachmentContentBuffer,
  mailerAttachments,
  normalizeComposeAttachments,
  publicAttachmentMeta,
  storedAttachmentRecords,
} from './compose-attachments.js';

const DEFAULT_SYNC_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const SYNC_WRITE_CHUNK = 50;
const IMAP_LIST_TTL_MS = 10 * 60 * 1000;
const DEFAULT_IMAP_POOL_IDLE_MS = 8 * 60_000;

const asIso = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : new Date().toISOString();
};

const cleanupError = (error) => scrubLogText(String(error?.message || error || 'Unknown mail error')).slice(0, 500);

/** Name the SQLite constraint so a skip log is enough to diagnose without a retry. */
export function sqliteConstraintReason(error) {
  const message = String(error?.message || '');
  if (/UNIQUE constraint failed: messages\.account_id, mailbox, uid/i.test(message)) {
    return 'UNIQUE messages.account_id, mailbox, uid';
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) return 'FOREIGN KEY';
  if (/CHECK constraint failed: smart_category|CHECK constraint failed: messages/i.test(message)) {
    return 'CHECK smart_category';
  }
  if (/constraint failed/i.test(message)) return cleanupError(error);
  return null;
}

function skipReason(error) {
  return sqliteConstraintReason(error) || cleanupError(error);
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

function normalizeCid(value) {
  return String(value || '').replace(/^<|>$/g, '').toLowerCase();
}

function pickParsedAttachment(parsedAttachments, index, meta) {
  const list = Array.isArray(parsedAttachments) ? parsedAttachments : [];
  const wantedCid = normalizeCid(meta?.contentId);
  if (wantedCid) {
    const byCid = list.find((item) => normalizeCid(item.cid || item.contentId) === wantedCid);
    if (byCid) return byCid;
  }
  if (Number.isInteger(index) && list[index]) return list[index];
  if (meta?.filename) {
    return list.find((item) => item.filename === meta.filename) || null;
  }
  return null;
}

export function buildImapOptions(account, credentials, config, { pooled = false } = {}) {
  const secure = Boolean(account.imap_secure);
  const poolIdleMs = Number.isSafeInteger(config.imapPoolIdleMs) ? config.imapPoolIdleMs : DEFAULT_IMAP_POOL_IDLE_MS;
  return {
    host: account.imap_host,
    port: account.imap_port,
    secure,
    // For explicit TLS, the socket is encrypted from byte one. For a cleartext
    // IMAP port, require STARTTLS before ImapFlow is allowed to authenticate.
    doSTARTTLS: secure ? undefined : true,
    auth: buildAuth(credentials, account.email, 'imap'),
    logger: false,
    socketTimeout: pooled ? Math.max(config.syncTimeoutMs, poolIdleMs + 60_000) : config.syncTimeoutMs,
    tls: { rejectUnauthorized: !config.allowInsecureTls },
    // One-shot connections log out immediately; pooled ones keep INBOX selected
    // so ImapFlow's auto-IDLE can push new mail without a reconnect.
    disableAutoIdle: !pooled,
  };
}

export function buildSmtpOptions(account, credentials, config) {
  const secure = Boolean(account.smtp_secure);
  return {
    host: account.smtp_host,
    port: account.smtp_port,
    secure,
    // Nodemailer can otherwise continue without STARTTLS when a server on 587
    // does not advertise it. Requiring the upgrade keeps credentials off a
    // plaintext connection for every non-implicit-TLS account.
    requireTLS: !secure,
    auth: buildAuth(credentials, account.email, 'smtp'),
    tls: { rejectUnauthorized: !config.allowInsecureTls },
    connectionTimeout: config.syncTimeoutMs,
    greetingTimeout: config.syncTimeoutMs,
    socketTimeout: config.syncTimeoutMs,
  };
}

/**
 * Compile mail through Nodemailer's documented stream transport. This avoids
 * depending on private MailComposer modules and gives SMTP and IMAP APPEND the
 * exact same RFC822 bytes.
 */
export async function compileRfc822Message(message) {
  const compiler = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  });
  const result = await compiler.sendMail({
    ...message,
    // Mail bodies and attachment contents are values, never instructions to
    // load server-side paths or URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  if (!Buffer.isBuffer(result.message)) {
    throw new Error('RFC822 compiler did not return a message buffer.');
  }
  return result.message;
}

function upstreamErrorText(error) {
  return [
    error?.code,
    error?.responseCode,
    error?.response,
    error?.serverResponseCode,
    error?.message,
  ].filter(Boolean).join(' ').toLowerCase();
}

function authenticationHelp(provider, protocol) {
  const protocolLabel = protocol.toUpperCase();
  if (provider === 'gmail') {
    return `Gmail rejected the ${protocolLabel} credentials. Use the full Google email address and a 16-character app password created after enabling 2-Step Verification.`;
  }
  if (provider === 'icloud') {
    return `iCloud rejected the ${protocolLabel} credentials. Generate an Apple app-specific password; for SMTP, use the full iCloud email address as the username.`;
  }
  if (provider === 'mailinabox') {
    return `Mail-in-a-Box rejected the ${protocolLabel} credentials. Use the full mailbox address and its mailbox or app password.`;
  }
  return `${protocolLabel} authentication was rejected. Check the username and use an app password when the provider offers one.`;
}

export function classifyMailConnectionError(error, { protocol, provider = 'custom' }) {
  const name = String(protocol || '').toLowerCase() === 'smtp' ? 'smtp' : 'imap';
  const label = name.toUpperCase();
  const text = upstreamErrorText(error);
  const authFailure = error?.authenticationFailed
    || error?.code === 'EAUTH'
    || [530, 534, 535].includes(Number(error?.responseCode))
    || /auth(?:entication)?(?:failed| error| rejected)|invalid credentials|username and password not accepted|login failed/.test(text);
  if (authFailure) {
    return { code: `${label}_AUTH_FAILED`, message: authenticationHelp(provider, name) };
  }
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(error?.code) || /getaddrinfo|name or service not known/.test(text)) {
    return { code: `${label}_DNS_FAILED`, message: `${label} server hostname could not be resolved. Check the server hostname and DNS.` };
  }
  if (error?.code === 'ECONNREFUSED' || /connection refused/.test(text)) {
    return { code: `${label}_CONNECTION_REFUSED`, message: `${label} server refused the connection. Check the hostname, port, and firewall.` };
  }
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error?.code) || /timed?\s*out|timeout/.test(text)) {
    return { code: `${label}_TIMEOUT`, message: `${label} server did not respond in time. Check the hostname, port, firewall, and server availability.` };
  }
  if (
    ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error?.code)
    || /certificate|self[- ]signed|tls|ssl/.test(text)
  ) {
    return { code: `${label}_TLS_FAILED`, message: `${label} TLS verification failed. Use the hostname on the server certificate and confirm its certificate chain is valid.` };
  }
  return { code: `${label}_CONNECTION_FAILED`, message: `${label} connection failed. Check the server settings and try again.` };
}

function connectionTestError(results) {
  const failures = Object.values(results).filter((result) => !result.ok);
  const code = failures.length === 1 ? failures[0].code : 'MAIL_CONNECTION_TEST_FAILED';
  const error = new ServiceUnavailableError(failures.map((failure) => failure.message).join(' '), code);
  // These sanitized details are safe for a setup UI. Raw upstream strings can
  // contain server banners or authentication context and are never returned.
  error.details = {
    protocols: Object.fromEntries(Object.entries(results).map(([protocol, result]) => [
      protocol,
      result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message },
    ])),
  };
  return error;
}

function sentAppendFailureCode(error, account) {
  if (error?.code === 'IMAP_APPEND_REJECTED') return error.code;
  const text = upstreamErrorText(error);
  if (/overquota|quota exceeded/.test(text)) return 'IMAP_APPEND_QUOTA_EXCEEDED';
  if (/toobig|too large|appendlimit/.test(text)) return 'IMAP_APPEND_TOO_LARGE';
  const classified = classifyMailConnectionError(error, { protocol: 'imap', provider: account.provider });
  return classified.code === 'IMAP_CONNECTION_FAILED' ? 'IMAP_APPEND_FAILED' : classified.code;
}

function smtpDeliverySummary(value, recipientCount, { resolved = false } = {}) {
  const total = Math.max(0, Number(recipientCount) || 0);
  const hasAccepted = Array.isArray(value?.accepted);
  const hasRejected = Array.isArray(value?.rejected);
  let acceptedCount = hasAccepted ? Math.min(total, value.accepted.length) : null;
  let rejectedCount = hasRejected ? Math.min(total, value.rejected.length) : null;

  if (acceptedCount === null && rejectedCount !== null) acceptedCount = Math.max(0, total - rejectedCount);
  if (rejectedCount === null && acceptedCount !== null) rejectedCount = Math.max(0, total - acceptedCount);
  // Some injected/custom transports do not expose SMTP recipient arrays. A
  // resolved send remains the compatibility signal that all were accepted.
  if (acceptedCount === null && rejectedCount === null) {
    acceptedCount = resolved ? total : 0;
    rejectedCount = 0;
  }

  const unconfirmedCount = Math.max(0, total - acceptedCount - rejectedCount);
  let status = 'failed';
  if (acceptedCount === 0 && rejectedCount >= total && total > 0) status = 'rejected';
  else if (acceptedCount > 0 && rejectedCount === 0 && unconfirmedCount === 0) status = 'accepted';
  else if (acceptedCount > 0) status = 'partial';
  else if (resolved) status = 'unconfirmed';

  return { status, recipientCount: total, acceptedCount, rejectedCount, unconfirmedCount };
}

function rejectedDeliveryError(delivery) {
  const allRejected = delivery.status === 'rejected';
  const error = new ServiceUnavailableError(
    allRejected
      ? 'The SMTP server rejected every recipient. Check the recipient addresses and try again.'
      : 'The SMTP server did not confirm any recipient. The message was not saved as sent.',
    allRejected ? 'SMTP_ALL_RECIPIENTS_REJECTED' : 'SMTP_DELIVERY_UNCONFIRMED',
  );
  error.details = { delivery };
  return error;
}

const MOVE_SPECIAL_USE = {
  archive: ['\\Archive', '\\All'],
  trash: ['\\Trash'],
  spam: ['\\Junk'],
};

function remoteMoveAction(state) {
  // Trash and Junk take precedence because the spam endpoint also marks the
  // message archived locally for list filtering.
  if (state.isTrashed === true) return 'trash';
  if (state.isSpam === true) return 'spam';
  if (state.isArchived === true) return 'archive';
  return null;
}

function specialUseDestination(folders, action) {
  const choices = MOVE_SPECIAL_USE[action] || [];
  return folders.find((folder) => choices.includes(String(folder.specialUse || '')))?.path || null;
}

function mappedUid(moveResult, sourceUid) {
  const value = moveResult?.uidMap instanceof Map ? moveResult.uidMap.get(sourceUid) : null;
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
}

const SYNC_FOLDER_FALLBACKS = {
  inbox: ['inbox'],
  sent: ['sent', 'sent mail', 'sent items', 'sent messages'],
  archive: ['archive', 'archives'],
  all: ['all mail', 'all messages'],
  trash: ['trash', 'bin', 'deleted items', 'deleted messages'],
  spam: ['spam', 'junk', 'junk email', 'bulk mail'],
};

function normalizedFolderName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function hasSpecialUse(folder, values) {
  return values.includes(String(folder?.specialUse || ''));
}

function conventionalFolder(folders, names) {
  return folders.find((folder) => {
    const name = normalizedFolderName(folder.name);
    const path = normalizedFolderName(folder.path);
    return names.includes(name) || names.includes(path);
  }) || null;
}

/**
 * Pick only portable/special-use folders. The `\\All` fallback lets Gmail
 * installations surface archived mail when no separate `\\Archive` exists.
 */
export function discoverSyncMailboxes(folders) {
  const inbox = folders.find((folder) => hasSpecialUse(folder, ['\\Inbox']))
    || conventionalFolder(folders, SYNC_FOLDER_FALLBACKS.inbox);
  const sent = folders.find((folder) => hasSpecialUse(folder, ['\\Sent']))
    || conventionalFolder(folders, SYNC_FOLDER_FALLBACKS.sent);
  let archive = folders.find((folder) => hasSpecialUse(folder, ['\\Archive']))
    || conventionalFolder(folders, SYNC_FOLDER_FALLBACKS.archive);
  let allMailMirror = false;
  if (!archive) {
    archive = folders.find((folder) => hasSpecialUse(folder, ['\\All']))
      || conventionalFolder(folders, SYNC_FOLDER_FALLBACKS.all);
    allMailMirror = Boolean(archive);
  }
  const trash = folders.find((folder) => hasSpecialUse(folder, ['\\Trash']))
    || conventionalFolder(folders, SYNC_FOLDER_FALLBACKS.trash);
  const spam = folders.find((folder) => hasSpecialUse(folder, ['\\Junk']))
    || conventionalFolder(folders, SYNC_FOLDER_FALLBACKS.spam);

  const candidates = [
    { role: 'inbox', mailbox: inbox?.path || 'INBOX', allMailMirror: false },
    sent && { role: 'sent', mailbox: sent.path, allMailMirror: false },
    archive && { role: 'archive', mailbox: archive.path, allMailMirror },
    trash && { role: 'trash', mailbox: trash.path, allMailMirror: false },
    spam && { role: 'spam', mailbox: spam.path, allMailMirror: false },
  ].filter(Boolean);

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.mailbox)) return false;
    seen.add(candidate.mailbox);
    return true;
  });
}

export function createMailService({
  config,
  repos,
  logger,
  metering = null,
  ImapClient = ImapFlow,
  createSmtpTransport = (options) => nodemailer.createTransport(options),
  compileMessage = compileRfc822Message,
  createMessageId = () => `<${randomUUID()}@amail.local>`,
}) {
  const newImapClient = (account, credentials, { pooled = false } = {}) => (
    new ImapClient(buildImapOptions(account, credentials, config, { pooled }))
  );
  const newSmtpTransport = (account, credentials) => createSmtpTransport(buildSmtpOptions(account, credentials, config));
  const attachmentCache = new Map();
  const imapPool = new Map();
  const poolIdleMs = Number.isSafeInteger(config.imapPoolIdleMs) ? config.imapPoolIdleMs : DEFAULT_IMAP_POOL_IDLE_MS;

  function clearPoolTimer(entry) {
    if (entry?.closeTimer) {
      clearTimeout(entry.closeTimer);
      entry.closeTimer = null;
    }
  }

  async function evictPoolEntry(accountId) {
    const entry = imapPool.get(accountId);
    if (!entry) return;
    imapPool.delete(accountId);
    clearPoolTimer(entry);
    entry.usable = false;
    try {
      entry.client.off?.('exists', entry.onExists);
    } catch {
      // EventEmitter.off is best-effort on fakes.
    }
    await entry.client.logout().catch(() => {});
  }

  async function acquirePooledClient(account, credentials) {
    const existing = imapPool.get(account.id);
    if (existing?.usable) {
      existing.refs += 1;
      existing.lastUsed = Date.now();
      clearPoolTimer(existing);
      return existing;
    }
    if (existing) await evictPoolEntry(account.id);
    const client = newImapClient(account, credentials, { pooled: true });
    await client.connect();
    const entry = {
      client,
      account,
      credentials,
      refs: 1,
      usable: true,
      folders: null,
      foldersAt: 0,
      lastUsed: Date.now(),
      closeTimer: null,
      onExists: null,
    };
    entry.onExists = () => {
      if (!entry.usable || entry.refs > 0) return;
      void syncAccount(account.id, { maxAgeMs: config.syncMinIntervalMs || 0 }).catch((error) => {
        logger.warn({ accountId: account.id, err: cleanupError(error) }, 'IMAP IDLE wake could not synchronize');
      });
    };
    client.on?.('exists', entry.onExists);
    imapPool.set(account.id, entry);
    return entry;
  }

  function releasePooledClient(accountId) {
    const entry = imapPool.get(accountId);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    entry.lastUsed = Date.now();
    if (poolIdleMs <= 0) {
      void evictPoolEntry(accountId);
      return;
    }
    const inbox = entry.folders?.find((folder) => String(folder.specialUse || '') === '\\Inbox')?.path
      || entry.folders?.find((folder) => String(folder.path || '').toLowerCase() === 'inbox')?.path
      || 'INBOX';
    if (typeof entry.client.mailboxOpen === 'function') {
      entry.client.mailboxOpen(inbox).catch(() => {});
    }
    clearPoolTimer(entry);
    entry.closeTimer = setTimeout(() => {
      void evictPoolEntry(accountId);
    }, poolIdleMs);
    entry.closeTimer.unref?.();
  }

  async function pooledList(entry) {
    if (entry.folders && Date.now() - entry.foldersAt < IMAP_LIST_TTL_MS) return entry.folders;
    entry.folders = await entry.client.list();
    entry.foldersAt = Date.now();
    return entry.folders;
  }

  function cachedAttachment(key) {
    const entry = attachmentCache.get(key);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      attachmentCache.delete(key);
      return null;
    }
    return entry.value;
  }

  function rememberAttachment(key, value) {
    if (attachmentCache.size >= 24) {
      const oldest = attachmentCache.keys().next().value;
      attachmentCache.delete(oldest);
    }
    attachmentCache.set(key, { value, expires: Date.now() + 60_000 });
  }

  function accountAndCredentials(accountId) {
    const account = repos.accounts.getRaw(accountId);
    if (!account) throw new NotFoundError('Mail account not found.');
    return { account, credentials: decryptJson(account.credential_ciphertext, config.credentialKey) };
  }

  function resolveThread({ accountId, subject, inReplyTo, references, threadId }) {
    if (threadId) {
      const direct = repos.threads.get(threadId);
      if (direct?.accountId === accountId) return direct;
    }
    const candidates = [inReplyTo, ...[...references].reverse()].filter(Boolean);
    for (const messageId of candidates) {
      const parent = repos.messages.findByRfcId(accountId, messageId);
      if (parent?.threadId) return repos.threads.get(parent.threadId);
    }
    const normalizedSubject = normalizeSubject(subject);
    if (normalizedSubject) {
      const existing = repos.threads.findBySubject(accountId, normalizedSubject);
      if (existing) return existing;
    }
    return repos.threads.create({
      account_id: accountId,
      subject: subject || '(no subject)',
      normalized_subject: normalizedSubject,
      latest_at: new Date().toISOString(),
    });
  }

  async function ingestImapMessage({ account, mailbox, role, allMailMirror = false, message }) {
    if (!message.source) return null;
    const parsed = await simpleParser(message.source);
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
    const sanitized = parsed.html
      ? sanitizeEmailHtml(parsed.html)
      : sanitizeEmailHtml(toSafeHtmlFromText(parsed.text || ''));
    const plainText = parsed.text || textSnippet(parsed.html || '');
    // Gmail's \All mirror contains copies of inbox/sent messages. Inbox and Sent
    // are synchronized first, so retain their canonical local placement instead
    // of turning those copies into duplicate archived conversations.
    if (allMailMirror && messageId) {
      const existing = repos.messages.findByRfcId(account.id, messageId);
      if (existing && existing.mailbox !== mailbox) return null;
    }
    const thread = resolveThread({ accountId: account.id, subject, inReplyTo, references });
    const receivedAt = asIso(message.internalDate || parsed.date || envelope.date);

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
    };
  }

  async function syncMailbox({ account, client, descriptor, limit }) {
    const { mailbox, role, allMailMirror = false } = descriptor;
    const maxMessageBytes = Number.isSafeInteger(config.syncMaxMessageBytes)
      ? config.syncMaxMessageBytes
      : DEFAULT_SYNC_MAX_MESSAGE_BYTES;
    let lock;
    let imported = 0;
    let skippedTooLarge = 0;
    let skippedUnavailable = 0;
    let skippedFailed = 0;
    const previousSync = repos.sync.get(account.id, mailbox);
    let lastUid = previousSync?.last_uid || 0;
    let uidValidity = null;
    let uidValidityChanged = false;
    const pendingWrites = [];

    const persistPayloads = (payloads) => {
      if (!payloads.length) return;
      const write = () => {
        for (const payload of payloads) {
          try {
            const saved = repos.messages.upsert(payload);
            if (saved) imported += 1;
          } catch (error) {
            skippedFailed += 1;
            const uid = Number(payload.uid || 0);
            const reason = skipReason(error);
            repos.sync.recordSkip?.({
              account_id: account.id,
              mailbox,
              uid,
              reason,
            });
            logger.warn(
              { accountId: account.id, mailbox, uid, err: reason },
              'IMAP message could not be imported; skipping it',
            );
          }
        }
      };
      if (typeof repos.runWriteBatch === 'function') repos.runWriteBatch(write);
      else write();
    };

    const flushWrites = () => {
      if (!pendingWrites.length) return;
      persistPayloads(pendingWrites.splice(0, pendingWrites.length));
    };

    try {
      lock = await client.getMailboxLock(mailbox);
      uidValidity = Number(client.mailbox?.uidValidity) || null;
      const previousUidValidity = Number(previousSync?.uid_validity) || null;
      if (previousUidValidity && uidValidity && previousUidValidity !== uidValidity) {
        uidValidityChanged = true;
        logger.info({ accountId: account.id, mailbox }, 'IMAP UIDVALIDITY changed; resynchronizing mailbox window');
        lastUid = 0;
        repos.sync.clearSkips?.(account.id, mailbox);
      }
      const uidNext = Number(client.mailbox?.uidNext || 0);
      const latestUid = Math.max(0, uidNext - 1);
      if (latestUid > lastUid) {
        const firstUid = Math.max(lastUid + 1, latestUid - limit + 1, 1);
        // Do not ask IMAP for RFC822 source in this pass. A message's reported
        // size lets us reject oversized mail without transferring any body or
        // attachment data, and this metadata window is capped by `limit`.
        // Process each envelope as it arrives so peak memory stays one
        // metadata record plus one bounded source, not the whole window.
        for await (const message of client.fetch(`${firstUid}:${latestUid}`, {
          uid: true,
          envelope: true,
          flags: true,
          labels: true,
          internalDate: true,
          size: true,
        }, { uid: true })) {
          const uid = Number(message.uid || 0);
          const reportedSize = Number(message.size);
          const hasReportedSize = Number.isSafeInteger(reportedSize) && reportedSize >= 0;
          if (hasReportedSize && reportedSize > maxMessageBytes) {
            skippedTooLarge += 1;
            lastUid = Math.max(lastUid, uid);
            continue;
          }

          const sourceMessage = await client.fetchOne(uid, {
            uid: true,
            source: { start: 0, maxLength: maxMessageBytes + 1 },
          }, { uid: true });
          const source = sourceMessage?.source;
          if (!Buffer.isBuffer(source)) {
            skippedUnavailable += 1;
            lastUid = Math.max(lastUid, uid);
            continue;
          }
          if (source.length > maxMessageBytes) {
            skippedTooLarge += 1;
            lastUid = Math.max(lastUid, uid);
            continue;
          }
          if (hasReportedSize && source.length !== reportedSize) {
            skippedUnavailable += 1;
            lastUid = Math.max(lastUid, uid);
            continue;
          }

          try {
            const payload = await ingestImapMessage({
              account,
              mailbox,
              role,
              allMailMirror,
              message: { ...message, source },
            });
            if (payload) {
              pendingWrites.push(payload);
              if (pendingWrites.length >= SYNC_WRITE_CHUNK) flushWrites();
            }
          } catch (error) {
            // A message the parser or the database rejects must not pin the
            // window: retrying it on every cycle costs the full fetch and parse
            // each time and blocks everything newer in the mailbox.
            skippedFailed += 1;
            const reason = skipReason(error);
            repos.sync.recordSkip?.({
              account_id: account.id,
              mailbox,
              uid,
              reason,
            });
            logger.warn(
              { accountId: account.id, mailbox, uid, err: reason },
              'IMAP message could not be imported; skipping it',
            );
          }
          lastUid = Math.max(lastUid, uid);
        }
        flushWrites();
      }
      const skipped = skippedTooLarge + skippedUnavailable + skippedFailed;
      const skipReasons = [
        skippedTooLarge && { code: 'IMAP_MESSAGE_TOO_LARGE', count: skippedTooLarge, maxBytes: maxMessageBytes },
        skippedUnavailable && { code: 'IMAP_MESSAGE_SOURCE_UNAVAILABLE', count: skippedUnavailable },
        skippedFailed && { code: 'IMAP_MESSAGE_IMPORT_FAILED', count: skippedFailed },
      ].filter(Boolean);
      if (skipped) {
        logger.info(
          { accountId: account.id, mailbox, skipped, skippedTooLarge, skippedUnavailable, skippedFailed, maxMessageBytes },
          'IMAP messages skipped without importing source content',
        );
      }
      repos.sync.save({
        account_id: account.id,
        mailbox,
        last_uid: lastUid,
        uid_validity: uidValidity,
        last_error: null,
        synced_at: new Date().toISOString(),
      });
      repos.accounts.markSynced(account.id);
      return {
        mailbox,
        role,
        status: skipped ? 'partial' : 'ok',
        imported,
        skipped,
        skipReasons,
        lastUid,
        uidValidityChanged,
      };
    } catch (error) {
      flushWrites();
      repos.sync.save({
        account_id: account.id,
        mailbox,
        last_uid: lastUid,
        uid_validity: uidValidity || Number(client.mailbox?.uidValidity) || null,
        last_error: cleanupError(error),
        synced_at: new Date().toISOString(),
      });
      logger.warn({ accountId: account.id, mailbox, err: cleanupError(error) }, 'IMAP mailbox synchronization failed');
      throw error;
    } finally {
      lock?.release();
    }
  }

  async function runSyncAccount(accountId, { mailbox, limit = config.syncBatchSize } = {}) {
    const { account, credentials } = accountAndCredentials(accountId);
    const explicitMailbox = typeof mailbox === 'string' && mailbox.trim() ? mailbox.trim() : null;
    // Existing UI clients ask to sync "INBOX". Treat that as the normal account
    // bundle so Sent/Archive/Trash/Spam arrive too; another mailbox is an
    // intentional targeted synchronization request.
    const singleMailbox = explicitMailbox && explicitMailbox.toLowerCase() !== 'inbox';
    if (!account.sync_enabled) {
      return {
        accountId,
        ...(singleMailbox ? { mailbox: explicitMailbox } : {}),
        skipped: true,
        reason: 'Sync is disabled for this account.',
        mailboxes: [],
      };
    }

    let entry;
    try {
      entry = await acquirePooledClient(account, credentials);
    } catch (error) {
      logger.warn({ accountId, err: cleanupError(error) }, 'IMAP connection for synchronization failed');
      throw new ServiceUnavailableError('Could not synchronize this account. Check its IMAP settings and app password.', 'IMAP_SYNC_FAILED');
    }
    const client = entry.client;

    try {
      const folders = singleMailbox ? null : await pooledList(entry);
      const descriptors = singleMailbox
        ? [{ mailbox: explicitMailbox, role: folderForMailbox(explicitMailbox), allMailMirror: false }]
        : discoverSyncMailboxes(folders);
      const mailboxes = [];
      for (const descriptor of descriptors) {
        try {
          mailboxes.push(await syncMailbox({ account, client, descriptor, limit }));
        } catch {
          const failed = { mailbox: descriptor.mailbox, role: descriptor.role, status: 'failed', imported: 0, error: 'IMAP_SYNC_FAILED' };
          mailboxes.push(failed);
          if (singleMailbox) {
            throw new ServiceUnavailableError('Could not synchronize this mailbox. Check its IMAP settings and app password.', 'IMAP_SYNC_FAILED');
          }
        }
      }
      const imported = mailboxes.reduce((sum, item) => sum + (item.imported || 0), 0);
      const skipped = mailboxes.reduce((sum, item) => sum + (item.skipped || 0), 0);
      const status = mailboxes.some((item) => item.status === 'failed')
        ? (mailboxes.some((item) => item.status !== 'failed') ? 'partial' : 'failed')
        : (mailboxes.some((item) => item.status === 'partial') ? 'partial' : 'ok');
      if (singleMailbox) {
        const summary = mailboxes[0] || { mailbox: explicitMailbox, imported: 0, lastUid: 0, status };
        return {
          accountId,
          mailbox: explicitMailbox,
          imported: summary.imported || 0,
          skipped: summary.skipped || 0,
          skipReasons: summary.skipReasons || [],
          lastUid: summary.lastUid || 0,
          uidValidityChanged: Boolean(summary.uidValidityChanged),
          status,
          mailboxes,
        };
      }
      return { accountId, imported, skipped, status, mailboxes };
    } catch (error) {
      await evictPoolEntry(account.id);
      throw error;
    } finally {
      releasePooledClient(account.id);
    }
  }

  const accountInFlight = new Map();
  const accountLastSync = new Map();
  const accountSyncKey = (accountId, { mailbox, limit }) => `${accountId}\u0000${syncKey({ mailbox, limit })}`;

  async function syncAccount(accountId, { mailbox, limit = config.syncBatchSize, maxAgeMs = 0, force = false } = {}) {
    const key = accountSyncKey(accountId, { mailbox, limit });
    const pending = accountInFlight.get(key);
    if (pending) return pending;
    const floor = force ? 0 : (Number(config.syncMinIntervalMs) || 0);
    const age = Math.max(Number(maxAgeMs) || 0, floor);
    const last = accountLastSync.get(key);
    if (age > 0 && last && Date.now() - last.finishedAt < age) return last.result;
    const promise = runSyncAccount(accountId, { mailbox, limit });
    accountInFlight.set(key, promise);
    try {
      const result = await promise;
      accountLastSync.set(key, { finishedAt: Date.now(), result });
      return result;
    } finally {
      accountInFlight.delete(key);
    }
  }

  async function runSyncAll({ mailbox = null, limit, force = false } = {}) {
    const accounts = repos.accounts.list().filter((account) => account.syncEnabled);
    const singleMailbox = typeof mailbox === 'string' && mailbox.trim() && mailbox.trim().toLowerCase() !== 'inbox';
    const results = [];
    for (const account of accounts) {
      try {
        results.push(await syncAccount(account.id, { mailbox, limit, force }));
      } catch (error) {
        results.push({ accountId: account.id, ...(singleMailbox ? { mailbox } : {}), status: 'failed', mailboxes: [], error: error.code || 'IMAP_SYNC_FAILED' });
      }
    }
    return results;
  }

  function afterSyncMaintenance() {
    try {
      const days = Number(config.retainDays) || 0;
      if (days > 0 && typeof repos.retention?.pruneBodies === 'function') {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const pruned = repos.retention.pruneBodies(cutoff);
        if (pruned > 0) {
          logger.info({ pruned, retainDays: days }, 'Pruned bodies of mail older than the retention window');
          const later = setTimeout(() => {
            try { repos.vacuumIfDue?.(); } catch { /* VACUUM is best-effort while idle */ }
          }, 15_000);
          later.unref?.();
        }
      }
    } catch (error) {
      logger.warn({ err: cleanupError(error) }, 'Mail body retention prune failed');
    }
    try {
      repos.checkpointWal?.();
    } catch (error) {
      logger.warn({ err: cleanupError(error) }, 'WAL checkpoint failed');
    }
  }

  // A full sync walks every mailbox of every account over IMAP and is the most
  // expensive thing this process does. Callers that only poll (the web client
  // tick, an agent checking for mail) are coalesced: a request identical to one
  // already running joins it, and `maxAgeMs` lets a caller accept the result of
  // a run that finished recently instead of starting another.
  let inFlightSync = null;
  let lastFullSync = null;
  const syncKey = ({ mailbox, limit }) => {
    const target = typeof mailbox === 'string' && mailbox.trim() ? mailbox.trim() : 'INBOX';
    return `${target.toLowerCase() === 'inbox' ? 'INBOX' : target}\u0000${limit ?? config.syncBatchSize ?? ''}`;
  };

  async function syncAll({ mailbox = null, limit, maxAgeMs = 0, force = false } = {}) {
    const key = syncKey({ mailbox, limit });
    while (inFlightSync) {
      if (inFlightSync.key === key) return inFlightSync.promise;
      await inFlightSync.promise.catch(() => {});
    }
    const floor = force ? 0 : (Number(config.syncMinIntervalMs) || 0);
    const age = Math.max(Number(maxAgeMs) || 0, floor);
    if (age > 0 && lastFullSync?.key === key && Date.now() - lastFullSync.finishedAt < age) {
      return lastFullSync.results;
    }
    const promise = runSyncAll({ mailbox, limit, force }).finally(() => afterSyncMaintenance());
    inFlightSync = { key, promise };
    try {
      const results = await promise;
      lastFullSync = { key, finishedAt: Date.now(), results };
      return results;
    } finally {
      inFlightSync = null;
    }
  }

  async function close() {
    const ids = [...imapPool.keys()];
    await Promise.all(ids.map((id) => evictPoolEntry(id)));
  }

  async function fetchAttachment(messageId, index) {
    const resolvedIndex = Number(index);
    if (!Number.isInteger(resolvedIndex) || resolvedIndex < 0) {
      throw new ValidationError('Attachment index is invalid.');
    }
    const cacheKey = `${messageId}:${resolvedIndex}`;
    const cached = cachedAttachment(cacheKey);
    if (cached) return cached;

    const message = repos.messages.get(messageId);
    if (!message) throw new NotFoundError('Message not found.');
    let rawAttachments = [];
    try {
      rawAttachments = JSON.parse(repos.messages.getRaw?.(messageId)?.attachments_json || '[]');
    } catch {
      rawAttachments = [];
    }
    const rawMeta = rawAttachments.find((item, index) => (Number.isInteger(item?.index) ? item.index : index) === resolvedIndex)
      || rawAttachments[resolvedIndex];
    const stored = attachmentContentBuffer(rawMeta);
    if (stored) {
      const value = {
        filename: rawMeta.filename || 'attachment',
        contentType: rawMeta.contentType || 'application/octet-stream',
        body: stored,
        contentId: rawMeta.contentId || null,
      };
      rememberAttachment(cacheKey, value);
      return value;
    }
    const meta = (message.attachments || []).find((item) => item.index === resolvedIndex)
      || message.attachments?.[resolvedIndex]
      || (rawMeta ? publicAttachmentMeta(rawMeta, resolvedIndex) : null);
    if (!meta) throw new NotFoundError('Attachment not found.');
    if (!Number.isInteger(message.uid) || message.uid < 1) {
      throw new ServiceUnavailableError(
        'This attachment is not available from IMAP. Sync the mailbox and try again.',
        'ATTACHMENT_IMAP_UID_MISSING',
      );
    }

    const { account, credentials } = accountAndCredentials(message.accountId);
    const maxMessageBytes = Number.isSafeInteger(config.syncMaxMessageBytes)
      ? config.syncMaxMessageBytes
      : DEFAULT_SYNC_MAX_MESSAGE_BYTES;
    const client = newImapClient(account, credentials);
    let lock;
    try {
      await client.connect();
      lock = await client.getMailboxLock(message.mailbox || 'INBOX');
      const sourceMessage = await client.fetchOne(message.uid, {
        uid: true,
        source: { start: 0, maxLength: maxMessageBytes + 1 },
      }, { uid: true });
      const source = sourceMessage?.source;
      if (!Buffer.isBuffer(source) || source.length > maxMessageBytes) {
        throw new ServiceUnavailableError('The original message could not be downloaded for this attachment.', 'ATTACHMENT_SOURCE_UNAVAILABLE');
      }
      const parsed = await simpleParser(source);
      const picked = pickParsedAttachment(parsed.attachments, resolvedIndex, meta);
      const body = picked?.content;
      if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
        throw new NotFoundError('Attachment not found in the original message.');
      }
      const value = {
        filename: picked.filename || meta.filename || 'attachment',
        contentType: picked.contentType || meta.contentType || 'application/octet-stream',
        body: Buffer.from(body),
        contentId: picked.cid || meta.contentId || null,
      };
      rememberAttachment(cacheKey, value);
      return value;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ServiceUnavailableError || error instanceof ValidationError) throw error;
      logger.warn({ messageId, err: cleanupError(error) }, 'IMAP attachment download failed');
      throw new ServiceUnavailableError('Could not download this attachment from the mail server.', 'ATTACHMENT_IMAP_FAILED');
    } finally {
      lock?.release();
      await client.logout().catch(() => {});
    }
  }

  async function verifyAccountConnections(account, credentials) {
    // Validate both auth variants synchronously so malformed input is a 400 and
    // never opens either socket.
    buildAuth(credentials, account.email, 'imap');
    buildAuth(credentials, account.email, 'smtp');

    const checkImap = async () => {
      const client = newImapClient(account, credentials);
      try {
        await client.connect();
      } finally {
        await client.logout().catch(() => {});
      }
    };
    const checkSmtp = async () => {
      const transport = newSmtpTransport(account, credentials);
      try {
        await transport.verify();
      } finally {
        transport.close?.();
      }
    };
    const [imap, smtp] = await Promise.allSettled([checkImap(), checkSmtp()]);
    const outcomes = {
      imap: imap.status === 'fulfilled'
        ? { ok: true }
        : { ok: false, ...classifyMailConnectionError(imap.reason, { protocol: 'imap', provider: account.provider }) },
      smtp: smtp.status === 'fulfilled'
        ? { ok: true }
        : { ok: false, ...classifyMailConnectionError(smtp.reason, { protocol: 'smtp', provider: account.provider }) },
    };
    if (!outcomes.imap.ok || !outcomes.smtp.ok) throw connectionTestError(outcomes);
    return { imap: true, smtp: true };
  }

  async function testSettings(input) {
    const email = String(input?.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw new ValidationError('A valid account email is required.');
    if (!input?.credentials || typeof input.credentials !== 'object') {
      throw new ValidationError('Account credentials are required for a connection test.');
    }
    const connection = accountConnection({ ...input, email });
    return verifyAccountConnections({
      email,
      provider: connection.provider,
      imap_host: connection.imap.host,
      imap_port: connection.imap.port,
      imap_secure: Number(connection.imap.secure),
      smtp_host: connection.smtp.host,
      smtp_port: connection.smtp.port,
      smtp_secure: Number(connection.smtp.secure),
    }, input.credentials);
  }

  async function testAccount(accountId) {
    const { account, credentials } = accountAndCredentials(accountId);
    return verifyAccountConnections(account, credentials);
  }

  async function appendProviderSentCopy({ account, credentials, rawMessage, sentAt }) {
    if (String(account.provider || '').toLowerCase() === 'gmail') {
      const status = { attempted: false, status: 'provider-managed', reason: 'gmail-auto-copies-sent' };
      logger.info({ accountId: account.id, sentCopy: status }, 'Provider Sent copy status');
      return status;
    }

    let client;
    try {
      client = newImapClient(account, credentials);
      await client.connect();
      const sent = discoverSyncMailboxes(await client.list()).find((descriptor) => descriptor.role === 'sent');
      if (!sent) {
        const status = { attempted: true, status: 'skipped', reason: 'sent-mailbox-not-found' };
        logger.info({ accountId: account.id, sentCopy: status }, 'Provider Sent copy status');
        return status;
      }
      const appended = await client.append(sent.mailbox, rawMessage, ['\\Seen'], sentAt);
      if (!appended) {
        const error = new Error('IMAP server rejected APPEND.');
        error.code = 'IMAP_APPEND_REJECTED';
        throw error;
      }
      const status = { attempted: true, status: 'appended', mailbox: sent.mailbox };
      logger.info({ accountId: account.id, sentCopy: status }, 'Provider Sent copy status');
      return status;
    } catch (error) {
      const status = { attempted: true, status: 'failed', reason: sentAppendFailureCode(error, account) };
      // Do not attach the upstream Error object: an IMAP response can include
      // authentication context or server implementation details.
      logger.warn({ accountId: account.id, sentCopy: status }, 'Provider Sent copy could not be appended after SMTP accepted the message');
      return status;
    } finally {
      await client?.logout().catch(() => {});
    }
  }

  async function sendMessage(input) {
    const { account, credentials } = accountAndCredentials(input.accountId);
    const to = recipientList(input.to, 'To');
    const cc = recipientList(input.cc, 'Cc');
    const bcc = recipientList(input.bcc, 'Bcc');
    if (!to.length && !cc.length && !bcc.length) throw new ValidationError('At least one recipient is required.');

    const parent = input.replyToMessageId ? repos.messages.findByRfcId(account.id, input.replyToMessageId) : null;
    const subject = String(input.subject || parent?.subject || '').trim() || '(no subject)';
    const references = [...new Set([...(parent?.references || []), parent?.messageId].filter(Boolean))];
    const htmlBody = sanitizeComposeHtml(input.htmlBody);
    const signed = appendSignature({
      html: htmlBody,
      text: String(input.textBody || textSnippet(htmlBody || input.htmlBody || '')),
      signature: account.signature,
      includeSignature: input.includeSignature !== false,
    });
    const messageId = createMessageId(account);
    const sentAt = new Date();
    const attachments = normalizeComposeAttachments(input.attachments);
    const envelope = {
      from: account.email,
      to: [...to, ...cc, ...bcc].map((recipient) => recipient.email),
    };
    const message = {
      envelope,
      messageId,
      date: sentAt,
      from: { name: account.display_name, address: account.email },
      to: recipientsToHeader(to) || undefined,
      cc: recipientsToHeader(cc) || undefined,
      // Bcc intentionally exists only in the SMTP envelope. Putting it in the
      // compiled raw message would disclose hidden recipients to everyone.
      subject,
      text: signed.text,
      html: signed.html || undefined,
      inReplyTo: parent?.messageId || input.inReplyTo || undefined,
      references: references.length ? references.join(' ') : undefined,
      headers: { 'X-Mailer': 'aMail' },
      attachments: attachments.length ? mailerAttachments(attachments) : undefined,
    };
    let transport;
    let rawMessage;
    let delivery;
    try {
      const compiled = await compileMessage(message);
      rawMessage = Buffer.isBuffer(compiled)
        ? compiled
        : (typeof compiled === 'string' ? Buffer.from(compiled) : null);
      if (!rawMessage?.length) throw new Error('RFC822 compilation produced an empty message.');
      transport = newSmtpTransport(account, credentials);
      const smtpResult = await transport.sendMail({ envelope, raw: rawMessage });
      delivery = smtpDeliverySummary(smtpResult, envelope.to.length, { resolved: true });
    } catch (error) {
      const rejected = smtpDeliverySummary(error, envelope.to.length);
      if (rejected.status === 'rejected') {
        logger.warn({ accountId: account.id, delivery: rejected }, 'SMTP rejected every message recipient');
        throw rejectedDeliveryError(rejected);
      }
      logger.warn({ accountId: account.id, err: cleanupError(error) }, 'SMTP send failed');
      throw new ServiceUnavailableError('Message could not be sent. Check SMTP settings and app password.', 'SMTP_SEND_FAILED');
    } finally {
      transport?.close?.();
    }

    if (delivery.acceptedCount === 0) {
      logger.warn({ accountId: account.id, delivery }, 'SMTP did not confirm any message recipient');
      throw rejectedDeliveryError(delivery);
    }
    if (delivery.status === 'partial') {
      logger.warn({ accountId: account.id, delivery }, 'SMTP accepted the message for only some recipients');
    }

    // Creating a local thread is a write. Defer it until SMTP confirms at least
    // one recipient so an all-rejected attempt cannot leave an empty thread.
    const thread = resolveThread({
      accountId: account.id,
      subject,
      inReplyTo: parent?.messageId || input.inReplyTo,
      references,
      threadId: input.threadId,
    });
    const sanitized = sanitizeEmailHtml(signed.html || toSafeHtmlFromText(signed.text));
    const saved = repos.messages.upsert({
      account_id: account.id,
      thread_id: thread.id,
      mailbox: 'Sent',
      uid: null,
      rfc_message_id: messageId,
      in_reply_to: parent?.messageId || input.inReplyTo || null,
      references_json: stringify(references),
      subject,
      from_name: account.display_name,
      from_email: account.email,
      to_json: stringify(to),
      cc_json: stringify(cc),
      bcc_json: stringify(bcc),
      reply_to_json: null,
      sent_at: sentAt.toISOString(),
      received_at: sentAt.toISOString(),
      html_body: sanitized.html,
      text_body: signed.text,
      snippet: textSnippet(signed.text),
      attachments_json: stringify(storedAttachmentRecords(attachments)),
      labels_json: '[]',
      is_read: 1,
      is_starred: 0,
      is_archived: 0,
      is_trashed: 0,
      is_spam: 0,
      snoozed_until: null,
      is_sent: 1,
    });
    if (input.draftId) repos.drafts.remove(input.draftId);
    const sentCopy = await appendProviderSentCopy({ account, credentials, rawMessage, sentAt });
    return { ...saved, delivery, sentCopy };
  }

  async function syncMessageStateToImap(message, state) {
    // IMAP has no portable Snooze command or special-use flag. Keep the local
    // snooze timestamp authoritative rather than pretending it was synced.
    if (state.snoozedUntil !== undefined) {
      return {
        message,
        remoteSync: { attempted: false, status: 'local-only', reason: 'snooze-is-not-portable-imap' },
      };
    }
    // The analyzed flag is aMail's own agent bookkeeping; it has no IMAP
    // counterpart, so an analyzed-only change never opens a mail connection.
    const imapRelevant = ['isRead', 'isStarred', 'isArchived', 'isTrashed', 'isSpam']
      .some((key) => state[key] !== undefined);
    if (!imapRelevant) {
      return {
        message,
        remoteSync: { attempted: false, status: 'local-only', reason: 'analyzed-flag-is-local' },
      };
    }
    if (!Number.isInteger(message.uid) || message.uid < 1) {
      return {
        message,
        remoteSync: { attempted: false, status: 'local-only', reason: 'message-has-no-imap-uid' },
      };
    }
    const { account, credentials } = accountAndCredentials(message.accountId);
    const client = newImapClient(account, credentials);
    let lock;
    const action = remoteMoveAction(state);
    try {
      await client.connect();
      let destination = null;
      if (action) {
        destination = specialUseDestination(await client.list(), action);
        if (!destination) {
          return {
            message,
            remoteSync: { attempted: false, status: 'skipped', action, reason: 'special-use-mailbox-not-found' },
          };
        }
        if (destination === message.mailbox) {
          return {
            message,
            remoteSync: { attempted: false, status: 'skipped', action, reason: 'already-in-destination', destination },
          };
        }
      }
      lock = await client.getMailboxLock(message.mailbox || 'INBOX');
      if (state.isRead !== undefined) {
        const method = state.isRead ? 'messageFlagsAdd' : 'messageFlagsRemove';
        await client[method](message.uid, ['\\Seen'], { uid: true });
      }
      if (state.isStarred !== undefined) {
        const method = state.isStarred ? 'messageFlagsAdd' : 'messageFlagsRemove';
        await client[method](message.uid, ['\\Flagged'], { uid: true });
      }
      if (!action) {
        return { message, remoteSync: { attempted: true, status: 'synced', action: 'flags' } };
      }
      // ImapFlow uses MOVE when available and safely falls back to COPY +
      // EXPUNGE for servers lacking RFC 6851 support.
      const moveResult = await client.messageMove(message.uid, destination, { uid: true });
      if (!moveResult) throw new Error(`IMAP ${action} move was rejected`);

      let movedMessage = message;
      let tracking = 'awaiting-mailbox-sync';
      try {
        movedMessage = repos.messages.relocate(message.id, {
          mailbox: destination,
          // UIDPLUS gives us the destination UID. Without it, null prevents a
          // later flag mutation from accidentally targeting a stale source UID.
          uid: mappedUid(moveResult, message.uid),
        }) || message;
        tracking = movedMessage.uid ? 'updated' : 'awaiting-mailbox-sync';
      } catch (error) {
        logger.warn({ messageId: message.id, err: cleanupError(error) }, 'IMAP move succeeded but local UID tracking could not be updated');
        tracking = 'untracked';
      }
      return {
        message: movedMessage,
        remoteSync: { attempted: true, status: 'moved', action, destination, tracking },
      };
    } finally {
      lock?.release();
      await client.logout().catch(() => {});
    }
  }

  async function updateMessageState(id, state) {
    const existing = repos.messages.get(id);
    if (!existing) throw new NotFoundError('Message not found.');
    const updated = repos.messages.setState(id, state);
    // Only the transition into "analyzed" is metered, so re-marking an already
    // analyzed message (or toggling it back) never inflates the count.
    if (state.isAnalyzed === true && !existing.isAnalyzed && updated?.isAnalyzed) {
      metering?.recordAnalyzed?.(1);
    }
    // Mail mutations are intentionally best-effort so offline local state stays
    // usable. The API response says whether IMAP accepted, skipped, or failed it.
    try {
      const { message, remoteSync } = await syncMessageStateToImap(updated, state);
      return { ...message, remoteSync };
    } catch (error) {
      logger.warn({ messageId: id, err: cleanupError(error) }, 'Could not synchronize message mutation to IMAP');
      return {
        ...updated,
        remoteSync: { attempted: true, status: 'failed', reason: 'imap-operation-failed' },
      };
    }
  }

  return { syncAccount, syncAll, testSettings, testAccount, sendMessage, updateMessageState, fetchAttachment, close };
}
