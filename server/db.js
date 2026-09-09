import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  SMART_CATEGORY_SLUGS,
  SMART_FILTER_VERSION,
  categoryLabel,
  classifyMessage,
  isSmartCategory,
  smartFilterFingerprint,
} from './services/smart-filter.js';

const SMART_FILTER_FINGERPRINT_SETTING = 'smartFilterFingerprint';
import { ftsDocument } from './services/fts.js';

const json = (value, fallback = []) => {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const stringify = (value, fallback = []) => JSON.stringify(value ?? fallback);
const now = () => new Date().toISOString();

function publicAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_blob ? `/api/accounts/${row.id}/avatar` : null,
    color: row.color,
    provider: row.provider,
    imap: { host: row.imap_host, port: row.imap_port, secure: Boolean(row.imap_secure) },
    smtp: { host: row.smtp_host, port: row.smtp_port, secure: Boolean(row.smtp_secure) },
    signature: row.signature || '',
    syncEnabled: Boolean(row.sync_enabled),
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicMessage(row) {
  if (!row) return null;
  const category = isSmartCategory(row.smart_category) ? row.smart_category : 'primary';
  return {
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    mailbox: row.mailbox,
    uid: row.uid,
    messageId: row.rfc_message_id,
    inReplyTo: row.in_reply_to,
    references: json(row.references_json),
    subject: row.subject || '(no subject)',
    from: { name: row.from_name || '', email: row.from_email || '' },
    to: json(row.to_json),
    cc: json(row.cc_json),
    bcc: json(row.bcc_json),
    replyTo: json(row.reply_to_json, null),
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    htmlBody: row.html_body || '',
    textBody: row.text_body || '',
    snippet: row.snippet || '',
    attachments: json(row.attachments_json).map((attachment, index) => ({
      index: Number.isInteger(attachment?.index) ? attachment.index : index,
      filename: attachment?.filename || attachment?.name || 'attachment',
      contentType: attachment?.contentType || 'application/octet-stream',
      size: Number(attachment?.size) || 0,
      contentId: attachment?.contentId || attachment?.cid || null,
    })),
    labels: json(row.labels_json),
    isRead: Boolean(row.is_read),
    isStarred: Boolean(row.is_starred),
    isArchived: Boolean(row.is_archived),
    isTrashed: Boolean(row.is_trashed),
    isSpam: Boolean(row.is_spam),
    snoozedUntil: row.snoozed_until,
    isSent: Boolean(row.is_sent),
    // Agent-facing counterpart of read/unread: set when an agent (or person)
    // has processed this message. Stored locally; never pushed to IMAP.
    isAnalyzed: Boolean(row.analyzed_at),
    analyzedAt: row.analyzed_at || null,
    analyzedBy: row.analyzed_by || null,
    category,
    categoryLabel: categoryLabel(category),
    categoryReason: row.smart_category_reason || 'No automated category signal matched.',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicThread(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    subject: row.subject || '(no subject)',
    participants: json(row.participants_json),
    snippet: row.snippet || '',
    latestAt: row.latest_at,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    unanalyzedCount: Number(row.unanalyzed_count) || 0,
    isAnalyzed: (Number(row.unanalyzed_count) || 0) === 0,
    isStarred: Boolean(row.is_starred),
    labels: json(row.labels_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicDraft(row, { includeContent = true } = {}) {
  if (!row) return null;
  const attachments = json(row.attachments_json).map((attachment, index) => {
    const meta = {
      index: Number.isInteger(attachment?.index) ? attachment.index : index,
      filename: attachment?.filename || attachment?.name || 'attachment',
      contentType: attachment?.contentType || 'application/octet-stream',
      size: Number(attachment?.size) || 0,
    };
    if (includeContent && attachment?.content) meta.content = attachment.content;
    return meta;
  });
  return {
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    to: json(row.to_json),
    cc: json(row.cc_json),
    bcc: json(row.bcc_json),
    subject: row.subject || '',
    htmlBody: row.html_body || '',
    textBody: row.text_body || '',
    attachments,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      avatar_blob BLOB,
      avatar_mime TEXT,
      color TEXT NOT NULL DEFAULT '#1a73e8',
      provider TEXT NOT NULL DEFAULT 'custom',
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL,
      imap_secure INTEGER NOT NULL DEFAULT 1,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER NOT NULL,
      smtp_secure INTEGER NOT NULL DEFAULT 1,
      credential_ciphertext TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      sync_enabled INTEGER NOT NULL DEFAULT 1,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      subject TEXT NOT NULL DEFAULT '',
      normalized_subject TEXT NOT NULL DEFAULT '',
      participants_json TEXT NOT NULL DEFAULT '[]',
      snippet TEXT NOT NULL DEFAULT '',
      latest_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      unanalyzed_count INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      labels_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_threads_folder ON threads(account_id, latest_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      mailbox TEXT NOT NULL DEFAULT 'INBOX',
      uid INTEGER,
      rfc_message_id TEXT,
      in_reply_to TEXT,
      references_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      from_email TEXT NOT NULL DEFAULT '',
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      bcc_json TEXT NOT NULL DEFAULT '[]',
      reply_to_json TEXT,
      sent_at TEXT,
      received_at TEXT,
      html_body TEXT NOT NULL DEFAULT '',
      text_body TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      labels_json TEXT NOT NULL DEFAULT '[]',
      is_read INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_trashed INTEGER NOT NULL DEFAULT 0,
      is_spam INTEGER NOT NULL DEFAULT 0,
      snoozed_until TEXT,
      is_sent INTEGER NOT NULL DEFAULT 0,
      analyzed_at TEXT,
      analyzed_by TEXT NOT NULL DEFAULT '',
      smart_category TEXT NOT NULL DEFAULT 'primary' CHECK (smart_category IN ('primary', 'github_ci', 'logs', 'status', 'ops_error', 'ops_quiet')),
      smart_category_reason TEXT NOT NULL DEFAULT '',
      smart_category_rule TEXT NOT NULL DEFAULT '',
      smart_category_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, mailbox, uid)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(account_id, mailbox, is_archived, is_trashed, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_rfc_id ON messages(account_id, rfc_message_id);

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      bcc_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL DEFAULT '',
      html_body TEXT NOT NULL DEFAULT '',
      text_body TEXT NOT NULL DEFAULT '',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_account ON drafts(account_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      transports_json TEXT NOT NULL DEFAULT '[]',
      name TEXT NOT NULL DEFAULT 'Passkey',
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      mailbox TEXT NOT NULL,
      last_uid INTEGER NOT NULL DEFAULT 0,
      uid_validity INTEGER,
      last_error TEXT,
      synced_at TEXT,
      PRIMARY KEY (account_id, mailbox)
    );
  `);
  const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name));
  if (!messageColumns.has('is_spam')) db.exec('ALTER TABLE messages ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0');
  if (!messageColumns.has('snoozed_until')) db.exec('ALTER TABLE messages ADD COLUMN snoozed_until TEXT');
  if (!messageColumns.has('smart_category')) db.exec("ALTER TABLE messages ADD COLUMN smart_category TEXT NOT NULL DEFAULT 'primary'");
  if (!messageColumns.has('smart_category_reason')) db.exec("ALTER TABLE messages ADD COLUMN smart_category_reason TEXT NOT NULL DEFAULT ''");
  if (!messageColumns.has('smart_category_rule')) db.exec("ALTER TABLE messages ADD COLUMN smart_category_rule TEXT NOT NULL DEFAULT ''");
  if (!messageColumns.has('smart_category_version')) db.exec('ALTER TABLE messages ADD COLUMN smart_category_version INTEGER NOT NULL DEFAULT 0');
  if (!messageColumns.has('analyzed_at')) db.exec('ALTER TABLE messages ADD COLUMN analyzed_at TEXT');
  if (!messageColumns.has('analyzed_by')) db.exec("ALTER TABLE messages ADD COLUMN analyzed_by TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_smart_category ON messages(account_id, smart_category, sent_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_analyzed ON messages(account_id, analyzed_at)');
  const threadColumns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((column) => column.name));
  if (!threadColumns.has('unanalyzed_count')) {
    db.exec('ALTER TABLE threads ADD COLUMN unanalyzed_count INTEGER NOT NULL DEFAULT 0');
    db.exec(`UPDATE threads SET unanalyzed_count = (
      SELECT COUNT(*) FROM messages WHERE messages.thread_id = threads.id AND messages.analyzed_at IS NULL
    )`);
  }

  // SQLite cannot ALTER a CHECK constraint in place. Rebuild the messages table
  // when an older smart_category check would reject ops_error / ops_quiet.
  const messagesTableSql = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'`).get()?.sql || '');
  const hasLegacyCategoryCheck = /CHECK\s*\(\s*smart_category\s+IN\s*\(\s*'primary'\s*,\s*'github_ci'\s*,\s*'logs'\s*,\s*'status'\s*\)\s*\)/i.test(messagesTableSql);
  if (hasLegacyCategoryCheck) {
    db.pragma('foreign_keys = OFF');
    const rebuildMessages = db.transaction(() => {
      db.exec(`
        CREATE TABLE messages_migrated (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          mailbox TEXT NOT NULL DEFAULT 'INBOX',
          uid INTEGER,
          rfc_message_id TEXT,
          in_reply_to TEXT,
          references_json TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          from_name TEXT NOT NULL DEFAULT '',
          from_email TEXT NOT NULL DEFAULT '',
          to_json TEXT NOT NULL DEFAULT '[]',
          cc_json TEXT NOT NULL DEFAULT '[]',
          bcc_json TEXT NOT NULL DEFAULT '[]',
          reply_to_json TEXT,
          sent_at TEXT,
          received_at TEXT,
          html_body TEXT NOT NULL DEFAULT '',
          text_body TEXT NOT NULL DEFAULT '',
          snippet TEXT NOT NULL DEFAULT '',
          attachments_json TEXT NOT NULL DEFAULT '[]',
          labels_json TEXT NOT NULL DEFAULT '[]',
          is_read INTEGER NOT NULL DEFAULT 0,
          is_starred INTEGER NOT NULL DEFAULT 0,
          is_archived INTEGER NOT NULL DEFAULT 0,
          is_trashed INTEGER NOT NULL DEFAULT 0,
          is_spam INTEGER NOT NULL DEFAULT 0,
          snoozed_until TEXT,
          is_sent INTEGER NOT NULL DEFAULT 0,
          analyzed_at TEXT,
          analyzed_by TEXT NOT NULL DEFAULT '',
          smart_category TEXT NOT NULL DEFAULT 'primary' CHECK (smart_category IN ('primary', 'github_ci', 'logs', 'status', 'ops_error', 'ops_quiet')),
          smart_category_reason TEXT NOT NULL DEFAULT '',
          smart_category_rule TEXT NOT NULL DEFAULT '',
          smart_category_version INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(account_id, mailbox, uid)
        );
        INSERT INTO messages_migrated (
          id, account_id, thread_id, mailbox, uid, rfc_message_id, in_reply_to, references_json,
          subject, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json,
          sent_at, received_at, html_body, text_body, snippet, attachments_json, labels_json,
          is_read, is_starred, is_archived, is_trashed, is_spam, snoozed_until, is_sent,
          analyzed_at, analyzed_by,
          smart_category, smart_category_reason, smart_category_rule, smart_category_version,
          created_at, updated_at
        )
        SELECT
          id, account_id, thread_id, mailbox, uid, rfc_message_id, in_reply_to, references_json,
          subject, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json,
          sent_at, received_at, html_body, text_body, snippet, attachments_json, labels_json,
          is_read, is_starred, is_archived, is_trashed, is_spam, snoozed_until, is_sent,
          analyzed_at, analyzed_by,
          CASE
            WHEN smart_category IN ('primary', 'github_ci', 'logs', 'status', 'ops_error', 'ops_quiet') THEN smart_category
            ELSE 'primary'
          END,
          smart_category_reason, smart_category_rule, smart_category_version,
          created_at, updated_at
        FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_migrated RENAME TO messages;
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, sent_at);
        CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(account_id, mailbox, is_archived, is_trashed, sent_at DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_rfc_id ON messages(account_id, rfc_message_id);
        CREATE INDEX IF NOT EXISTS idx_messages_smart_category ON messages(account_id, smart_category, sent_at DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_analyzed ON messages(account_id, analyzed_at);
      `);
    });
    rebuildMessages();
    db.pragma('foreign_keys = ON');
  }

  // Rules are partly operator-configured (ops-digest sources), so a changed
  // fingerprint reclassifies everything rather than only version-stale rows.
  const fingerprint = smartFilterFingerprint();
  const storedFingerprint = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(SMART_FILTER_FINGERPRINT_SETTING);
  const rulesChanged = json(storedFingerprint?.value_json, null) !== fingerprint;
  const staleMessages = rulesChanged
    ? db.prepare('SELECT id, subject, from_name, from_email, labels_json, snippet, text_body FROM messages').all()
    : db.prepare(`SELECT id, subject, from_name, from_email, labels_json, snippet, text_body
      FROM messages
      WHERE smart_category_version <> ?
        OR smart_category_reason = ''
        OR smart_category_rule = ''
        OR smart_category NOT IN (${SMART_CATEGORY_SLUGS.map(() => '?').join(', ')})`)
      .all(SMART_FILTER_VERSION, ...SMART_CATEGORY_SLUGS);
  if (staleMessages.length) {
    const updateCategory = db.prepare(`UPDATE messages SET
      smart_category = @smart_category,
      smart_category_reason = @smart_category_reason,
      smart_category_rule = @smart_category_rule,
      smart_category_version = @smart_category_version
      WHERE id = @id`);
    db.transaction((messages) => {
      for (const message of messages) {
        const classification = classifyMessage(message);
        updateCategory.run({
          id: message.id,
          smart_category: classification.category,
          smart_category_reason: classification.categoryReason,
          smart_category_rule: classification.rule,
          smart_category_version: classification.version,
        });
      }
    })(staleMessages);
  }
  if (rulesChanged) {
    db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(SMART_FILTER_FINGERPRINT_SETTING, JSON.stringify(fingerprint), now());
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      subject,
      snippet,
      from_name,
      from_email,
      recipients,
      text_body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  // messages_fts is a regular (content-bearing) FTS5 table, so the
  // INSERT ... VALUES('delete', rowid) command is invalid for it: earlier
  // builds installed a trigger using it, which made every DELETE FROM messages
  // fail with "SQL logic error". Replace it with a plain DELETE.
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ad_fts;
    CREATE TRIGGER messages_ad_fts AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
    END;
  `);
  backfillMessagesFts(db);
}

const FTS_BACKFILL_BATCH = 100;

function prepareSqliteTempDir(dataDir) {
  const sqliteTmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(sqliteTmpDir, { recursive: true, mode: 0o700 });
  // The Compose service is read-only with a 64 MiB /tmp tmpfs. FTS rebuilds of a
  // live mailbox can overflow that and crash the process before listen().
  process.env.SQLITE_TMPDIR = sqliteTmpDir;
  return sqliteTmpDir;
}

function backfillMessagesFts(db, { batchSize = FTS_BACKFILL_BATCH } = {}) {
  const ftsCount = db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get()?.count || 0;
  const messageCount = db.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count || 0;
  const ftsColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name));
  const canIndexFts = ['to_json', 'cc_json', 'bcc_json', 'text_body', 'snippet', 'from_name', 'from_email', 'subject']
    .every((column) => ftsColumns.has(column));
  if (!canIndexFts || ftsCount === messageCount) return;

  // delete-all is only valid on contentless/external-content FTS5 tables.
  // This standalone index must be cleared with a normal DELETE.
  db.exec('DELETE FROM messages_fts');
  const selectBatch = db.prepare(`
    SELECT rowid, subject, snippet, from_name, from_email, to_json, cc_json, bcc_json, text_body
    FROM messages
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ?
  `);
  const insertFts = db.prepare(`INSERT INTO messages_fts(
    rowid, subject, snippet, from_name, from_email, recipients, text_body
  ) VALUES (@rowid, @subject, @snippet, @from_name, @from_email, @recipients, @text_body)`);
  const insertBatch = db.transaction((rows) => {
    for (const row of rows) {
      try {
        insertFts.run(ftsDocument(row, json));
      } catch {
        // One unindexable body must not keep the whole inbox from starting.
      }
    }
  });

  let lastRowid = 0;
  for (;;) {
    const rows = selectBatch.all(lastRowid, batchSize);
    if (!rows.length) break;
    insertBatch(rows);
    lastRowid = rows[rows.length - 1].rowid;
  }
}

export function createDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const sqliteTmpDir = prepareSqliteTempDir(config.dataDir);
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma(`temp_store_directory = '${sqliteTmpDir.replace(/'/g, "''")}'`);
  initSchema(db);
  return db;
}

export function createRepositories(db) {
  const queries = {
    accountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    accountByEmail: db.prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE'),
    accountList: db.prepare('SELECT * FROM accounts ORDER BY display_name COLLATE NOCASE, email COLLATE NOCASE'),
    accountInsert: db.prepare(`INSERT INTO accounts (
      id, email, display_name, avatar_blob, avatar_mime, color, provider,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      credential_ciphertext, signature, sync_enabled, created_at, updated_at
    ) VALUES (
      @id, @email, @display_name, @avatar_blob, @avatar_mime, @color, @provider,
      @imap_host, @imap_port, @imap_secure, @smtp_host, @smtp_port, @smtp_secure,
      @credential_ciphertext, @signature, @sync_enabled, @created_at, @updated_at
    )`),
    accountUpdate: db.prepare(`UPDATE accounts SET
      display_name = @display_name, avatar_blob = @avatar_blob, avatar_mime = @avatar_mime,
      color = @color, provider = @provider, imap_host = @imap_host, imap_port = @imap_port,
      imap_secure = @imap_secure, smtp_host = @smtp_host, smtp_port = @smtp_port,
      smtp_secure = @smtp_secure, credential_ciphertext = @credential_ciphertext,
      signature = @signature, sync_enabled = @sync_enabled, updated_at = @updated_at
      WHERE id = @id`),
    accountDelete: db.prepare('DELETE FROM accounts WHERE id = ?'),
    accountSynced: db.prepare('UPDATE accounts SET last_synced_at = ?, updated_at = ? WHERE id = ?'),
    accountAvatar: db.prepare('SELECT avatar_blob, avatar_mime, display_name, email FROM accounts WHERE id = ?'),

    threadById: db.prepare('SELECT * FROM threads WHERE id = ?'),
    threadBySubject: db.prepare('SELECT * FROM threads WHERE account_id = ? AND normalized_subject = ? ORDER BY latest_at DESC LIMIT 1'),
    threadList: db.prepare(`SELECT * FROM threads WHERE account_id = @accountId
      ORDER BY latest_at DESC LIMIT @limit OFFSET @offset`),
    threadInsert: db.prepare(`INSERT INTO threads (
      id, account_id, subject, normalized_subject, participants_json, snippet, latest_at,
      message_count, unread_count, unanalyzed_count, is_starred, labels_json, created_at, updated_at
    ) VALUES (
      @id, @account_id, @subject, @normalized_subject, @participants_json, @snippet, @latest_at,
      @message_count, @unread_count, @unanalyzed_count, @is_starred, @labels_json, @created_at, @updated_at
    )`),
    threadUpdateSummary: db.prepare(`UPDATE threads SET
      subject = @subject, participants_json = @participants_json, snippet = @snippet,
      latest_at = @latest_at, message_count = @message_count, unread_count = @unread_count,
      unanalyzed_count = @unanalyzed_count,
      is_starred = @is_starred, labels_json = @labels_json, updated_at = @updated_at
      WHERE id = @id`),
    messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    messageByRfcId: db.prepare('SELECT * FROM messages WHERE account_id = ? AND rfc_message_id = ? ORDER BY sent_at DESC LIMIT 1'),
    messagesByThread: db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY COALESCE(sent_at, received_at, created_at) ASC'),
    messageList: db.prepare(`SELECT m.* FROM messages m
      WHERE m.account_id = @accountId AND
        CASE @folder
          WHEN 'inbox' THEN m.mailbox = 'INBOX' AND m.is_archived = 0 AND m.is_trashed = 0 AND m.is_spam = 0 AND (m.snoozed_until IS NULL OR m.snoozed_until <= @now)
          WHEN 'starred' THEN m.is_starred = 1 AND m.is_trashed = 0
          WHEN 'sent' THEN m.is_sent = 1 AND m.is_trashed = 0
          WHEN 'drafts' THEN 0
          WHEN 'snoozed' THEN m.snoozed_until > @now AND m.is_trashed = 0 AND m.is_spam = 0
          WHEN 'all' THEN m.is_trashed = 0 AND m.is_spam = 0
          WHEN 'trash' THEN m.is_trashed = 1
          WHEN 'spam' THEN m.is_spam = 1 AND m.is_trashed = 0
          WHEN 'archive' THEN m.is_archived = 1 AND m.is_trashed = 0 AND (m.snoozed_until IS NULL OR m.snoozed_until <= @now)
          ELSE m.mailbox = @mailbox AND m.is_trashed = 0 AND m.is_spam = 0
        END
        AND (@category = '' OR m.smart_category = @category)
        AND (@query = '' OR m.subject LIKE @likeQuery OR m.from_name LIKE @likeQuery OR m.from_email LIKE @likeQuery OR m.snippet LIKE @likeQuery)
      ORDER BY COALESCE(m.sent_at, m.received_at, m.created_at) DESC LIMIT @limit OFFSET @offset`),
    messageCount: db.prepare(`SELECT COUNT(*) AS count FROM messages m
      WHERE m.account_id = @accountId AND
        CASE @folder
          WHEN 'inbox' THEN m.mailbox = 'INBOX' AND m.is_archived = 0 AND m.is_trashed = 0 AND m.is_spam = 0 AND (m.snoozed_until IS NULL OR m.snoozed_until <= @now)
          WHEN 'starred' THEN m.is_starred = 1 AND m.is_trashed = 0
          WHEN 'sent' THEN m.is_sent = 1 AND m.is_trashed = 0
          WHEN 'drafts' THEN 0
          WHEN 'snoozed' THEN m.snoozed_until > @now AND m.is_trashed = 0 AND m.is_spam = 0
          WHEN 'all' THEN m.is_trashed = 0 AND m.is_spam = 0
          WHEN 'trash' THEN m.is_trashed = 1
          WHEN 'spam' THEN m.is_spam = 1 AND m.is_trashed = 0
          WHEN 'archive' THEN m.is_archived = 1 AND m.is_trashed = 0 AND (m.snoozed_until IS NULL OR m.snoozed_until <= @now)
          ELSE m.mailbox = @mailbox AND m.is_trashed = 0 AND m.is_spam = 0
        END
        AND (@category = '' OR m.smart_category = @category)
        AND (@query = '' OR m.subject LIKE @likeQuery OR m.from_name LIKE @likeQuery OR m.from_email LIKE @likeQuery OR m.snippet LIKE @likeQuery)`),
    messageCategoryCounts: db.prepare(`WITH scoped AS (
      SELECT m.*,
        CASE WHEN @query = '' OR m.subject LIKE @likeQuery OR m.from_name LIKE @likeQuery OR m.from_email LIKE @likeQuery OR m.snippet LIKE @likeQuery THEN 1 ELSE 0 END AS query_match
      FROM messages m
      WHERE m.account_id = @accountId AND
        CASE @folder
          WHEN 'inbox' THEN m.mailbox = 'INBOX' AND m.is_archived = 0 AND m.is_trashed = 0 AND m.is_spam = 0 AND (m.snoozed_until IS NULL OR m.snoozed_until <= @now)
          WHEN 'starred' THEN m.is_starred = 1 AND m.is_trashed = 0
          WHEN 'sent' THEN m.is_sent = 1 AND m.is_trashed = 0
          WHEN 'drafts' THEN 0
          WHEN 'snoozed' THEN m.snoozed_until > @now AND m.is_trashed = 0 AND m.is_spam = 0
          WHEN 'all' THEN m.is_trashed = 0 AND m.is_spam = 0
          WHEN 'trash' THEN m.is_trashed = 1
          WHEN 'spam' THEN m.is_spam = 1 AND m.is_trashed = 0
          WHEN 'archive' THEN m.is_archived = 1 AND m.is_trashed = 0 AND (m.snoozed_until IS NULL OR m.snoozed_until <= @now)
          ELSE m.mailbox = @mailbox AND m.is_trashed = 0 AND m.is_spam = 0
        END
    ), ranked AS (
      SELECT smart_category AS category,
        ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY COALESCE(sent_at, received_at, created_at) DESC, id DESC) AS message_rank,
        MAX(query_match) OVER (PARTITION BY thread_id) AS thread_matches
      FROM scoped
    )
    SELECT category, COUNT(*) AS count FROM ranked
      WHERE message_rank = 1 AND (@query = '' OR thread_matches = 1)
      GROUP BY category`),
    // Conversation-level badges for the sidebar: unread inbox threads, starred
    // threads, and drafts. Counts are account-scoped and independent of the list
    // filter so switching folders does not zero out the badges.
    folderBadgeCounts: db.prepare(`SELECT
      (
        SELECT COUNT(*) FROM (
          SELECT thread_id FROM messages
          WHERE account_id = @accountId
            AND mailbox = 'INBOX'
            AND is_archived = 0 AND is_trashed = 0 AND is_spam = 0
            AND is_read = 0
            AND (snoozed_until IS NULL OR snoozed_until <= @now)
            AND smart_category <> 'ops_quiet'
          GROUP BY thread_id
        )
      ) AS inbox,
      (
        SELECT COUNT(*) FROM (
          SELECT thread_id FROM messages
          WHERE account_id = @accountId
            AND is_starred = 1 AND is_trashed = 0
          GROUP BY thread_id
        )
      ) AS starred,
      (
        SELECT COUNT(*) FROM (
          SELECT thread_id FROM messages
          WHERE account_id = @accountId
            AND snoozed_until > @now AND is_trashed = 0 AND is_spam = 0
          GROUP BY thread_id
        )
      ) AS snoozed,
      (SELECT COUNT(*) FROM drafts WHERE account_id = @accountId) AS drafts,
      (
        SELECT COUNT(*) FROM (
          SELECT thread_id FROM messages
          WHERE account_id = @accountId
            AND mailbox = 'INBOX'
            AND is_archived = 0 AND is_trashed = 0 AND is_spam = 0
            AND analyzed_at IS NULL
            AND (snoozed_until IS NULL OR snoozed_until <= @now)
            AND smart_category <> 'ops_quiet'
          GROUP BY thread_id
        )
      ) AS unanalyzed
    `),
    messageInsert: db.prepare(`INSERT INTO messages (
      id, account_id, thread_id, mailbox, uid, rfc_message_id, in_reply_to, references_json,
      subject, from_name, from_email, to_json, cc_json, bcc_json, reply_to_json,
      sent_at, received_at, html_body, text_body, snippet, attachments_json, labels_json,
      is_read, is_starred, is_archived, is_trashed, is_spam, snoozed_until, is_sent,
      smart_category, smart_category_reason, smart_category_rule, smart_category_version,
      created_at, updated_at
    ) VALUES (
      @id, @account_id, @thread_id, @mailbox, @uid, @rfc_message_id, @in_reply_to, @references_json,
      @subject, @from_name, @from_email, @to_json, @cc_json, @bcc_json, @reply_to_json,
      @sent_at, @received_at, @html_body, @text_body, @snippet, @attachments_json, @labels_json,
      @is_read, @is_starred, @is_archived, @is_trashed, @is_spam, @snoozed_until, @is_sent,
      @smart_category, @smart_category_reason, @smart_category_rule, @smart_category_version,
      @created_at, @updated_at
    )`),
    messageUpdate: db.prepare(`UPDATE messages SET
      thread_id = @thread_id, mailbox = @mailbox, uid = @uid, rfc_message_id = @rfc_message_id,
      in_reply_to = @in_reply_to, references_json = @references_json, subject = @subject,
      from_name = @from_name, from_email = @from_email, to_json = @to_json, cc_json = @cc_json,
      bcc_json = @bcc_json, reply_to_json = @reply_to_json, sent_at = @sent_at,
      received_at = @received_at, html_body = @html_body, text_body = @text_body, snippet = @snippet,
      attachments_json = @attachments_json, labels_json = @labels_json, is_read = @is_read,
      is_starred = @is_starred, is_archived = @is_archived, is_trashed = @is_trashed,
      is_spam = @is_spam, snoozed_until = @snoozed_until,
      is_sent = @is_sent, smart_category = @smart_category,
      smart_category_reason = @smart_category_reason, smart_category_rule = @smart_category_rule,
      smart_category_version = @smart_category_version, updated_at = @updated_at
      WHERE id = @id`),
    messageRelocate: db.prepare(`UPDATE messages SET mailbox = @mailbox, uid = @uid, updated_at = @updated_at WHERE id = @id`),
    messageState: db.prepare(`UPDATE messages SET
      is_read = COALESCE(@is_read, is_read),
      is_starred = COALESCE(@is_starred, is_starred),
      is_archived = COALESCE(@is_archived, is_archived),
      is_trashed = COALESCE(@is_trashed, is_trashed),
      is_spam = COALESCE(@is_spam, is_spam),
      snoozed_until = COALESCE(@snoozed_until, snoozed_until),
      analyzed_at = CASE WHEN @analyzed_change = 1 THEN @analyzed_at ELSE analyzed_at END,
      analyzed_by = CASE WHEN @analyzed_change = 1 THEN @analyzed_by ELSE analyzed_by END,
      updated_at = @updated_at
      WHERE id = @id`),
    syncState: db.prepare('SELECT * FROM sync_state WHERE account_id = ? AND mailbox = ?'),
    syncStateUpsert: db.prepare(`INSERT INTO sync_state (account_id, mailbox, last_uid, uid_validity, last_error, synced_at)
      VALUES (@account_id, @mailbox, @last_uid, @uid_validity, @last_error, @synced_at)
      ON CONFLICT(account_id, mailbox) DO UPDATE SET
        last_uid = excluded.last_uid, uid_validity = excluded.uid_validity,
        last_error = excluded.last_error, synced_at = excluded.synced_at`),
    draftById: db.prepare('SELECT * FROM drafts WHERE id = ?'),
    draftList: db.prepare('SELECT * FROM drafts WHERE account_id = ? ORDER BY updated_at DESC'),
    draftListAll: db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC'),
    draftInsert: db.prepare(`INSERT INTO drafts (
      id, account_id, thread_id, to_json, cc_json, bcc_json, subject, html_body,
      text_body, attachments_json, created_at, updated_at
    ) VALUES (
      @id, @account_id, @thread_id, @to_json, @cc_json, @bcc_json, @subject, @html_body,
      @text_body, @attachments_json, @created_at, @updated_at
    )`),
    draftUpdate: db.prepare(`UPDATE drafts SET thread_id = @thread_id, to_json = @to_json,
      cc_json = @cc_json, bcc_json = @bcc_json, subject = @subject, html_body = @html_body,
      text_body = @text_body, attachments_json = @attachments_json, updated_at = @updated_at WHERE id = @id`),
    draftDelete: db.prepare('DELETE FROM drafts WHERE id = ?'),
    settingList: db.prepare('SELECT * FROM settings ORDER BY key'),
    settingByKey: db.prepare('SELECT * FROM settings WHERE key = ?'),
    settingUpsert: db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`),
    messageRow: db.prepare('SELECT rowid, * FROM messages WHERE id = ?'),
    ftsInsert: db.prepare(`INSERT INTO messages_fts(
      rowid, subject, snippet, from_name, from_email, recipients, text_body
    ) VALUES (@rowid, @subject, @snippet, @from_name, @from_email, @recipients, @text_body)`),
    ftsDelete: db.prepare('DELETE FROM messages_fts WHERE rowid = ?'),
    searchThreadIds: db.prepare(`SELECT m.thread_id AS threadId
      FROM messages m
      JOIN messages_fts fts ON fts.rowid = m.rowid
      WHERE m.account_id = @accountId AND
        CASE @folder
          WHEN 'inbox' THEN m.mailbox = 'INBOX' AND m.is_archived = 0 AND m.is_trashed = 0 AND m.is_spam = 0 AND (m.snoozed_until IS NULL OR m.snoozed_until <= @now)
          WHEN 'starred' THEN m.is_starred = 1 AND m.is_trashed = 0
          WHEN 'sent' THEN m.is_sent = 1 AND m.is_trashed = 0
          WHEN 'drafts' THEN 0
          WHEN 'snoozed' THEN m.snoozed_until > @now AND m.is_trashed = 0 AND m.is_spam = 0
          WHEN 'all' THEN m.is_trashed = 0 AND m.is_spam = 0
          WHEN 'trash' THEN m.is_trashed = 1
          WHEN 'spam' THEN m.is_spam = 1 AND m.is_trashed = 0
          WHEN 'archive' THEN m.is_archived = 1 AND m.is_trashed = 0 AND (m.snoozed_until IS NULL OR m.snoozed_until <= @now)
          ELSE m.mailbox = @mailbox AND m.is_trashed = 0 AND m.is_spam = 0
        END
        AND messages_fts MATCH @ftsQuery
      GROUP BY m.thread_id
      ORDER BY MAX(COALESCE(m.sent_at, m.received_at, m.created_at)) DESC
      LIMIT @limit`),
    passkeyById: db.prepare('SELECT * FROM passkeys WHERE id = ?'),
    passkeyList: db.prepare('SELECT * FROM passkeys ORDER BY created_at DESC'),
    passkeyCount: db.prepare('SELECT COUNT(*) AS count FROM passkeys'),
    passkeyInsert: db.prepare(`INSERT INTO passkeys (
      id, public_key, counter, device_type, backed_up, transports_json, name, created_at, last_used_at
    ) VALUES (
      @id, @public_key, @counter, @device_type, @backed_up, @transports_json, @name, @created_at, @last_used_at
    )`),
    passkeyTouch: db.prepare('UPDATE passkeys SET counter = @counter, last_used_at = @last_used_at WHERE id = @id'),
    passkeyDelete: db.prepare('DELETE FROM passkeys WHERE id = ?'),
  };

  const syncFts = (id) => {
    const row = queries.messageRow.get(id);
    if (!row) return;
    queries.ftsDelete.run(row.rowid);
    queries.ftsInsert.run(ftsDocument(row, json));
  };

  const recomputeThread = db.transaction((threadId) => {
    const thread = queries.threadById.get(threadId);
    if (!thread) return null;
    const messages = queries.messagesByThread.all(threadId);
    if (!messages.length) return null;
    const newest = messages.at(-1);
    const participants = [...new Map(messages.flatMap((message) => {
      const from = message.from_email ? [{ name: message.from_name, email: message.from_email }] : [];
      return [...from, ...json(message.to_json)];
    }).filter((item) => item?.email).map((item) => [item.email.toLowerCase(), item])).values()];
    const labels = [...new Set(messages.flatMap((message) => json(message.labels_json)))];
    queries.threadUpdateSummary.run({
      id: threadId,
      subject: newest.subject || thread.subject,
      participants_json: stringify(participants),
      snippet: newest.snippet || '',
      latest_at: newest.sent_at || newest.received_at || newest.created_at,
      message_count: messages.length,
      unread_count: messages.filter((message) => !message.is_read).length,
      unanalyzed_count: messages.filter((message) => !message.analyzed_at).length,
      is_starred: messages.some((message) => message.is_starred) ? 1 : 0,
      labels_json: stringify(labels),
      updated_at: now(),
    });
    return queries.threadById.get(threadId);
  });

  return {
    accounts: {
      list: () => queries.accountList.all().map(publicAccount),
      get: (id) => publicAccount(queries.accountById.get(id)),
      getRaw: (id) => queries.accountById.get(id) || null,
      getByEmailRaw: (email) => queries.accountByEmail.get(email) || null,
      create(input) {
        const id = randomUUID();
        const timestamp = now();
        queries.accountInsert.run({ id, created_at: timestamp, updated_at: timestamp, ...input });
        return publicAccount(queries.accountById.get(id));
      },
      update(id, input) {
        const existing = queries.accountById.get(id);
        if (!existing) return null;
        queries.accountUpdate.run({ ...existing, ...input, id, updated_at: now() });
        return publicAccount(queries.accountById.get(id));
      },
      remove: (id) => queries.accountDelete.run(id).changes > 0,
      markSynced(id) {
        const timestamp = now();
        queries.accountSynced.run(timestamp, timestamp, id);
      },
      avatar: (id) => queries.accountAvatar.get(id) || null,
    },
    messages: {
      get: (id) => publicMessage(queries.messageById.get(id)),
      getRaw: (id) => queries.messageById.get(id) || null,
      list({ accountId, folder = 'inbox', mailbox = 'INBOX', query = '', category = '', limit = 50, offset = 0 }) {
        const params = {
          accountId,
          folder,
          mailbox,
          query,
          category: category ? String(category) : '',
          likeQuery: `%${query}%`,
          limit,
          offset,
          now: now(),
        };
        const items = queries.messageList.all(params).map(publicMessage);
        return { items, total: queries.messageCount.get(params).count };
      },
      categoryCounts({ accountId, folder = 'inbox', mailbox = 'INBOX', query = '' }) {
        const counts = Object.fromEntries(SMART_CATEGORY_SLUGS.map((category) => [category, 0]));
        const rows = queries.messageCategoryCounts.all({
          accountId,
          folder,
          mailbox,
          query,
          likeQuery: `%${query}%`,
          now: now(),
        });
        for (const row of rows) {
          if (isSmartCategory(row.category)) counts[row.category] = row.count;
        }
        return counts;
      },
      folderCounts(accountId) {
        const row = queries.folderBadgeCounts.get({ accountId, now: now() }) || {};
        return {
          inbox: Number(row.inbox) || 0,
          starred: Number(row.starred) || 0,
          snoozed: Number(row.snoozed) || 0,
          drafts: Number(row.drafts) || 0,
          unanalyzed: Number(row.unanalyzed) || 0,
        };
      },
      forThread: (threadId) => queries.messagesByThread.all(threadId).map(publicMessage),
      findByRfcId: (accountId, messageId) => publicMessage(queries.messageByRfcId.get(accountId, messageId)),
      upsert: db.transaction((input) => {
        const classification = classifyMessage(input);
        const classifiedInput = {
          ...input,
          smart_category: classification.category,
          smart_category_reason: classification.categoryReason,
          smart_category_rule: classification.rule,
          smart_category_version: classification.version,
        };
        const byUid = classifiedInput.uid === null || classifiedInput.uid === undefined
          ? null
          : db.prepare('SELECT * FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?')
            .get(classifiedInput.account_id, classifiedInput.mailbox, classifiedInput.uid);
        // A MOVE without UIDPLUS cannot tell us the destination UID. Reusing an
        // RFC Message-ID here prevents a later mailbox sync from duplicating it.
        const existing = byUid || (classifiedInput.rfc_message_id
          ? queries.messageByRfcId.get(classifiedInput.account_id, classifiedInput.rfc_message_id)
          : null);
        const timestamp = now();
        const row = { ...classifiedInput, updated_at: timestamp };
        if (existing) {
          row.id = existing.id;
          queries.messageUpdate.run(row);
          recomputeThread(existing.thread_id);
          if (existing.thread_id !== row.thread_id) recomputeThread(row.thread_id);
          syncFts(existing.id);
          return publicMessage(queries.messageById.get(existing.id));
        }
        row.id ||= randomUUID();
        row.created_at ||= timestamp;
        queries.messageInsert.run(row);
        recomputeThread(row.thread_id);
        syncFts(row.id);
        return publicMessage(queries.messageById.get(row.id));
      }),
      setState(id, state) {
        const row = queries.messageById.get(id);
        if (!row) return null;
        queries.messageState.run({
          id,
          updated_at: now(),
          is_read: state.isRead === undefined ? null : Number(Boolean(state.isRead)),
          is_starred: state.isStarred === undefined ? null : Number(Boolean(state.isStarred)),
          is_archived: state.isArchived === undefined ? null : Number(Boolean(state.isArchived)),
          is_trashed: state.isTrashed === undefined ? null : Number(Boolean(state.isTrashed)),
          is_spam: state.isSpam === undefined ? null : Number(Boolean(state.isSpam)),
          snoozed_until: state.snoozedUntil === undefined ? null : state.snoozedUntil,
          analyzed_change: state.isAnalyzed === undefined ? 0 : 1,
          analyzed_at: state.isAnalyzed ? (state.analyzedAt || now()) : null,
          analyzed_by: state.isAnalyzed ? String(state.analyzedBy || '').slice(0, 120) : '',
        });
        recomputeThread(row.thread_id);
        return publicMessage(queries.messageById.get(id));
      },
      relocate(id, { mailbox, uid }) {
        const row = queries.messageById.get(id);
        if (!row) return null;
        queries.messageRelocate.run({ id, mailbox, uid, updated_at: now() });
        return publicMessage(queries.messageById.get(id));
      },
      searchThreadIds({ accountId, folder = 'inbox', mailbox = 'INBOX', ftsQuery, limit = 500 }) {
        if (!ftsQuery) return [];
        return queries.searchThreadIds.all({
          accountId,
          folder,
          mailbox,
          ftsQuery,
          limit,
          now: now(),
        }).map((row) => row.threadId);
      },
      forThreads(threadIds = [], { folder = '', mailbox = 'INBOX' } = {}) {
        const ids = [...new Set(threadIds.filter(Boolean))];
        if (!ids.length) return [];
        const sql = `SELECT * FROM messages WHERE thread_id IN (${ids.map(() => '?').join(',')})
          ${folder ? `AND CASE ?
            WHEN 'inbox' THEN mailbox = 'INBOX' AND is_archived = 0 AND is_trashed = 0 AND is_spam = 0 AND (snoozed_until IS NULL OR snoozed_until <= ?)
            WHEN 'starred' THEN is_starred = 1 AND is_trashed = 0
            WHEN 'sent' THEN is_sent = 1 AND is_trashed = 0
            WHEN 'drafts' THEN 0
            WHEN 'snoozed' THEN snoozed_until > ? AND is_trashed = 0 AND is_spam = 0
            WHEN 'all' THEN is_trashed = 0 AND is_spam = 0
            WHEN 'trash' THEN is_trashed = 1
            WHEN 'spam' THEN is_spam = 1 AND is_trashed = 0
            WHEN 'archive' THEN is_archived = 1 AND is_trashed = 0 AND (snoozed_until IS NULL OR snoozed_until <= ?)
            ELSE mailbox = ? AND is_trashed = 0 AND is_spam = 0
          END` : ''}
          ORDER BY COALESCE(sent_at, received_at, created_at) ASC`;
        const statement = db.prepare(sql);
        const nowValue = now();
        const params = folder
          ? [...ids, folder, nowValue, nowValue, nowValue, mailbox]
          : ids;
        return statement.all(...params).map(publicMessage);
      },
    },
    threads: {
      get: (id) => publicThread(queries.threadById.get(id)),
      findBySubject: (accountId, subject) => publicThread(queries.threadBySubject.get(accountId, subject)),
      list: ({ accountId, limit = 50, offset = 0 }) => queries.threadList.all({ accountId, limit, offset }).map(publicThread),
      create(input) {
        const id = randomUUID();
        const timestamp = now();
        queries.threadInsert.run({
          id,
          participants_json: '[]',
          snippet: '',
          message_count: 0,
          unread_count: 0,
          unanalyzed_count: 0,
          is_starred: 0,
          labels_json: '[]',
          created_at: timestamp,
          updated_at: timestamp,
          ...input,
        });
        return publicThread(queries.threadById.get(id));
      },
      recompute: (id) => publicThread(recomputeThread(id)),
    },
    sync: {
      get: (accountId, mailbox) => queries.syncState.get(accountId, mailbox) || null,
      save: (state) => queries.syncStateUpsert.run(state),
    },
    drafts: {
      get: (id) => publicDraft(queries.draftById.get(id), { includeContent: true }),
      list: (accountId) => queries.draftList.all(accountId).map((row) => publicDraft(row, { includeContent: false })),
      listAll: () => queries.draftListAll.all().map((row) => publicDraft(row, { includeContent: false })),
      create(input) {
        const id = randomUUID();
        const timestamp = now();
        queries.draftInsert.run({ id, created_at: timestamp, updated_at: timestamp, ...input });
        return publicDraft(queries.draftById.get(id));
      },
      update(id, input) {
        const existing = queries.draftById.get(id);
        if (!existing) return null;
        queries.draftUpdate.run({ ...existing, ...input, id, updated_at: now() });
        return publicDraft(queries.draftById.get(id));
      },
      remove: (id) => queries.draftDelete.run(id).changes > 0,
    },
    settings: {
      list: () => Object.fromEntries(queries.settingList.all().map((row) => [row.key, json(row.value_json, null)])),
      get: (key) => {
        const row = queries.settingByKey.get(key);
        return row ? json(row.value_json, null) : undefined;
      },
      set: (key, value) => queries.settingUpsert.run(key, JSON.stringify(value), now()),
    },
    passkeys: {
      listRaw: () => queries.passkeyList.all(),
      getRaw: (id) => queries.passkeyById.get(id) || null,
      count: () => Number(queries.passkeyCount.get()?.count) || 0,
      create(input) {
        const timestamp = now();
        queries.passkeyInsert.run({
          ...input,
          created_at: timestamp,
          last_used_at: null,
        });
        return queries.passkeyById.get(input.id);
      },
      touch(id, counter) {
        queries.passkeyTouch.run({ id, counter, last_used_at: now() });
        return queries.passkeyById.get(id);
      },
      remove: (id) => queries.passkeyDelete.run(id).changes > 0,
    },
    close: () => db.close(),
  };
}

export { json, stringify, now, publicAccount, publicMessage, publicThread, publicDraft };
