/**
 * Usage metering for hosted deployments.
 *
 * The only metered event is an agent (or person) marking a message analyzed.
 * Events carry a count and a timestamp, never message ids, subjects, addresses,
 * or agent names, so the metering endpoint learns how much mail was processed
 * and nothing about its contents.
 *
 * Self-hosted installs leave `AMAIL_METERING_URL` unset and get a no-op
 * service: no timers, no network, no buffered state.
 */

export const METERING_EVENT_ANALYZED = 'analyzed';

const DEFAULT_FLUSH_INTERVAL_MS = 15_000;
const DEFAULT_MAX_PENDING_BATCHES = 240;
const REQUEST_TIMEOUT_MS = 10_000;

const noopLogger = { warn() {}, error() {}, info() {} };

export function createNoopMeteringService() {
  return Object.freeze({
    enabled: false,
    recordAnalyzed() {},
    async flush() {},
    async close() {},
    pendingCount: () => 0,
  });
}

/**
 * @param {object} options
 * @param {object} options.config `meteringUrl`, `meteringToken`, `tenantId`, `releaseSha`
 * @param {object} [options.logger]
 * @param {Function} [options.fetchImpl] injectable for tests
 * @param {Function} [options.now] injectable clock returning a Date
 * @param {number} [options.flushIntervalMs]
 * @param {number} [options.maxPendingBatches] drop oldest batches beyond this
 */
export function createMeteringService({
  config,
  logger = noopLogger,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  maxPendingBatches = DEFAULT_MAX_PENDING_BATCHES,
} = {}) {
  const url = String(config?.meteringUrl || '').trim();
  if (!url) return createNoopMeteringService();

  const token = String(config?.meteringToken || '');
  const tenant = String(config?.tenantId || '') || null;
  const release = config?.releaseSha || null;

  // The open batch accumulates counts between flushes. Sealed batches wait to
  // be delivered; a failed delivery keeps them queued and retries next tick.
  let openCount = 0;
  let openSince = null;
  const pending = [];
  let flushing = null;
  let closed = false;
  let timer = null;
  let consecutiveFailures = 0;

  function sealOpenBatch() {
    if (!openCount) return;
    pending.push({ type: METERING_EVENT_ANALYZED, count: openCount, at: openSince, until: now().toISOString() });
    openCount = 0;
    openSince = null;
    while (pending.length > maxPendingBatches) {
      const dropped = pending.shift();
      logger.error({ dropped: dropped.count }, 'Metering backlog exceeded its limit; oldest analyzed batch dropped');
    }
  }

  async function deliver(events) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ version: 1, tenant, release, sentAt: now().toISOString(), events }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`Metering endpoint responded ${response.status}`);
        error.status = response.status;
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function flush() {
    if (flushing) return flushing;
    sealOpenBatch();
    if (!pending.length) return undefined;
    flushing = (async () => {
      const events = pending.splice(0, pending.length);
      try {
        await deliver(events);
        consecutiveFailures = 0;
      } catch (error) {
        // Requeue at the front so ordering is preserved for the next attempt.
        pending.unshift(...events);
        consecutiveFailures += 1;
        const summary = { status: error?.status || null, reason: error?.name === 'AbortError' ? 'timeout' : 'request-failed', attempts: consecutiveFailures };
        if (consecutiveFailures === 1 || consecutiveFailures % 20 === 0) {
          logger.warn(summary, 'Metering delivery failed; analyzed counts stay queued');
        }
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  function scheduleFlush() {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().then(() => {
        if (pending.length || openCount) scheduleFlush();
      });
    }, flushIntervalMs);
    timer.unref?.();
  }

  function recordAnalyzed(count = 1) {
    const increment = Number(count);
    if (closed || !Number.isInteger(increment) || increment <= 0) return;
    if (!openCount) openSince = now().toISOString();
    openCount += increment;
    scheduleFlush();
  }

  async function close() {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await flush();
  }

  return Object.freeze({
    enabled: true,
    recordAnalyzed,
    flush,
    close,
    pendingCount: () => pending.reduce((sum, batch) => sum + batch.count, 0) + openCount,
  });
}
