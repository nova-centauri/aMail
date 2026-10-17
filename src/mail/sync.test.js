import { describe, expect, it } from 'vitest';
import { syncResultStatus, syncSkippedMessageCount, syncWasAccepted } from './sync.js';

describe('sync HTTP 202 payloads', () => {
  it('treats accepted enqueue responses as accepted, not failed', () => {
    const payload = {
      accepted: true,
      state: 'started',
      sync: { inFlight: true, queueDepth: 1, oldestStartedAt: '2026-10-17T12:00:00.000Z' },
    };
    expect(syncWasAccepted(payload)).toBe(true);
    expect(syncResultStatus(payload)).toBe('accepted');
    expect(syncSkippedMessageCount(payload)).toBe(0);
  });

  it('still reads completed IMAP results when they are present', () => {
    expect(syncResultStatus({ results: [{ status: 'failed' }] })).toBe('failed');
    expect(syncWasAccepted({ results: [{ status: 'ok' }] })).toBe(false);
  });
});
