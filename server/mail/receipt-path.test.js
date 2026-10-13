import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INBOX_PROBE_INTERVAL_MS,
  backgroundReceiptPlan,
  imapAutoIdleEnabled,
  transportProxyDecision,
} from './receipt-path.js';

test('IMAP and SMTP stay off the privacy proxy; only remote images may use it', () => {
  const tor = transportProxyDecision({ remoteContentProxyUrl: 'http://tor-proxy:8118' });
  assert.equal(tor.imap, null);
  assert.equal(tor.smtp, null);
  assert.equal(tor.remoteContent, 'http://tor-proxy:8118');

  const direct = transportProxyDecision({});
  assert.equal(direct.imap, null);
  assert.equal(direct.smtp, null);
  assert.equal(direct.remoteContent, null);
  assert.equal(transportProxyDecision({ remoteContentProxyUrl: '   ' }).remoteContent, null);
});

test('new inbox mail is probed every minute; the full-folder interval is only the slow pass', () => {
  assert.equal(backgroundReceiptPlan({ syncIntervalMinutes: 0 }).enabled, false);
  assert.equal(backgroundReceiptPlan({ syncIntervalMinutes: 0 }).inboxProbeMs, 0);
  assert.equal(backgroundReceiptPlan({}).enabled, false);

  const hosted = backgroundReceiptPlan({ syncIntervalMinutes: 15 });
  assert.equal(hosted.enabled, true);
  assert.equal(hosted.preferIdle, true);
  assert.equal(hosted.inboxProbeMs, INBOX_PROBE_INTERVAL_MS);
  assert.equal(hosted.inboxProbeMs, 60_000);
  assert.equal(hosted.fullSyncMs, 15 * 60_000);
  assert.ok(hosted.inboxProbeMs < hosted.fullSyncMs);

  const selfHosted = backgroundReceiptPlan({ syncIntervalMinutes: 5 });
  assert.equal(selfHosted.inboxProbeMs, 60_000);
  assert.equal(selfHosted.fullSyncMs, 5 * 60_000);
  assert.ok(selfHosted.inboxProbeMs < selfHosted.fullSyncMs);
});

test('pooled connections prefer IMAP IDLE, one-shot connections and non-IDLE servers do not', () => {
  assert.equal(imapAutoIdleEnabled({ pooled: true }), true);
  assert.equal(imapAutoIdleEnabled({ pooled: true, capabilities: null }), true);
  assert.equal(imapAutoIdleEnabled({ pooled: true, capabilities: new Set(['IMAP4rev1', 'IDLE']) }), true);
  assert.equal(imapAutoIdleEnabled({ pooled: true, capabilities: new Map([['IMAP4rev1', true], ['IDLE', true]]) }), true);
  assert.equal(imapAutoIdleEnabled({ pooled: true, capabilities: new Map([['IMAP4rev1', true]]) }), false);
  assert.equal(imapAutoIdleEnabled({ pooled: true, capabilities: ['IMAP4rev1'] }), false);
  assert.equal(imapAutoIdleEnabled({ pooled: false, capabilities: new Set(['IDLE']) }), false);
});
