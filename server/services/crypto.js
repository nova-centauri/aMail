import crypto from 'node:crypto';
import { ServiceUnavailableError, ValidationError } from '../errors.js';

const VERSION = 'v1';
const CAPABILITY_VERSION = 'v2';
const CAPABILITY_AAD = Buffer.from('amail/capability-token/v2', 'utf8');
const encode = (value) => Buffer.from(value).toString('base64url');
const decode = (value) => Buffer.from(value, 'base64url');

function requireKey(key) {
  if (!key || key.length !== 32) {
    throw new ServiceUnavailableError(
      'Credential encryption is unavailable. Set AMAIL_ENCRYPTION_KEY before adding mail accounts.',
      'CREDENTIAL_ENCRYPTION_UNAVAILABLE',
    );
  }
}
export function encryptJson(value, key) {
  requireKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, encode(iv), encode(tag), encode(ciphertext)].join('.');
}

export function decryptJson(payload, key) {
  requireKey(key);
  const [version, ivValue, tagValue, ciphertextValue] = String(payload || '').split('.');
  if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new ValidationError('Stored account credentials have an unsupported format.');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, decode(ivValue));
    decipher.setAuthTag(decode(tagValue));
    const plaintext = Buffer.concat([decipher.update(decode(ciphertextValue)), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    throw new ServiceUnavailableError(
      'Stored account credentials cannot be decrypted. Confirm AMAIL_ENCRYPTION_KEY has not changed.',
      'CREDENTIAL_DECRYPTION_FAILED',
    );
  }
}

const HKDF_SALT = Buffer.from('aMail', 'utf8');

/**
 * Derive an independent 32-byte subkey from a secret for one named purpose.
 * Different `info` strings give unrelated keys, so the database key, credential
 * key, and token key can all descend from one root without sharing material.
 */
export function deriveSubkey(secret, info, length = 32) {
  const ikm = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8');
  if (!ikm.length) throw new ValidationError('A secret is required to derive a key.');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, HKDF_SALT, Buffer.from(String(info), 'utf8'), length));
}

export function timingSafeMatch(received, expected) {
  if (!received || !expected) return false;
  const left = Buffer.from(String(received));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function signPayload(payload, key) {
  requireKey(key);
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

export function createSignedToken(payload, key) {
  const encodedPayload = encode(JSON.stringify(payload));
  return `${encodedPayload}.${signPayload(encodedPayload, key)}`;
}

export function readSignedToken(token, key) {
  const [encodedPayload, signature] = String(token || '').split('.');
  if (!encodedPayload || !signature || !timingSafeMatch(signature, signPayload(encodedPayload, key))) {
    throw new ValidationError('The remote-content token is invalid.');
  }
  try {
    return JSON.parse(decode(encodedPayload).toString('utf8'));
  } catch {
    throw new ValidationError('The remote-content token is malformed.');
  }
}

/**
 * Short-lived capability URLs are routinely visible to browsers and reverse
 * proxies. Encrypt their payload as well as authenticating it so a remote
 * image URL, message id, or attachment index is not exposed in the query
 * string. AES-GCM's random IV also prevents two equal capabilities from being
 * linkable by their token value.
 */
export function createCapabilityToken(payload, key) {
  requireKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(CAPABILITY_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [CAPABILITY_VERSION, encode(iv), encode(cipher.getAuthTag()), encode(ciphertext)].join('.');
}

export function readCapabilityToken(token, key) {
  requireKey(key);
  const value = String(token || '');
  if (!value.startsWith(`${CAPABILITY_VERSION}.`)) {
    // Tokens live for at most an hour (five minutes by default). Accepting the
    // old signed form lets images already displayed across a rolling deploy
    // finish loading; all newly issued tokens use the opaque form above.
    return readSignedToken(value, key);
  }

  const [version, ivValue, tagValue, ciphertextValue, extra] = value.split('.');
  if (version !== CAPABILITY_VERSION || !ivValue || !tagValue || !ciphertextValue || extra) {
    throw new ValidationError('The capability token is invalid.');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, decode(ivValue));
    decipher.setAAD(CAPABILITY_AAD);
    decipher.setAuthTag(decode(tagValue));
    const plaintext = Buffer.concat([decipher.update(decode(ciphertextValue)), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new ValidationError('The capability token is invalid.');
  }
}
