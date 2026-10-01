import { describe, expect, it } from 'vitest';
import {
  conversationMatchesMailboxQuery,
  mailboxQueryIsActive,
  parseMailboxQuery,
  serializeMailboxQuery,
} from './search-query.js';

const now = Date.parse('2026-08-31T12:00:00.000Z');

describe('parseMailboxQuery', () => {
  it('leaves free text for FTS and captures Gmail operators', () => {
    const parsed = parseMailboxQuery('from:ada@example.com subject:"ci failed" has:attachment invoice', { now });
    expect(parsed.from).toEqual(['ada@example.com']);
    expect(parsed.subject).toEqual(['ci failed']);
    expect(parsed.hasAttachment).toBe(true);
    expect(parsed.text).toBe('invoice');
    expect(mailboxQueryIsActive(parsed)).toBe(true);
  });

  it('parses dates, unread, and folder overrides', () => {
    const parsed = parseMailboxQuery('after:2026/01/01 before:2026-02-01 is:unread in:sent', { now });
    expect(parsed.after).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.before).toBe('2026-02-01T00:00:00.000Z');
    expect(parsed.isUnread).toBe(true);
    expect(parsed.folder).toBe('sent');
  });

  it('parses relative ages from a fixed now', () => {
    const parsed = parseMailboxQuery('newer_than:7d older_than:2w', { now });
    expect(parsed.after).toBe('2026-08-24T12:00:00.000Z');
    expect(parsed.before).toBe('2026-08-17T12:00:00.000Z');
  });

  it('round-trips operators through serializeMailboxQuery', () => {
    const raw = 'from:Ada to:sales@example.com has:attachment after:2026-01-06 is:starred invoice';
    expect(serializeMailboxQuery(parseMailboxQuery(raw, { now }))).toBe(
      'from:Ada to:sales@example.com has:attachment after:2026-01-06 is:starred invoice',
    );
  });

  it('treats in:anywhere as All Mail and preserves the MCP opt-in flag', () => {
    const parsed = parseMailboxQuery('in:anywhere invoice', { now });
    expect(parsed.anywhere).toBe(true);
    expect(parsed.folder).toBe('all');
    expect(parsed.text).toBe('invoice');
    expect(serializeMailboxQuery(parsed)).toBe('in:anywhere invoice');
  });
});

describe('conversationMatchesMailboxQuery', () => {
  const thread = {
    subject: 'Invoice 1842',
    snippet: 'Please pay',
    from: { name: 'Ada', email: 'ada@example.com' },
    to: [{ email: 'owner@example.test' }],
    attachments: [{ filename: 'invoice.pdf', size: 1200 }],
    latestAt: '2026-01-10T00:00:00.000Z',
    unread: true,
    starred: false,
  };

  it('matches from, attachment, and after operators', () => {
    expect(conversationMatchesMailboxQuery(thread, parseMailboxQuery('from:ada has:attachment after:2026-01-01'))).toBe(true);
    expect(conversationMatchesMailboxQuery(thread, parseMailboxQuery('from:ada has:attachment after:2026-02-01'))).toBe(false);
    expect(conversationMatchesMailboxQuery(thread, parseMailboxQuery('from:nobody'))).toBe(false);
    expect(conversationMatchesMailboxQuery(thread, parseMailboxQuery('-has:attachment'))).toBe(false);
  });
});
