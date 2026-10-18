import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventLoopWatchdog, watchdogSnapshot } from './event-loop-watchdog.js';

test('a stuck single-flight past the deadline is reported unhealthy', () => {
  const healthy = watchdogSnapshot({
    histogram: { mean: 0, max: 0, percentile: () => 0 },
    oldestAgeMs: 1_000,
    stuckSyncMs: 120_000,
    lagThresholdMs: 1_500,
  });
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.stuckSync, false);

  const stuck = watchdogSnapshot({
    histogram: { mean: 0, max: 0, percentile: () => 0 },
    oldestAgeMs: 180_000,
    stuckSyncMs: 120_000,
    lagThresholdMs: 1_500,
  });
  assert.equal(stuck.healthy, false);
  assert.equal(stuck.stuckSync, true);
});

test('event-loop lag above the threshold is unhealthy without waiting on the clock', () => {
  const watchdog = createEventLoopWatchdog({
    lagThresholdMs: 50,
    stuckSyncMs: 0,
    histogram: {
      mean: 80 * 1e6,
      max: 120 * 1e6,
      percentile: () => 90 * 1e6,
    },
  });
  const snapshot = watchdog.snapshot({ oldestAgeMs: null });
  assert.equal(snapshot.healthy, false);
  assert.equal(snapshot.eventLoopLagP99Ms, 90);
  watchdog.disable();
});

test('a stall logs in-flight request ids and MCP tool names without waiting on the clock', () => {
  const lines = [];
  const watchdog = createEventLoopWatchdog({
    lagThresholdMs: 50,
    stallLogMs: 100,
    stuckSyncMs: 0,
    histogram: {
      mean: 200 * 1e6,
      max: 400 * 1e6,
      percentile: () => 250 * 1e6,
    },
    logger: { warn(fields, message) { lines.push({ fields, message }); } },
    inFlight: () => [{ reqId: 'req_1', method: 'POST', path: '/mcp', mcpTool: 'get_thread', ageMs: 400 }],
    now: () => 5_000,
  });
  watchdog.check();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].fields.event, 'event_loop_stall');
  assert.equal(lines[0].fields.inFlight[0].mcpTool, 'get_thread');
  assert.equal(lines[0].fields.inFlight[0].reqId, 'req_1');
  watchdog.check();
  assert.equal(lines.length, 1, 'stall logs are rate-limited');
  watchdog.disable();
});
