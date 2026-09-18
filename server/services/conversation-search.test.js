import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationSearch, escapeLike } from './conversation-search.js';
import { parseMailboxQuery } from '../mail/search-query.js';

test('LIKE metacharacters are escaped for SQL contains matches', () => {
  assert.equal(escapeLike('a%b_c\\d'), 'a\\%b\\_c\\\\d');
});

test('conversation search SQL paginates in SQLite and pushes operators into predicates', () => {
  const parsed = parseMailboxQuery('from:ada@example.com has:attachment after:2026-01-01 invoice');
  const built = buildConversationSearch({
    accountIds: ['account-1'],
    folder: 'inbox',
    parsed,
    ftsQuery: '"invoice"*',
    limit: 50,
    offset: 50,
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  assert.equal(built.empty, false);
  assert.match(built.pageSql, /LIMIT @limit OFFSET @offset/);
  assert.doesNotMatch(built.pageSql, /\b1000\b/);
  assert.doesNotMatch(built.pageSql, /\b500\b/);
  assert.match(built.pageSql, /messages_fts MATCH @ftsQuery/);
  assert.match(built.pageSql, /from_name/);
  assert.match(built.pageSql, /has_attachment = 1/);
  assert.match(built.pageSql, /latest_at >= @after/);
  assert.equal(built.params.limit, 50);
  assert.equal(built.params.offset, 50);
  assert.equal(built.params.from0, '%ada@example.com%');
});
