import crypto, { randomUUID } from 'node:crypto';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { decryptJson, encryptJson } from './crypto.js';
import { MESSAGE_EVENT_TYPES } from './message-events.js';
import {
  createWebhookTransport,
  signWebhookBody,
  WebhookDeliveryError,
} from './webhook-delivery.js';

/*
 * Outbound webhooks: subscriptions, a durable delivery queue, retries.
 *
 * - A subscription is a URL, a secret, the event types it wants and an
 *   optional account filter. They are managed over REST and MCP and stored in
 *   SQLite; AMAIL_WEBHOOK_URL/SECRET/EVENTS add one static subscription.
 * - Each matching event becomes one `pending` row in webhook_deliveries. The
 *   event subscriber only writes that row; the dispatcher sends in the
 *   background, so a slow or dead receiver never delays mail ingestion.
 * - A failed attempt is retried after 1m, 5m, 30m, 2h and 6h (with jitter).
 *   The schedule lives in the row, so it survives a restart. After the last
 *   retry the delivery is `failed`.
 * - A subscription whose events keep failing is switched off after
 *   `webhookMaxConsecutiveFailures` in a row, and says so in its status.
 * - The queue is bounded per subscription: past `webhookMaxQueue` undelivered
 *   events the oldest is dropped and counted.
 * - Off by default: with no subscription nothing is queued, resolved or sent.
 */

export const WEBHOOK_RETRY_DELAYS_MS = Object.freeze([
  60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000,
]);
/** The first attempt plus one per retry delay. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
export const WEBHOOK_RETRY_JITTER = 0.1;
export const MAX_WEBHOOK_SUBSCRIPTIONS = 20;
export const ENV_WEBHOOK_ID = 'env';
export const WEBHOOK_PING_EVENT = 'ping';
const MIN_SECRET_CHARS = 16;
const MAX_SECRET_CHARS = 256;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_ACCOUNT_FILTER = 100;
const IDLE_RECHECK_MS = 60_000;

const noopLogger = { info() {}, warn() {}, error() {} };

function unavailable() {
  return new AppError('Webhooks are not available on this server.', { status: 503, code: 'WEBHOOKS_UNAVAILABLE', expose: true });
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(32).toString('base64url')}`;
}

/** Delay before retry number `attempts` (1-based count of attempts made). */
export function webhookRetryDelayMs(attempts, random = Math.random) {
  const base = WEBHOOK_RETRY_DELAYS_MS[attempts - 1];
  if (base === undefined) return null;
  return Math.round(base * (1 - WEBHOOK_RETRY_JITTER + (2 * WEBHOOK_RETRY_JITTER * random())));
}

function validateEvents(value) {
  if (!Array.isArray(value) || !value.length) {
    throw new ValidationError(`events must list at least one of: ${Object.keys(MESSAGE_EVENT_TYPES).join(', ')}, or "*".`);
  }
  const events = [...new Set(value.map((item) => String(item ?? '').trim()))];
  const unknown = events.filter((item) => item !== '*' && !Object.hasOwn(MESSAGE_EVENT_TYPES, item));
  if (unknown.length) {
    throw new ValidationError(`Unknown webhook event. Supported events: ${Object.keys(MESSAGE_EVENT_TYPES).join(', ')}, or "*".`);
  }
  return events;
}

function validateSecret(value) {
  // Printable ASCII keeps the secret safe to paste into any .env or header.
  if (typeof value !== 'string' || value.length < MIN_SECRET_CHARS || value.length > MAX_SECRET_CHARS
    || !/^[\x21-\x7e]+$/.test(value)) {
    throw new ValidationError(`secret must be ${MIN_SECRET_CHARS}-${MAX_SECRET_CHARS} printable characters without spaces. Omit it to have one generated.`);
  }
  return value;
}

function validateDescription(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError('description must be text.');
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);
}

export function createWebhookService({
  config = {},
  repos,
  events = null,
  logger = noopLogger,
  transport = null,
  version = '0.0.0',
  now = () => Date.now(),
  random = Math.random,
  // Tests drive the dispatcher by hand with dispatchDue().
  autoDispatch = true,
} = {}) {
  const store = repos.webhooks;
  const sender = transport || createWebhookTransport({
    allowHosts: config.webhookAllowHosts || [],
    timeoutMs: config.webhookTimeoutMs,
    userAgent: `aMail-Webhook/${version}`,
  });
  const maxQueue = Number(config.webhookMaxQueue) > 0 ? Number(config.webhookMaxQueue) : 1_000;
  const logSize = Number(config.webhookDeliveryLogSize) > 0 ? Number(config.webhookDeliveryLogSize) : 100;
  const maxFailures = Number.isInteger(config.webhookMaxConsecutiveFailures) ? config.webhookMaxConsecutiveFailures : 20;
  const iso = (ms = now()) => new Date(ms).toISOString();

  let subscriptions = [];
  let started = false;
  let closed = false;
  let timer = null;
  let dispatching = null;
  let unsubscribeEvents = null;
  const counters = { delivered: 0, failed: 0 };
  // /api/health reads this snapshot; it is rebuilt on writes, never by the probe.
  let snapshot = {
    enabled: false, subscriptions: 0, active: 0, disabled: 0, autoDisabled: 0, pending: 0, dropped: 0,
    deliveredSinceStart: 0, failedSinceStart: 0,
  };

  function reload() {
    subscriptions = store.list().map((row) => ({
      ...row,
      events: parseJsonList(row.events_json),
      accountIds: parseJsonList(row.account_ids_json),
    }));
    let pending = 0;
    try {
      pending = store.deliveries.pendingTotal();
    } catch {
      pending = 0;
    }
    snapshot = {
      enabled: subscriptions.length > 0,
      subscriptions: subscriptions.length,
      active: subscriptions.filter((item) => item.enabled).length,
      disabled: subscriptions.filter((item) => !item.enabled).length,
      autoDisabled: subscriptions.filter((item) => !item.enabled && item.disabled_reason !== 'manual').length,
      pending,
      dropped: subscriptions.reduce((sum, item) => sum + (Number(item.dropped_count) || 0), 0),
      deliveredSinceStart: counters.delivered,
      failedSinceStart: counters.failed,
    };
  }

  function publicSubscription(row) {
    if (!row) return null;
    const enabled = Boolean(row.enabled);
    return {
      id: row.id,
      // `env` is the AMAIL_WEBHOOK_URL subscription; change it in the environment.
      source: row.source === 'env' ? 'env' : 'api',
      url: row.url,
      description: row.description || '',
      events: parseJsonList(row.events_json),
      accountIds: parseJsonList(row.account_ids_json),
      enabled,
      status: enabled ? 'active' : (row.disabled_reason && row.disabled_reason !== 'manual' ? 'auto-disabled' : 'disabled'),
      disabledReason: enabled ? null : (row.disabled_reason || 'manual'),
      disabledAt: enabled ? null : (row.disabled_at || null),
      consecutiveFailures: Number(row.consecutive_failures) || 0,
      droppedCount: Number(row.dropped_count) || 0,
      pendingDeliveries: store.deliveries.pendingCount(row.id),
      lastSuccessAt: row.last_success_at || null,
      lastFailureAt: row.last_failure_at || null,
      lastError: row.last_error || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function publicDelivery(row) {
    return {
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      status: row.status,
      attempts: Number(row.attempts) || 0,
      nextAttemptAt: row.status === 'pending' ? (row.next_attempt_at || null) : null,
      lastAttemptAt: row.last_attempt_at || null,
      lastDeliveryId: row.last_delivery_id || null,
      responseStatus: row.response_status ?? null,
      error: row.last_error || null,
      createdAt: row.created_at,
      completedAt: row.completed_at || null,
    };
  }

  function secretFor(row) {
    if (row.source === 'env') return config.webhookSecret || null;
    try {
      return decryptJson(row.secret_ciphertext, config.credentialKey)?.secret || null;
    } catch {
      return null;
    }
  }

  function validateAccountIds(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_ACCOUNT_FILTER) {
      throw new ValidationError('accountIds must be a list of account ids.');
    }
    const ids = [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
    for (const id of ids) {
      if (!repos.accounts.get(id)) throw new ValidationError('accountIds contains an account that does not exist.');
    }
    return ids;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!autoDispatch || closed || !started) return;
    let next = null;
    try {
      next = store.deliveries.nextDueAt();
    } catch {
      return;
    }
    if (!next) return;
    const wait = Math.min(Math.max(0, Date.parse(next) - now()), IDLE_RECHECK_MS);
    timer = setTimeout(() => {
      timer = null;
      dispatchDue().catch((error) => logger.warn({ err: String(error?.message || error) }, 'Webhook dispatcher pass failed'));
    }, wait);
    timer.unref?.();
  }

  function disable(row, reason) {
    const at = iso();
    store.update(row.id, { enabled: 0, disabled_reason: reason, disabled_at: at });
    store.deliveries.closePending(row.id, { status: 'failed', error: 'subscription-disabled', at });
    store.deliveries.prune(row.id, logSize);
    if (reason !== 'manual') {
      logger.warn({ webhookId: row.id, reason }, 'Webhook subscription switched off');
    }
  }

  async function send(row, { eventId, eventType, body }) {
    const secret = secretFor(row);
    if (!secret) throw new WebhookDeliveryError('secret-unavailable', { code: 'WEBHOOK_SECRET_UNAVAILABLE' });
    const deliveryId = randomUUID();
    const result = await sender.post({
      url: row.url,
      body,
      headers: {
        'content-type': 'application/json',
        'x-amail-event': eventType,
        'x-amail-event-id': eventId,
        'x-amail-delivery': deliveryId,
        'x-amail-signature': signWebhookBody(secret, body, Math.floor(now() / 1000)),
      },
    }).catch((error) => {
      error.deliveryId = deliveryId;
      throw error;
    });
    return { ...result, deliveryId };
  }

  async function attempt(delivery) {
    const row = store.get(delivery.subscription_id);
    const at = iso();
    if (!row || !row.enabled) {
      store.deliveries.close(delivery.id, { status: 'failed', error: 'subscription-disabled', at });
      return;
    }
    const attempts = (Number(delivery.attempts) || 0) + 1;
    let status = null;
    let reason = null;
    let deliveryId = null;
    try {
      const result = await send(row, {
        eventId: delivery.event_id,
        eventType: delivery.event_type,
        body: delivery.payload_json,
      });
      status = result.status;
      deliveryId = result.deliveryId;
      if (status < 200 || status >= 300) {
        reason = status >= 300 && status < 400 ? `redirect-not-followed-${status}` : `http-${status}`;
      }
    } catch (error) {
      deliveryId = error?.deliveryId || null;
      reason = error instanceof WebhookDeliveryError ? error.reason : 'delivery-failed';
    }
    // The subscription may have been deleted or disabled while the request was in flight.
    const current = store.get(row.id);
    if (!current || !store.deliveries.get(delivery.id)) return;
    const base = { attempts, last_attempt_at: at, last_delivery_id: deliveryId, response_status: status };
    if (!reason) {
      store.deliveries.update(delivery.id, {
        ...base, status: 'delivered', next_attempt_at: null, last_error: null, completed_at: at,
      });
      store.update(row.id, { consecutive_failures: 0, last_success_at: at, last_error: null });
      store.deliveries.prune(row.id, logSize);
      counters.delivered += 1;
      return;
    }
    if (!current.enabled) {
      store.deliveries.update(delivery.id, {
        ...base, status: 'failed', next_attempt_at: null, last_error: 'subscription-disabled', completed_at: at,
      });
      return;
    }
    // 410 Gone is the receiver saying the endpoint no longer exists.
    const delay = status === 410 ? null : webhookRetryDelayMs(attempts, random);
    if (delay !== null) {
      store.deliveries.update(delivery.id, {
        ...base, status: 'pending', next_attempt_at: iso(now() + delay), last_error: reason,
      });
      store.update(row.id, { last_failure_at: at, last_error: reason });
      return;
    }
    store.deliveries.update(delivery.id, {
      ...base, status: 'failed', next_attempt_at: null, last_error: reason, completed_at: at,
    });
    counters.failed += 1;
    const failures = (Number(current.consecutive_failures) || 0) + 1;
    store.update(row.id, { consecutive_failures: failures, last_failure_at: at, last_error: reason });
    logger.warn({ webhookId: row.id, event: delivery.event_type, attempts, reason }, 'Webhook delivery failed after its last retry');
    if (status === 410) disable(row, 'gone');
    else if (maxFailures > 0 && failures >= maxFailures) disable(row, 'consecutive-failures');
    else store.deliveries.prune(row.id, logSize);
  }

  /**
   * Send everything that is due. One delivery per subscription at a time, so
   * a subscription's events go out in order and a slow receiver only holds up
   * its own queue.
   */
  function dispatchDue() {
    if (dispatching) return dispatching;
    if (closed) return Promise.resolve();
    const pass = async () => {
      for (;;) {
        if (closed) break;
        const at = iso();
        const due = store.list()
          .filter((row) => row.enabled)
          .map((row) => store.deliveries.dueFor(row.id, at))
          .filter(Boolean);
        if (!due.length) break;
        await Promise.all(due.map((delivery) => attempt(delivery).catch((error) => {
          logger.warn({ err: String(error?.message || error) }, 'Webhook delivery attempt failed unexpectedly');
          // Never spin on a row that cannot be processed.
          store.deliveries.close(delivery.id, { status: 'failed', error: 'internal-error', at: iso() });
        })));
      }
    };
    // `finally` runs on a later tick, so it can never clear the slot before
    // the assignment below has filled it (a pass with nothing due is synchronous).
    dispatching = pass().finally(() => {
      dispatching = null;
      if (!closed) {
        reload();
        schedule();
      }
    });
    return dispatching;
  }

  function enqueue(row, event) {
    const overflow = store.deliveries.pendingCount(row.id) - maxQueue + 1;
    if (overflow > 0) {
      const at = iso();
      let dropped = 0;
      for (const id of store.deliveries.oldestPending(row.id, overflow)) {
        if (store.deliveries.close(id, { status: 'dropped', error: 'queue-full', at })) dropped += 1;
      }
      if (dropped) {
        const total = (Number(row.dropped_count) || 0) + dropped;
        store.update(row.id, { dropped_count: total });
        row.dropped_count = total;
        if (total === dropped || total % 100 < dropped) {
          logger.warn({ webhookId: row.id, dropped: total }, 'Webhook queue is full; oldest undelivered events dropped');
        }
        store.deliveries.prune(row.id, logSize);
      }
    }
    store.deliveries.insert({
      id: randomUUID(),
      subscription_id: row.id,
      event_id: event.id,
      event_type: event.type,
      payload_json: JSON.stringify({ id: event.id, type: event.type, createdAt: event.createdAt, data: event.data }),
      status: 'pending',
      next_attempt_at: iso(),
      created_at: iso(),
    });
  }

  function onEvent(event) {
    if (closed || !event || !Object.hasOwn(MESSAGE_EVENT_TYPES, event.type)) return;
    let queued = 0;
    for (const row of subscriptions) {
      if (!row.enabled) continue;
      if (!row.events.includes('*') && !row.events.includes(event.type)) continue;
      if (row.accountIds.length && !row.accountIds.includes(event.data?.accountId)) continue;
      try {
        enqueue(row, event);
        queued += 1;
      } catch (error) {
        logger.warn({ webhookId: row.id, err: String(error?.message || error) }, 'Webhook event could not be queued');
      }
    }
    if (!queued) return;
    snapshot = { ...snapshot, pending: snapshot.pending + queued };
    if (autoDispatch && started) {
      // Off the caller's stack: the write that raised the event returns first.
      setImmediate(() => {
        dispatchDue().catch((error) => logger.warn({ err: String(error?.message || error) }, 'Webhook dispatcher pass failed'));
      });
    }
  }

  /** Mirror AMAIL_WEBHOOK_URL/SECRET/EVENTS into the one `env` subscription. */
  function syncEnvSubscription() {
    const existing = store.get(ENV_WEBHOOK_ID);
    if (!config.webhookUrl) {
      if (existing) store.remove(ENV_WEBHOOK_ID);
      return;
    }
    let url;
    try {
      url = sender.checkUrl(config.webhookUrl).toString();
    } catch (error) {
      logger.error({ code: error?.code || null }, 'AMAIL_WEBHOOK_URL was refused; the environment webhook is off');
      if (existing) store.remove(ENV_WEBHOOK_ID);
      return;
    }
    const secret = String(config.webhookSecret || '');
    if (secret.length < MIN_SECRET_CHARS) {
      logger.error(`AMAIL_WEBHOOK_URL needs AMAIL_WEBHOOK_SECRET (at least ${MIN_SECRET_CHARS} characters); the environment webhook is off`);
      if (existing) store.remove(ENV_WEBHOOK_ID);
      return;
    }
    const eventsJson = JSON.stringify(config.webhookEvents?.length ? config.webhookEvents : ['message.received']);
    if (!existing) {
      const at = iso();
      store.insert({
        id: ENV_WEBHOOK_ID,
        source: 'env',
        url,
        description: 'Defined by AMAIL_WEBHOOK_URL',
        events_json: eventsJson,
        account_ids_json: '[]',
        secret_ciphertext: '',
        enabled: 1,
        created_at: at,
        updated_at: at,
      });
    } else if (existing.url !== url) {
      // A new target starts clean rather than inheriting the old one's failures.
      store.update(ENV_WEBHOOK_ID, {
        url, events_json: eventsJson, enabled: 1, disabled_reason: null, disabled_at: null, consecutive_failures: 0, last_error: null,
      });
    } else if (existing.events_json !== eventsJson) {
      store.update(ENV_WEBHOOK_ID, { events_json: eventsJson });
    }
  }

  function requireRow(id) {
    const row = store.get(String(id || ''));
    if (!row) throw new NotFoundError('Webhook not found.');
    return row;
  }

  return {
    eventTypes: () => ({ ...MESSAGE_EVENT_TYPES }),
    start() {
      if (started || closed) return;
      started = true;
      try {
        syncEnvSubscription();
      } catch (error) {
        logger.error({ err: String(error?.message || error) }, 'The environment webhook could not be set up');
      }
      reload();
      unsubscribeEvents = events?.on?.('*', onEvent) || null;
      schedule();
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      await dispatching?.catch(() => {});
    },
    /** In-memory counters for /api/health. Never touches SQLite. */
    status: () => ({ ...snapshot, deliveredSinceStart: counters.delivered, failedSinceStart: counters.failed }),
    dispatchDue,
    list() {
      return store.list().map(publicSubscription);
    },
    get(id, { deliveries = 50 } = {}) {
      const row = requireRow(id);
      return {
        webhook: publicSubscription(row),
        deliveries: store.deliveries.recent(row.id, Math.min(Math.max(1, Number(deliveries) || 50), 200)).map(publicDelivery),
      };
    },
    /** Returns `{ webhook, secret }`. This is the only time the secret is readable. */
    async create(input = {}) {
      if (store.count() >= MAX_WEBHOOK_SUBSCRIPTIONS) {
        throw new ConflictError(`This server already has ${MAX_WEBHOOK_SUBSCRIPTIONS} webhooks. Delete one first.`);
      }
      const eventList = validateEvents(input.events);
      const accountIds = validateAccountIds(input.accountIds);
      const description = validateDescription(input.description);
      const secret = input.secret === undefined || input.secret === null ? generateWebhookSecret() : validateSecret(input.secret);
      // Encrypt before the network check so a server without an encryption key
      // fails the same way account creation does, without a DNS lookup.
      const ciphertext = encryptJson({ secret }, config.credentialKey);
      const url = (await sender.assertDeliverable(input.url)).toString();
      const at = iso();
      const row = store.insert({
        id: randomUUID(),
        source: 'api',
        url,
        description,
        events_json: JSON.stringify(eventList),
        account_ids_json: JSON.stringify(accountIds),
        secret_ciphertext: ciphertext,
        enabled: input.enabled === false ? 0 : 1,
        created_at: at,
        updated_at: at,
      });
      if (input.enabled === false) store.update(row.id, { disabled_reason: 'manual', disabled_at: at });
      reload();
      logger.info({ webhookId: row.id, events: eventList }, 'Webhook created');
      return { webhook: publicSubscription(store.get(row.id)), secret };
    },
    /** Returns `{ webhook }`, plus `secret` when `rotateSecret` generated a new one. */
    async update(id, patch = {}) {
      const row = requireRow(id);
      const wanted = Object.keys(patch).filter((key) => patch[key] !== undefined);
      if (row.source === 'env' && wanted.some((key) => key !== 'enabled')) {
        throw new ConflictError('This webhook is defined by AMAIL_WEBHOOK_URL. Change it in the server environment; only enabled can be set here.');
      }
      const fields = {};
      let newSecret = null;
      if (patch.events !== undefined) fields.events_json = JSON.stringify(validateEvents(patch.events));
      if (patch.accountIds !== undefined) fields.account_ids_json = JSON.stringify(validateAccountIds(patch.accountIds));
      if (patch.description !== undefined) fields.description = validateDescription(patch.description);
      if (patch.secret !== undefined && patch.secret !== null) {
        if (patch.rotateSecret) throw new ValidationError('Pass secret or rotateSecret, not both.');
        fields.secret_ciphertext = encryptJson({ secret: validateSecret(patch.secret) }, config.credentialKey);
      } else if (patch.rotateSecret === true) {
        newSecret = generateWebhookSecret();
        fields.secret_ciphertext = encryptJson({ secret: newSecret }, config.credentialKey);
      }
      if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
        throw new ValidationError('enabled must be true or false.');
      }
      if (patch.url !== undefined) fields.url = (await sender.assertDeliverable(patch.url)).toString();
      if (!store.get(row.id)) throw new NotFoundError('Webhook not found.');
      if (Object.keys(fields).length) store.update(row.id, fields);
      if (patch.enabled === true) {
        // Re-enabling is also how an auto-disabled subscription is revived.
        store.update(row.id, { enabled: 1, disabled_reason: null, disabled_at: null, consecutive_failures: 0 });
      } else if (patch.enabled === false && row.enabled) {
        disable(row, 'manual');
      }
      reload();
      schedule();
      return { webhook: publicSubscription(store.get(row.id)), ...(newSecret ? { secret: newSecret } : {}) };
    },
    remove(id) {
      const row = requireRow(id);
      if (row.source === 'env') {
        throw new ConflictError('This webhook is defined by AMAIL_WEBHOOK_URL. Remove that variable to delete it.');
      }
      store.remove(row.id);
      reload();
      return true;
    },
    /**
     * Send one `ping` event now. A single attempt, never retried, and it does
     * not count towards the failures that switch a subscription off.
     */
    async test(id) {
      const row = requireRow(id);
      const event = {
        id: randomUUID(),
        type: WEBHOOK_PING_EVENT,
        createdAt: iso(),
        data: { webhookId: row.id, message: 'aMail webhook test' },
      };
      const body = JSON.stringify(event);
      const startedAt = now();
      let status = null;
      let reason = null;
      let deliveryId = null;
      try {
        const result = await send(row, { eventId: event.id, eventType: event.type, body });
        status = result.status;
        deliveryId = result.deliveryId;
        if (status < 200 || status >= 300) {
          reason = status >= 300 && status < 400 ? `redirect-not-followed-${status}` : `http-${status}`;
        }
      } catch (error) {
        deliveryId = error?.deliveryId || null;
        reason = error instanceof WebhookDeliveryError ? error.reason : 'delivery-failed';
      }
      const at = iso();
      if (store.get(row.id)) {
        const deliveryRow = {
          id: randomUUID(),
          subscription_id: row.id,
          event_id: event.id,
          event_type: event.type,
          payload_json: body,
          status: reason ? 'failed' : 'delivered',
          attempts: 1,
          next_attempt_at: null,
          last_attempt_at: at,
          last_delivery_id: deliveryId,
          response_status: status,
          last_error: reason,
          created_at: event.createdAt,
          completed_at: at,
        };
        store.deliveries.insert(deliveryRow);
        store.deliveries.prune(row.id, logSize);
      }
      return {
        ok: !reason,
        eventId: event.id,
        deliveryId,
        responseStatus: status,
        error: reason,
        durationMs: Math.max(0, now() - startedAt),
      };
    },
  };
}

/** Stand-in when the server has no webhook service (unit tests that mount routes without one). */
export function unavailableWebhookService() {
  const fail = () => {
    throw unavailable();
  };
  return {
    eventTypes: () => ({ ...MESSAGE_EVENT_TYPES }),
    start() {},
    async close() {},
    status: () => null,
    async dispatchDue() {},
    list: fail,
    get: fail,
    create: async () => fail(),
    update: async () => fail(),
    remove: fail,
    test: async () => fail(),
  };
}
