/**
 * SQL for conversation list/search. Operators and leftover FTS text are
 * evaluated here so listing is not clipped to a JS candidate window.
 */
import { mailboxQueryIsActive } from '../mail/search-query.js';

export function folderPredicate(alias) {
  const a = alias;
  return `CASE @folder
          WHEN 'inbox' THEN ${a}.mailbox = 'INBOX' AND ${a}.is_archived = 0 AND ${a}.is_trashed = 0 AND ${a}.is_spam = 0 AND (${a}.snoozed_until IS NULL OR ${a}.snoozed_until <= @now)
          WHEN 'starred' THEN ${a}.is_starred = 1 AND ${a}.is_trashed = 0
          WHEN 'sent' THEN ${a}.is_sent = 1 AND ${a}.is_trashed = 0
          WHEN 'drafts' THEN 0
          WHEN 'snoozed' THEN ${a}.snoozed_until > @now AND ${a}.is_trashed = 0 AND ${a}.is_spam = 0
          WHEN 'all' THEN ${a}.is_trashed = 0 AND ${a}.is_spam = 0
          WHEN 'trash' THEN ${a}.is_trashed = 1
          WHEN 'spam' THEN ${a}.is_spam = 1 AND ${a}.is_trashed = 0
          WHEN 'archive' THEN ${a}.is_archived = 1 AND ${a}.is_trashed = 0 AND (${a}.snoozed_until IS NULL OR ${a}.snoozed_until <= @now)
          ELSE ${a}.mailbox = @mailbox AND ${a}.is_trashed = 0 AND ${a}.is_spam = 0
        END`;
}

export function escapeLike(value) {
  return String(value || '').toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function likeContains(value) {
  return `%${escapeLike(value)}%`;
}

function accountPredicate(accountIds, params) {
  const ids = [...new Set((accountIds || []).filter(Boolean))];
  if (!ids.length) return { sql: '0', ids };
  if (ids.length === 1) {
    params.accountId = ids[0];
    return { sql: 'm.account_id = @accountId', ids };
  }
  const placeholders = ids.map((id, index) => {
    params[`account${index}`] = id;
    return `@account${index}`;
  });
  return { sql: `m.account_id IN (${placeholders.join(', ')})`, ids };
}

function existsInThread(alias, extraSql) {
  return `EXISTS (
      SELECT 1 FROM messages ${alias}
      WHERE ${alias}.thread_id = stats.thread_id
        AND ${alias}.account_id = stats.account_id
        AND ${folderPredicate(alias)}
        AND (${extraSql})
    )`;
}

function likeHaystack(alias, columns, param) {
  return columns.map((column) => `lower(${alias}.${column}) LIKE ${param} ESCAPE '\\'`).join(' OR ');
}

/**
 * Build the CTE shared by the page, total, and category-count queries.
 * Message bodies are never selected.
 */
export function buildConversationSearch(input = {}) {
  const {
    accountIds = [],
    folder = 'inbox',
    mailbox = 'INBOX',
    parsed = null,
    ftsQuery = '',
    category = '',
    personEmails = [],
    hideQuiet = false,
    limit = 50,
    offset = 0,
    nowIso,
  } = input;
  const params = {
    folder,
    mailbox: String(mailbox || 'INBOX'),
    now: nowIso,
    category: category ? String(category) : '',
    hideQuiet: hideQuiet ? 1 : 0,
    limit,
    offset,
  };
  const { sql: accountSql, ids } = accountPredicate(accountIds, params);
  if (!ids.length) {
    return {
      params,
      empty: true,
      pageSql: 'SELECT NULL AS threadId WHERE 0',
      countSql: 'SELECT 0 AS total',
      categorySql: 'SELECT NULL AS category, 0 AS count WHERE 0',
    };
  }

  const filters = [];
  if (ftsQuery) {
    params.ftsQuery = ftsQuery;
    filters.push(`EXISTS (
      SELECT 1 FROM messages fts_m
      JOIN messages_fts fts ON fts.rowid = fts_m.rowid
      WHERE fts_m.thread_id = stats.thread_id
        AND fts_m.account_id = stats.account_id
        AND ${folderPredicate('fts_m')}
        AND messages_fts MATCH @ftsQuery
    )`);
  }

  const query = parsed && mailboxQueryIsActive(parsed) ? parsed : null;
  if (query) {
    query.from.forEach((value, index) => {
      const key = `from${index}`;
      params[key] = likeContains(value);
      filters.push(existsInThread('from_m', likeHaystack('from_m', ['from_name', 'from_email'], `@${key}`)));
    });
    query.notFrom.forEach((value, index) => {
      const key = `notFrom${index}`;
      params[key] = likeContains(value);
      filters.push(`NOT ${existsInThread('nfrom_m', likeHaystack('nfrom_m', ['from_name', 'from_email'], `@${key}`))}`);
    });
    query.to.forEach((value, index) => {
      const key = `to${index}`;
      params[key] = likeContains(value);
      filters.push(existsInThread('to_m', likeHaystack('to_m', ['to_json', 'cc_json'], `@${key}`)));
    });
    query.notTo.forEach((value, index) => {
      const key = `notTo${index}`;
      params[key] = likeContains(value);
      filters.push(`NOT ${existsInThread('nto_m', likeHaystack('nto_m', ['to_json', 'cc_json'], `@${key}`))}`);
    });
    query.subject.forEach((value, index) => {
      const key = `subject${index}`;
      params[key] = likeContains(value);
      filters.push(existsInThread('subj_m', likeHaystack('subj_m', ['subject'], `@${key}`)));
    });
    query.notSubject.forEach((value, index) => {
      const key = `notSubject${index}`;
      params[key] = likeContains(value);
      filters.push(`NOT ${existsInThread('nsubj_m', likeHaystack('nsubj_m', ['subject'], `@${key}`))}`);
    });
    if (query.hasAttachment === true) filters.push('stats.has_attachment = 1');
    if (query.hasAttachment === false) filters.push('stats.has_attachment = 0');
    if (query.after) {
      params.after = query.after;
      filters.push('stats.latest_at >= @after');
    }
    if (query.before) {
      params.before = query.before;
      filters.push('stats.latest_at < @before');
    }
    if (query.isUnread === true) filters.push('stats.has_unread = 1');
    if (query.isUnread === false) filters.push('stats.has_unread = 0');
    if (query.isStarred === true) filters.push('stats.has_starred = 1');
    if (query.isStarred === false) filters.push('stats.has_starred = 0');
    if (query.isAnalyzed === true) filters.push('stats.has_unanalyzed = 0');
    if (query.isAnalyzed === false) filters.push('stats.has_unanalyzed = 1');
  }

  const emails = [...new Set((personEmails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
  if (emails.length) {
    const personSql = emails.map((email, index) => {
      const key = `person${index}`;
      params[key] = email;
      return `lower(person_m.from_email) = @${key}
        OR instr(lower(person_m.from_name), @${key}) > 0
        OR instr(lower(person_m.to_json), @${key}) > 0
        OR instr(lower(person_m.cc_json), @${key}) > 0
        OR instr(lower(COALESCE(person_m.reply_to_json, '')), @${key}) > 0`;
    }).join(' OR ');
    filters.push(existsInThread('person_m', personSql));
  }

  if (hideQuiet) filters.push("stats.latest_category <> 'ops_quiet'");

  const whereSql = filters.length ? `WHERE ${filters.join('\n      AND ')}` : '';
  const pageWhere = [
    filters.length ? filters.join('\n      AND ') : '',
    category ? 'stats.latest_category = @category' : '',
  ].filter(Boolean);
  const pageWhereSql = pageWhere.length ? `WHERE ${pageWhere.join('\n      AND ')}` : '';
  const cte = `WITH ranked AS (
      SELECT
        m.thread_id AS thread_id,
        m.account_id AS account_id,
        m.id AS id,
        m.is_read AS is_read,
        m.is_starred AS is_starred,
        m.analyzed_at AS analyzed_at,
        m.attachments_json AS attachments_json,
        m.smart_category AS smart_category,
        COALESCE(m.sent_at, m.received_at, m.created_at) AS ts,
        ROW_NUMBER() OVER (
          PARTITION BY m.account_id, m.thread_id
          ORDER BY COALESCE(m.sent_at, m.received_at, m.created_at) DESC, m.id DESC
        ) AS rk
      FROM messages m
      WHERE ${accountSql}
        AND ${folderPredicate('m')}
    ),
    stats AS (
      SELECT
        thread_id,
        account_id,
        MAX(ts) AS latest_at,
        MAX(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS has_unread,
        MAX(is_starred) AS has_starred,
        MAX(CASE WHEN analyzed_at IS NULL THEN 1 ELSE 0 END) AS has_unanalyzed,
        MAX(CASE WHEN json_valid(attachments_json) AND json_array_length(attachments_json) > 0 THEN 1 ELSE 0 END) AS has_attachment,
        MAX(CASE WHEN rk = 1 THEN smart_category END) AS latest_category
      FROM ranked
      GROUP BY account_id, thread_id
    ),
    filtered AS (
      SELECT thread_id, account_id, latest_at, latest_category
      FROM stats
      ${whereSql}
    ),
    paged AS (
      SELECT thread_id, account_id, latest_at, latest_category
      FROM stats
      ${pageWhereSql}
    )`;

  return {
    params,
    empty: false,
    pageSql: `${cte}
      SELECT thread_id AS threadId
      FROM paged
      ORDER BY latest_at DESC, thread_id DESC
      LIMIT @limit OFFSET @offset`,
    countSql: `${cte}
      SELECT COUNT(*) AS total FROM paged`,
    categorySql: `${cte}
      SELECT latest_category AS category, COUNT(*) AS count
      FROM filtered
      WHERE latest_category IS NOT NULL AND latest_category <> 'ops_quiet'
      GROUP BY latest_category`,
  };
}
