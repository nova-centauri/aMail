import { requestPath } from '../logging.js';
import { globalInFlight, mcpCallMeta } from '../services/in-flight-requests.js';
import { SLOW_MESSAGES_MS, sanitizeMessagesPhases, sanitizeMessagesQuery } from '../services/messages-query-log.js';

export const SLOW_REQUEST_MS = 250;
export { SLOW_MESSAGES_MS, sanitizeMessagesPhases, sanitizeMessagesQuery };
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
export function requestStartFields(request) {
  const path = requestPath(request?.originalUrl || request?.url);
  const mcp = path === '/mcp' ? mcpCallMeta(request?.body) : { mcpMethod: null, mcpTool: null };
  return {
    reqId: request?.id || request?.log?.bindings?.()?.reqId || null,
    method: request?.method || null,
    path,
    mcpTool: mcp.mcpTool,
    mcpMethod: mcp.mcpMethod,
  };
}

function flushLogger(logger) {
  try {
    logger?.flush?.();
  } catch {
    // Best-effort: a hang after this line must still have a start record.
  }
}

/**
 * Log user-agent, client IP, route, and duration for slow requests and a
 * sample of the inbox poller routes so a live 3s loop can be identified
 * without logging query strings or credentials.
 *
 * Request-start lines (except /api/health) are flushed before the handler so a
 * hung SQLite/IMAP call still leaves method/path/tool/id in the log.
 */
export function requestTiming({
  slowMs = SLOW_REQUEST_MS,
  sampleRate = POLLER_SAMPLE_RATE,
  random = Math.random,
  now = () => process.hrtime.bigint(),
  inFlight = globalInFlight,
} = {}) {
  return (request, response, next) => {
    const started = now();
    const startFields = requestStartFields(request);
    const path = startFields.path;
    const logger = request.log || request.app?.get?.('logger');
    const tracked = inFlight?.begin?.({
      reqId: startFields.reqId,
      method: startFields.method,
      path,
      mcpTool: startFields.mcpTool,
      mcpMethod: startFields.mcpMethod,
    });
    if (path !== '/api/health') {
      logger?.info?.({ event: 'request_start', ...startFields }, 'Request started');
      flushLogger(logger);
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      inFlight?.end?.(tracked?.reqId || startFields.reqId);
      const durationMs = Number(now() - started) / 1e6;
      const decision = shouldLogRequestTiming(path, durationMs, { slowMs, sampleRate, random });
      if (!decision.log) return;
      const fields = { event: decision.event, reqId: startFields.reqId, mcpTool: startFields.mcpTool, ...requestTimingFields(request, response, durationMs) };
      if (path === '/api/messages' && durationMs >= SLOW_MESSAGES_MS) {
        fields.query = sanitizeMessagesQuery(request?.query);
        fields.phases = sanitizeMessagesPhases(request?.messagesPhases);
      }
      logger?.info?.(fields, decision.event === 'slow_request' ? 'Slow request' : 'Poller sample');
    };
    response.once('finish', done);
    response.once('close', done);
    next();
  };
}
