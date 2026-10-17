/**
 * Listing/SSE change version. Writers bump an in-memory counter and a
 * single-row table. Readers never scan messages/accounts/sync_state.
 */

export function emptyChangeStamp() {
  return { version: 0, changedAt: null, messageAt: null, syncAt: null, accountAt: null };
}

export function stampFromRow(row) {
  if (!row) return emptyChangeStamp();
  const messageAt = row.message_at || row.messageAt || null;
  const syncAt = row.sync_at || row.syncAt || null;
  const accountAt = row.account_at || row.accountAt || null;
  const times = [messageAt, syncAt, accountAt].filter(Boolean).sort();
  return {
    version: Number(row.version) || 0,
    changedAt: times.at(-1) || null,
    messageAt,
    syncAt,
    accountAt,
  };
}

export function rowFromStamp(stamp = emptyChangeStamp()) {
  return {
    version: Number(stamp.version) || 0,
    message_at: stamp.messageAt || null,
    sync_at: stamp.syncAt || null,
    account_at: stamp.accountAt || null,
  };
}

function later(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left >= right ? left : right;
}

export function bumpChangeStamp(current, field, at) {
  const next = { ...(current || emptyChangeStamp()) };
  const when = at || new Date().toISOString();
  if (field === 'message') next.messageAt = when;
  else if (field === 'account') next.accountAt = when;
  else if (field === 'sync') next.syncAt = when;
  else next.messageAt = when;
  if (field !== 'sync') next.version = (Number(next.version) || 0) + 1;
  const times = [next.messageAt, next.syncAt, next.accountAt].filter(Boolean).sort();
  next.changedAt = times.at(-1) || when;
  return next;
}

export function mergeChangeStamp(left, right) {
  const a = left || emptyChangeStamp();
  const b = right || emptyChangeStamp();
  const messageAt = later(a.messageAt, b.messageAt);
  const syncAt = later(a.syncAt, b.syncAt);
  const accountAt = later(a.accountAt, b.accountAt);
  const times = [messageAt, syncAt, accountAt].filter(Boolean).sort();
  return {
    version: Math.max(Number(a.version) || 0, Number(b.version) || 0),
    changedAt: times.at(-1) || null,
    messageAt,
    syncAt,
    accountAt,
  };
}

/** Inbox/ETag/SSE token. Sync-cursor timestamps are excluded. */
export function listCacheToken(stamp = {}) {
  const times = [stamp.messageAt, stamp.accountAt].filter(Boolean).sort();
  const at = times.at(-1) || '';
  const version = Number(stamp.version) || 0;
  if (!version && !at) return '';
  return `${version}:${at}`;
}

export function createChangeVersionStore({
  load,
  persist,
  now = () => new Date().toISOString(),
} = {}) {
  let stamp = stampFromRow(typeof load === 'function' ? load() : null);
  const listeners = new Set();

  function emit() {
    const snapshot = { ...stamp };
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken SSE listener must not roll back the write.
      }
    }
    return snapshot;
  }

  function save() {
    persist?.(rowFromStamp(stamp));
  }

  return {
    stamp() {
      return { ...stamp };
    },
    bump(field, at = now()) {
      stamp = bumpChangeStamp(stamp, field, at);
      save();
      return emit();
    },
    applyRemote(incoming) {
      if (!incoming || typeof incoming !== 'object') return { ...stamp };
      const next = mergeChangeStamp(stamp, incoming);
      if (
        next.version === stamp.version
        && next.messageAt === stamp.messageAt
        && next.accountAt === stamp.accountAt
        && next.syncAt === stamp.syncAt
      ) {
        return { ...stamp };
      }
      stamp = next;
      save();
      return emit();
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
