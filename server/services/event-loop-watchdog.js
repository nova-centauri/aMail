import { monitorEventLoopDelay } from 'node:perf_hooks';
import { globalInFlight } from './in-flight-requests.js';

export const DEFAULT_EVENT_LOOP_LAG_MS = 1_500;
export const DEFAULT_STALL_LOG_MS = 3_000;

function nsToMs(value) {
  return Math.round((Number(value) || 0) / 1e6);
}

export function watchdogSnapshot({
  histogram = null,
  oldestAgeMs = null,
  stuckSyncMs = 0,
  lagThresholdMs = DEFAULT_EVENT_LOOP_LAG_MS,
} = {}) {
  const lagMeanMs = histogram ? nsToMs(histogram.mean) : 0;
  const lagP99Ms = histogram && typeof histogram.percentile === 'function'
    ? nsToMs(histogram.percentile(99))
    : lagMeanMs;
  const lagMaxMs = histogram ? nsToMs(histogram.max) : 0;
  const stuckSync = Number(stuckSyncMs) > 0
    && oldestAgeMs != null
    && Number(oldestAgeMs) > Number(stuckSyncMs);
  const lagHigh = lagP99Ms > Number(lagThresholdMs);
  return {
    eventLoopLagMs: lagMeanMs,
    eventLoopLagP99Ms: lagP99Ms,
    eventLoopLagMaxMs: lagMaxMs,
    lagThresholdMs: Number(lagThresholdMs) || DEFAULT_EVENT_LOOP_LAG_MS,
    stuckSync,
    stuckSyncMs: Number(stuckSyncMs) || 0,
    healthy: !lagHigh && !stuckSync,
  };
}

/** Mutable histogram for tests: one stall, then reset() clears the window. */
export function createTestHistogram({ meanMs = 0, maxMs = 0, p99Ms = 0 } = {}) {
  const toNs = (ms) => Number(ms) * 1e6;
  const state = { meanMs, maxMs, p99Ms };
  return {
    get mean() { return toNs(state.meanMs); },
    get max() { return toNs(state.maxMs); },
    percentile() { return toNs(state.p99Ms); },
    reset() {
      state.meanMs = 0;
      state.maxMs = 0;
      state.p99Ms = 0;
    },
  };
}

/**
 * Event-loop lag for /api/health. Does not query SQLite or take IMAP locks.
 * Each sample is the delay since the last sample; the histogram is reset so a
 * past stall cannot keep health at 503 or spam stall warnings.
 * Tests inject a histogram so they never wait on a real delay.
 */
export function createEventLoopWatchdog({
  lagThresholdMs = DEFAULT_EVENT_LOOP_LAG_MS,
  stuckSyncMs = 0,
  stallLogMs = DEFAULT_STALL_LOG_MS,
  histogram = null,
  enable = false,
  logger = null,
  inFlight = () => globalInFlight.list(),
  scheduleInterval = null,
} = {}) {
  const owned = !histogram;
  const h = histogram || monitorEventLoopDelay({ resolution: 20 });
  if (owned && enable && typeof h.enable === 'function') h.enable();
  let cancelInterval = () => {};

  function sample({ oldestAgeMs = null } = {}) {
    const snap = watchdogSnapshot({
      histogram: h,
      oldestAgeMs,
      stuckSyncMs,
      lagThresholdMs,
    });
    if (typeof h.reset === 'function') h.reset();
    return snap;
  }

  function check({ oldestAgeMs = null } = {}) {
    const snap = sample({ oldestAgeMs });
    const stallMs = Number(stallLogMs) || DEFAULT_STALL_LOG_MS;
    const stalled = snap.eventLoopLagMaxMs >= stallMs
      || snap.eventLoopLagP99Ms >= stallMs
      || snap.stuckSync;
    if (stalled && logger?.warn) {
      const inflight = typeof inFlight === 'function' ? inFlight() : inFlight;
      logger.warn({
        event: 'event_loop_stall',
        ...snap,
        inFlight: inflight,
      }, 'Event loop stall');
    }
    return snap;
  }

  if (enable) {
    const tickMs = Math.min(1_000, Math.max(200, Number(stallLogMs) || DEFAULT_STALL_LOG_MS));
    if (typeof scheduleInterval === 'function') {
      cancelInterval = scheduleInterval(tickMs, () => check()) || (() => {});
    } else {
      const timer = setInterval(() => check(), tickMs);
      timer.unref?.();
      cancelInterval = () => clearInterval(timer);
    }
  }

  return {
    snapshot: sample,
    check,
    disable() {
      cancelInterval();
      if (owned && typeof h.disable === 'function') h.disable();
    },
  };
}
