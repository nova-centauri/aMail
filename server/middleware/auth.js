import crypto from 'node:crypto';
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from '../config.js';
import { timingSafeMatch } from '../services/crypto.js';
import { KeyslotError } from '../services/keyslots.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function readCookie(request, name) {
  const pairs = String(request.headers.cookie || '').split(';');
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === name) return decodeURIComponent(pair.slice(index + 1).trim());
  }
  return null;
}

function bearerToken(request) {
  const authorization = request.get('authorization') || '';
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1] || null;
}

export function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.env === 'production' && config.cookieSecure !== false,
    maxAge: SESSION_TTL_MS,
    path: '/',
  };
}

export function sessionCookieClearOptions(config) {
  const options = sessionCookieOptions(config);
  return {
    path: options.path,
    httpOnly: options.httpOnly,
    sameSite: options.sameSite,
    secure: options.secure,
  };
}

/**
 * Environment mode: the classic single access token. The browser session
 * cookie carries the token itself, as it always has.
 */
function createEnvAuthenticator({ config }) {
  const requestHasAccess = (request) => {
    if (!config.accessToken) return true;
    return timingSafeMatch(bearerToken(request), config.accessToken)
      || timingSafeMatch(readCookie(request, SESSION_COOKIE), config.accessToken)
      || timingSafeMatch(readCookie(request, LEGACY_SESSION_COOKIE), config.accessToken);
  };
  return {
    mode: 'env',
    protected: Boolean(config.accessToken),
    requestHasAccess,
    credentialLogin(secret) {
      if (!config.accessToken) return { ok: true, sessionValue: null };
      if (!timingSafeMatch(secret, config.accessToken)) throw new KeyslotError('Invalid access token.', 'AUTH_FAILED', 401);
      return { ok: true, sessionValue: config.accessToken };
    },
    beginSession(response) {
      if (config.accessToken) response.cookie(SESSION_COOKIE, config.accessToken, sessionCookieOptions(config));
    },
    endSession(_request, response) {
      response.clearCookie(SESSION_COOKIE, sessionCookieClearOptions(config));
      response.clearCookie(LEGACY_SESSION_COOKIE, sessionCookieClearOptions(config));
    },
    status: () => ({ keyMode: 'env', locked: false, initialized: true }),
  };
}

/**
 * Keyslot mode: a bearer token is valid exactly when it unwraps the DEK, and
 * doing so unlocks a locked harness. Browser sessions are opaque ids held in
 * memory; they vanish with the process, which is also when the harness
 * re-locks, so a restart always requires a fresh keyslot credential.
 */
function createKeyslotAuthenticator({ config, vault }) {
  const sessions = new Map();

  function pruneSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id);
    }
  }

  function sessionValid(id) {
    if (!id) return false;
    const session = sessions.get(id);
    if (!session) return false;
    if (session.expiresAt <= Date.now() || !vault.isUnlocked()) {
      sessions.delete(id);
      return false;
    }
    return true;
  }

  const requestHasAccess = (request) => {
    const bearer = bearerToken(request);
    if (bearer && vault.authenticateToken(bearer)) return true;
    return sessionValid(readCookie(request, SESSION_COOKIE));
  };

  return {
    mode: 'keyslot',
    protected: true,
    requestHasAccess,
    credentialLogin(secret) {
      const { slot } = vault.unlockWithSecret(secret, { via: 'session' });
      return { ok: true, slot };
    },
    beginSession(response, { slotId = null } = {}) {
      pruneSessions();
      const id = crypto.randomBytes(32).toString('base64url');
      sessions.set(id, { slotId, expiresAt: Date.now() + SESSION_TTL_MS });
      response.cookie(SESSION_COOKIE, id, sessionCookieOptions(config));
    },
    endSession(request, response) {
      const id = readCookie(request, SESSION_COOKIE);
      if (id) sessions.delete(id);
      response.clearCookie(SESSION_COOKIE, sessionCookieClearOptions(config));
      response.clearCookie(LEGACY_SESSION_COOKIE, sessionCookieClearOptions(config));
    },
    clearSessions: () => sessions.clear(),
    status: () => vault.status(),
  };
}

export function createAuthenticator({ config, vault = null }) {
  return vault ? createKeyslotAuthenticator({ config, vault }) : createEnvAuthenticator({ config });
}

/** Back-compat helper for callers that only have a config. */
export function requestHasAccess(request, config) {
  return createEnvAuthenticator({ config }).requestHasAccess(request);
}

export function accessGate(auth) {
  const authenticator = typeof auth?.requestHasAccess === 'function' ? auth : createEnvAuthenticator({ config: auth });
  return (request, response, next) => {
    let allowed;
    try {
      allowed = authenticator.requestHasAccess(request);
    } catch (error) {
      return next(error);
    }
    if (allowed) return next();
    response.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'aMail access token required.' } });
  };
}
