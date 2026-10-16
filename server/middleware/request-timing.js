import { requestPath } from '../logging.js';

export const SLOW_REQUEST_MS = 250;
export const POLLER_SAMPLE_RATE = 0.2;
const POLLER_PREFIXES = ['/api/messages', '/api/changes', '/api/sync'];

export function clientIp(request) {
  const forwarded = request?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 80);
  }
  return request?.ip || request?.socket?.remoteAddress || null;
}

export function clientUserAgent(request) {
  return String(request?.headers?.['user-agent'] || '').slice(0, 180);
}

export function isPollerPath(path) {
  return POLLER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function shouldLogRequestTiming(path, durationMs, { slowMs = SLOW_REQUEST_MS, sampleRate = POLLER_SAMPLE_RATE, random = Math.random } = {}) {
  if (durationMs >= slowMs) return { log: true, event: 'slow_request' };
  if (isPollerPath(path) && random() < sampleRate) return { log: true, event: 'poller_sample' };
  return { log: false, event: null };
}

export function requestTimingFields(request, response, durationMs) {
  return {
    method: request?.method,
    path: requestPath(request?.originalUrl || request?.url),
    status: response?.statusCode,
    durationMs: Math.round(durationMs),
    userAgent: clientUserAgent(request),
    ip: clientIp(request),
  };
}

/**
 * Log user-agent, client IP, route, and duration for slow requests and a
 * sample of the inbox poller routes so a live 3s loop can be identified
 * without logging query strings or credentials.
 */
export function requestTiming({ slowMs = SLOW_REQUEST_MS, sampleRate = POLLER_SAMPLE_RATE, random = Math.random, now = () => process.hrtime.bigint() } = {}) {
  return (request, response, next) => {
    const started = now();
    response.on('finish', () => {
      const durationMs = Number(now() - started) / 1e6;
      const path = requestPath(request.originalUrl || request.url);
      const decision = shouldLogRequestTiming(path, durationMs, { slowMs, sampleRate, random });
      if (!decision.log) return;
      const fields = { event: decision.event, ...requestTimingFields(request, response, durationMs) };
      const logger = request.log || request.app?.get?.('logger');
      logger?.info?.(fields, decision.event === 'slow_request' ? 'Slow request' : 'Poller sample');
    });
    next();
  };
}
