import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEventLoopWatchdog,
  createTestHistogram,
  watchdogSnapshot,
} from './event-loop-watchdog.js';

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
    histogram: createTestHistogram({ meanMs: 80, maxMs: 120, p99Ms: 90 }),
  });
  const snapshot = watchdog.snapshot({ oldestAgeMs: null });
  assert.equal(snapshot.healthy, false);
  assert.equal(snapshot.eventLoopLagP99Ms, 90);
  watchdog.disable();
});

test('a stall logs in-flight request ids and MCP tool names without waiting on the clock', () => {
  const lines = [];
  const histogram = createTestHistogram({ meanMs: 200, maxMs: 400, p99Ms: 250 });
  const watchdog = createEventLoopWatchdog({
    lagThresholdMs: 50,
    stallLogMs: 100,
    stuckSyncMs: 0,
    histogram,
    logger: { warn(fields, message) { lines.push({ fields, message }); } },
    inFlight: () => [{ reqId: 'req_1', method: 'POST', path: '/mcp', mcpTool: 'get_thread', ageMs: 400 }],
  });
  watchdog.check();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].fields.event, 'event_loop_stall');
  assert.equal(lines[0].fields.inFlight[0].mcpTool, 'get_thread');
  assert.equal(lines[0].fields.inFlight[0].reqId, 'req_1');
  watchdog.disable();
});

test('one stall produces one warning; the next quiet interval is healthy', () => {
  const lines = [];
  const histogram = createTestHistogram({ meanMs: 200, maxMs: 5_784, p99Ms: 5_000 });
  const watchdog = createEventLoopWatchdog({
    lagThresholdMs: 1_500,
    stallLogMs: 3_000,
    stuckSyncMs: 0,
    histogram,
    logger: { warn(fields, message) { lines.push({ fields, message }); } },
    inFlight: () => [],
  });

  const stalled = watchdog.check();
  assert.equal(stalled.healthy, false);
  assert.equal(stalled.eventLoopLagMaxMs, 5_784);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'Event loop stall');

  const quiet = watchdog.check();
  assert.equal(quiet.healthy, true);
  assert.equal(quiet.eventLoopLagMaxMs, 0);
  assert.equal(quiet.eventLoopLagP99Ms, 0);
  assert.equal(lines.length, 1, 'a quiet interval must not repeat the stall warning');

  const health = watchdog.snapshot();
  assert.equal(health.healthy, true);
  assert.equal(health.eventLoopLagMaxMs, 0);
  watchdog.disable();
});

test('health uses the windowed lag so a past stall cannot keep 503', () => {
  const histogram = createTestHistogram({ meanMs: 200, maxMs: 5_784, p99Ms: 5_000 });
  const watchdog = createEventLoopWatchdog({
    lagThresholdMs: 1_500,
    stallLogMs: 3_000,
    histogram,
  });
  const stalled = watchdog.snapshot();
  assert.equal(stalled.healthy, false);
  assert.equal(stalled.eventLoopLagMaxMs, 5_784);

  const next = watchdog.snapshot();
  assert.equal(next.healthy, true);
  assert.equal(next.eventLoopLagMaxMs, 0);
  assert.equal(next.eventLoopLagP99Ms, 0);
  watchdog.disable();
});
