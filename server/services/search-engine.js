/**
 * Typesense-backed mailbox search.
 *
 * SQLite FTS stays the fallback (and the only index when the database is
 * encrypted, unless the operator opts in). Typesense ranks the local cache:
 * typos, token dropping, field weights, and grouped thread pages with no
 * 100/500/1000 clip. IMAP SEARCH for mail that was never imported is unchanged
 * and still refuses is:analyzed / is:unanalyzed.
 */
import { attachmentFilenames } from './fts.js';
import { HIDDEN_DEFAULT_CATEGORIES, SMART_CATEGORY_SLUGS } from './smart-filter.js';

export const SEARCH_COLLECTION = 'amail_messages_v1';
const IMPORT_BATCH = 40;
const THREAD_BATCH = 20;
const TYPESENSE_PAGE_CAP = 250;
const BODY_CAP = 80_000;

const VIRTUAL_FOLDERS = ['inbox', 'starred', 'sent', 'snoozed', 'all', 'trash', 'spam', 'archive'];
const LATEST_FIELDS = {
  inbox: 'latest_inbox',
  starred: 'latest_starred',
  sent: 'latest_sent',
  snoozed: 'latest_snoozed',
  all: 'latest_all',
  trash: 'latest_trash',
  spam: 'latest_spam',
  archive: 'latest_archive',
};
const QUERY_FIELDS = ['subject', 'from_name', 'from_email', 'recipients', 'snippet', 'attachments', 'text_body'];
const QUERY_WEIGHTS = ['8', '4', '4', '3', '2', '2', '1'];
const COUNT_CATEGORIES = SMART_CATEGORY_SLUGS.filter((slug) => !HIDDEN_DEFAULT_CATEGORIES.includes(slug));

const SCHEMA_FIELDS = [
  { name: 'thread_id', type: 'string', facet: true },
  { name: 'account_id', type: 'string', facet: true },
  { name: 'thread_key', type: 'string', facet: true },
  { name: 'mailbox', type: 'string', facet: true },
  { name: 'is_read', type: 'bool', facet: true },
  { name: 'is_starred', type: 'bool', facet: true },
  { name: 'is_archived', type: 'bool', facet: true },
  { name: 'is_trashed', type: 'bool', facet: true },
  { name: 'is_spam', type: 'bool', facet: true },
  { name: 'is_sent', type: 'bool', facet: true },
  { name: 'source_imported', type: 'bool', facet: true },
  { name: 'analyzed', type: 'bool', facet: true },
  { name: 'has_attachment', type: 'bool', facet: true },
  { name: 'snoozed_until', type: 'int64' },
  { name: 'sent_at', type: 'int64' },
  { name: 'subject', type: 'string', optional: true },
  { name: 'snippet', type: 'string', optional: true },
  { name: 'from_name', type: 'string', optional: true },
  { name: 'from_email', type: 'string', optional: true },
  { name: 'recipients', type: 'string', optional: true },
  { name: 'text_body', type: 'string', optional: true },
  { name: 'attachments', type: 'string', optional: true },
  { name: 'from_tokens', type: 'string[]', facet: true, optional: true },
  { name: 'to_tokens', type: 'string[]', facet: true, optional: true },
  { name: 'subject_tokens', type: 'string[]', facet: true, optional: true },
  { name: 'thread_from', type: 'string[]', facet: true, optional: true },
  { name: 'thread_to', type: 'string[]', facet: true, optional: true },
  { name: 'thread_subject', type: 'string[]', facet: true, optional: true },
  { name: 'thread_people', type: 'string[]', facet: true, optional: true },
  { name: 'unread_in', type: 'string[]', facet: true, optional: true },
  { name: 'starred_in', type: 'string[]', facet: true, optional: true },
  { name: 'attachment_in', type: 'string[]', facet: true, optional: true },
  { name: 'unanalyzed_in', type: 'string[]', facet: true, optional: true },
  { name: 'imported_in', type: 'string[]', facet: true, optional: true },
  { name: 'quiet_in', type: 'string[]', facet: true, optional: true },
  { name: 'category_in', type: 'string[]', facet: true, optional: true },
  ...Object.values(LATEST_FIELDS).map((name) => ({ name, type: 'int64' })),
];

/**
 * auto: Typesense when a URL and key are set and the SQLite file is not encrypted.
 * typesense: force it, including a plaintext index beside SQLCipher.
 * off / fts: keep search inside SQLite.
 */
export function resolveSearchBackend(config = {}) {
  const requested = String(config.searchEngine || 'auto').trim().toLowerCase();
  const mode = ['auto', 'typesense', 'off', 'fts'].includes(requested) ? requested : 'auto';
  const encrypted = config.keyMode === 'keyslot' || Boolean(config.encryptDatabase && config.databaseKey);
  if (mode === 'off' || mode === 'fts') {
    return { name: 'fts', enabled: false, plaintextIndex: false, reason: 'disabled' };
  }
  if (!config.typesenseUrl || !config.typesenseApiKey) {
    return { name: 'fts', enabled: false, plaintextIndex: false, reason: 'unconfigured' };
  }
  if (encrypted && mode !== 'typesense') {
    return { name: 'fts', enabled: false, plaintextIndex: false, reason: 'encrypted-database' };
  }
  return { name: 'typesense', enabled: true, plaintextIndex: encrypted, reason: encrypted ? 'explicit-plaintext-index' : 'configured' };
}

export function searchTokens(value) {
  const tokens = String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9@._+-]*/g) || [];
  const out = new Set();
  for (const token of tokens) {
    out.add(token);
    for (const part of token.split(/[@._+-]+/)) {
      if (part.length >= 2) out.add(part);
    }
  }
  return [...out].slice(0, 64);
}

export function filterToken(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_@.+-]+$/.test(text)) return text;
  return `\`${text.replace(/`/g, '')}\``;
}

function jsonPeople(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  try {
    const parsed = JSON.parse(value || 'null');
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    // Malformed recipient JSON should not drop the rest of the document.
  }
  return [];
}

function messageTime(row) {
  const ms = Date.parse(row?.sent_at || row?.received_at || row?.created_at || '');
  return Number.isNaN(ms) ? 0 : ms;
}

function flag(value) {
  return Number(value) === 1 || value === true;
}

/** Virtual folders this cached row belongs to at `nowMs`. Matches the SQL folder predicate. */
export function messageFolders(row, nowMs) {
  const trashed = flag(row.is_trashed);
  const spam = flag(row.is_spam);
  const archived = flag(row.is_archived);
  const starred = flag(row.is_starred);
  const sent = flag(row.is_sent);
  const snoozedUntil = Date.parse(row.snoozed_until || '') || 0;
  const snoozed = snoozedUntil > nowMs;
  const mailbox = row.mailbox || 'INBOX';
  const folders = [];
  if (mailbox === 'INBOX' && !archived && !trashed && !spam && !snoozed) folders.push('inbox');
  if (starred && !trashed) folders.push('starred');
  if (sent && !trashed) folders.push('sent');
  if (snoozed && !trashed && !spam) folders.push('snoozed');
  if (!trashed && !spam) folders.push('all');
  if (trashed) folders.push('trash');
  if (spam && !trashed) folders.push('spam');
  if (archived && !trashed && !snoozed) folders.push('archive');
  return folders;
}

function recipientText(row) {
  return [...jsonPeople(row.to_json), ...jsonPeople(row.cc_json), ...jsonPeople(row.bcc_json)]
    .map((person) => `${person?.name || ''} ${person?.email || ''}`)
    .join(' ');
}

function peopleEmails(row) {
  const people = [
    { email: row.from_email },
    ...jsonPeople(row.to_json),
    ...jsonPeople(row.cc_json),
    ...jsonPeople(row.bcc_json),
    ...jsonPeople(row.reply_to_json),
  ];
  return [...new Set(people.map((person) => String(person?.email || '').trim().toLowerCase()).filter(Boolean))];
}

function folderFilter(folder, mailbox, nowMs) {
  const now = String(nowMs);
  switch (folder) {
    case 'inbox':
      return `mailbox:=INBOX && is_archived:=false && is_trashed:=false && is_spam:=false && snoozed_until:<=${now}`;
    case 'starred':
      return 'is_starred:=true && is_trashed:=false';
    case 'sent':
      return 'is_sent:=true && is_trashed:=false';
    case 'snoozed':
      return `snoozed_until:>${now} && is_trashed:=false && is_spam:=false`;
    case 'all':
      return 'is_trashed:=false && is_spam:=false';
    case 'trash':
      return 'is_trashed:=true';
    case 'spam':
      return 'is_spam:=true && is_trashed:=false';
    case 'archive':
      return `is_archived:=true && is_trashed:=false && snoozed_until:<=${now}`;
    default:
      return `mailbox:=${filterToken(mailbox || 'INBOX')} && is_trashed:=false && is_spam:=false`;
  }
}

function tokenClause(field, value, { folder = '', scoped = false } = {}) {
  const tokens = searchTokens(value).slice(0, 8);
  if (!tokens.length) return '';
  return tokens
    .map((token) => `${field}:=${filterToken(scoped ? `${folder}:${token}` : token)}`)
    .join(' && ');
}

function documentsForThread(rows, nowMs) {
  const latest = Object.fromEntries(VIRTUAL_FOLDERS.map((folder) => [folder, 0]));
  const latestCategory = {};
  const unread = new Set();
  const starred = new Set();
  const attachment = new Set();
  const unanalyzed = new Set();
  const imported = new Set();
  const quiet = new Set();
  const categoryIn = new Set();
  const threadFrom = new Set();
  const threadTo = new Set();
  const threadSubject = new Set();
  const threadPeople = new Set();
  const prepared = rows.map((row) => {
    const attachments = jsonPeople(row.attachments_json);
    return {
      row,
      membership: messageFolders(row, nowMs),
      fromTokens: searchTokens(`${row.from_name || ''} ${row.from_email || ''}`),
      toTokens: searchTokens(recipientText(row)),
      subjectTokens: searchTokens(row.subject),
      people: peopleEmails(row),
      time: messageTime(row),
      hasAttachment: attachments.length > 0,
      attachmentText: attachmentFilenames(row, jsonPeople),
    };
  });
  for (const item of prepared) {
    for (const folder of item.membership) {
      if (item.time >= latest[folder]) {
        latest[folder] = item.time;
        latestCategory[folder] = item.row.smart_category || 'primary';
      }
      if (!flag(item.row.is_read)) unread.add(folder);
      if (flag(item.row.is_starred)) starred.add(folder);
      if (item.hasAttachment) attachment.add(folder);
      const importedSource = Number(item.row.source_imported ?? 1) === 1;
      if (importedSource) imported.add(folder);
      if (importedSource && !item.row.analyzed_at) unanalyzed.add(folder);
      for (const token of item.fromTokens) threadFrom.add(`${folder}:${token}`);
      for (const token of item.toTokens) threadTo.add(`${folder}:${token}`);
      for (const token of item.subjectTokens) threadSubject.add(`${folder}:${token}`);
      for (const email of item.people) threadPeople.add(`${folder}:${email}`);
    }
  }
  for (const folder of VIRTUAL_FOLDERS) {
    if (!latestCategory[folder]) continue;
    categoryIn.add(`${folder}:${latestCategory[folder]}`);
    if (latestCategory[folder] === 'ops_quiet') quiet.add(folder);
  }
  const denorm = {
    thread_from: [...threadFrom],
    thread_to: [...threadTo],
    thread_subject: [...threadSubject],
    thread_people: [...threadPeople],
    unread_in: [...unread],
    starred_in: [...starred],
    attachment_in: [...attachment],
    unanalyzed_in: [...unanalyzed],
    imported_in: [...imported],
    quiet_in: [...quiet],
    category_in: [...categoryIn],
  };
  for (const [folder, field] of Object.entries(LATEST_FIELDS)) denorm[field] = latest[folder] || 0;

  return prepared.map((item) => {
    const body = String(item.row.text_body || '').slice(0, BODY_CAP);
    const document = {
      id: item.row.id,
      thread_id: item.row.thread_id,
      account_id: item.row.account_id,
      thread_key: `${item.row.account_id}\t${item.row.thread_id}`,
      mailbox: item.row.mailbox || 'INBOX',
      is_read: flag(item.row.is_read),
      is_starred: flag(item.row.is_starred),
      is_archived: flag(item.row.is_archived),
      is_trashed: flag(item.row.is_trashed),
      is_spam: flag(item.row.is_spam),
      is_sent: flag(item.row.is_sent),
      source_imported: Number(item.row.source_imported ?? 1) === 1,
      analyzed: Boolean(item.row.analyzed_at),
      has_attachment: item.hasAttachment,
      snoozed_until: Date.parse(item.row.snoozed_until || '') || 0,
      sent_at: item.time,
      subject: item.row.subject || '',
      snippet: item.row.snippet || '',
      from_name: item.row.from_name || '',
      from_email: item.row.from_email || '',
      recipients: recipientText(item.row),
      attachments: item.attachmentText,
      from_tokens: item.fromTokens,
      to_tokens: item.toTokens,
      subject_tokens: item.subjectTokens,
      ...denorm,
    };
    // An emptied body (retention prune, or an envelope-only hit) must not wipe
    // text Typesense already stored. Omitting the field keeps the previous value
    // on emplace; a first insert simply has no body yet.
    if (body) document.text_body = body;
    return document;
  });
}

export function buildThreadDocuments(rows, nowMs = Date.now()) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row?.id || !row.thread_id || !row.account_id) continue;
    const key = `${row.account_id}\t${row.thread_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].flatMap((group) => documentsForThread(group, nowMs));
}

function accountFilter(accountIds) {
  const ids = [...new Set((accountIds || []).filter(Boolean))];
  if (!ids.length) return '';
  if (ids.length === 1) return `account_id:=${filterToken(ids[0])}`;
  return `account_id:=[${ids.map((id) => filterToken(id)).join(',')}]`;
}

/**
 * One grouped page search plus a count search per smart category.
 * `found` on a grouped query is the number of threads, not messages.
 */
export function buildTypesenseQuery(input = {}) {
  const {
    accountIds = [],
    folder = 'inbox',
    mailbox = 'INBOX',
    parsed = null,
    category = '',
    personEmails = [],
    hideQuiet = false,
    page = 1,
    pageSize = 50,
    offset = null,
    limit = null,
    threadIds = null,
    nowMs = Date.now(),
  } = input;
  const text = String(parsed?.text || '').trim();
  if (!text) return null;
  const accounts = accountFilter(accountIds);
  if (!accounts) return null;
  const filters = [accounts, folderFilter(folder, mailbox, nowMs)];
  const latestField = LATEST_FIELDS[folder] || 'sent_at';
  for (const value of parsed.from || []) {
    const clause = tokenClause('from_tokens', value);
    if (clause) filters.push(clause);
  }
  for (const value of parsed.to || []) {
    const clause = tokenClause('to_tokens', value);
    if (clause) filters.push(clause);
  }
  for (const value of parsed.subject || []) {
    const clause = tokenClause('subject_tokens', value);
    if (clause) filters.push(clause);
  }
  for (const value of parsed.notFrom || []) {
    const clause = tokenClause('thread_from', value, { folder, scoped: true });
    if (clause) filters.push(`!(${clause})`);
  }
  for (const value of parsed.notTo || []) {
    const clause = tokenClause('thread_to', value, { folder, scoped: true });
    if (clause) filters.push(`!(${clause})`);
  }
  for (const value of parsed.notSubject || []) {
    const clause = tokenClause('thread_subject', value, { folder, scoped: true });
    if (clause) filters.push(`!(${clause})`);
  }
  if (parsed.hasAttachment === true) filters.push(`attachment_in:=${filterToken(folder)}`);
  if (parsed.hasAttachment === false) filters.push(`!(attachment_in:=${filterToken(folder)})`);
  if (parsed.after) {
    const ms = Date.parse(parsed.after);
    if (!Number.isNaN(ms)) filters.push(`${latestField}:>=${ms}`);
  }
  if (parsed.before) {
    const ms = Date.parse(parsed.before);
    if (!Number.isNaN(ms)) filters.push(`${latestField}:<${ms}`);
  }
  if (parsed.isUnread === true) filters.push(`unread_in:=${filterToken(folder)}`);
  if (parsed.isUnread === false) filters.push(`!(unread_in:=${filterToken(folder)})`);
  if (parsed.isStarred === true) filters.push(`starred_in:=${filterToken(folder)}`);
  if (parsed.isStarred === false) filters.push(`!(starred_in:=${filterToken(folder)})`);
  if (parsed.isAnalyzed === true) {
    filters.push(`!(unanalyzed_in:=${filterToken(folder)})`);
    filters.push(`imported_in:=${filterToken(folder)}`);
  }
  if (parsed.isAnalyzed === false) filters.push(`unanalyzed_in:=${filterToken(folder)}`);
  const emails = [...new Set((personEmails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
  if (emails.length) {
    filters.push(`thread_people:=[${emails.map((email) => filterToken(`${folder}:${email}`)).join(',')}]`);
  }
  if (hideQuiet) filters.push(`!(quiet_in:=${filterToken(folder)})`);
  const onlyThreads = [...new Set((threadIds || []).filter(Boolean))];
  if (onlyThreads.length) {
    filters.push(`thread_id:=[${onlyThreads.map((id) => filterToken(id)).join(',')}]`);
  }
  const base = filters.join(' && ');
  const perPage = Math.min(TYPESENSE_PAGE_CAP, Math.max(1, Number(limit || pageSize) || 50));
  const paging = Number.isInteger(offset)
    ? { offset: Math.max(0, offset), limit: perPage }
    : { page: Math.max(1, Number(page) || 1), per_page: perPage };
  const search = (filterBy, pageFields) => ({
    collection: SEARCH_COLLECTION,
    q: text,
    query_by: QUERY_FIELDS.join(','),
    query_by_weights: QUERY_WEIGHTS.join(','),
    prefix: QUERY_FIELDS.map(() => 'true').join(','),
    drop_tokens_threshold: 1,
    typo_tokens_threshold: 1,
    filter_by: filterBy,
    group_by: 'thread_key',
    group_limit: 1,
    sort_by: '_text_match:desc,sent_at:desc',
    include_fields: 'thread_id',
    highlight_fields: 'snippet',
    ...pageFields,
  });
  const pageFilter = category ? `${base} && category_in:=${filterToken(`${folder}:${category}`)}` : base;
  return {
    searches: [
      search(pageFilter, paging),
      ...COUNT_CATEGORIES.map((slug) => search(
        `${base} && category_in:=${filterToken(`${folder}:${slug}`)}`,
        { page: 1, per_page: 1 },
      )),
    ],
  };
}

function threadIdsFromResult(result) {
  if (Array.isArray(result?.grouped_hits)) {
    return result.grouped_hits
      .map((group) => group?.hits?.[0]?.document?.thread_id)
      .filter(Boolean);
  }
  return (result?.hits || []).map((hit) => hit?.document?.thread_id).filter(Boolean);
}

export function createSearchEngine({ config, repos, logger = null, fetchImpl = globalThis.fetch } = {}) {
  const decision = resolveSearchBackend(config);
  const baseUrl = String(config?.typesenseUrl || '').replace(/\/$/, '');
  let wanted = false;
  let ready = false;
  let stopped = false;
  let tail = Promise.resolve();
  let retryTimer = null;
  const pendingIds = new Set();
  const removedAccounts = new Set();

  async function typesense(path, { method = 'GET', body = null, timeoutMs = 8_000, contentType = 'application/json' } = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        'X-TYPESENSE-API-KEY': config.typesenseApiKey,
        ...(body == null ? {} : { 'Content-Type': contentType }),
      },
      body: body == null ? undefined : body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Typesense ${method} ${path} failed (${response.status})`);
    }
    const text = await response.text();
    if (!text) return null;
    if (contentType === 'text/plain') return text;
    return JSON.parse(text);
  }

  async function ensureCollection() {
    const existing = await fetchImpl(`${baseUrl}/collections/${SEARCH_COLLECTION}`, {
      headers: { 'X-TYPESENSE-API-KEY': config.typesenseApiKey },
      signal: AbortSignal.timeout(8_000),
    });
    await existing.text();
    if (existing.status === 404) {
      await typesense('/collections', {
        method: 'POST',
        body: JSON.stringify({
          name: SEARCH_COLLECTION,
          default_sorting_field: 'sent_at',
          fields: SCHEMA_FIELDS,
        }),
      });
      return;
    }
    if (!existing.ok) throw new Error(`Typesense collection lookup failed (${existing.status})`);
  }

  async function importBatch(documents) {
    if (!documents.length) return;
    const body = documents.map((document) => JSON.stringify(document)).join('\n');
    const text = await typesense(
      `/collections/${SEARCH_COLLECTION}/documents/import?action=emplace`,
      { method: 'POST', body, timeoutMs: 60_000, contentType: 'text/plain' },
    );
    const failed = String(text || '').split('\n').filter((line) => line && !/"success"\s*:\s*true/.test(line)).length;
    if (failed) logger?.warn?.({ failed }, 'Typesense skipped some messages during indexing');
  }

  async function importRows(rows, nowMs = Date.now()) {
    const documents = buildThreadDocuments(rows, nowMs);
    for (let index = 0; index < documents.length; index += IMPORT_BATCH) {
      await importBatch(documents.slice(index, index + IMPORT_BATCH));
    }
  }

  async function deleteByFilter(filterBy) {
    await typesense(`/collections/${SEARCH_COLLECTION}/documents?filter_by=${encodeURIComponent(filterBy)}`, {
      method: 'DELETE',
      timeoutMs: 60_000,
    });
  }

  async function flushPending() {
    const ids = [...pendingIds];
    const accounts = [...removedAccounts];
    pendingIds.clear();
    removedAccounts.clear();
    if (!ids.length && !accounts.length) return;
    await ensureCollection();
    for (const accountId of accounts) await deleteByFilter(`account_id:=${filterToken(accountId)}`);
    if (!ids.length) return;
    const threadIds = repos.messages.searchThreadIdsForMessages(ids);
    await importRows(repos.messages.searchRowsForThreads(threadIds));
  }

  function scheduleFlush() {
    tail = tail.then(() => flushPending()).catch((error) => {
      logger?.warn?.({ err: error }, 'Typesense index update failed');
    });
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!stopped) tail = tail.then(() => runBackfill());
    }, 15_000);
    retryTimer.unref?.();
  }

  async function runBackfill() {
    try {
      await ensureCollection();
      let after = '';
      let threads = 0;
      for (;;) {
        if (stopped) return;
        const ids = repos.messages.searchThreadPage({ after, limit: THREAD_BATCH });
        if (!ids.length) break;
        await importRows(repos.messages.searchRowsForThreads(ids));
        threads += ids.length;
        after = ids.at(-1);
      }
      ready = true;
      logger?.info?.({ threads }, 'Typesense search index is ready');
    } catch (error) {
      ready = false;
      logger?.warn?.({ err: error }, 'Typesense is unavailable; search is using SQLite FTS');
      scheduleRetry();
    }
  }

  async function multiSearch(built) {
    const payload = await typesense('/multi_search', {
      method: 'POST',
      body: JSON.stringify({ searches: built.searches }),
    });
    return payload?.results || [];
  }

  return {
    decision,
    get enabled() {
      return Boolean(wanted && ready && !stopped);
    },
    start() {
      if (wanted || stopped) return;
      if (!decision.enabled) {
        logger?.info?.({ reason: decision.reason }, 'Mailbox search is using SQLite FTS');
        return;
      }
      wanted = true;
      if (decision.plaintextIndex) {
        logger?.warn?.('Typesense stores a plaintext copy of indexed mail outside SQLCipher');
      }
      tail = runBackfill();
    },
    stop() {
      stopped = true;
      ready = false;
      if (retryTimer) clearTimeout(retryTimer);
    },
    whenIdle() {
      return tail;
    },
    noteWrite({ messageIds = [], accountRemoved = null } = {}) {
      if (!wanted || stopped) return;
      if (accountRemoved) removedAccounts.add(accountRemoved);
      for (const id of messageIds) {
        if (id) pendingIds.add(id);
      }
      scheduleFlush();
    },
    async searchConversations(input = {}) {
      await tail;
      if (!ready || stopped) throw new Error('Typesense search index is not ready');
      const built = buildTypesenseQuery(input);
      if (!built) return { threadIds: [], total: 0, categoryCounts: [] };
      const results = await multiSearch(built);
      const pageResult = results[0] || {};
      const categoryCounts = COUNT_CATEGORIES.map((slug, index) => ({
        category: slug,
        count: Number(results[index + 1]?.found) || 0,
      }));
      return {
        threadIds: threadIdsFromResult(pageResult),
        total: Number(pageResult.found) || 0,
        categoryCounts,
      };
    },
    async matchingThreadIds(input = {}) {
      const ids = [...new Set((input.threadIds || []).filter(Boolean))];
      if (!ids.length) return new Set();
      await tail;
      if (!ready || stopped) throw new Error('Typesense search index is not ready');
      const built = buildTypesenseQuery({
        ...input,
        threadIds: ids,
        offset: 0,
        limit: Math.min(TYPESENSE_PAGE_CAP, ids.length),
      });
      if (!built) return new Set();
      // Membership only needs the first search, not the category counts.
      built.searches = [built.searches[0]];
      const results = await multiSearch(built);
      return new Set(threadIdsFromResult(results[0]));
    },
  };
}
