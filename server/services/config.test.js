import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, parseOpsSources, readEnv, resolveDbPath } from '../config.js';

const MIB = 1024 * 1024;

test('IMAP message download cap has a safe default and bounded configuration range', () => {
  assert.equal(loadConfig({}).syncMaxMessageBytes, 10 * MIB);
  assert.equal(loadConfig({ AMAIL_SYNC_MAX_MESSAGE_BYTES: String(64 * 1024) }).syncMaxMessageBytes, 64 * 1024);
  assert.equal(loadConfig({ AMAIL_SYNC_MAX_MESSAGE_BYTES: String(50 * MIB) }).syncMaxMessageBytes, 50 * MIB);

  for (const invalid of ['not-a-number', String(64 * 1024 - 1), String(50 * MIB + 1)]) {
    assert.equal(loadConfig({ AMAIL_SYNC_MAX_MESSAGE_BYTES: invalid }).syncMaxMessageBytes, 10 * MIB);
  }
});

test('release SHA is exposed only when it is a full commit identifier', () => {
  const release = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  assert.equal(loadConfig({}).releaseSha, null);
  assert.equal(loadConfig({ AMAIL_RELEASE_SHA: 'abc123' }).releaseSha, null);
  assert.equal(loadConfig({ AMAIL_RELEASE_SHA: release }).releaseSha, release.toLowerCase());
});

test('GigaMail-era GIGAMAIL_* variables keep working as a fallback', () => {
  assert.equal(readEnv({ GIGAMAIL_ACCESS_TOKEN: 'legacy' }, 'ACCESS_TOKEN'), 'legacy');
  assert.equal(readEnv({ GIGAMAIL_ACCESS_TOKEN: 'legacy', AMAIL_ACCESS_TOKEN: 'modern' }, 'ACCESS_TOKEN'), 'modern');
  assert.equal(readEnv({ AMAIL_ACCESS_TOKEN: '' }, 'ACCESS_TOKEN', 'fallback'), 'fallback');
  assert.equal(loadConfig({ GIGAMAIL_ACCESS_TOKEN: 'legacy-token' }).accessToken, 'legacy-token');
  assert.equal(loadConfig({ GIGAMAIL_TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(loadConfig({ SYNC_INTERVAL_MINUTES: '7' }).syncIntervalMinutes, 7);
  assert.equal(loadConfig({ AMAIL_SYNC_INTERVAL_MINUTES: '3', SYNC_INTERVAL_MINUTES: '7' }).syncIntervalMinutes, 3);
});

test('the database path prefers amail.sqlite but keeps using an existing GigaMail database', () => {
  const dataDir = '/data';
  const files = new Set();
  const exists = (file) => files.has(file);
  assert.equal(resolveDbPath(dataDir, { exists }), path.join(dataDir, 'amail.sqlite'));
  files.add(path.join(dataDir, 'gigamail.sqlite'));
  assert.equal(resolveDbPath(dataDir, { exists }), path.join(dataDir, 'gigamail.sqlite'));
  files.add(path.join(dataDir, 'amail.sqlite'));
  assert.equal(resolveDbPath(dataDir, { exists }), path.join(dataDir, 'amail.sqlite'));
});

test('WebAuthn origin and RP ID come only from explicit configuration', () => {
  assert.equal(loadConfig({}).webauthnRpId, '');
  assert.deepEqual(loadConfig({}).webauthnOrigins, []);
  assert.equal(loadConfig({ NODE_ENV: 'production' }).webauthnRpId, '');
  assert.deepEqual(loadConfig({ NODE_ENV: 'production' }).webauthnOrigins, []);
  assert.equal(
    loadConfig({ NODE_ENV: 'production', AMAIL_RP_ID: 'mail.example.test', AMAIL_ORIGIN: 'https://mail.example.test' }).webauthnRpId,
    'mail.example.test',
  );
  assert.equal(loadConfig({ GIGAMAIL_RP_ID: 'mail.example.test' }).webauthnRpId, 'mail.example.test');
  assert.deepEqual(
    loadConfig({ AMAIL_ORIGIN: 'https://mail.example.test,http://localhost:5173' }).webauthnOrigins,
    ['https://mail.example.test', 'http://localhost:5173'],
  );
  assert.equal(loadConfig({}).webauthnRpName, 'aMail');
});

test('ops-digest sources default to common homelab tools and can be replaced or disabled', () => {
  assert.deepEqual(loadConfig({}).opsSources, ['proxmox', 'watchtower']);
  assert.deepEqual(parseOpsSources('Proxmox, nightly-backup ,proxmox'), ['proxmox', 'nightly-backup']);
  assert.deepEqual(parseOpsSources(''), []);
  assert.deepEqual(loadConfig({ AMAIL_OPS_SOURCES: '' }).opsSources, []);
  assert.deepEqual(loadConfig({ AMAIL_OPS_SOURCES: 'uptime kuma' }).opsSources, ['uptime kuma']);
});

test('density controls default to a 60s sync floor, an 8-minute IMAP pool, and no body retention', () => {
  assert.equal(loadConfig({}).syncMinIntervalMs, 60_000);
  assert.equal(loadConfig({}).imapPoolIdleMs, 8 * 60_000);
  assert.equal(loadConfig({}).retainDays, 0);
  assert.equal(loadConfig({}).syncBatchSize, 200);
  assert.equal(loadConfig({}).syncMaxMessageBytes, 10 * MIB);
  assert.equal(loadConfig({}).syncIntervalMinutes, 0);
  assert.equal(loadConfig({ AMAIL_SYNC_MIN_INTERVAL_MS: '0' }).syncMinIntervalMs, 0);
  assert.equal(loadConfig({ AMAIL_IMAP_POOL_IDLE_MS: '120000' }).imapPoolIdleMs, 120_000);
  assert.equal(loadConfig({ AMAIL_RETAIN_DAYS: '30' }).retainDays, 30);
});

test('sync throughput controls default to a 60s page budget, 3 accounts at once, and a 10-minute deadline', () => {
  assert.equal(loadConfig({}).syncPassBudgetMs, 60_000);
  assert.equal(loadConfig({}).syncConcurrency, 3);
  assert.equal(loadConfig({}).syncAccountTimeoutMs, 10 * 60_000);
  assert.equal(loadConfig({ AMAIL_KEY_MODE: 'keyslot' }).syncConcurrency, 1);
  assert.equal(loadConfig({ AMAIL_SYNC_PASS_BUDGET_MS: '0' }).syncPassBudgetMs, 0);
  assert.equal(loadConfig({ AMAIL_SYNC_CONCURRENCY: '6' }).syncConcurrency, 6);
  assert.equal(loadConfig({ GIGAMAIL_SYNC_ACCOUNT_TIMEOUT_MS: '0' }).syncAccountTimeoutMs, 0);
});

test('keyslot mode uses the hosted density profile unless explicit env overrides it', () => {
  const hosted = loadConfig({ AMAIL_KEY_MODE: 'keyslot' });
  assert.equal(hosted.syncBatchSize, 100);
  assert.equal(hosted.syncMaxMessageBytes, 5 * MIB);
  assert.equal(hosted.syncIntervalMinutes, 15);
  assert.equal(hosted.logLevel, 'error');
  assert.equal(hosted.syncMinIntervalMs, 60_000);
  assert.equal(hosted.imapPoolIdleMs, 8 * 60_000);
  assert.equal(hosted.retainDays, 0);
  assert.equal(loadConfig({ AMAIL_KEY_MODE: 'keyslot', AMAIL_SYNC_BATCH_SIZE: '200' }).syncBatchSize, 200);
  assert.equal(loadConfig({ AMAIL_KEY_MODE: 'keyslot', AMAIL_SYNC_MAX_MESSAGE_BYTES: String(10 * MIB) }).syncMaxMessageBytes, 10 * MIB);
  assert.equal(loadConfig({ AMAIL_KEY_MODE: 'keyslot', SYNC_INTERVAL_MINUTES: '5' }).syncIntervalMinutes, 5);
  assert.equal(loadConfig({ AMAIL_KEY_MODE: 'keyslot', LOG_LEVEL: 'info' }).logLevel, 'info');
});
