import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMailboxQuery } from './search-query.js';
import {
  bodyStructureFilenames,
  canUseGmraw,
  imapSearchIsSelective,
  mailboxesForDeepSearch,
  mailboxesForSearch,
  newestUids,
  shouldDeepSearchProvider,
  shouldSearchProvider,
  toGmailRawQuery,
  toImapSearchQuery,
} from './imap-search.js';

test('in:anywhere is the MCP opt-in and still means All Mail locally', () => {
  const parsed = parseMailboxQuery('in:anywhere invoice');
  assert.equal(parsed.anywhere, true);
  assert.equal(parsed.folder, 'all');
  assert.equal(parsed.text, 'invoice');
  assert.equal(shouldSearchProvider(parsed, { source: 'mcp', folder: 'all' }), true);
  assert.equal(shouldSearchProvider(parsed, { source: 'human', folder: 'inbox' }), false);
  assert.equal(shouldSearchProvider(parsed, { source: 'deep', folder: 'all' }), true);
});

test('fast listing stays local; deep search covers leftover text and operators', () => {
  const leftover = parseMailboxQuery('invoice from:ada@example.com');
  assert.equal(shouldSearchProvider(leftover, { source: 'human', folder: 'inbox' }), false);
  assert.equal(shouldSearchProvider(leftover, { source: 'mcp', folder: 'inbox' }), false);
  assert.equal(shouldSearchProvider(leftover, { source: 'deep', folder: 'inbox' }), true);
  assert.equal(shouldDeepSearchProvider(parseMailboxQuery('from:ada@example.com')), true);
  assert.equal(imapSearchIsSelective(parseMailboxQuery('from:ada@example.com')), true);
  assert.equal(shouldDeepSearchProvider(parseMailboxQuery('has:attachment')), true);
  assert.equal(imapSearchIsSelective(parseMailboxQuery('has:attachment')), false);
  assert.equal(shouldSearchProvider(parseMailboxQuery('invoice is:unanalyzed'), { source: 'human' }), false);
  assert.equal(shouldSearchProvider(parseMailboxQuery('invoice is:analyzed'), { source: 'deep' }), false);
  assert.equal(shouldDeepSearchProvider(parseMailboxQuery('invoice'), { folder: 'drafts' }), false);
});

test('portable IMAP SEARCH and Gmail gmraw omit is:analyzed', () => {
  const parsed = parseMailboxQuery('from:ada subject:ci has:attachment after:2026-01-01 invoice');
  assert.deepEqual(toImapSearchQuery(parsed).from, 'ada');
  assert.equal(toImapSearchQuery(parsed).text, 'invoice');
  assert.equal(toImapSearchQuery(parsed).subject, 'ci');
  assert.equal(String(toImapSearchQuery(parsed).since.toISOString()), '2026-01-01T00:00:00.000Z');
  const raw = toGmailRawQuery(parsed);
  assert.match(raw, /from:ada/);
  assert.match(raw, /has:attachment/);
  assert.match(raw, /invoice/);
  assert.doesNotMatch(raw, /analyzed/);
  assert.equal(toGmailRawQuery(parseMailboxQuery('invoice is:unanalyzed')).includes('analyzed'), false);
});

test('Gmail gmraw is used for gmail accounts or X-GM-EXT-1', () => {
  assert.equal(canUseGmraw({ provider: 'gmail' }, {}), true);
  assert.equal(canUseGmraw({ provider: 'custom' }, { capabilities: new Map([['X-GM-EXT-1', true]]) }), true);
  assert.equal(canUseGmraw({ provider: 'custom' }, { capabilities: new Map() }), false);
});

test('search mailboxes follow sync folders and cap All Mail on Gmail mirrors', () => {
  const descriptors = [
    { role: 'inbox', mailbox: 'INBOX', allMailMirror: false },
    { role: 'sent', mailbox: 'Sent', allMailMirror: false },
    { role: 'archive', mailbox: '[Gmail]/All Mail', allMailMirror: true },
  ];
  assert.deepEqual(mailboxesForSearch(descriptors, 'inbox').map((item) => item.mailbox), ['INBOX']);
  assert.deepEqual(mailboxesForSearch(descriptors, 'all').map((item) => item.mailbox), ['[Gmail]/All Mail']);
  assert.equal(newestUids([1, 40, 9, 40], 2).join(','), '40,9');
  assert.deepEqual(
    bodyStructureFilenames({
      childNodes: [
        { type: 'text/plain', disposition: 'inline' },
        { type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'invoice.pdf' } },
      ],
    }),
    ['invoice.pdf'],
  );
});

test('deep search covers inbox plus archive, sent, and custom folders', () => {
  const descriptors = [
    { role: 'inbox', mailbox: 'INBOX', allMailMirror: false },
    { role: 'sent', mailbox: 'Sent', allMailMirror: false },
    { role: 'archive', mailbox: '[Gmail]/All Mail', allMailMirror: true },
    { role: 'inbox', mailbox: 'Receipts', allMailMirror: false },
    { role: 'trash', mailbox: 'Trash', allMailMirror: false },
  ];
  assert.deepEqual(
    mailboxesForDeepSearch(descriptors, 'inbox').map((item) => item.mailbox),
    ['INBOX', '[Gmail]/All Mail', 'Sent', 'Receipts'],
  );
  assert.deepEqual(mailboxesForDeepSearch(descriptors, 'all').map((item) => item.mailbox), ['[Gmail]/All Mail']);
  assert.deepEqual(mailboxesForDeepSearch(descriptors, 'sent').map((item) => item.mailbox), ['Sent']);
  assert.equal(mailboxesForDeepSearch(descriptors, 'inbox').some((item) => item.mailbox === 'Trash'), false);
});
