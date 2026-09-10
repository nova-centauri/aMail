import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_SYNC_INTERVAL_MS,
  FOCUSED_SYNC_INTERVAL_MS,
  LIVE_SYNC_MAX_AGE_SECONDS,
  MAX_FOCUSED_SYNC_INTERVAL_MS,
  SYNC_DUTY_FACTOR,
  createLiveMailboxSync,
  mailboxSessionIsActive,
  nextLiveSyncDelayMs,
} from './live-sync.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  it('polls quickly while focused and relaxes in the background', () => {
    expect(nextLiveSyncDelayMs(true)).toBe(FOCUSED_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs(false)).toBe(BACKGROUND_SYNC_INTERVAL_MS);
    expect(FOCUSED_SYNC_INTERVAL_MS).toBe(60_000);
    expect(LIVE_SYNC_MAX_AGE_SECONDS).toBe(60);
    expect(BACKGROUND_SYNC_INTERVAL_MS).toBe(5 * 60_000);
  });

  it('paces a slow sync so the server is not kept syncing back to back', () => {
    expect(nextLiveSyncDelayMs(true, 3_000)).toBe(FOCUSED_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs(true, 60_000)).toBe(60_000 * SYNC_DUTY_FACTOR);
    expect(nextLiveSyncDelayMs(true, 60 * 60_000)).toBe(MAX_FOCUSED_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs(false, 60_000)).toBe(BACKGROUND_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs(false, 10 * 60_000)).toBe(10 * 60_000 * SYNC_DUTY_FACTOR);
    expect(nextLiveSyncDelayMs(true, Number.NaN)).toBe(FOCUSED_SYNC_INTERVAL_MS);
    expect(nextLiveSyncDelayMs(true, -5)).toBe(FOCUSED_SYNC_INTERVAL_MS);
  });
});

describe('createLiveMailboxSync', () => {
  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('checks inboxes immediately, then on the focused interval', async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => {});
    const active = { value: true };
    const controller = createLiveMailboxSync({
      getActive: () => active.value,
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

  it('slows down while inactive and syncs again as soon as focus returns', async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => {});
    const active = { value: true };
    const controller = createLiveMailboxSync({
      getActive: () => active.value,
      sync,
    });

    controller.start();
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);

    active.value = false;
    controller.handleBecameInactive();
    await vi.advanceTimersByTimeAsync(FOCUSED_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BACKGROUND_SYNC_INTERVAL_MS - FOCUSED_SYNC_INTERVAL_MS);
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);

    active.value = true;
    controller.handleBecameActive();
    await flush();
    expect(sync).toHaveBeenCalledTimes(3);
    expect(sync).toHaveBeenLastCalledWith({ immediate: true });

    controller.stop();
  });

  it('waits longer after a sync that took a long time', async () => {
    vi.useFakeTimers();
    const syncDuration = 60_000;
    const sync = vi.fn(() => new Promise((resolve) => { setTimeout(resolve, syncDuration); }));
    const controller = createLiveMailboxSync({
      getActive: () => true,
      sync,
    });

    controller.start();
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(syncDuration);
    await flush();

    // The old fixed interval would have fired here.
    await vi.advanceTimersByTimeAsync(FOCUSED_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(syncDuration * SYNC_DUTY_FACTOR - FOCUSED_SYNC_INTERVAL_MS);
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);

    controller.stop();
  });

  it('does not overlap in-flight syncs', async () => {
    vi.useFakeTimers();
    let resolveSync;
    const sync = vi.fn(() => new Promise((resolve) => { resolveSync = resolve; }));
    const controller = createLiveMailboxSync({
      getActive: () => true,
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
});
