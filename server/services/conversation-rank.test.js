import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationDedupeKey, dedupeConversations, mergeSearchResults, scoreConversation } from './conversation-rank.js';
import { parseMailboxQuery } from '../mail/search-query.js';

test('RFC Message-ID dedupes the same mail across accounts', () => {
  const first = {
    id: 'work-thread',
    messageId: '<invoice@vendor.test>',
    subject: 'Invoice',
    from: { email: 'accounts@vendor.test' },
    latestAt: '2019-01-01T00:00:00.000Z',
    sourceImported: false,
  };
  const second = {
    id: 'personal-thread',
    messageId: '<invoice@vendor.test>',
    subject: 'Invoice',
    from: { email: 'accounts@vendor.test' },
    latestAt: '2019-01-02T00:00:00.000Z',
    sourceImported: true,
  };
  assert.equal(conversationDedupeKey(first), conversationDedupeKey(second));
  assert.deepEqual(dedupeConversations([first, second]).map((item) => item.id), ['personal-thread']);
});

test('mergeSearchResults inserts new hits by recency without reshuffling shown rows', () => {
  const shown = [
    { id: 'a', latestAt: '2026-02-01T00:00:00.000Z', messageId: '<a@test>' },
    { id: 'c', latestAt: '2026-01-01T00:00:00.000Z', messageId: '<c@test>' },
  ];
  const incoming = [
    { id: 'a', latestAt: '2026-02-01T00:00:00.000Z', messageId: '<a@test>' },
    { id: 'b', latestAt: '2026-01-15T00:00:00.000Z', messageId: '<b@test>' },
    { id: 'dup', latestAt: '2026-03-01T00:00:00.000Z', messageId: '<a@test>' },
  ];
  assert.deepEqual(mergeSearchResults(shown, incoming).map((item) => item.id), ['a', 'b', 'c']);
});

test('leftover text scores subject hits above snippet-only matches', () => {
  const parsed = parseMailboxQuery('invoice');
  const subject = scoreConversation({ subject: 'January invoice', snippet: 'hello', from: { email: 'a@b.c' }, latestAt: '2020-01-01T00:00:00.000Z' }, parsed);
  const snippet = scoreConversation({ subject: 'Hello', snippet: 'please pay the invoice', from: { email: 'a@b.c' }, latestAt: '2026-01-01T00:00:00.000Z' }, parsed);
  assert.ok(subject > snippet);
});
