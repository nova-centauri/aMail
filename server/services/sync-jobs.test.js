import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyncJobBoard, mcpEnqueueStatus, publicSyncJob } from './sync-jobs.js';

test('mcpEnqueueStatus maps in-flight work to already_running', () => {
  assert.equal(mcpEnqueueStatus('started'), 'queued');
  assert.equal(mcpEnqueueStatus('queued'), 'queued');
  assert.equal(mcpEnqueueStatus('in-flight'), 'already_running');
  assert.equal(mcpEnqueueStatus('recent'), 'already_running');
  assert.equal(mcpEnqueueStatus('cooling'), 'already_running');
});

test('the job board stores a pollable snapshot and caps history', () => {
  let now = 1_000;
  const board = createSyncJobBoard({ now: () => now });
  const first = board.create({ kind: 'all' });
  assert.match(first.id, /^sync_1_/);
  assert.equal(first.status, 'queued');
  board.finish(first, { status: 'done', result: { accounts: 1 } });
  assert.equal(board.get(first.id).status, 'done');
  assert.equal(publicSyncJob(first).jobId, first.id);
  assert.equal(board.latest().id, first.id);

  for (let index = 0; index < 40; index += 1) {
    now += 1;
    board.create({ kind: 'account', accountId: `a${index}` });
  }
  assert.equal(board.get(first.id), null);
  assert.ok(board.latest());
});
