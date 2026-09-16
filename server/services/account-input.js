import { decryptJson, encryptJson } from './crypto.js';
import {
  accountConnection,
  DEFAULT_ACCOUNT_COLOR,
  isEmail,
} from '../utils/mail.js';
import { normalizeStoredSignature } from '../utils/signature.js';
import { ValidationError } from '../errors.js';

export const booleanField = (value, fallback, fieldName) => {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  throw new ValidationError(`${fieldName} must be true or false.`);
};

export function parseAvatar(dataUrl) {
  if (dataUrl === null) return { avatar_blob: null, avatar_mime: null };
  if (typeof dataUrl !== 'string') throw new ValidationError('Avatar must be an image data URL.');
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw new ValidationError('Avatar must be a PNG, JPEG, GIF, or WebP data URL.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 1_000_000) throw new ValidationError('Avatar must be smaller than 1 MB.');
  return { avatar_blob: buffer, avatar_mime: match[1].toLowerCase() };
}

const CREDENTIAL_FIELDS = new Set([
  // The account connection form includes email as legacy credential metadata;
  // authentication still uses the explicit usernames or the account email.
  'email', 'username', 'user', 'imapUsername', 'imapUser', 'smtpUsername', 'smtpUser',
  'password', 'imapPassword', 'smtpPassword', 'accessToken', 'imapAccessToken', 'smtpAccessToken',
]);

function mergedCredentials(patch, current = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('Account credentials must be an object.');
  }
  for (const [field, value] of Object.entries(patch)) {
    if (!CREDENTIAL_FIELDS.has(field) || typeof value !== 'string' || value.length > 16_384) {
      throw new ValidationError('Account credentials contain an invalid field.');
    }
  }
  const merged = { ...current };
  // A replacement app password applies to both protocols. Old OAuth tokens
  // and protocol-specific passwords would otherwise silently win in buildAuth.
  if (patch.password) {
    for (const field of ['password', 'imapPassword', 'smtpPassword', 'accessToken', 'imapAccessToken', 'smtpAccessToken']) {
      delete merged[field];
    }
  }
  for (const [field, value] of Object.entries(patch)) {
    // Empty password inputs mean "keep the saved password", never "erase it".
    if (/Password$|^password$/.test(field) && value === '') continue;
    merged[field] = value;
  }
  return merged;
}

export function accountLoginSettings(existing, config) {
  const credentials = decryptJson(existing.credential_ciphertext, config.credentialKey);
  const username = String(credentials.username || credentials.user || existing.email).trim();
  // An explicit allowlist is essential: stored credentials also contain
  // passwords and OAuth tokens, which must never be returned to the browser.
  return {
    username,
    imapUsername: String(credentials.imapUsername || credentials.imapUser || username).trim(),
    smtpUsername: String(credentials.smtpUsername || credentials.smtpUser || username).trim(),
    authType: credentials.accessToken || credentials.imapAccessToken || credentials.smtpAccessToken ? 'oauth2' : 'password',
  };
}

export function serializeAccountInput(body, existing, config) {
  const email = String(body.email ?? existing?.email ?? '').trim().toLowerCase();
  if (!isEmail(email)) throw new ValidationError('A valid account email is required.');
  if (existing && email !== existing.email.toLowerCase()) {
    throw new ValidationError('Account email cannot be changed. Remove and re-add the account instead.');
  }
  const currentConnection = existing ? {
    provider: existing.provider,
    imap: { host: existing.imap_host, port: existing.imap_port, secure: Boolean(existing.imap_secure) },
    smtp: { host: existing.smtp_host, port: existing.smtp_port, secure: Boolean(existing.smtp_secure) },
  } : {};
  const connection = accountConnection({
    ...currentConnection,
    ...body,
    imap: { ...currentConnection.imap, ...(body.imap || {}) },
    smtp: { ...currentConnection.smtp, ...(body.smtp || {}) },
  });
  let credentials;
  if (body.credentials !== undefined) {
    const current = existing ? decryptJson(existing.credential_ciphertext, config.credentialKey) : {};
    const merged = mergedCredentials(body.credentials, current);
    credentials = existing && JSON.stringify(current) === JSON.stringify(merged)
      ? existing.credential_ciphertext
      : encryptJson(merged, config.credentialKey);
  } else if (existing) {
    credentials = existing.credential_ciphertext;
  } else {
    throw new ValidationError('Account credentials are required.');
  }
  const avatar = body.avatarDataUrl === undefined
    ? { avatar_blob: existing?.avatar_blob || null, avatar_mime: existing?.avatar_mime || null }
    : parseAvatar(body.avatarDataUrl);
  const color = String(body.color ?? existing?.color ?? DEFAULT_ACCOUNT_COLOR);
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new ValidationError('Account color must be a six-digit hex color.');
  return {
    email,
    display_name: String(body.displayName ?? existing?.display_name ?? email.split('@')[0]).trim().slice(0, 120) || email,
    ...avatar,
    color,
    provider: connection.provider,
    imap_host: connection.imap.host,
    imap_port: connection.imap.port,
    imap_secure: Number(connection.imap.secure),
    smtp_host: connection.smtp.host,
    smtp_port: connection.smtp.port,
    smtp_secure: Number(connection.smtp.secure),
    credential_ciphertext: credentials,
    signature: normalizeStoredSignature(body.signature ?? existing?.signature ?? ''),
    sync_enabled: Number(booleanField(body.syncEnabled, existing ? Boolean(existing.sync_enabled) : true, 'Sync enabled')),
  };
}

export function accountTestInput(input, config) {
  return {
    email: input.email,
    provider: input.provider,
    imap: {
      host: input.imap_host,
      port: input.imap_port,
      secure: Boolean(input.imap_secure),
    },
    smtp: {
      host: input.smtp_host,
      port: input.smtp_port,
      secure: Boolean(input.smtp_secure),
    },
    credentials: decryptJson(input.credential_ciphertext, config.credentialKey),
  };
}
