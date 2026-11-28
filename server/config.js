import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LOG_LEVEL, normalizeLogLevel } from './logging.js';
import { deriveSubkey } from './services/crypto.js';
import { parseAuthHeaders, parseHostAllowlist } from './services/attachment-fetch.js';
import { parseAuthservIdList } from './services/auth-results.js';
import { parseWebhookAllowHosts, parseWebhookEventList } from './services/webhook-delivery.js';

export const APP_NAME = 'aMail';
export const APP_VERSION = '0.1.0';
export const DATABASE_KEY_INFO = 'amail/database-key/v1';
export const SESSION_COOKIE = 'amail_session';
/** Cookie name used by GigaMail-era deployments; still accepted for auth. */
export const LEGACY_SESSION_COOKIE = 'gigamail_session';
export const DB_FILENAME = 'amail.sqlite';
const LEGACY_DB_FILENAME = 'gigamail.sqlite';

const boolean = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const integer = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

function deriveKey(value) {
  if (!value) return null;

  // Accepting a passphrase rather than exposing a base64-only requirement makes
  // deployment secrets easier to manage. SHA-256 gives AES-256 a stable 32-byte key.
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Read `AMAIL_<name>`, falling back to the GigaMail-era `GIGAMAIL_<name>` so an
 * existing `.env` keeps working after upgrading.
 */
export function readEnv(env, name, fallback = undefined) {
  const modern = env[`AMAIL_${name}`];
  if (modern !== undefined && modern !== '') return modern;
  const legacy = env[`GIGAMAIL_${name}`];
  if (legacy !== undefined && legacy !== '') return legacy;
  return fallback;
}

/**
 * Prefer the aMail database filename, but keep opening a GigaMail-era database
 * in place so upgrades never leave existing mail behind.
 */
export function resolveDbPath(dataDir, { exists = fs.existsSync } = {}) {
  const modern = path.join(dataDir, DB_FILENAME);
  const legacy = path.join(dataDir, LEGACY_DB_FILENAME);
  if (!exists(modern) && exists(legacy)) return legacy;
  return modern;
}

const RELEASE_SHA_RE = /^[0-9a-f]{40}$/;
const BAKED_RELEASE_SHA_PATH = '/app/RELEASE_SHA';

function parseReleaseSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return RELEASE_SHA_RE.test(sha) ? sha : null;
}

function readBakedReleaseSha(filePath) {
  if (!filePath) return null;
  try {
    return parseReleaseSha(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function loadConfig(env = process.env, options = {}) {
  const dataDir = path.resolve(readEnv(env, 'DATA_DIR') || path.join(process.cwd(), 'data'));
  const encryptionKey = readEnv(env, 'ENCRYPTION_KEY');
  const credentialKey = deriveKey(encryptionKey);
  const remoteTokenKey = deriveKey(readEnv(env, 'REMOTE_TOKEN_KEY') || encryptionKey);
  // Runtime AMAIL_RELEASE_SHA wins when it is a full commit. Compose always
  // forwards ${AMAIL_RELEASE_SHA:-}, which is empty when unset and would
  // override an image ENV — so the image also bakes /app/RELEASE_SHA.
  const releaseSha = parseReleaseSha(readEnv(env, 'RELEASE_SHA'))
    || readBakedReleaseSha(options.bakedReleaseShaPath ?? BAKED_RELEASE_SHA_PATH);
  // Whole-database encryption is opt-in for self-hosted installs because an
  // existing plaintext file is migrated in place on the first keyed boot.
  const encryptDatabase = boolean(readEnv(env, 'ENCRYPT_DATABASE'));
  // `env` (default) keys everything from AMAIL_ENCRYPTION_KEY and gates access
  // with AMAIL_ACCESS_TOKEN. `keyslot` is the hosted model: the container boots
  // locked and every key derives from a DEK that only a keyslot credential can
  // unwrap. Both modes run from the same image.
  const keyMode = String(readEnv(env, 'KEY_MODE') || 'env').trim().toLowerCase() === 'keyslot' ? 'keyslot' : 'env';
  const keyslotMode = keyMode === 'keyslot';
  const keyModeConflicts = keyslotMode
    ? ['ENCRYPTION_KEY', 'ACCESS_TOKEN', 'REMOTE_TOKEN_KEY', 'ENCRYPT_DATABASE'].filter((name) => readEnv(env, name) !== undefined)
    : [];
  const webauthnOrigins = String(readEnv(env, 'ORIGIN') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const mib = 1024 * 1024;

  return Object.freeze({
    appName: APP_NAME,
    env: env.NODE_ENV || 'development',
    // A local default makes a fresh install safe. The container explicitly sets
    // HOST=0.0.0.0 while Compose binds the published port to loopback.
    host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 3000, { min: 1, max: 65535 }),
    dataDir,
    dbPath: resolveDbPath(dataDir),
    staticDir: path.resolve(readEnv(env, 'STATIC_DIR') || path.join(process.cwd(), 'dist')),
    releaseSha,
    credentialKey: keyslotMode ? null : credentialKey,
    remoteTokenKey: keyslotMode ? null : remoteTokenKey,
    encryptDatabase: keyslotMode ? true : encryptDatabase,
    databaseKey: !keyslotMode && encryptDatabase && encryptionKey ? deriveSubkey(encryptionKey, DATABASE_KEY_INFO) : null,
    accessToken: keyslotMode ? null : (readEnv(env, 'ACCESS_TOKEN') || null),
    keyMode,
    keyModeConflicts,
    // Keyslot mode only. The provision secret authorizes the one-time
    // /api/keyslots/init call; the escrow key is the operator KEK an opted-in
    // tenant's DEK is wrapped under; the handoff socket passes the DEK between
    // an old and a new process during a deploy.
    provisionSecret: keyslotMode ? (readEnv(env, 'PROVISION_SECRET') || null) : null,
    escrowKey: keyslotMode ? (readEnv(env, 'ESCROW_KEY') || null) : null,
    handoffSocket: keyslotMode ? (readEnv(env, 'HANDOFF_SOCKET') || null) : null,
    handoffSecret: keyslotMode ? (readEnv(env, 'HANDOFF_SECRET') || null) : null,
    // This intentionally stays false unless a reverse proxy has been selected by
    // the operator. Trusting arbitrary forwarded headers is unsafe by default.
    trustProxy: boolean(readEnv(env, 'TRUST_PROXY')),
    allowInsecureTls: boolean(readEnv(env, 'ALLOW_INSECURE_TLS')),
    // Protected accounts may be reviewed and marked analyzed locally, but
    // message flags, moves and sending (including Sent APPEND) are forbidden.
    imapWriteProtectedAccounts: (readEnv(env, 'IMAP_WRITE_PROTECTED_ACCOUNTS') || '')
      .split(',').map((email) => email.trim().toLowerCase()).filter(Boolean),
    cookieSecure: boolean(readEnv(env, 'COOKIE_SECURE'), true),
    // Hosted (keyslot) defaults are the density profile: a smaller first-sync
    // window, a 5 MiB parse cap, a 15-minute unattended poll, and error-only
    // logs. Explicit env still wins. Self-hosted `env` mode keeps the OSS
    // defaults so an existing .env is unchanged.
    syncBatchSize: integer(readEnv(env, 'SYNC_BATCH_SIZE'), keyslotMode ? 100 : 200, { min: 1, max: 1000 }),
    syncTimeoutMs: integer(readEnv(env, 'SYNC_TIMEOUT_MS'), 60_000, { min: 5_000, max: 300_000 }),
    imapConnectTimeoutMs: integer(readEnv(env, 'IMAP_CONNECT_TIMEOUT_MS'), 20_000, { min: 3_000, max: 120_000 }),
    syncMailboxTimeoutMs: integer(readEnv(env, 'SYNC_MAILBOX_TIMEOUT_MS'), 45_000, { min: 0, max: 10 * 60_000 }),
    syncMaxMessagesPerAccount: integer(readEnv(env, 'SYNC_MAX_MESSAGES_PER_ACCOUNT'), 500, { min: 1, max: 10_000 }),
    eventLoopLagMs: integer(readEnv(env, 'EVENT_LOOP_LAG_MS'), 1_500, { min: 50, max: 30_000 }),
    eventLoopStallLogMs: integer(readEnv(env, 'EVENT_LOOP_STALL_LOG_MS'), 3_000, { min: 200, max: 60_000 }),
    // The raw RFC822 source includes attachments. Keep each parse bounded so a
    // single unexpectedly large message cannot consume unrestricted memory.
    syncMaxMessageBytes: integer(readEnv(env, 'SYNC_MAX_MESSAGE_BYTES'), keyslotMode ? 5 * mib : 10 * mib, {
      min: 64 * 1024,
      max: 50 * 1024 * 1024,
    }),
    // Floor applied to every syncAll/syncAccount (including old clients and
    // MCP). Inside this window the previous result is returned. 0 disables.
    // Manual refresh passes force=true to bypass it.
    syncMinIntervalMs: integer(readEnv(env, 'SYNC_MIN_INTERVAL_MS'), 60_000, { min: 0, max: 3_600_000 }),
    // A mailbox with more new mail than one SYNC_BATCH_SIZE page keeps paging
    // (oldest first) until this much time has passed, then resumes next pass.
    syncPassBudgetMs: integer(readEnv(env, 'SYNC_PASS_BUDGET_MS'), 60_000, { min: 0, max: 30 * 60_000 }),
    // Accounts synchronized in parallel, each on its own IMAP session.
    syncConcurrency: integer(readEnv(env, 'SYNC_CONCURRENCY'), keyslotMode ? 1 : 3, { min: 1, max: 16 }),
    // Hard stop for one account's pass; its socket is closed so a server that
    // stops answering cannot stall every later sync. 0 disables.
    syncAccountTimeoutMs: integer(readEnv(env, 'SYNC_ACCOUNT_TIMEOUT_MS'), 120_000, { min: 0, max: 60 * 60_000 }),
    // Keep one IMAP TCP session per account this long after the last use so
    // the next pass skips the TLS handshake. 0 logs out immediately (tests).
    imapPoolIdleMs: integer(readEnv(env, 'IMAP_POOL_IDLE_MS'), 8 * 60_000, { min: 0, max: 30 * 60_000 }),
    // Phase logs for health, listings, and IMAP passes. CPU_PROF also asks
    // the image entrypoint to add Node --cpu-prof.
    debugTiming: boolean(readEnv(env, 'DEBUG_TIMING'), false) || boolean(env.AMAIL_DEBUG_TIMING, false),
    cpuProf: boolean(readEnv(env, 'CPU_PROF'), false) || boolean(env.AMAIL_CPU_PROF, false),
    // Parse + SQLCipher writes on a worker thread. Tests turn this off.
    syncWorker: boolean(readEnv(env, 'SYNC_WORKER'), env.NODE_ENV !== 'test'),
    // Conversation search and get_thread SQLCipher reads on a dedicated
    // worker. A hang here used to freeze the HTTP event loop for minutes.
    searchReadWorker: boolean(readEnv(env, 'SEARCH_READ_WORKER'), env.NODE_ENV !== 'test'),
    searchQueryDeadlineMs: integer(readEnv(env, 'SEARCH_QUERY_DEADLINE_MS'), 10_000, { min: 50, max: 120_000 }),
    // 0 disables background polling. Otherwise this is the full-folder pass
    // (Sent, Drafts, and the rest). New inbox mail does not wait for it:
    // pooled IMAP IDLE pushes, and a 60-second UIDNEXT probe is the fallback.
    // Hosted defaults the full pass to 15 minutes.
    syncIntervalMinutes: integer(
      readEnv(env, 'SYNC_INTERVAL_MINUTES', env.SYNC_INTERVAL_MINUTES),
      keyslotMode ? 15 : 0,
      { min: 0, max: 1440 },
    ),
    // 0 keeps bodies forever. Operators may set AMAIL_RETAIN_DAYS to drop
    // html_body/text_body older than that (headers, snippet, flags stay).
    retainDays: integer(readEnv(env, 'RETAIN_DAYS'), 0, { min: 0, max: 3650 }),
    remoteContentMaxBytes: integer(readEnv(env, 'REMOTE_CONTENT_MAX_BYTES'), 5 * 1024 * 1024, {
      min: 16 * 1024,
      max: 25 * 1024 * 1024,
    }),
    remoteContentTimeoutMs: integer(readEnv(env, 'REMOTE_CONTENT_TIMEOUT_MS'), 12_000, {
      min: 1_000,
      max: 60_000,
    }),
    // Capability URLs can be used by an unauthenticated <img> request, so keep
    // them deliberately short-lived. Reading a message reissues fresh tokens.
    remoteContentTokenTtlSeconds: integer(readEnv(env, 'REMOTE_CONTENT_TOKEN_TTL'), 5 * 60, {
      min: 30,
      max: 60 * 60,
    }),
    // REMOTE_CONTENT_PROXY_URL is deliberately not read from the conventional
    // HTTP_PROXY variables: only privacy image requests should use Tor/Privoxy.
    remoteContentProxyUrl: env.REMOTE_CONTENT_PROXY_URL || readEnv(env, 'REMOTE_CONTENT_PROXY_URL') || null,
    // Direct fetches reveal the server IP. They are intentionally available only
    // as an explicit non-production development escape hatch.
    allowDirectRemoteContent: (env.NODE_ENV || 'development') !== 'production'
      && boolean(readEnv(env, 'ALLOW_DIRECT_REMOTE_CONTENT')),
    // Attach-by-URL for drafts (save_draft `url` attachments). Off until the
    // operator lists hosts; https only, public addresses only. See
    // docs/drafts.md, "Attaching files by URL".
    draftAttachmentUrlHosts: parseHostAllowlist(readEnv(env, 'DRAFT_ATTACHMENT_URL_HOSTS')),
    // JSON {"host": {"Header": "value"}}; null when the value is not valid JSON.
    draftAttachmentUrlAuth: parseAuthHeaders(readEnv(env, 'DRAFT_ATTACHMENT_URL_AUTH')),
    draftAttachmentFetchTimeoutMs: integer(readEnv(env, 'DRAFT_ATTACHMENT_FETCH_TIMEOUT_MS'), 20_000, {
      min: 1_000,
      max: 120_000,
    }),
    // Receiving-server names (authserv-ids) whose Authentication-Results
    // headers are believed for every account, on top of each account's own
    // list and the provider defaults. See docs/webhooks.md.
    trustedAuthservIds: parseAuthservIdList(readEnv(env, 'TRUSTED_AUTHSERV_IDS')),
    // message.received is announced only for mail received this recently, so
    // a first sync or a re-import never floods webhook and SSE subscribers.
    eventRecencyMs: integer(readEnv(env, 'EVENT_RECENCY_HOURS'), 24, { min: 1, max: 24 * 365 }) * 60 * 60 * 1000,
    // Outbound webhooks. Subscriptions live in the database (REST/MCP); these
    // three define one static subscription for deployments with no UI step.
    // Nothing is sent, queued or resolved while no subscription exists.
    webhookUrl: String(readEnv(env, 'WEBHOOK_URL') || '').trim() || null,
    webhookSecret: readEnv(env, 'WEBHOOK_SECRET') || null,
    webhookEvents: parseWebhookEventList(readEnv(env, 'WEBHOOK_EVENTS')),
    // Exact hosts (names or IP literals) a webhook may target even though they
    // are private, loopback or plain http. Empty: public https only.
    webhookAllowHosts: parseWebhookAllowHosts(readEnv(env, 'WEBHOOK_ALLOW_HOSTS')),
    webhookTimeoutMs: integer(readEnv(env, 'WEBHOOK_TIMEOUT_MS'), 10_000, { min: 1_000, max: 60_000 }),
    // Consecutive events that ran out of retries before a subscription is
    // switched off. 0 never switches one off.
    webhookMaxConsecutiveFailures: integer(readEnv(env, 'WEBHOOK_MAX_CONSECUTIVE_FAILURES'), 20, { min: 0, max: 10_000 }),
    // Undelivered events kept per subscription; the oldest is dropped beyond it.
    webhookMaxQueue: integer(readEnv(env, 'WEBHOOK_MAX_QUEUE'), 1_000, { min: 1, max: 100_000 }),
    // Finished deliveries kept per subscription for GET /api/webhooks/:id.
    webhookDeliveryLogSize: integer(readEnv(env, 'WEBHOOK_DELIVERY_LOG_SIZE'), 100, { min: 1, max: 5_000 }),
    // `error` is the hosted profile: failures only, no per-request entries.
    logLevel: normalizeLogLevel(env.LOG_LEVEL, keyslotMode ? 'error' : DEFAULT_LOG_LEVEL),
    // Hosted-only usage metering. Unset means no-op: nothing is buffered or
    // sent. The endpoint receives analyzed counts and timestamps, nothing else.
    meteringUrl: parseHttpUrl(readEnv(env, 'METERING_URL')),
    meteringToken: readEnv(env, 'METERING_TOKEN') || null,
    // Opaque identifier the metering endpoint uses to attribute events.
    tenantId: String(readEnv(env, 'TENANT_ID') || '').trim().slice(0, 128) || null,
    webauthnRpName: readEnv(env, 'RP_NAME') || APP_NAME,
    // Passkeys must match the public HTTPS origin. Behind a reverse proxy the
    // container usually sees an internal Host, so operators pin these explicitly;
    // when unset, the RP ID and origin are derived from each request.
    webauthnRpId: String(readEnv(env, 'RP_ID') || '').trim(),
    webauthnOrigins,
    // OAuth discovery must publish one stable issuer. Reuse the first public
    // WebAuthn origin so existing reverse-proxy deployments need no new secret
    // or setting; local development derives it from the request Host instead.
    publicOrigin: webauthnOrigins.map((value) => {
      try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
      } catch {
        return null;
      }
    }).find(Boolean) || null,
    // Keywords that identify routine infrastructure digests (Proxmox, Watchtower,
    // a backup job, ...). Matching mail is hidden from the default inbox unless it
    // reports a failure, which surfaces under "Ops errors".
    opsSources: parseOpsSources(env.AMAIL_OPS_SOURCES ?? env.GIGAMAIL_OPS_SOURCES),
    // auto uses Typesense when AMAIL_TYPESENSE_URL is set and the SQLite file
    // is not encrypted. off/fts keeps FTS inside the database. typesense forces
    // the external index even next to SQLCipher (the index is plaintext).
    searchEngine: normalizeSearchEngine(readEnv(env, 'SEARCH_ENGINE')),
    typesenseUrl: parseHttpUrl(readEnv(env, 'TYPESENSE_URL')),
    typesenseApiKey: readEnv(env, 'TYPESENSE_API_KEY') || null,
  });
}

function normalizeSearchEngine(value) {
  const mode = String(value || 'auto').trim().toLowerCase();
  return ['auto', 'typesense', 'off', 'fts'].includes(mode) ? mode : 'auto';
}

/** Accept only absolute http(s) URLs; anything else disables the feature. */
export function parseHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export const DEFAULT_OPS_SOURCES = Object.freeze(['proxmox', 'watchtower']);

/**
 * `AMAIL_OPS_SOURCES` is a comma-separated keyword list. Each keyword becomes a
 * source id; an empty string disables ops-digest detection entirely.
 */
export function parseOpsSources(value) {
  if (value === undefined || value === null) return [...DEFAULT_OPS_SOURCES];
  const keywords = String(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z0-9][a-z0-9 _./-]{0,63}$/.test(item));
  return [...new Set(keywords)];
}
