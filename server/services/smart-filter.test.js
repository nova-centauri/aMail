import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { createDatabase, createRepositories } from '../db.js';
import {
  SMART_CATEGORY_SLUGS,
  SMART_FILTER_VERSION,
  classifyMessage,
  configureSmartFilter,
  normalizeEmailAddress,
  smartFilterFingerprint,
} from './smart-filter.js';
import { messageMatchesPersonFlag, normalizePersonFlags } from './person-flags.js';

const makeTempDatabase = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-smart-filter-'));
  return { dataDir, dbPath: path.join(dataDir, 'mail.sqlite') };
};

test('smart filtering is deterministic, explainable, and gives GitHub precedence over failure wording', () => {
  const cases = [
    {
      message: { from_email: 'notifications@github.com', subject: '[acme/api] Workflow run failed' },
      category: 'github_ci',
      rule: 'github.sender',
    },
    {
      message: { from_email: 'alerts@datadoghq.com', subject: 'Monitor triggered: API latency' },
      category: 'logs',
      rule: 'logs.sender',
    },
    {
      message: { from_email: 'logs@mail.example.test', subject: 'Nightly backup completed with 3 warnings' },
      category: 'logs',
      rule: 'logs.sender_local_part',
    },
    {
      message: { from_email: 'updates@statuspage.io', subject: 'Scheduled maintenance completed' },
      category: 'status',
      rule: 'status.sender',
    },
    {
      message: { from_name: 'GitHub Status', from_email: 'notify@githubstatus.com', subject: 'Critical incident resolved' },
      category: 'status',
      rule: 'status.sender',
    },
    {
      message: {
        from_email: 'friend@example.com',
        subject: 'Can you send a status update?',
        text_body: 'We can look through the logs together tomorrow.',
      },
      category: 'primary',
      rule: 'primary.default',
    },
    {
      message: { from_email: 'watchtower@home.lab', subject: 'Watchtower update report: all containers up to date' },
      category: 'ops_quiet',
      rule: 'ops_quiet.watchtower',
    },
    {
      message: { from_email: 'root@proxmox.local', subject: 'Proxmox backup failed on pve-1' },
      category: 'ops_error',
      rule: 'ops_error.proxmox',
    },
    {
      // Not a configured ops source: ordinary keyword rules apply instead.
      message: { from_email: 'jobs@example-digest.test', subject: 'Daily digest' },
      category: 'primary',
      rule: 'primary.default',
    },
  ];

  assert.deepEqual(SMART_CATEGORY_SLUGS, ['primary', 'github_ci', 'logs', 'status', 'ops_error', 'ops_quiet']);
  for (const { message, category, rule } of cases) {
    const first = classifyMessage(message);
    const second = classifyMessage({ ...message });
    assert.deepEqual(second, first);
    assert.equal(first.category, category);
    assert.equal(first.rule, rule);
    assert.equal(first.version, SMART_FILTER_VERSION);
    assert.ok(first.categoryLabel);
    assert.match(first.categoryReason, /\S/);
  }
});

test('ops-digest sources are operator-configurable and change the rule fingerprint', (t) => {
  const defaultFingerprint = smartFilterFingerprint();
  t.after(() => configureSmartFilter({ opsSources: ['proxmox', 'watchtower'] }));

  configureSmartFilter({ opsSources: ['nightly-backup'] });
  assert.notEqual(smartFilterFingerprint(), defaultFingerprint);
  assert.equal(classifyMessage({ from_email: 'root@proxmox.local', subject: 'Proxmox backup failed on pve-1' }).category, 'logs');
  const quiet = classifyMessage({ from_email: 'cron@example.test', subject: 'nightly-backup completed successfully' });
  assert.equal(quiet.category, 'ops_quiet');
  assert.equal(quiet.rule, 'ops_quiet.nightly_backup');
  const failed = classifyMessage({ from_email: 'cron@example.test', subject: 'nightly-backup failed: exit code 1' });
  assert.equal(failed.category, 'ops_error');

  configureSmartFilter({ opsSources: [] });
  assert.equal(classifyMessage({ from_email: 'watchtower@home.lab', subject: 'Watchtower update report: all containers up to date' }).category, 'primary');
});

test('person flags are validated, canonicalized, and match any address role', () => {
  assert.equal(normalizeEmailAddress('Ada <Ada@Example.test>'), 'ada@example.test');
  const flags = normalizePersonFlags([
    { label: 'Ada Lovelace', emails: ['ada@example.test', 'Ada.L@example.test'] },
    { id: 'Support Desk', label: 'Support', emails: 'support@example.test, help@example.test' },
  ]);
  assert.equal(flags[0].id, 'ada-lovelace');
  assert.deepEqual(flags[0].emails, ['ada@example.test', 'ada.l@example.test']);
  assert.equal(flags[1].id, 'support-desk');
  assert.deepEqual(flags[1].emails, ['support@example.test', 'help@example.test']);
  assert.ok(messageMatchesPersonFlag({ from_email: 'ada@example.test', to_json: '[{"email":"me@example.test"}]' }, flags[0]));
  assert.ok(messageMatchesPersonFlag({ from_email: 'boss@example.test', to: [{ email: 'help@example.test' }] }, flags[1]));
  assert.ok(messageMatchesPersonFlag({ from_email: 'client@example.test', cc: [{ email: 'Ada.L@example.test' }] }, flags[0]));
  assert.equal(messageMatchesPersonFlag({ from_email: 'stranger@example.test' }, flags[1]), false);
  assert.throws(() => normalizePersonFlags([{ label: 'No addresses', emails: [] }]), /at least one email/);
  assert.throws(() => normalizePersonFlags([{ label: 'Bad', emails: ['not-an-email'] }]), /not a valid email/);
  assert.throws(() => normalizePersonFlags([{ label: 'Dup', emails: ['a@example.test'] }, { label: 'dup', emails: ['b@example.test'] }]), /unique/);
});

test('existing databases gain category columns and old messages are classified on startup', (t) => {
  const config = makeTempDatabase();
  const legacy = new Database(config.dbPath);
  legacy.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      mailbox TEXT NOT NULL DEFAULT 'INBOX',
      rfc_message_id TEXT,
      subject TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      from_email TEXT NOT NULL DEFAULT '',
      labels_json TEXT NOT NULL DEFAULT '[]',
      snippet TEXT NOT NULL DEFAULT '',
      text_body TEXT NOT NULL DEFAULT '',
      sent_at TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_trashed INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO messages (
      id, account_id, thread_id, mailbox, rfc_message_id, subject,
      from_name, from_email, labels_json, snippet, text_body, sent_at
    ) VALUES (
      'legacy-message', 'legacy-account', 'legacy-thread', 'INBOX', '<legacy@example.test>',
      '[acme/api] Build passed', 'GitHub', 'notifications@github.com', '[]', '', '',
      '2026-01-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const db = createDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name));
  for (const column of ['smart_category', 'smart_category_reason', 'smart_category_rule', 'smart_category_version']) {
    assert.ok(columns.has(column), `expected migrated column ${column}`);
  }
  const row = db.prepare(`SELECT smart_category, smart_category_reason, smart_category_rule, smart_category_version
    FROM messages WHERE id = ?`).get('legacy-message');
  assert.equal(row.smart_category, 'github_ci');
  assert.equal(row.smart_category_rule, 'github.sender');
  assert.equal(row.smart_category_version, SMART_FILTER_VERSION);
  assert.match(row.smart_category_reason, /GitHub/);
});

test('message repository persists public category metadata and supports filtering and counts', (t) => {
  const config = makeTempDatabase();
  const db = createDatabase(config);
  const repos = createRepositories(db);
  t.after(() => {
    repos.close();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  const account = repos.accounts.create({
    email: 'owner@example.test',
    display_name: 'Owner',
    avatar_blob: null,
    avatar_mime: null,
    color: '#1a73e8',
    provider: 'custom',
    imap_host: 'imap.example.test',
    imap_port: 993,
    imap_secure: 1,
    smtp_host: 'smtp.example.test',
    smtp_port: 465,
    smtp_secure: 1,
    credential_ciphertext: 'test-only',
    signature: '',
    sync_enabled: 1,
  });

  const samples = [
    ['Personal note', 'friend@example.test', 'primary'],
    ['[acme/api] Check run failed', 'notifications@github.com', 'github_ci'],
    ['[FIRING:1] API error rate exceeded', 'alertmanager@example.test', 'logs'],
    ['Scheduled maintenance completed', 'updates@statuspage.io', 'status'],
  ];

  let primaryThreadId;
  let githubThreadId;
  for (const [index, [subject, fromEmail, expectedCategory]] of samples.entries()) {
    const timestamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
    const thread = repos.threads.create({
      account_id: account.id,
      subject,
      normalized_subject: subject.toLowerCase(),
      latest_at: timestamp,
    });
    if (expectedCategory === 'primary') primaryThreadId = thread.id;
    if (expectedCategory === 'github_ci') githubThreadId = thread.id;
    const message = repos.messages.upsert({
      account_id: account.id,
      thread_id: thread.id,
      mailbox: 'INBOX',
      uid: index + 1,
      rfc_message_id: `<message-${index + 1}@example.test>`,
      in_reply_to: null,
      references_json: '[]',
      subject,
      from_name: '',
      from_email: fromEmail,
      to_json: '[]',
      cc_json: '[]',
      bcc_json: '[]',
      reply_to_json: null,
      sent_at: timestamp,
      received_at: timestamp,
      html_body: '',
      text_body: '',
      snippet: '',
      attachments_json: '[]',
      labels_json: '[]',
      is_read: 0,
      is_starred: 0,
      is_archived: 0,
      is_trashed: 0,
      is_spam: 0,
      snoozed_until: null,
      is_sent: 0,
    });
    assert.equal(message.category, expectedCategory);
    assert.ok(message.categoryLabel);
    assert.match(message.categoryReason, /\S/);
  }

  // Category badges describe conversations, not the number of messages inside
  // each conversation.
  repos.messages.upsert({
    account_id: account.id,
    thread_id: primaryThreadId,
    mailbox: 'INBOX',
    uid: 99,
    rfc_message_id: '<primary-followup@example.test>',
    in_reply_to: null,
    references_json: '[]',
    subject: 'Re: Personal note',
    from_name: '',
    from_email: 'friend@example.test',
    to_json: '[]',
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: '2026-01-05T00:00:00.000Z',
    received_at: '2026-01-05T00:00:00.000Z',
    html_body: '',
    text_body: '',
    snippet: '',
    attachments_json: '[]',
    labels_json: '[]',
    is_read: 0,
    is_starred: 0,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    snoozed_until: null,
    is_sent: 0,
  });

  repos.messages.upsert({
    account_id: account.id,
    thread_id: githubThreadId,
    mailbox: 'INBOX',
    uid: 100,
    rfc_message_id: '<human-ci-followup@example.test>',
    in_reply_to: null,
    references_json: '[]',
    subject: 'Re: Check run failed — looking now',
    from_name: '',
    from_email: 'teammate@example.test',
    to_json: '[]',
    cc_json: '[]',
    bcc_json: '[]',
    reply_to_json: null,
    sent_at: '2026-01-06T00:00:00.000Z',
    received_at: '2026-01-06T00:00:00.000Z',
    html_body: '',
    text_body: '',
    snippet: '',
    attachments_json: '[]',
    labels_json: '[]',
    is_read: 0,
    is_starred: 0,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    snoozed_until: null,
    is_sent: 0,
  });

  const github = repos.messages.list({ accountId: account.id, category: 'github_ci' });
  assert.equal(github.total, 1);
  assert.equal(github.items[0].category, 'github_ci');
  assert.deepEqual(repos.messages.categoryCounts({ accountId: account.id }), {
    primary: 2,
    github_ci: 0,
    logs: 1,
    status: 1,
    ops_error: 0,
    ops_quiet: 0,
  });
});
