export const MIN_SILENT_MAILBOX_RELOAD_MS = 5_000;

export function mailboxQueryKey({
  folder = '',
  accountId = '',
  category = '',
  personFlag = '',
  query = '',
  accessToken = '',
  sessionStamp = 0,
} = {}) {
  return [folder, accountId || '', category || '', personFlag || '', query || '', accessToken || '', sessionStamp || 0].join('\u0000');
}

/** Silent live-sync ticks already have accounts; refetching them is what logs GET /api/accounts on every /api/messages. */
export function mailboxReloadNeedsAccounts(silent, accountCount = 0) {
  return !silent || Number(accountCount) <= 0;
}

export function mailboxReloadNeedsSession(silent) {
  return !silent;
}

/**
 * Drop duplicate silent/in-flight loads. A user-facing folder or account change
 * (`silent=false`) still starts so the previous request can be abandoned.
 */
export function shouldStartMailboxLoad({
  inFlight = 0,
  silent = false,
  sameQuery = false,
  lastStartedAt = 0,
  now = Date.now(),
  minSilentGapMs = MIN_SILENT_MAILBOX_RELOAD_MS,
} = {}) {
  if (silent && inFlight > 0) return false;
  if (silent && lastStartedAt && now - lastStartedAt < minSilentGapMs) return false;
  if (!silent && inFlight > 0 && sameQuery) return false;
  return true;
}

/** Keep the same state object when the selected account id did not change. */
export function nextActiveAccount(current, nextAccounts = []) {
  const found = Array.isArray(nextAccounts)
    ? nextAccounts.find((item) => item?.id && item.id === current?.id) || null
    : null;
  if ((current?.id || null) === (found?.id || null)) return current ?? null;
  return found;
}
