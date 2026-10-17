import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailboxEventHub,
  eventsForStampChange,
  eventsForSyncFlight,
  replaySince,
} from './mailbox-events.js';

test('stamp deltas emit change-version plus plugin event names', () => {
  const names = (previous, next) => eventsForStampChange(previous, next).map((item) => item.event);
  assert.deepEqual(names(null, { changedAt: null }), []);
  assert.deepEqual(
    names({ changedAt: 'a', messageAt: 'a' }, { changedAt: 'b', messageAt: 'b' }),
    ['change-version', 'new-mail', 'message.new'],
  );
  assert.deepEqual(
    names({ changedAt: 'a', syncAt: 'a' }, { changedAt: 'b', syncAt: 'b' }),
    ['change-version', 'sync-status', 'sync.mailbox'],
  );
  assert.deepEqual(
    names({ changedAt: 'a', accountAt: 'a' }, { changedAt: 'b', accountAt: 'b' }),
    ['change-version', 'account.updated'],
  );
});

test('in-flight flips emit sync-status and sync.mailbox once', () => {
  assert.deepEqual(eventsForSyncFlight(false, false, 't'), []);
  assert.equal(eventsForSyncFlight(false, true, 't')[0].data.state, 'started');
  assert.equal(eventsForSyncFlight(true, false, 't')[0].data.state, 'done');
  assert.deepEqual(eventsForSyncFlight(true, false, 't').map((item) => item.event), ['sync-status', 'sync.mailbox']);
});

test('Last-Event-ID replay reports a gap when the ring has moved on', () => {
  const buffer = [{ id: 10, event: 'change-version', data: { changedAt: 'a' } }];
  assert.deepEqual(replaySince(buffer, '', 10), { gap: false, events: [] });
  assert.equal(replaySince(buffer, '9', 10).gap, true);
  assert.deepEqual(replaySince(buffer, '10', 10).events, []);
  assert.equal(replaySince([], '3', 5).gap, true);
});

test('the hub only polls while someone is subscribed', async () => {
  let stamps = 0;
  const repos = {
    changes: {
      stamp() {
        stamps += 1;
        return { changedAt: '2026-10-17T00:00:00.000Z', messageAt: '2026-10-17T00:00:00.000Z' };
      },
    },
  };
  const hub = createMailboxEventHub({ repos, pollMs: 20, heartbeatMs: 1_000, bufferSize: 8 });
  const seen = [];
  const stop = hub.subscribe((payload) => seen.push(payload));
  hub.publish('change-version', { changedAt: 'x' });
  assert.equal(seen.at(-1).event, 'change-version');
  assert.equal(seen.at(-1).id, 1);
  stop();
  const afterUnsubscribe = stamps;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stamps, afterUnsubscribe);
  hub.close();
});
