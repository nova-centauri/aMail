import { useEffect, useRef } from 'react';

export const FOCUSED_SYNC_INTERVAL_MS = 20_000;
export const BACKGROUND_SYNC_INTERVAL_MS = 5 * 60_000;
export const MAX_FOCUSED_SYNC_INTERVAL_MS = 10 * 60_000;
export const MIN_ERROR_BACKOFF_MS = 2_000;
export const MAX_ERROR_BACKOFF_MS = 5 * 60_000;
// A focused tick reads the local change stamp. The server imports new mail
// over IMAP IDLE and a UIDNEXT probe, so this timer does not start an IMAP
// pass. If a tick does run long, the next pause scales with it.
export const SYNC_DUTY_FACTOR = 2;
// A result the server produced this recently is good enough for a poll; it
// lets a second tab or an agent share one run instead of starting another.
export const LIVE_SYNC_MAX_AGE_SECONDS = 60;

export function isUnauthorizedStatus(status) {
  return status === 401 || status === 403;
}

export function isUnauthorizedError(error) {
  return isUnauthorizedStatus(error?.status);
}

export function mailboxSessionIsVisible(doc = globalThis.document) {
  return Boolean(doc && doc.visibilityState === 'visible');
}

export function mailboxSessionIsActive(doc = globalThis.document) {
  if (!mailboxSessionIsVisible(doc)) return false;
  if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return false;
  return true;
}

export function errorBackoffMs(failures = 1, random = Math.random) {
  const attempt = Math.max(1, Number(failures) || 1);
  const exp = Math.min(MAX_ERROR_BACKOFF_MS, MIN_ERROR_BACKOFF_MS * (2 ** (attempt - 1)));
  const jitter = exp * 0.2 * ((Number(random()) || 0) * 2 - 1);
  return Math.round(Math.min(MAX_ERROR_BACKOFF_MS, Math.max(MIN_ERROR_BACKOFF_MS, exp + jitter)));
}

export function nextLiveSyncDelayMs(visibility, lastDurationMs = 0, { failures = 0, random = Math.random } = {}) {
  const state = visibility === true ? 'focused' : visibility === false ? 'hidden' : visibility;
  if (state === 'hidden' || state == null) return null;
  if (failures > 0) return errorBackoffMs(failures, random);
  const duration = Number.isFinite(lastDurationMs) && lastDurationMs > 0 ? lastDurationMs : 0;
  const paced = duration * SYNC_DUTY_FACTOR;
  if (state === 'focused' || state === true) {
    return Math.min(Math.max(FOCUSED_SYNC_INTERVAL_MS, paced), MAX_FOCUSED_SYNC_INTERVAL_MS);
  }
  return Math.max(BACKGROUND_SYNC_INTERVAL_MS, paced);
}

export function createLiveMailboxSync({
  getVisible,
  getActive,
  sync,
  onUnauthorized,
  setTimeoutFn = (fn, delay) => globalThis.setTimeout(fn, delay),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
  nowFn = () => Date.now(),
  random = Math.random,
} = {}) {
  let timer = 0;
  let stopped = true;
  let running = false;
  let lastDurationMs = 0;
  let failures = 0;

  const visibility = () => {
    const visible = typeof getVisible === 'function' ? getVisible() : true;
    if (!visible) return 'hidden';
    if (typeof getActive === 'function') return getActive() ? 'focused' : 'visible';
    return 'focused';
  };

  const stopTimer = () => {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = 0;
  };

  const arm = () => {
    stopTimer();
    if (stopped) return;
    const delay = nextLiveSyncDelayMs(visibility(), lastDurationMs, { failures, random });
    if (delay == null) return;
    timer = setTimeoutFn(() => {
      timer = 0;
      void run();
    }, delay);
  };

  const run = async ({ immediate = false } = {}) => {
    if (stopped || running) return;
    if (!immediate && visibility() === 'hidden') return;
    running = true;
    stopTimer();
    const startedAt = nowFn();
    try {
      await sync?.({ immediate });
      failures = 0;
    } catch (error) {
      if (isUnauthorizedError(error)) {
        stopped = true;
        onUnauthorized?.(error);
      } else {
        failures += 1;
      }
    } finally {
      lastDurationMs = Math.max(0, nowFn() - startedAt);
      running = false;
      if (!stopped) arm();
    }
  };

  return {
    start() {
      stopped = false;
      failures = 0;
      void run({ immediate: true });
    },
    handleBecameActive() {
      if (stopped) return;
      void run({ immediate: true });
    },
    handleBecameInactive() {
      if (stopped || running) return;
      arm();
    },
    stop() {
      stopped = true;
      stopTimer();
    },
  };
}

export function useLiveMailboxSync({ enabled, onSync, onUnauthorized }) {
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    if (!enabled) return undefined;

    const controller = createLiveMailboxSync({
      getVisible: () => mailboxSessionIsVisible(),
      getActive: () => mailboxSessionIsActive(),
      sync: (meta) => onSyncRef.current?.(meta),
      onUnauthorized: (error) => onUnauthorizedRef.current?.(error),
    });

    const onSessionChange = () => {
      if (mailboxSessionIsVisible()) controller.handleBecameActive();
      else controller.handleBecameInactive();
    };

    document.addEventListener('visibilitychange', onSessionChange);
    window.addEventListener('focus', onSessionChange);
    window.addEventListener('pageshow', onSessionChange);
    window.addEventListener('blur', onSessionChange);
    controller.start();

    return () => {
      controller.stop();
      document.removeEventListener('visibilitychange', onSessionChange);
      window.removeEventListener('focus', onSessionChange);
      window.removeEventListener('pageshow', onSessionChange);
      window.removeEventListener('blur', onSessionChange);
    };
  }, [enabled]);
}
