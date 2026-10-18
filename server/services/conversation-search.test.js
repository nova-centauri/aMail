import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationSearch, cheapInboxPredicate, cheapWindowedListingSql, escapeLike, listingNeedsThreadStats, listingProbe } from './conversation-search.js';
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

test('analyzed filters require imported source and extra IMAP thread ids bypass FTS', () => {
  const analyzed = buildConversationSearch({
    accountIds: ['account-1'],
    folder: 'inbox',
    parsed: parseMailboxQuery('is:analyzed'),
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  assert.match(analyzed.pageSql, /imported_count > 0/);
  assert.match(analyzed.pageSql, /has_unanalyzed = 0/);

  const unanalyzed = buildConversationSearch({
    accountIds: ['account-1'],
    folder: 'inbox',
    parsed: parseMailboxQuery('is:unanalyzed'),
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  assert.match(unanalyzed.pageSql, /has_unanalyzed = 1/);

  const withHits = buildConversationSearch({
    accountIds: ['account-1'],
    folder: 'inbox',
    parsed: parseMailboxQuery('invoice'),
    ftsQuery: '"invoice"*',
    extraThreadIds: ['thread-envelope'],
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  assert.match(withHits.pageSql, /stats.thread_id IN \(@extraThread0\)/);
  assert.equal(withHits.params.extraThread0, 'thread-envelope');

  const restricted = buildConversationSearch({
    accountIds: ['account-1'],
    folder: 'inbox',
    restrictThreadIds: ['thread-envelope'],
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  assert.match(restricted.pageSql, /stats.thread_id IN \(@restrict0\)/);
  assert.equal(restricted.params.restrict0, 'thread-envelope');
  assert.doesNotMatch(restricted.pageSql, /messages_fts MATCH/);
});

test('default inbox listing skips attachment JSON and the full stats window', () => {
  assert.equal(listingNeedsThreadStats({ folder: 'inbox', hideQuiet: true }), false);
  const cheap = buildConversationSearch({
    accountIds: ['account-1'],
    folder: 'inbox',
    hideQuiet: true,
    limit: 50,
    offset: 0,
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  assert.equal(cheap.cheap, true);
  assert.equal(cheap.deriveTotalFromCategories, true);
  assert.doesNotMatch(cheap.pageSql, /json_array_length/);
  assert.doesNotMatch(cheap.pageSql, /has_attachment/);
  assert.doesNotMatch(cheap.pageSql, /attachments_json/);
  assert.doesNotMatch(cheap.pageSql, /html_body/);
  assert.doesNotMatch(cheap.pageSql, /AS MATERIALIZED/);
  assert.doesNotMatch(cheap.pageSql, /SELECT COUNT\(\*\) FROM latest/);
  assert.match(cheap.pageSql, /FROM heads/);
  assert.match(cheap.pageSql, /LIMIT @probe/);
  assert.match(cheap.pageSql, /COALESCE\(m\.is_draft, 0\) = 0/);
  assert.match(cheap.pageSql, /INDEXED BY idx_messages_inbox_list/);
  assert.match(cheapInboxPredicate('m'), /COALESCE\(m\.is_draft, 0\) = 0/);
  assert.match(cheap.pageSql, /LIMIT @limit OFFSET @offset/);
  assert.equal(cheap.params.probe, listingProbe(50, 0));

  const windowed = cheapWindowedListingSql({
    accountSql: 'm.account_id = @accountId',
    hideQuiet: true,
    category: '',
    folder: 'inbox',
  });
  assert.match(windowed.pageSql, /AS MATERIALIZED/);
  assert.match(windowed.pageSql, /SELECT COUNT\(\*\) FROM latest/);

  const legacy = buildConversationSearch({
    accountIds: ['account-1'],
    folder: 'inbox',
    hideQuiet: true,
    forceLegacy: true,
    nowIso: '2026-09-18T00:00:00.000Z',
  });
  assert.equal(legacy.cheap, false);
  assert.match(legacy.pageSql, /json_array_length/);
});
