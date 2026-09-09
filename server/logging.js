import pino from 'pino';

/**
 * Logging policy shared by self-hosted and hosted installs.
 *
 * Hosted tenants run at `LOG_LEVEL=error`, so the only entries that exist in
 * normal operation are failures. Whatever level is active, entries may carry a
 * route, an HTTP status, and opaque internal ids (request id, message id), but
 * never a body, subject, address, query string, credential, or cookie. The
 * serializers below enforce that at the sink instead of relying on every call
 * site to remember.
 */

export const LOG_LEVELS = Object.freeze(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
export const DEFAULT_LOG_LEVEL = 'info';
const MAX_TEXT_LENGTH = 600;

export function normalizeLogLevel(value, fallback = DEFAULT_LOG_LEVEL) {
  const level = String(value || '').trim().toLowerCase();
  return LOG_LEVELS.includes(level) ? level : fallback;
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CREDENTIAL_PATTERN = /\b(pass(?:word|wd|phrase)?|pwd|token|secret|authorization|api[_-]?key|access[_-]?key|cookie)\b(\s*[:=]\s*)(Bearer \[redacted\]|"[^"]*"|'[^']*'|\S+)/gi;
const BEARER_PATTERN = /\bbearer\s+[A-Z0-9._~+/=-]+/gi;
// Only a `?` that follows a path segment is a query string; a trailing question
// mark in prose is left alone.
const QUERY_STRING_PATTERN = /(\/[^\s?"'<>]*)\?[^\s"'<>]+/g;

/**
 * Remove mailbox content and credentials from free text destined for a log.
 * Applied to error messages, stack traces, and upstream server responses.
 */
export function scrubLogText(value) {
  let text = String(value ?? '');
  if (!text) return text;
  text = text
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(CREDENTIAL_PATTERN, (_match, key, separator) => `${key}${separator}[redacted]`)
    .replace(EMAIL_PATTERN, '[email]')
    .replace(QUERY_STRING_PATTERN, '$1?[query]');
  if (text.length > MAX_TEXT_LENGTH) text = `${text.slice(0, MAX_TEXT_LENGTH)}…`;
  return text;
}

/**
 * Allowlist error serializer. `pino.stdSerializers.err` copies every enumerable
 * property of an error, which for IMAP/SMTP/HTTP client errors includes raw
 * server responses, commands, and request bodies. Only structural fields are
 * kept, and the text fields are scrubbed.
 */
export function errorSerializer(error) {
  if (error === null || error === undefined) return error;
  if (typeof error !== 'object') return { type: typeof error, message: scrubLogText(error) };
  const serialized = {
    type: error.name || error.constructor?.name || 'Error',
    message: scrubLogText(error.message),
  };
  if (error.code !== undefined) serialized.code = typeof error.code === 'string' ? error.code.slice(0, 80) : error.code;
  if (Number.isInteger(error.status)) serialized.status = error.status;
  if (Number.isInteger(error.statusCode)) serialized.statusCode = error.statusCode;
  if (typeof error.stack === 'string') serialized.stack = scrubLogText(error.stack);
  if (error.cause !== undefined && error.cause !== error) serialized.cause = errorSerializer(error.cause);
  return serialized;
}

/** Request path only: a query string can carry search terms or capability tokens. */
export function requestPath(value) {
  const raw = String(value || '');
  try {
    return new URL(raw, 'http://amail.invalid').pathname;
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
}

export function requestSerializer(request) {
  // Headers are never logged: they hold bearer credentials, cookies, and
  // mail-client fingerprints. Route params are random ids and stay useful for
  // reproducing a bug without exposing mailbox content.
  return {
    id: request.id,
    method: request.method,
    url: requestPath(request.url),
    remoteAddress: request.socket?.remoteAddress,
  };
}

export function responseSerializer(response) {
  // Response headers can include Set-Cookie for the session, so only the code.
  return { statusCode: response?.statusCode };
}

export const logSerializers = Object.freeze({
  err: errorSerializer,
  error: errorSerializer,
  req: requestSerializer,
  res: responseSerializer,
});

export function createLogger(config, options = {}, destination = undefined) {
  const pinoOptions = {
    level: normalizeLogLevel(config?.logLevel),
    redact: {
      paths: ['req.headers', 'res.headers', 'headers', 'cookie', 'authorization', 'password', 'credentials', 'accessToken', 'token'],
      remove: true,
    },
    serializers: logSerializers,
    ...options,
  };
  return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}
