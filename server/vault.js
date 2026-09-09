import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { deriveSubkey } from './services/crypto.js';
import {
  KeyslotError,
  generateDek,
  generateRecoveryCode,
  generateToken,
  looksLikeRecoveryCode,
  looksLikeToken,
  publicKeyslot,
  unwrapDek,
  wrapDek,
} from './services/keyslots.js';

export const CREDENTIAL_KEY_INFO = 'amail/credential-key/v1';
export const REMOTE_TOKEN_KEY_INFO = 'amail/remote-token-key/v1';
const MIN_PASSPHRASE_LENGTH = 12;

export class HarnessLockedError extends AppError {
  constructor(message = 'This aMail harness is locked. Present a keyslot credential (bearer token, passphrase, passkey, or recovery code) to unlock it.') {
    super(message, { status: 503, code: 'HARNESS_LOCKED', expose: true });
  }
}

export class HarnessUninitializedError extends AppError {
  constructor(message = 'This aMail harness has not been provisioned yet.') {
    super(message, { status: 503, code: 'HARNESS_UNINITIALIZED', expose: true });
  }
}

/** Every key the runtime needs, derived from the DEK so nothing else is stored. */
export function deriveRuntimeKeys(dek) {
  return {
    databaseKey: Buffer.from(dek),
    credentialKey: deriveSubkey(dek, CREDENTIAL_KEY_INFO),
    remoteTokenKey: deriveSubkey(dek, REMOTE_TOKEN_KEY_INFO),
  };
}

/**
 * A proxy that resolves its target on every access. Routes and MCP tools keep
 * calling `repos.messages.get(...)` exactly as before; while the harness is
 * locked the resolver throws HarnessLockedError, which the error handler turns
 * into a 503 with a clear code.
 */
export function lazyProxy(resolve) {
  const cache = new WeakMap();
  const wrap = (getTarget) => new Proxy(Object.create(null), {
    get(_ignored, property) {
      const target = getTarget();
      if (target === null || target === undefined) return undefined;
      const value = target[property];
      if (typeof value === 'function') return value.bind(target);
      if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !Array.isArray(value)) {
        let nested = cache.get(value);
        if (!nested) {
          nested = wrap(() => getTarget()?.[property]);
          cache.set(value, nested);
        }
        return nested;
      }
      return value;
    },
    has(_ignored, property) {
      const target = getTarget();
      return target ? property in target : false;
    },
    ownKeys() {
      const target = getTarget();
      return target ? Reflect.ownKeys(target) : [];
    },
    getOwnPropertyDescriptor(_ignored, property) {
      const target = getTarget();
      if (!target || !(property in target)) return undefined;
      return { configurable: true, enumerable: true, writable: false, value: target[property] };
    },
  });
  return wrap(resolve);
}

export const RUNTIME_KEY_PROPERTIES = Object.freeze(['databaseKey', 'credentialKey', 'remoteTokenKey']);

/**
 * The config object routes see in keyslot mode: static settings come from the
 * environment as usual, while the key material resolves from the unlocked
 * runtime (and throws HarnessLockedError while locked).
 */
export function keyedConfigProxy(baseConfig, resolveKeys) {
  const statics = { ...baseConfig };
  for (const property of RUNTIME_KEY_PROPERTIES) delete statics[property];
  return new Proxy(statics, {
    get(target, property) {
      if (RUNTIME_KEY_PROPERTIES.includes(property)) return resolveKeys()[property];
      return target[property];
    },
    set() {
      return false;
    },
  });
}

/**
 * Locked/unlocked state for one tenant harness.
 *
 * `buildRuntime(keys)` opens the database and constructs the services; it runs
 * on every unlock and its result is torn down on lock. The DEK lives only in
 * this closure.
 */
export function createVault({ config, keyslots, buildRuntime, logger, onUnlock = () => {}, onLock = () => {} }) {
  let dek = null;
  let runtime = null;
  let unlockedAt = null;
  let unlockedVia = null;
  // Verified bearer tokens are remembered by hash so a request costs one hash
  // instead of one HKDF + AES-GCM per keyslot. Cleared on lock.
  const tokenCache = new Map();

  const hashToken = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
  const isUnlocked = () => dek !== null;

  function requireRuntime() {
    if (!runtime) {
      if (!keyslots.initialized()) throw new HarnessUninitializedError();
      throw new HarnessLockedError();
    }
    return runtime;
  }

  function status() {
    return {
      keyMode: 'keyslot',
      initialized: keyslots.initialized(),
      locked: !isUnlocked(),
      unlockedAt,
      unlockedVia,
      keyslots: keyslots.list().length,
      escrow: keyslots.ofType('escrow').length > 0,
    };
  }

  function unlockWithDek(candidate, { via = 'unknown', slotId = null } = {}) {
    if (!Buffer.isBuffer(candidate) || candidate.length !== 32) throw new KeyslotError('Malformed DEK.', 'DEK_MALFORMED', 500);
    if (isUnlocked()) {
      if (!crypto.timingSafeEqual(candidate, dek)) throw new KeyslotError('A different DEK is already active.', 'DEK_MISMATCH', 409);
      return status();
    }
    const keys = deriveRuntimeKeys(candidate);
    const built = buildRuntime(keys);
    dek = Buffer.from(candidate);
    runtime = built;
    unlockedAt = new Date().toISOString();
    unlockedVia = via;
    if (slotId) keyslots.touch(slotId);
    logger?.info?.({ via }, 'Harness unlocked');
    try {
      onUnlock(runtime);
    } catch (error) {
      logger?.error?.({ err: error }, 'Post-unlock hook failed');
    }
    return status();
  }

  function lock({ reason = 'manual' } = {}) {
    if (!isUnlocked()) return status();
    const closing = runtime;
    runtime = null;
    dek.fill(0);
    dek = null;
    unlockedAt = null;
    unlockedVia = null;
    tokenCache.clear();
    try {
      onLock(closing, reason);
    } catch (error) {
      logger?.error?.({ err: error }, 'Pre-lock hook failed');
    }
    try {
      closing?.close?.();
    } catch (error) {
      logger?.error?.({ err: error }, 'Closing the runtime on lock failed');
    }
    logger?.info?.({ reason }, 'Harness locked');
    return status();
  }

  /** Try a credential against slots of the given types; returns the slot or null. */
  function trySlots(secret, types) {
    for (const slot of keyslots.slots()) {
      if (!types.includes(slot.type) || !slot.wrapped) continue;
      const candidate = unwrapDek(slot, secret);
      if (candidate) return { slot, dek: candidate };
    }
    return null;
  }

  function unlockWithSecret(secret, { types, via = 'credential' } = {}) {
    const text = String(secret || '');
    if (!text) throw new KeyslotError('A credential is required.', 'KEYSLOT_CREDENTIAL_REQUIRED', 400);
    // Cheap, high-entropy slot types first so a passphrase (scrypt) is only
    // stretched when the credential cannot be a token or recovery code.
    const candidates = types || (looksLikeToken(text)
      ? ['token']
      : looksLikeRecoveryCode(text) ? ['recovery', 'passphrase'] : ['passphrase', 'recovery']);
    const match = trySlots(text, candidates);
    if (!match) throw new KeyslotError('That credential does not unlock this harness.', 'KEYSLOT_INVALID', 401);
    unlockWithDek(match.dek, { via: `${via}:${match.slot.type}`, slotId: match.slot.id });
    match.dek.fill(0);
    if (match.slot.type === 'token') tokenCache.set(hashToken(text), match.slot.id);
    return { slot: publicKeyslot(match.slot) };
  }

  /** Bearer-token check used by the access gate on every request. */
  function authenticateToken(token) {
    if (!looksLikeToken(token)) return null;
    const digest = hashToken(token);
    if (isUnlocked()) {
      const cached = tokenCache.get(digest);
      if (cached) {
        // Revocation deletes the slot; the cache must not outlive it.
        if (keyslots.get(cached)) return cached;
        tokenCache.delete(digest);
      }
    }
    const match = trySlots(token, ['token']);
    if (!match) return null;
    if (!isUnlocked()) unlockWithDek(match.dek, { via: 'bearer:token', slotId: match.slot.id });
    match.dek.fill(0);
    tokenCache.set(digest, match.slot.id);
    return match.slot.id;
  }

  function unlockWithPasskey(passkeyId, prfOutput) {
    const slot = keyslots.ofType('passkey').find((item) => item.passkey?.id === passkeyId);
    if (!slot) throw new KeyslotError('That passkey is not registered on this harness.', 'KEYSLOT_INVALID', 401);
    if (!slot.wrapped) throw new KeyslotError('This passkey has not been linked to the encryption key yet.', 'PASSKEY_SLOT_PENDING', 409);
    const prf = Buffer.isBuffer(prfOutput) ? prfOutput : Buffer.from(String(prfOutput || ''), 'base64url');
    const candidate = unwrapDek(slot, prf);
    if (!candidate) throw new KeyslotError('That passkey does not unlock this harness.', 'KEYSLOT_INVALID', 401);
    unlockWithDek(candidate, { via: 'passkey', slotId: slot.id });
    candidate.fill(0);
    return { slot: publicKeyslot(slot) };
  }

  function requireDek() {
    if (!isUnlocked()) throw new HarnessLockedError();
    return dek;
  }

  function addSlot({ type, secret, label = '', extra = {} }) {
    const slot = wrapDek(requireDek(), { type, secret, label, extra });
    return keyslots.add(slot);
  }

  function init({ label = 'Initial token' } = {}) {
    if (keyslots.initialized()) throw new KeyslotError('This harness is already provisioned.', 'HARNESS_ALREADY_INITIALIZED', 409);
    const fresh = generateDek();
    const token = generateToken();
    const recoveryCode = generateRecoveryCode();
    keyslots.add(wrapDek(fresh, { type: 'token', secret: token, label }));
    keyslots.add(wrapDek(fresh, { type: 'recovery', secret: recoveryCode, label: 'Recovery code' }));
    unlockWithDek(fresh, { via: 'provision' });
    fresh.fill(0);
    return { token, recoveryCode, keyslots: keyslots.list() };
  }

  function addTokenSlot({ label = '' } = {}) {
    const token = generateToken();
    const slot = addSlot({ type: 'token', secret: token, label });
    return { token, slot };
  }

  function addRecoverySlot() {
    const recoveryCode = generateRecoveryCode();
    const slot = addSlot({ type: 'recovery', secret: recoveryCode, label: 'Recovery code' });
    return { recoveryCode, slot };
  }

  function addPassphraseSlot({ passphrase, label = 'Passphrase' } = {}) {
    const text = String(passphrase || '').normalize('NFKC').trim();
    if (text.length < MIN_PASSPHRASE_LENGTH) {
      throw new KeyslotError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`, 'PASSPHRASE_TOO_SHORT', 400);
    }
    return { slot: addSlot({ type: 'passphrase', secret: text, label }) };
  }

  function addEscrowSlot() {
    if (!config.escrowKey) throw new KeyslotError('Escrow is not offered on this server.', 'ESCROW_UNAVAILABLE', 503);
    if (keyslots.ofType('escrow').length) throw new KeyslotError('Escrow is already enabled.', 'ESCROW_ALREADY_ENABLED', 409);
    return { slot: addSlot({ type: 'escrow', secret: config.escrowKey, label: 'Operator escrow (stay unlocked across restarts)' }) };
  }

  /** Link a registered passkey's PRF output to the DEK while unlocked. */
  function completePasskeySlot(passkeyId, prfOutput) {
    const slot = keyslots.ofType('passkey').find((item) => item.passkey?.id === passkeyId);
    if (!slot) throw new KeyslotError('That passkey is not registered on this harness.', 'KEYSLOT_INVALID', 404);
    const prf = Buffer.isBuffer(prfOutput) ? prfOutput : Buffer.from(String(prfOutput || ''), 'base64url');
    if (prf.length < 16) throw new KeyslotError('The passkey did not return a PRF secret.', 'PASSKEY_PRF_REQUIRED', 400);
    const wrapped = wrapDek(requireDek(), { id: slot.id, type: 'passkey', secret: prf, label: slot.label, extra: { passkey: slot.passkey, createdAt: slot.createdAt } });
    return { slot: keyslots.update(slot.id, { salt: wrapped.salt, nonce: wrapped.nonce, tag: wrapped.tag, wrapped: wrapped.wrapped, kdf: wrapped.kdf }) };
  }

  /** Boot-time escrow unlock: only when the tenant opted in. */
  function unlockFromEscrow() {
    if (!config.escrowKey || isUnlocked()) return false;
    const match = trySlots(config.escrowKey, ['escrow']);
    if (!match) return false;
    unlockWithDek(match.dek, { via: 'escrow', slotId: match.slot.id });
    match.dek.fill(0);
    return true;
  }

  function removeSlot(id) {
    const removed = keyslots.remove(id);
    for (const [digest, slotId] of tokenCache) {
      if (slotId === id) tokenCache.delete(digest);
    }
    return removed;
  }

  return {
    mode: 'keyslot',
    status,
    isUnlocked,
    isInitialized: () => keyslots.initialized(),
    init,
    lock,
    unlockWithSecret,
    unlockWithDek,
    unlockWithPasskey,
    unlockFromEscrow,
    authenticateToken,
    addTokenSlot,
    addRecoverySlot,
    addPassphraseSlot,
    addEscrowSlot,
    completePasskeySlot,
    removeSlot,
    listSlots: () => keyslots.list(),
    /** Only the handoff server may read this, and only while unlocked. */
    exportDek: () => Buffer.from(requireDek()),
    runtime: {
      config: keyedConfigProxy(config, () => requireRuntime().config),
      repos: lazyProxy(() => requireRuntime().repos),
      mailService: lazyProxy(() => requireRuntime().mailService),
      remoteContent: lazyProxy(() => requireRuntime().remoteContent),
    },
    current: () => runtime,
  };
}
