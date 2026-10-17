import assert from 'node:assert/strict';
import test from 'node:test';
import { compareModseq, planMailboxSync, uidPages } from './mailbox-sync-plan.js';

test('periodic sync does not refetch already-synced UIDs', () => {
  const caughtUp = planMailboxSync({
    lastUid: 40,
    uidValidity: 7,
    previousUidValidity: 7,
    uidNext: 41,
    limit: 200,
    mode: 'incremental',
  });
  assert.equal(caughtUp.kind, 'unchanged');
  assert.equal(caughtUp.reason, 'uidnext');
  assert.equal(caughtUp.firstUid, null);

  const burst = planMailboxSync({
    lastUid: 10,
    uidValidity: 7,
    previousUidValidity: 7,
    uidNext: 23,
    limit: 5,
    mode: 'incremental',
  });
  assert.equal(burst.kind, 'new-uids');
  assert.equal(burst.firstUid, 11);
  assert.equal(burst.endUid, 22);
  assert.deepEqual(uidPages(burst.firstUid, burst.endUid, 5), [
    { firstUid: 11, endUid: 15 },
    { firstUid: 16, endUid: 20 },
    { firstUid: 21, endUid: 22 },
  ]);
});

test('a never-synced mailbox still imports only the newest page on an incremental pass', () => {
  const first = planMailboxSync({
    lastUid: 0,
    uidValidity: 3,
    previousUidValidity: null,
    uidNext: 13,
    limit: 5,
    mode: 'incremental',
  });
  assert.equal(first.kind, 'initial');
  assert.equal(first.reason, 'first-sync');
  assert.equal(first.firstUid, 8);
  assert.equal(first.endUid, 12);
});

test('a first window and a UIDVALIDITY change import only the newest page', () => {
  const initial = planMailboxSync({
    lastUid: 0,
    uidValidity: 3,
    previousUidValidity: null,
    uidNext: 13,
    limit: 5,
    mode: 'full',
  });
  assert.equal(initial.kind, 'initial');
  assert.equal(initial.firstUid, 8);
  assert.equal(initial.endUid, 12);

  const rotated = planMailboxSync({
    lastUid: 999,
    uidValidity: 4,
    previousUidValidity: 3,
    uidNext: 13,
    limit: 5,
    mode: 'incremental',
  });
  assert.equal(rotated.uidValidityChanged, true);
  assert.equal(rotated.resetCursor, true);
  assert.equal(rotated.firstUid, 8);
  assert.equal(rotated.endUid, 12);
});

test('CONDSTORE flag catch-up runs only when UIDNEXT is unchanged and MODSEQ moved', () => {
  const flags = planMailboxSync({
    lastUid: 10,
    uidValidity: 1,
    previousUidValidity: 1,
    uidNext: 11,
    mode: 'incremental',
    mailboxModseq: '90',
    previousModseq: '40',
  });
  assert.equal(flags.kind, 'flags');
  assert.equal(flags.changedSince, '40');
  assert.equal(compareModseq('90', '40') > 0, true);

  const still = planMailboxSync({
    lastUid: 10,
    uidValidity: 1,
    previousUidValidity: 1,
    uidNext: 11,
    mode: 'incremental',
    mailboxModseq: '40',
    previousModseq: '40',
  });
  assert.equal(still.kind, 'unchanged');
});
