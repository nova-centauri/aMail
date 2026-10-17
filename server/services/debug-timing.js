/**
 * Opt-in phase logs so production can see which slice of a request or IMAP
 * pass actually burned the event loop. Enable with AMAIL_DEBUG_TIMING=1 or
 * AMAIL_CPU_PROF=1 (the latter also asks the entrypoint to add --cpu-prof).
 */

export function debugTimingEnabled(config = {}) {
  return Boolean(config.debugTiming || config.cpuProf);
}

export function createPhaseTimer({ enabled = false, logger = null, now = () => process.hrtime.bigint(), label = 'timing' } = {}) {
  const started = now();
  const marks = [];

  function msSince(from) {
    return Number(now() - from) / 1e6;
  }

  return {
    enabled: Boolean(enabled),
    mark(phase) {
      const at = now();
      const elapsedMs = msSince(started);
      const last = marks.at(-1);
      const deltaMs = last ? msSince(last.at) : elapsedMs;
      const entry = { phase, elapsedMs, deltaMs, at };
      marks.push(entry);
      return entry;
    },
    snapshot() {
      return {
        label,
        totalMs: msSince(started),
        phases: marks.map((item) => ({
          phase: item.phase,
          elapsedMs: Math.round(item.elapsedMs * 10) / 10,
          deltaMs: Math.round(item.deltaMs * 10) / 10,
        })),
      };
    },
    log(extra = {}) {
      if (!enabled || !logger?.info) return;
      logger.info({ event: 'debug_timing', ...this.snapshot(), ...extra }, label);
    },
  };
}
