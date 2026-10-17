export const MAILBOX_EVENT_HEARTBEAT_MS = 20_000;
export const MAILBOX_EVENT_POLL_MS = 250;
export const MAILBOX_EVENT_BUFFER = 64;

export function emptyStamp() {
  return { changedAt: null, messageAt: null, syncAt: null, accountAt: null };
}

export function readStamp(repos) {
  const stamp = repos?.changes?.stamp?.();
  if (!stamp || typeof stamp !== 'object') return emptyStamp();
  return {
    changedAt: stamp.changedAt || null,
    messageAt: stamp.messageAt || null,
    syncAt: stamp.syncAt || null,
    accountAt: stamp.accountAt || null,
  };
}

/**
 * Map a change-version stamp delta to the SSE names the Omarchy plugin
 * already switches on, plus the change-version/new-mail/sync-status aliases
 * operators asked for.
 */
export function eventsForStampChange(previous, next) {
  const before = previous || emptyStamp();
  const after = next || emptyStamp();
  if (!after.changedAt || after.changedAt === before.changedAt) return [];
  const changedAt = after.changedAt;
  const events = [{ event: 'change-version', data: { changedAt } }];
  if (after.messageAt && after.messageAt !== before.messageAt) {
    events.push({ event: 'new-mail', data: { changedAt } });
    events.push({ event: 'message.new', data: { changedAt } });
  }
  if (after.syncAt && after.syncAt !== before.syncAt) {
    events.push({ event: 'sync-status', data: { changedAt, state: 'updated' } });
    events.push({ event: 'sync.mailbox', data: { changedAt } });
  }
  if (after.accountAt && after.accountAt !== before.accountAt) {
    events.push({ event: 'account.updated', data: { changedAt } });
  }
  return events;
}

export function eventsForSyncFlight(wasInFlight, isInFlight, changedAt) {
  if (Boolean(wasInFlight) === Boolean(isInFlight)) return [];
  const state = isInFlight ? 'started' : 'done';
  const data = { changedAt: changedAt || null, state, inFlight: Boolean(isInFlight) };
  return [
    { event: 'sync-status', data },
    { event: 'sync.mailbox', data },
  ];
}

export function replaySince(buffer, lastEventId, latestSeq) {
  const id = Number.parseInt(String(lastEventId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) return { gap: false, events: [] };
  if (!buffer.length) {
    return { gap: id < latestSeq, events: [] };
  }
  const oldest = buffer[0].id;
  if (id < oldest) return { gap: true, events: [] };
  if (id > latestSeq) return { gap: true, events: [] };
  return { gap: false, events: buffer.filter((item) => item.id > id) };
}

export function createMailboxEventHub({
  repos,
  mailService = null,
  pollMs = MAILBOX_EVENT_POLL_MS,
  heartbeatMs = MAILBOX_EVENT_HEARTBEAT_MS,
  bufferSize = MAILBOX_EVENT_BUFFER,
} = {}) {
  const listeners = new Set();
  const buffer = [];
  let seq = 0;
  let timer = null;
  let lastStamp = emptyStamp();
  let lastInFlight = false;

  function currentInFlight() {
    try {
      return Boolean(mailService?.runtimeStatus?.()?.inFlight);
    } catch {
      return false;
    }
  }

  function publish(event, data = {}) {
    seq += 1;
    const payload = { id: seq, event, data: { ...data } };
    buffer.push(payload);
    if (buffer.length > bufferSize) buffer.shift();
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
        // A broken SSE client must not take down the hub.
      }
    }
    return payload;
  }

  function tick() {
    const stamp = readStamp(repos);
    for (const item of eventsForStampChange(lastStamp, stamp)) publish(item.event, item.data);
    lastStamp = stamp;
    const inFlight = currentInFlight();
    for (const item of eventsForSyncFlight(lastInFlight, inFlight, stamp.changedAt)) {
      publish(item.event, item.data);
    }
    lastInFlight = inFlight;
  }

  function start() {
    if (timer) return;
    lastStamp = readStamp(repos);
    lastInFlight = currentInFlight();
    timer = setInterval(tick, Math.max(20, Number(pollMs) || MAILBOX_EVENT_POLL_MS));
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function subscribe(listener) {
    listeners.add(listener);
    start();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stop();
    };
  }

  return {
    heartbeatMs: Math.max(1_000, Number(heartbeatMs) || MAILBOX_EVENT_HEARTBEAT_MS),
    subscribe,
    publish,
    replaySince(lastEventId) {
      return replaySince(buffer, lastEventId, seq);
    },
    changedAt() {
      return readStamp(repos).changedAt;
    },
    seq() {
      return seq;
    },
    close() {
      listeners.clear();
      stop();
    },
  };
}
