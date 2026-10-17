import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
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

function trackSql(db, executed) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(prepared, method) {
            const value = prepared[method];
            if (['all', 'get', 'run'].includes(method)) return (...args) => {
              executed.push(sql);
              return value.apply(prepared, args);
            };
            return typeof value === 'function' ? value.bind(prepared) : value;
          },
        });
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function isStampScanSql(sql) {
  return /MAX\s*\(\s*(updated_at|synced_at)\s*\)/i.test(sql)
    && /FROM\s+(messages|accounts|sync_state)\b/i.test(sql);
}

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
  assert.equal(listRefetchStamp(next), '0:a');
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

test('the hub only starts while someone is subscribed and does not poll stamps', async () => {
  let stamps = 0;
  const repos = {
    changes: {
      stamp() {
        stamps += 1;
        return { changedAt: '2026-10-17T00:00:00.000Z', messageAt: '2026-10-17T00:00:00.000Z' };
      },
    },
  };
  const hub = createMailboxEventHub({ repos, heartbeatMs: 1_000, bufferSize: 8 });
  const seen = [];
  const stop = hub.subscribe((payload) => seen.push(payload));
  hub.publish('change-version', { changedAt: 'x' });
  assert.equal(seen.at(-1).event, 'change-version');
  assert.equal(seen.at(-1).id, 1);
  const afterSubscribe = stamps;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stamps, afterSubscribe);
  stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stamps, afterSubscribe);
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

test('the event hub does not run SQL on an idle tick', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-hub-idle-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const executed = [];
  const db = trackSql(createDatabase({ dataDir, dbPath: path.join(dataDir, 'mail.sqlite') }), executed);
  const repos = createRepositories(db);
  t.after(() => repos.close());
  const hub = createMailboxEventHub({
    repos,
    mailService: { runtimeStatus: () => ({ inFlight: false }) },
    heartbeatMs: 1_000,
  });
  t.after(() => hub.close());
  executed.length = 0;
  const stop = hub.subscribe(() => {});
  hub.poll();
  hub.poll();
  const scans = executed.filter(isStampScanSql);
  const listing = executed.filter((sql) => /WITH\s+latest/i.test(sql) || /idx_messages_inbox_list/i.test(sql));
  assert.equal(scans.length, 0, scans[0] || 'idle tick scanned MAX(updated_at)');
  assert.equal(listing.length, 0, listing[0] || 'idle tick ran listing SQL');
  stop();
});

test('a writer bump notifies the hub without a stamp poll', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-hub-push-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const repos = createRepositories(createDatabase({ dataDir, dbPath: path.join(dataDir, 'mail.sqlite') }));
  t.after(() => repos.close());
  const hub = createMailboxEventHub({ repos, heartbeatMs: 1_000 });
  t.after(() => hub.close());
  const account = repos.accounts.create({
    email: 'owner@example.test', display_name: 'Owner', avatar_blob: null, avatar_mime: null,
    color: '#1a73e8', provider: 'custom', imap_host: 'imap.example.test', imap_port: 993,
    imap_secure: 1, smtp_host: 'smtp.example.test', smtp_port: 465, smtp_secure: 1,
    credential_ciphertext: 'fixture', signature: '', sync_enabled: 0,
  });
  const thread = repos.threads.create({
    account_id: account.id, subject: 'Hello', normalized_subject: 'hello', latest_at: '2026-10-17T00:00:00.000Z',
  });
  const seen = [];
  hub.subscribe((payload) => seen.push(payload.event));
  repos.messages.upsert({
    account_id: account.id, thread_id: thread.id, mailbox: 'INBOX', uid: 1,
    rfc_message_id: '<push@example.test>', in_reply_to: null, references_json: '[]',
    subject: 'Hello', from_name: '', from_email: 'friend@example.test',
    to_json: '[]', cc_json: '[]', bcc_json: '[]', reply_to_json: null,
    sent_at: '2026-10-17T00:00:00.000Z', received_at: '2026-10-17T00:00:00.000Z',
    html_body: '', text_body: '', snippet: 'Hello', attachments_json: '[]', labels_json: '[]',
    is_read: 0, is_starred: 0, is_archived: 0, is_trashed: 0, is_spam: 0,
    snoozed_until: null, is_sent: 0,
  });
  assert.ok(seen.includes('message.new'));
  assert.ok(seen.includes('change-version'));
});
