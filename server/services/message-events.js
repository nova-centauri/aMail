import { randomUUID } from 'node:crypto';

/*
 * Message lifecycle events. One typed emitter per runtime; the webhook
 * dispatcher (services/webhooks.js) and the SSE hub (services/mailbox-events.js)
 * subscribe to it, and anything else inside the server can too.
 *
 * `message.received` is derived from committed database writes rather than
 * from the sync code, so every ingest path is covered by one rule (main-thread
 * sync, the sync worker, body hydration, deep-search imports):
 *
 *   - the row is new (repos.messageWrites; a re-sync or flag change is an
 *     update and never announces), or an envelope-only row just got its source;
 *   - it is inbound: not sent mail, not a draft, not already in Trash, and not
 *     a second copy of a Message-ID the account already holds under another
 *     folder or label;
 *   - it was received inside the recency window (AMAIL_EVENT_RECENCY_HOURS,
 *     24 by default). This is what keeps a first sync, a UIDVALIDITY reset or
 *     a mailbox migration from announcing hundreds of old messages.
 *
 * To add an event: add it to MESSAGE_EVENT_TYPES, emit it from the place the
 * transition happens, and document its payload in docs/webhooks.md.
 */

export const MESSAGE_EVENT_TYPES = Object.freeze({
  'message.received': 'A new inbound message was imported from the mail server.',
  'message.sent': 'A message was accepted by SMTP for at least one recipient.',
  'message.analyzed': 'A message was marked analyzed by an agent or a person.',
});

export const DEFAULT_EVENT_RECENCY_MS = 24 * 60 * 60 * 1000;

const MAX_SUBJECT_CHARS = 998;
const MAX_NAME_CHARS = 256;
const MAX_ADDRESS_CHARS = 320;

const clip = (value, limit) => String(value ?? '').slice(0, limit);

/**
 * The `data` object of a message event. Deliberately small: ids, the sender,
 * the subject and the stored authentication verdicts. Never bodies, snippets,
 * recipients or attachment content; the receiver fetches the message itself.
 */
export function messageEventData(message, account = null) {
  return {
    messageId: message.id,
    accountId: message.accountId,
    accountEmail: account?.email || null,
    threadId: message.threadId,
    mailbox: clip(message.mailbox, 256),
    rfcMessageId: message.messageId ? clip(message.messageId, 998) : null,
    from: {
      name: clip(message.from?.name, MAX_NAME_CHARS),
      email: clip(message.from?.email, MAX_ADDRESS_CHARS),
    },
    subject: clip(message.subject, MAX_SUBJECT_CHARS),
    receivedAt: message.receivedAt || null,
    isSpam: Boolean(message.isSpam),
    authentication: message.authentication || null,
  };
}

/** Why a created row is not announced, or null when it should be. */
export function receivedSuppression(message, write, { nowMs, recencyMs }) {
  if (!message) return 'missing';
  if (write?.copy) return 'copy';
  if (message.isSent) return 'sent';
  if (message.isDraft) return 'draft';
  if (message.isTrashed) return 'trash';
  if (message.sourceImported === false) return 'envelope-only';
  const receivedMs = Date.parse(message.receivedAt || message.createdAt || '');
  if (Number.isFinite(receivedMs) && nowMs - receivedMs > recencyMs) return 'backfill';
  return null;
}

export function createMessageEvents({
  repos,
  config = {},
  logger = null,
  now = () => Date.now(),
} = {}) {
  const configuredRecency = Number(config.eventRecencyMs);
  const recencyMs = Number.isFinite(configuredRecency) && configuredRecency > 0
    ? configuredRecency
    : DEFAULT_EVENT_RECENCY_MS;
  const listeners = new Map();
  const counters = { emitted: 0, suppressed: 0, suppressedBackfill: 0 };

  function on(type, listener) {
    if (typeof listener !== 'function') return () => {};
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
    return () => listeners.get(type)?.delete(listener);
  }

  function emit(type, data) {
    const event = Object.freeze({
      id: randomUUID(),
      type,
      createdAt: new Date(now()).toISOString(),
      data,
    });
    counters.emitted += 1;
    for (const key of [type, '*']) {
      for (const listener of listeners.get(key) || []) {
        try {
          listener(event);
        } catch (error) {
          // A subscriber can never fail mail ingestion, sending or a state change.
          logger?.warn?.({ event: type, err: String(error?.message || error) }, 'Message event subscriber failed');
        }
      }
    }
    return event;
  }

  const accountFor = (accountId) => {
    try {
      return repos?.accounts?.get?.(accountId) || null;
    } catch {
      return null;
    }
  };

  function onMessageWrite(write) {
    if (write?.kind !== 'created') return;
    let message = null;
    try {
      message = repos.messages.get(write.id);
    } catch {
      return;
    }
    const reason = receivedSuppression(message, write, { nowMs: now(), recencyMs });
    if (reason) {
      counters.suppressed += 1;
      if (reason === 'backfill') counters.suppressedBackfill += 1;
      return;
    }
    emit('message.received', messageEventData(message, accountFor(message.accountId)));
  }

  const unsubscribeWrites = repos?.messageWrites?.subscribe?.(onMessageWrite) || (() => {});

  return {
    recencyMs,
    on,
    emit,
    /** SMTP accepted the message; `message` is the stored Sent copy. */
    messageSent(message) {
      if (!message?.id) return null;
      return emit('message.sent', {
        ...messageEventData(message, accountFor(message.accountId)),
        sentAt: message.sentAt || null,
      });
    },
    /** The analyzed flag went from unset to set. */
    messageAnalyzed(message) {
      if (!message?.id) return null;
      return emit('message.analyzed', {
        ...messageEventData(message, accountFor(message.accountId)),
        analyzedAt: message.analyzedAt || null,
        analyzedBy: message.analyzedBy || null,
      });
    },
    stats: () => ({ ...counters }),
    close() {
      unsubscribeWrites();
      listeners.clear();
    },
  };
}
