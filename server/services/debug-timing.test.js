import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhaseTimer, debugTimingEnabled } from './debug-timing.js';

test('debug timing is off unless DEBUG_TIMING or CPU_PROF is set', () => {
  assert.equal(debugTimingEnabled({}), false);
  assert.equal(debugTimingEnabled({ debugTiming: true }), true);
  assert.equal(debugTimingEnabled({ cpuProf: true }), true);
});

test('phase timer records deltas without waiting on a clock', () => {
  let now = 0n;
  const logged = [];
  const timer = createPhaseTimer({
    enabled: true,
    now: () => now,
    logger: { info(fields) { logged.push(fields); } },
    label: 'probe',
  });
  now = 2_000_000n;
  timer.mark('stamp');
  now = 5_000_000n;
  timer.mark('list');
  timer.log({ path: '/api/messages' });
  assert.equal(logged[0].event, 'debug_timing');
  assert.equal(logged[0].label, 'probe');
  assert.deepEqual(logged[0].phases.map((item) => item.phase), ['stamp', 'list']);
});
