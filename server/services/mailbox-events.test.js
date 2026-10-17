import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAILBOX_EVENT_COALESCE_MS,
  createMailboxEventHub,
  createRefetchCoalescer,
  eventsForStampChange,
  eventsForSyncFlight,
  listRefetchStamp,
  mergeCoalescedEvents,
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
    names({ changedAt: 'a', accountAt: 'a' }, { changedAt: 'b', accountAt: 'b' }),
    ['change-version', 'account.updated'],
  );
});

test('sync-cursor-only stamp changes do not emit refetch events', () => {
  const previous = { changedAt: 'a', messageAt: 'a', syncAt: 'a', accountAt: null };
  const next = { changedAt: 'b', messageAt: 'a', syncAt: 'b', accountAt: null };
  assert.equal(listRefetchStamp(next), 'a');
  assert.notEqual(next.changedAt, next.messageAt);
  assert.deepEqual(eventsForStampChange(previous, next), []);
  assert.deepEqual(eventsForStampChange(null, { changedAt: 's', syncAt: 's' }), []);
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

test('coalescer emits the first burst immediately and at most one flush per interval', () => {
  assert.equal(MAILBOX_EVENT_COALESCE_MS, 15_000);
  let now = 1_000;
  const published = [];
  const scheduled = [];
  const coalescer = createRefetchCoalescer({
    intervalMs: 15_000,
    now: () => now,
    schedule(fn, ms) {
      const entry = { fn, at: now + ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    publish(event, data) {
      published.push({ event, data });
    },
  });

  coalescer.enqueue([
    { event: 'change-version', data: { changedAt: 't1' } },
    { event: 'message.new', data: { changedAt: 't1' } },
    { event: 'sync.mailbox', data: { changedAt: 't1' } },
  ]);
  assert.deepEqual(published.map((item) => item.event), ['change-version', 'message.new', 'sync.mailbox']);

  coalescer.enqueue([
    { event: 'change-version', data: { changedAt: 't2' } },
    { event: 'message.new', data: { changedAt: 't2' } },
    { event: 'sync.mailbox', data: { changedAt: 't2' } },
  ]);
  coalescer.enqueue({ event: 'message.new', data: { changedAt: 't3' } });
  assert.equal(published.length, 3);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].at, 16_000);

  now = 16_000;
  scheduled[0].fn();
  assert.equal(published.filter((item) => item.event === 'message.new').length, 2);
  assert.equal(published.findLast((item) => item.event === 'message.new').data.changedAt, 't3');
  assert.deepEqual(
    mergeCoalescedEvents([
      { event: 'message.new', data: { changedAt: 'a' } },
      { event: 'message.new', data: { changedAt: 'b' } },
    ]),
    [{ event: 'message.new', data: { changedAt: 'b' } }],
  );
  coalescer.close();
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

test('the hub coalesces stamp ticks and ignores cursor-only progress', () => {
  let now = 0;
  const scheduled = [];
  const stamp = {
    changedAt: 't0',
    messageAt: 't0',
    syncAt: 't0',
    accountAt: null,
  };
  const repos = { changes: { stamp: () => ({ ...stamp }) } };
  const hub = createMailboxEventHub({
    repos,
    pollMs: 60_000,
    heartbeatMs: 1_000,
    coalesceMs: 15_000,
    now: () => now,
    schedule(fn, ms) {
      const entry = { fn, at: now + ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  const seen = [];
  hub.subscribe((payload) => seen.push(payload.event));

  stamp.syncAt = 's1';
  stamp.changedAt = 's1';
  hub.poll();
  assert.deepEqual(seen, []);

  stamp.messageAt = 'm1';
  stamp.changedAt = 'm1';
  hub.poll();
  assert.ok(seen.includes('message.new'));
  assert.ok(seen.includes('change-version'));
  const afterFirst = seen.length;

  stamp.messageAt = 'm2';
  stamp.changedAt = 'm2';
  stamp.syncAt = 's2';
  hub.poll();
  stamp.messageAt = 'm3';
  stamp.changedAt = 'm3';
  hub.poll();
  assert.equal(seen.length, afterFirst);

  now = 15_000;
  for (const entry of scheduled) {
    if (!entry.cancelled) entry.fn();
  }
  assert.equal(seen.filter((event) => event === 'message.new').length, 2);
  assert.ok(seen.length - afterFirst <= 3);
  hub.close();
});
