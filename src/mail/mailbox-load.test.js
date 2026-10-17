import { describe, expect, it } from 'vitest';
import {
  MIN_SILENT_MAILBOX_RELOAD_MS,
  mailboxQueryKey,
  mailboxReloadNeedsAccounts,
  mailboxReloadNeedsSession,
  nextActiveAccount,
  shouldStartMailboxLoad,
} from './mailbox-load.js';

describe('mailbox reload gating', () => {
  it('skips accounts and session on a silent tick once accounts are loaded', () => {
    expect(mailboxReloadNeedsAccounts(false, 3)).toBe(true);
    expect(mailboxReloadNeedsAccounts(true, 0)).toBe(true);
    expect(mailboxReloadNeedsAccounts(true, 2)).toBe(false);
    expect(mailboxReloadNeedsSession(true)).toBe(false);
    expect(mailboxReloadNeedsSession(false)).toBe(true);
  });

  it('does not start a silent reload on top of an in-flight load or inside the min gap', () => {
    expect(shouldStartMailboxLoad({ inFlight: 1, silent: true })).toBe(false);
    expect(shouldStartMailboxLoad({
      silent: true,
      lastStartedAt: 10_000,
      now: 10_000 + MIN_SILENT_MAILBOX_RELOAD_MS - 1,
    })).toBe(false);
    expect(shouldStartMailboxLoad({
      silent: true,
      lastStartedAt: 10_000,
      now: 10_000 + MIN_SILENT_MAILBOX_RELOAD_MS,
    })).toBe(true);
    expect(shouldStartMailboxLoad({ inFlight: 1, silent: false, sameQuery: true })).toBe(false);
    expect(shouldStartMailboxLoad({ inFlight: 1, silent: false, sameQuery: false })).toBe(true);
  });

  it('keeps the same activeAccount object when only lastSyncedAt changed', () => {
    const current = { id: 'a1', email: 'one@example.test', lastSyncedAt: '2026-01-01T00:00:00.000Z' };
    const next = nextActiveAccount(current, [
      { id: 'a1', email: 'one@example.test', lastSyncedAt: '2026-01-01T00:01:00.000Z' },
    ]);
    expect(next).toBe(current);
    expect(nextActiveAccount(null, [{ id: 'a1' }])).toBe(null);
    expect(nextActiveAccount({ id: 'gone' }, [{ id: 'a1' }])).toBe(null);
  });

  it('builds a stable query key for the loadMailbox effect', () => {
    const key = mailboxQueryKey({ folder: 'inbox', accountId: '', category: 'all', query: '' });
    expect(key).toBe(mailboxQueryKey({ folder: 'inbox', category: 'all' }));
    expect(key).not.toBe(mailboxQueryKey({ folder: 'sent', category: 'all' }));
  });
});
