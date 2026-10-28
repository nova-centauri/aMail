import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OAUTH_STATE_FILENAME = 'oauth.json';

const FILE_VERSION = 1;
const MAX_CLIENTS = 500;
const MAX_CODES = 1_000;
const MAX_TOKENS = 2_000;

export class OAuthStoreCapacityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OAuthStoreCapacityError';
  }
}

export function oauthTokenHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('base64url');
}

function emptyFile() {
  return {
    version: FILE_VERSION,
    createdAt: new Date().toISOString(),
    clients: [],
    codes: [],
    tokens: [],
  };
}

function copy(value) {
  return value == null ? value : structuredClone(value);
}

function isExpired(record, timestamp = Date.now()) {
  const expiresAt = Date.parse(record?.expiresAt || '');
  return !Number.isFinite(expiresAt) || expiresAt <= timestamp;
}

/**
 * Small file-backed OAuth state store.
 *
 * The file sits next to the encrypted mail database because OAuth discovery,
 * refresh, and bearer checks must work while a keyslot-mode harness is locked.
 * It contains public client metadata and SHA-256 hashes of high-entropy codes
 * and tokens, never the credentials themselves.
 */
export function createOAuthStore({ dataDir, filePath = path.join(dataDir, OAUTH_STATE_FILENAME) }) {
  let cache = null;
  let cachedSignature = null;
  const signatureOf = (stat) => `${stat.mtimeMs}:${stat.size}:${stat.ino}`;

  function read() {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      cache = emptyFile();
      cachedSignature = null;
      return cache;
    }
    if (cache && cachedSignature === signatureOf(stat)) return cache;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (
      parsed?.version !== FILE_VERSION
      || !Array.isArray(parsed.clients)
      || !Array.isArray(parsed.codes)
      || !Array.isArray(parsed.tokens)
    ) {
      throw new Error('The OAuth state file has an unsupported format.');
    }
    cache = parsed;
    cachedSignature = signatureOf(stat);
    return cache;
  }

  function write(data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
    cache = data;
    cachedSignature = signatureOf(fs.statSync(filePath));
  }

  function mutate(updater) {
    const data = structuredClone(read());
    const result = updater(data);
    write(data);
    return result;
  }

  function registerClient(metadata) {
    return mutate((data) => {
      if (data.clients.length >= MAX_CLIENTS) {
        const active = new Set([...data.codes, ...data.tokens].filter((record) => !isExpired(record)).map((record) => record.clientId));
        const removable = data.clients
          .filter((client) => !active.has(client.id))
          .sort((left, right) => Date.parse(left.lastUsedAt || left.createdAt) - Date.parse(right.lastUsedAt || right.createdAt));
        const removeIds = new Set(removable.slice(0, Math.max(1, data.clients.length - MAX_CLIENTS + 1)).map((client) => client.id));
        data.clients = data.clients.filter((client) => !removeIds.has(client.id));
      }
      if (data.clients.length >= MAX_CLIENTS) {
        throw new OAuthStoreCapacityError('Too many OAuth clients are registered. Remove stale OAuth state before registering another client.');
      }
      const timestamp = new Date().toISOString();
      const client = {
        id: `amail_client_${crypto.randomBytes(24).toString('base64url')}`,
        ...copy(metadata),
        createdAt: timestamp,
        lastUsedAt: timestamp,
      };
      data.clients.push(client);
      return copy(client);
    });
  }

  function getClient(id) {
    return copy(read().clients.find((client) => client.id === id) || null);
  }

  function touchClient(id) {
    return mutate((data) => {
      const client = data.clients.find((item) => item.id === id);
      if (!client) return false;
      client.lastUsedAt = new Date().toISOString();
      return true;
    });
  }

  function saveCode(code, record) {
    return mutate((data) => {
      data.codes = data.codes.filter((item) => !isExpired(item));
      if (data.codes.length >= MAX_CODES) throw new OAuthStoreCapacityError('Too many OAuth authorization requests are pending.');
      data.codes.push({ digest: oauthTokenHash(code), ...copy(record) });
      return true;
    });
  }

  /** Authorization codes are one-use: the first redemption attempt consumes it. */
  function consumeCode(code) {
    return mutate((data) => {
      const digest = oauthTokenHash(code);
      const index = data.codes.findIndex((item) => item.digest === digest);
      if (index < 0) return null;
      const [record] = data.codes.splice(index, 1);
      return isExpired(record) ? null : copy(record);
    });
  }

  function saveToken(token, record) {
    return mutate((data) => {
      data.tokens = data.tokens.filter((item) => !isExpired(item));
      if (data.tokens.length >= MAX_TOKENS) throw new OAuthStoreCapacityError('Too many OAuth tokens are active.');
      data.tokens.push({ digest: oauthTokenHash(token), ...copy(record) });
      return true;
    });
  }

  function getToken(token, type) {
    const digest = oauthTokenHash(token);
    const record = read().tokens.find((item) => item.digest === digest && item.type === type);
    return record && !isExpired(record) ? copy(record) : null;
  }

  function consumeToken(token, type) {
    return mutate((data) => {
      const digest = oauthTokenHash(token);
      const index = data.tokens.findIndex((item) => item.digest === digest && item.type === type);
      if (index < 0) return null;
      const [record] = data.tokens.splice(index, 1);
      return isExpired(record) ? null : copy(record);
    });
  }

  function revokeToken(token) {
    return mutate((data) => {
      const digest = oauthTokenHash(token);
      const removed = data.tokens.filter((item) => item.digest === digest);
      data.tokens = data.tokens.filter((item) => item.digest !== digest);
      return copy(removed);
    });
  }

  function removeToken(token, type) {
    return mutate((data) => {
      const digest = oauthTokenHash(token);
      const removed = data.tokens.filter((item) => item.digest === digest && item.type === type);
      data.tokens = data.tokens.filter((item) => !(item.digest === digest && item.type === type));
      return copy(removed);
    });
  }

  function prune(timestamp = Date.now()) {
    return mutate((data) => {
      const expiredTokens = data.tokens.filter((item) => isExpired(item, timestamp));
      data.codes = data.codes.filter((item) => !isExpired(item, timestamp));
      data.tokens = data.tokens.filter((item) => !isExpired(item, timestamp));
      return expiredTokens.map((item) => item.slotId).filter(Boolean);
    });
  }

  return {
    filePath,
    registerClient,
    getClient,
    touchClient,
    saveCode,
    consumeCode,
    saveToken,
    getToken,
    consumeToken,
    revokeToken,
    removeToken,
    prune,
  };
}
