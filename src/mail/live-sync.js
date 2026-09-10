import { useEffect, useRef } from 'react';

export const FOCUSED_SYNC_INTERVAL_MS = 60_000;
export const BACKGROUND_SYNC_INTERVAL_MS = 5 * 60_000;
export const MAX_FOCUSED_SYNC_INTERVAL_MS = 10 * 60_000;
// A full sync runs every mailbox of every account over IMAP, so the pause after
// one is scaled to how long it took: the server is never asked to spend more
// than about a third of its time syncing for one open tab.
export const SYNC_DUTY_FACTOR = 2;
// A result the server produced this recently is good enough for a poll; it
// lets a second tab or an agent share one run instead of starting another.
export const LIVE_SYNC_MAX_AGE_SECONDS = 60;

export function mailboxSessionIsActive(doc = globalThis.document) {
  if (!doc || doc.visibilityState !== 'visible') return false;
  if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return false;
  return true;
}

export function nextLiveSyncDelayMs(active, lastDurationMs = 0) {
  const duration = Number.isFinite(lastDurationMs) && lastDurationMs > 0 ? lastDurationMs : 0;
  const paced = duration * SYNC_DUTY_FACTOR;
  if (active) return Math.min(Math.max(FOCUSED_SYNC_INTERVAL_MS, paced), MAX_FOCUSED_SYNC_INTERVAL_MS);
  return Math.max(BACKGROUND_SYNC_INTERVAL_MS, paced);
}

export function createLiveMailboxSync({
  getActive,
  sync,
  setTimeoutFn = (fn, delay) => globalThis.setTimeout(fn, delay),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
  nowFn = () => Date.now(),
} = {}) {
  let timer = 0;
  let stopped = true;
  let running = false;
  let lastDurationMs = 0;

  const stopTimer = () => {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = 0;
  };

  const arm = () => {
    stopTimer();
    if (stopped) return;
    const delay = nextLiveSyncDelayMs(Boolean(getActive?.()), lastDurationMs);
    timer = setTimeoutFn(() => {
      timer = 0;
      void run();
    }, delay);
  };

  const run = async ({ immediate = false } = {}) => {
    if (stopped || running) return;
    running = true;
    stopTimer();
    const startedAt = nowFn();
    try {
      await sync?.({ immediate });
    } finally {
      lastDurationMs = Math.max(0, nowFn() - startedAt);
      running = false;
      if (!stopped) arm();
    }
  };

  return {
    start() {
      stopped = false;
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

export function useLiveMailboxSync({ enabled, onSync }) {
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;

  useEffect(() => {
    if (!enabled) return undefined;

    const controller = createLiveMailboxSync({
      getActive: () => mailboxSessionIsActive(),
      sync: (meta) => onSyncRef.current?.(meta),
    });

    const onSessionChange = () => {
      if (mailboxSessionIsActive()) controller.handleBecameActive();
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
