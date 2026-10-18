import assert from 'node:assert/strict';
import test from 'node:test';
import { nextProxyCooldown } from './remote-content.js';

test('the privacy proxy cools down after repeated failures so mail is not delayed', () => {
  const first = nextProxyCooldown({ failures: 0, now: 1_000 });
  assert.equal(first.failures, 1);
  assert.equal(first.coolingUntil, 0);
  const third = nextProxyCooldown({ failures: 2, now: 1_000, cooldownMs: 60_000 });
  assert.equal(third.failures, 3);
  assert.equal(third.coolingUntil, 61_000);
});
