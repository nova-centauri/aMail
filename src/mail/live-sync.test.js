import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_SYNC_INTERVAL_MS,
  FOCUSED_SYNC_INTERVAL_MS,
  LIVE_SYNC_MAX_AGE_SECONDS,
  MAX_ERROR_BACKOFF_MS,
  MAX_FOCUSED_SYNC_INTERVAL_MS,
  MIN_ERROR_BACKOFF_MS,
  SYNC_DUTY_FACTOR,
  createLiveMailboxSync,
  errorBackoffMs,
  isUnauthorizedError,
  mailboxSessionIsActive,
  mailboxSessionIsVisible,
  nextLiveSyncDelayMs,
} from './live-sync.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mailboxSessionIsVisible', () => {
  it('follows document visibility and does not require focus', () => {
    expect(mailboxSessionIsVisible({ visibilityState: 'visible', hasFocus: () => false })).toBe(true);
    expect(mailboxSessionIsVisible({ visibilityState: 'hidden', hasFocus: () => true })).toBe(false);
    expect(mailboxSessionIsVisible(null)).toBe(false);
  });
});

describe('mailboxSessionIsActive', () => {
  it('requires a visible, focused document', () => {
    expect(mailboxSessionIsActive({ visibilityState: 'visible', hasFocus: () => true })).toBe(true);
    expect(mailboxSessionIsActive({ visibilityState: 'hidden', hasFocus: () => true })).toBe(false);
    expect(mailboxSessionIsActive({ visibilityState: 'visible', hasFocus: () => false })).toBe(false);
    expect(mailboxSessionIsActive(null)).toBe(false);
  });
});

describe('nextLiveSyncDelayMs', () => {
  it('polls on a sane focused interval and pauses while hidden', () => {
    expect(nextLiveSyncDelayMs('focused')).toBe(FOCUSED_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs(true)).toBe(FOCUSED_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs('hidden')).toBeNull();
    expect(nextLiveSyncDelayMs(false)).toBeNull();
    expect(FOCUSED_SYNC_INTERVAL_MS).toBe(20_000);
    expect(LIVE_SYNC_MAX_AGE_SECONDS).toBe(60);
    expect(BACKGROUND_SYNC_INTERVAL_MS).toBe(5 * 60_000);
  });

  it('paces a slow tick so the inbox is not reloaded back to back', () => {
    expect(nextLiveSyncDelayMs('focused', 3_000)).toBe(FOCUSED_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs('focused', 60_000)).toBe(60_000 * SYNC_DUTY_FACTOR);
    expect(nextLiveSyncDelayMs('focused', 60 * 60_000)).toBe(MAX_FOCUSED_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs('visible', 60_000)).toBe(BACKGROUND_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs('visible', 10 * 60_000)).toBe(10 * 60_000 * SYNC_DUTY_FACTOR);
    expect(nextLiveSyncDelayMs('focused', Number.NaN)).toBe(FOCUSED_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs('focused', -5)).toBe(FOCUSED_SYNC_INTERVAL_MS);
  });

  it('backs off exponentially with jitter after errors', () => {
    expect(errorBackoffMs(1, () => 0.5)).toBe(MIN_ERROR_BACKOFF_MS);
    expect(errorBackoffMs(2, () => 0.5)).toBe(4_000);
    expect(errorBackoffMs(20, () => 0.5)).toBe(MAX_ERROR_BACKOFF_MS);
    expect(nextLiveSyncDelayMs('focused', 0, { failures: 3, random: () => 0.5 })).toBe(8_000);
    const low = errorBackoffMs(3, () => 0);
    const high = errorBackoffMs(3, () => 1);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(MIN_ERROR_BACKOFF_MS);
  });
});

describe('createLiveMailboxSync', () => {
  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('checks inboxes immediately, then on the focused interval', async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => {});
    const visible = { value: true };
    const controller = createLiveMailboxSync({
      getVisible: () => visible.value,
      sync,
    });

    controller.start();
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenLastCalledWith({ immediate: true });

    await vi.advanceTimersByTimeAsync(FOCUSED_SYNC_INTERVAL_MS - 1);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);

    controller.stop();
    await vi.advanceTimersByTimeAsync(FOCUSED_SYNC_INTERVAL_MS * 2);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('pauses while hidden and syncs again as soon as the tab is visible', async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => {});
    const visible = { value: true };
    const controller = createLiveMailboxSync({
      getVisible: () => visible.value,
      sync,
    });

    controller.start();
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);

    visible.value = false;
    controller.handleBecameInactive();
    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(1);

    visible.value = true;
    controller.handleBecameActive();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith({ immediate: true });

    controller.stop();
  });

  it('waits longer after a tick that took a long time', async () => {
    vi.useFakeTimers();
    const syncDuration = 60_000;
    const sync = vi.fn(() => new Promise((resolve) => { setTimeout(resolve, syncDuration); }));
    const controller = createLiveMailboxSync({
      getVisible: () => true,
      sync,
    });

    controller.start();
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(syncDuration);
    await flush();

    await vi.advanceTimersByTimeAsync(FOCUSED_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(syncDuration * SYNC_DUTY_FACTOR - FOCUSED_SYNC_INTERVAL_MS);
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);

    controller.stop();
  });

  it('does not overlap in-flight ticks', async () => {
    vi.useFakeTimers();
    let resolveSync;
    const sync = vi.fn(() => new Promise((resolve) => { resolveSync = resolve; }));
    const controller = createLiveMailboxSync({
      getVisible: () => true,
      sync,
    });

    controller.start();
    await flush();
    controller.handleBecameActive();
    controller.handleBecameActive();
    expect(sync).toHaveBeenCalledTimes(1);

    resolveSync();
    await flush();
    controller.stop();
  });

  it('stops on 401 and does not schedule another tick', async () => {
    vi.useFakeTimers();
    const onUnauthorized = vi.fn();
    const sync = vi.fn(async () => {
      const error = new Error('Unauthorized');
      error.status = 401;
      throw error;
    });
    const controller = createLiveMailboxSync({
      getVisible: () => true,
      sync,
      onUnauthorized,
    });

    controller.start();
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(isUnauthorizedError({ status: 401 })).toBe(true);

    await vi.advanceTimersByTimeAsync(MAX_ERROR_BACKOFF_MS);
    expect(sync).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('uses exponential backoff after a timeout and does not overlap the retry', async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => {
      const error = new Error('The operation was aborted');
      error.status = 0;
      throw error;
    });
    const controller = createLiveMailboxSync({
      getVisible: () => true,
      sync,
      random: () => 0.5,
    });

    controller.start();
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_ERROR_BACKOFF_MS - 1);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);

    controller.stop();
  });
});
