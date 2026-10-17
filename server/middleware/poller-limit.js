import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from '../config.js';

export const POLLER_RATE_WINDOW_MS = 60_000;
/** One focused tab at 20s is 3/min. 15 stops the 3s tight loop (~20/min) without blocking folder clicks. */
export const MESSAGES_PER_MINUTE = 15;
/** Old clients POST /sync on every mailbox reload. A real IMAP pass is single-flight; this caps the waiters. */
export const SYNC_PER_MINUTE = 8;

function cookieValue(request, name) {
  const pairs = String(request.headers?.cookie || '').split(';');
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(pair.slice(index + 1).trim());
      } catch {
        return pair.slice(index + 1).trim();
      }
    }
  }
  return null;
}

/**
 * Prefer the session cookie or bearer token so two users behind NPM share one
 * X-Forwarded-For without sharing a quota. Fall back to a normalized IP.
 */
export function pollerClientKey(request) {
  const session = cookieValue(request, SESSION_COOKIE) || cookieValue(request, LEGACY_SESSION_COOKIE);
  if (session) return `session:${session.slice(0, 80)}`;
  const authorization = request.get?.('authorization') || request.headers?.authorization || '';
  const bearer = String(authorization).match(/^Bearer\s+(\S+)/i)?.[1];
  if (bearer) return `bearer:${bearer.slice(0, 80)}`;
  return `ip:${ipKeyGenerator(request.ip || '127.0.0.1')}`;
}

export function retryAfterSeconds(windowMs = POLLER_RATE_WINDOW_MS) {
  return Math.max(1, Math.ceil(Number(windowMs) / 1000) || 60);
}

export function pollerRateLimitedBody(windowMs = POLLER_RATE_WINDOW_MS) {
  const retryAfterSec = retryAfterSeconds(windowMs);
  return {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many mailbox requests from this client. Wait before retrying.',
      retryAfterSec,
    },
  };
}

export function pollerRateLimitEnabled(config = {}, env = process.env) {
  if (config.pollerRateLimit === false) return false;
  if (config.pollerRateLimit === true) return true;
  return (config.env || env.NODE_ENV) === 'production';
}

export function passthrough(_request, _response, next) {
  next();
}

export function pollerRateLimit({
  limit,
  windowMs = POLLER_RATE_WINDOW_MS,
} = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: pollerClientKey,
    handler(request, response, _next, options) {
      const retryAfterSec = retryAfterSeconds(options.windowMs || windowMs);
      response.set('Retry-After', String(retryAfterSec));
      response.status(options.statusCode || 429).json(pollerRateLimitedBody(options.windowMs || windowMs));
    },
  });
}
