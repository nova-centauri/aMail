import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../errors.js';

/**
 * Keyslots: the LUKS-style key model for a hosted aMail harness.
 *
 * One random data-encryption key (DEK) protects the whole SQLite file and the
 * keys derived from it. The DEK is never stored bare. Each credential the
 * tenant holds wraps it once into a keyslot:
 *
 *   token      an MCP/REST bearer token; verifying the token *is* unwrapping
 *   passphrase a human passphrase for the UI (scrypt-stretched)
 *   recovery   a recovery code shown once at provisioning
 *   passkey    a WebAuthn credential whose PRF output wraps the DEK
 *   escrow     opt-in: wrapped under the operator's KEK so the container can
 *              unlock itself after a restart
 *
 * The keyslot file must be readable while the database is locked, so it lives
 * beside the database as plaintext JSON containing only ciphertext, salts,
 * nonces, and non-secret metadata. Losing every slot loses the local cache,
 * never the mail: the tenant's IMAP servers remain the source of truth.
 */

export const KEYSLOT_FILENAME = 'keyslots.json';
export const KEYSLOT_TYPES = Object.freeze(['token', 'passphrase', 'recovery', 'passkey', 'escrow']);
export const DEK_BYTES = 32;
const FILE_VERSION = 1;
const WRAP_INFO = 'amail/keyslot-wrap/v1';
const TOKEN_PREFIX = 'amk1_';
const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const MIN_PASSPHRASE_LENGTH = 12;
// Crockford-style alphabet without the characters people confuse for each other.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const RECOVERY_GROUPS = 6;
const RECOVERY_GROUP_LENGTH = 5;

export class KeyslotError extends AppError {
  constructor(message, code = 'KEYSLOT_INVALID', status = 401) {
    super(message, { status, code, expose: true });
  }
}

const b64 = (buffer) => Buffer.from(buffer).toString('base64url');
const unb64 = (value) => Buffer.from(String(value || ''), 'base64url');

export function generateDek() {
  return crypto.randomBytes(DEK_BYTES);
}

export function generateToken() {
  return `${TOKEN_PREFIX}${b64(crypto.randomBytes(32))}`;
}

export function looksLikeToken(value) {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX) && value.length >= TOKEN_PREFIX.length + 40;
}

export function generateRecoveryCode() {
  const groups = [];
  for (let group = 0; group < RECOVERY_GROUPS; group += 1) {
    let text = '';
    for (let index = 0; index < RECOVERY_GROUP_LENGTH; index += 1) {
      text += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    groups.push(text);
  }
  return groups.join('-');
}

/** Case-insensitive, separator-insensitive, and forgiving of O/0 and I/1/L. */
export function normalizeRecoveryCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function looksLikeRecoveryCode(value) {
  const normalized = normalizeRecoveryCode(value);
  return normalized.length === RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH;
}

function normalizePassphrase(value) {
  return String(value || '').normalize('NFKC').trim();
}

function secretBytes(type, secret) {
  if (Buffer.isBuffer(secret)) return secret;
  switch (type) {
    case 'recovery':
      return Buffer.from(normalizeRecoveryCode(secret), 'utf8');
    case 'passphrase':
      return Buffer.from(normalizePassphrase(secret), 'utf8');
    default:
      return Buffer.from(String(secret ?? ''), 'utf8');
  }
}

function wrappingKey(slot, secret) {
  const material = secretBytes(slot.type, secret);
  if (!material.length) throw new KeyslotError('A credential is required.', 'KEYSLOT_CREDENTIAL_REQUIRED', 400);
  const salt = unb64(slot.salt);
  if (slot.kdf === 'scrypt') {
    const params = { ...SCRYPT_PARAMS, ...(slot.kdfParams || {}) };
    return crypto.scryptSync(material, salt, 32, params);
  }
  return Buffer.from(crypto.hkdfSync('sha256', material, salt, Buffer.from(WRAP_INFO, 'utf8'), 32));
}

function aad(slot) {
  return Buffer.from(`${slot.id}:${slot.type}`, 'utf8');
}

/**
 * Wrap the DEK under a credential. Low-entropy passphrases go through scrypt;
 * everything else (random tokens, recovery codes, PRF outputs, the operator
 * KEK) is already high-entropy and uses HKDF.
 */
export function wrapDek(dek, { id, type, secret, label = '', extra = {} }) {
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) throw new KeyslotError('DEK must be 32 bytes.', 'DEK_MALFORMED', 500);
  if (!KEYSLOT_TYPES.includes(type)) throw new ValidationError('Unknown keyslot type.');
  const slot = {
    id: id || crypto.randomUUID(),
    type,
    label: String(label || '').slice(0, 80),
    kdf: type === 'passphrase' ? 'scrypt' : 'hkdf',
    ...(type === 'passphrase' ? { kdfParams: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p } } : {}),
    salt: b64(crypto.randomBytes(32)),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    ...extra,
  };
  const key = wrappingKey(slot, secret);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(slot));
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  slot.nonce = b64(nonce);
  slot.tag = b64(cipher.getAuthTag());
  slot.wrapped = b64(wrapped);
  return slot;
}

/** Returns the DEK, or null when the credential does not fit this slot. */
export function unwrapDek(slot, secret) {
  if (!slot?.wrapped || !slot.nonce || !slot.tag || !slot.salt) return null;
  let key;
  try {
    key = wrappingKey(slot, secret);
  } catch {
    return null;
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(slot.nonce));
    decipher.setAAD(aad(slot));
    decipher.setAuthTag(unb64(slot.tag));
    const dek = Buffer.concat([decipher.update(unb64(slot.wrapped)), decipher.final()]);
    return dek.length === DEK_BYTES ? dek : null;
  } catch {
    return null;
  }
}

export function publicKeyslot(slot) {
  if (!slot) return null;
  return {
    id: slot.id,
    type: slot.type,
    label: slot.label || '',
    createdAt: slot.createdAt,
    lastUsedAt: slot.lastUsedAt || null,
    // A passkey slot registered without PRF support cannot unlock yet.
    ...(slot.type === 'passkey' ? { canUnlock: Boolean(slot.wrapped), passkeyId: slot.passkey?.id || null } : {}),
  };
}

function emptyFile() {
  return { version: FILE_VERSION, createdAt: new Date().toISOString(), userHandle: null, slots: [] };
}

/**
 * File-backed keyslot store with atomic writes. The file is re-read when its
 * mtime changes so an out-of-band provisioning step is picked up without a
 * restart.
 */
export function createKeyslotStore({ dataDir, filePath = path.join(dataDir, KEYSLOT_FILENAME) }) {
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
    if (parsed?.version !== FILE_VERSION || !Array.isArray(parsed.slots)) {
      throw new KeyslotError('The keyslot file has an unsupported format.', 'KEYSLOT_FILE_INVALID', 500);
    }
    cache = parsed;
    cachedSignature = signatureOf(stat);
    return cache;
  }

  function write(data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
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

  const store = {
    filePath,
    initialized: () => read().slots.length > 0,
    slots: () => read().slots.map((slot) => ({ ...slot })),
    list: () => read().slots.map(publicKeyslot),
    get: (id) => read().slots.find((slot) => slot.id === id) || null,
    ofType: (type) => read().slots.filter((slot) => slot.type === type),
    add(slot) {
      return mutate((data) => {
        if (data.slots.some((existing) => existing.id === slot.id)) throw new ConflictError('Keyslot id already exists.');
        data.slots.push(slot);
        return publicKeyslot(slot);
      });
    },
    update(id, patch) {
      return mutate((data) => {
        const slot = data.slots.find((existing) => existing.id === id);
        if (!slot) throw new NotFoundError('Keyslot not found.');
        Object.assign(slot, patch);
        return publicKeyslot(slot);
      });
    },
    touch(id) {
      // Bookkeeping only; a failed write must never block an unlock.
      try {
        store.update(id, { lastUsedAt: new Date().toISOString() });
      } catch {
        // ignore
      }
    },
    remove(id) {
      return mutate((data) => {
        const index = data.slots.findIndex((slot) => slot.id === id);
        if (index < 0) return false;
        const remaining = data.slots.filter((slot, position) => position !== index && slot.type !== 'escrow' && slot.wrapped);
        if (!remaining.length) {
          throw new ConflictError('Refusing to delete the last credential that can unlock this harness. Add another keyslot first.');
        }
        data.slots.splice(index, 1);
        return true;
      });
    },
    /** Stable WebAuthn user handle kept outside the encrypted database. */
    userHandle() {
      const current = read().userHandle;
      if (typeof current === 'string' && current.length >= 16) return Buffer.from(current, 'base64url');
      const generated = crypto.randomBytes(32).toString('base64url');
      mutate((data) => {
        data.userHandle = generated;
      });
      return Buffer.from(generated, 'base64url');
    },
  };
  return store;
}

/**
 * Adapter so the passkey service can persist WebAuthn credentials in the
 * keyslot file (they must be verifiable while the database is locked).
 */
export function passkeyStoreFromKeyslots(store) {
  const rowOf = (slot) => (slot?.type === 'passkey' && slot.passkey ? {
    id: slot.passkey.id,
    public_key: Buffer.from(slot.passkey.publicKey, 'base64url'),
    counter: Number(slot.passkey.counter) || 0,
    device_type: slot.passkey.deviceType || null,
    backed_up: slot.passkey.backedUp ? 1 : 0,
    transports_json: JSON.stringify(slot.passkey.transports || []),
    name: slot.label || 'Passkey',
    created_at: slot.createdAt,
    last_used_at: slot.lastUsedAt || null,
    keyslotId: slot.id,
    canUnlock: Boolean(slot.wrapped),
  } : null);
  const slotFor = (passkeyId) => store.ofType('passkey').find((slot) => slot.passkey?.id === passkeyId) || null;
  return {
    listRaw: () => store.ofType('passkey').map(rowOf),
    getRaw: (passkeyId) => rowOf(slotFor(passkeyId)),
    count: () => store.ofType('passkey').length,
    create(input) {
      if (slotFor(input.id)) throw new ConflictError('That passkey is already registered.');
      const slot = {
        id: crypto.randomUUID(),
        type: 'passkey',
        label: String(input.name || 'Passkey').slice(0, 80),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        passkey: {
          id: input.id,
          publicKey: Buffer.from(input.public_key).toString('base64url'),
          counter: Number(input.counter) || 0,
          deviceType: input.device_type || null,
          backedUp: Boolean(input.backed_up),
          transports: JSON.parse(input.transports_json || '[]'),
        },
      };
      store.add(slot);
      return rowOf(store.get(slot.id));
    },
    touch(passkeyId, counter) {
      const slot = slotFor(passkeyId);
      if (!slot) return null;
      store.update(slot.id, { lastUsedAt: new Date().toISOString(), passkey: { ...slot.passkey, counter } });
      return rowOf(store.get(slot.id));
    },
    remove(passkeyId) {
      const slot = slotFor(passkeyId);
      return slot ? store.remove(slot.id) : false;
    },
    userHandle: () => store.userHandle(),
  };
}
