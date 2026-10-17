import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bumpChangeStamp,
  createChangeVersionStore,
  emptyChangeStamp,
  listCacheToken,
  mergeChangeStamp,
} from './change-version.js';

test('a content bump increments the version; a sync-cursor bump does not', () => {
  const started = emptyChangeStamp();
  const message = bumpChangeStamp(started, 'message', '2026-10-17T18:00:00.000Z');
  assert.equal(message.version, 1);
  assert.equal(message.messageAt, '2026-10-17T18:00:00.000Z');
  assert.equal(listCacheToken(message), '1:2026-10-17T18:00:00.000Z');

  const synced = bumpChangeStamp(message, 'sync', '2026-10-17T18:01:00.000Z');
  assert.equal(synced.version, 1);
  assert.equal(synced.syncAt, '2026-10-17T18:01:00.000Z');
  assert.equal(listCacheToken(synced), listCacheToken(message));
});

test('the in-memory store notifies listeners without a SQL loader on bump', () => {
  const rows = [];
  const seen = [];
  const store = createChangeVersionStore({
    load: () => null,
    persist: (row) => rows.push({ ...row }),
    now: () => '2026-10-17T18:02:00.000Z',
  });
  store.subscribe((stamp) => seen.push(stamp.version));
  store.bump('message');
  assert.deepEqual(seen, [1]);
  assert.equal(store.stamp().messageAt, '2026-10-17T18:02:00.000Z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 1);
  const worker = store.applyRemote({
    version: 4,
    messageAt: '2026-10-17T18:03:00.000Z',
    syncAt: null,
    accountAt: null,
  });
  assert.equal(worker.version, 4);
  assert.deepEqual(seen, [1, 4]);
});

test('mergeChangeStamp keeps the later timestamps and the higher version', () => {
  const merged = mergeChangeStamp(
    { version: 2, messageAt: 'a', syncAt: 's1', accountAt: null, changedAt: 's1' },
    { version: 9, messageAt: 'b', syncAt: null, accountAt: 'c', changedAt: 'c' },
  );
  assert.equal(merged.version, 9);
  assert.equal(merged.messageAt, 'b');
  assert.equal(merged.accountAt, 'c');
  assert.equal(merged.syncAt, 's1');
});
