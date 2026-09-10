import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LOG_LEVEL, normalizeLogLevel } from './logging.js';
import { deriveSubkey } from './services/crypto.js';

export const APP_NAME = 'aMail';
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

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(readEnv(env, 'DATA_DIR') || path.join(process.cwd(), 'data'));
  const encryptionKey = readEnv(env, 'ENCRYPTION_KEY');
  const credentialKey = deriveKey(encryptionKey);
  const remoteTokenKey = deriveKey(readEnv(env, 'REMOTE_TOKEN_KEY') || encryptionKey);
  const releaseSha = String(readEnv(env, 'RELEASE_SHA') || '');
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
    releaseSha: /^[0-9a-f]{40}$/i.test(releaseSha) ? releaseSha.toLowerCase() : null,
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
    cookieSecure: boolean(readEnv(env, 'COOKIE_SECURE'), true),
    // Hosted (keyslot) defaults are the density profile: a smaller first-sync
    // window, a 5 MiB parse cap, a 15-minute unattended poll, and error-only
    // logs. Explicit env still wins. Self-hosted `env` mode keeps the OSS
    // defaults so an existing .env is unchanged.
    syncBatchSize: integer(readEnv(env, 'SYNC_BATCH_SIZE'), keyslotMode ? 100 : 200, { min: 1, max: 1000 }),
    syncTimeoutMs: integer(readEnv(env, 'SYNC_TIMEOUT_MS'), 60_000, { min: 5_000, max: 300_000 }),
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
    // Keep one IMAP TCP session per account this long after the last use so
    // the next pass skips the TLS handshake. 0 logs out immediately (tests).
    imapPoolIdleMs: integer(readEnv(env, 'IMAP_POOL_IDLE_MS'), 8 * 60_000, { min: 0, max: 30 * 60_000 }),
    // 0 disables background polling. Hosted defaults to 15. A focused tab
    // polls GET /api/changes; IMAP IDLE on the pooled INBOX connection is the
    // push path for new mail between polls.
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
    webauthnOrigins: String(readEnv(env, 'ORIGIN') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    // Keywords that identify routine infrastructure digests (Proxmox, Watchtower,
    // a backup job, ...). Matching mail is hidden from the default inbox unless it
    // reports a failure, which surfaces under "Ops errors".
    opsSources: parseOpsSources(env.AMAIL_OPS_SOURCES ?? env.GIGAMAIL_OPS_SOURCES),
  });
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
