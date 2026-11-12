import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AppError } from '../errors.js';
import { isNonPublicAddress } from './attachment-fetch.js';
import { MESSAGE_EVENT_TYPES } from './message-events.js';

/*
 * The network half of outbound webhooks: which URLs aMail will POST to, how a
 * request is signed, and one hardened POST. services/webhooks.js owns
 * subscriptions, the queue and retries.
 *
 * aMail POSTs to a URL someone typed, so the rules mirror attach-by-URL
 * (attachment-fetch.js) and share its address check:
 *
 * - https only, no user:pass@ in the URL.
 * - Every address the host resolves to must be public: loopback, private,
 *   link-local (cloud metadata), CGNAT, multicast and reserved ranges are
 *   refused. The connection uses the address that was checked, so DNS
 *   rebinding cannot swap in an internal address between check and connect.
 * - Redirects are never followed; a 3xx answer is a failed delivery.
 * - AMAIL_WEBHOOK_ALLOW_HOSTS is the one escape hatch: an exact host (name or
 *   IP literal) listed there may be private and may use plain http, for a
 *   receiver on the same LAN or Docker network.
 * - Errors and logs never carry the URL's path or query, or the response body.
 */

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;
export const MAX_WEBHOOK_URL_CHARS = 2_048;
const MAX_RESPONSE_BYTES = 64 * 1024;

function urlError(message, code = 'WEBHOOK_URL_BLOCKED', status = 422) {
  return new AppError(message, { status, code, expose: true });
}

/** A failed delivery attempt. `reason` is a short, safe label for the log. */
export class WebhookDeliveryError extends Error {
  constructor(reason, { code = 'WEBHOOK_DELIVERY_FAILED' } = {}) {
    super(reason);
    this.name = 'WebhookDeliveryError';
    this.code = code;
    this.reason = reason;
  }
}

function bareHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** "receiver.lan, 192.168.1.20, [fd00::5]" -> exact lowercase hosts. No wildcards. */
export function parseWebhookAllowHosts(value) {
  const hosts = String(value || '')
    .split(',')
    .map(bareHost)
    .filter((host) => host && host.length <= 253 && (net.isIP(host) || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)));
  return [...new Set(hosts)];
}

/** AMAIL_WEBHOOK_EVENTS: comma list of event types, or `*`. Default message.received. */
export function parseWebhookEventList(value) {
  const events = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item === '*' || Object.hasOwn(MESSAGE_EVENT_TYPES, item));
  return events.length ? [...new Set(events)] : ['message.received'];
}

/**
 * `X-AMail-Signature` value: `t=<unix seconds>,v1=<hex HMAC-SHA256>` over
 * `"<t>.<raw body>"`, keyed with the subscription secret as UTF-8.
 */
export function signWebhookBody(secret, body, timestampSeconds) {
  const digest = crypto.createHmac('sha256', String(secret))
    .update(`${timestampSeconds}.${body}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

/**
 * Reference verifier (the receiver's side), used by the tests and mirrored by
 * the snippets in docs/webhooks.md. Constant-time compare, 5-minute tolerance.
 */
export function verifyWebhookSignature(secret, body, header, {
  toleranceSeconds = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  const parts = Object.fromEntries(String(header || '').split(',').map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [part.trim(), ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  const timestamp = Number(parts.t);
  if (!Number.isSafeInteger(timestamp) || !/^[0-9a-f]{64}$/.test(parts.v1 || '')) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = signWebhookBody(secret, body, timestamp).split('v1=')[1];
  return crypto.timingSafeEqual(Buffer.from(parts.v1, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Checks that need no network: shape, scheme, credentials, literal addresses.
 * Returns the parsed URL (fragment removed).
 */
export function checkWebhookUrl(raw, { allowHosts = [], isBlockedAddress = isNonPublicAddress } = {}) {
  const text = String(raw ?? '').trim();
  let url;
  try {
    if (!text || text.length > MAX_WEBHOOK_URL_CHARS) throw new Error('length');
    url = new URL(text);
  } catch {
    throw urlError('The webhook URL is not a valid URL.', 'WEBHOOK_URL_INVALID', 400);
  }
  const host = bareHost(url.hostname);
  const allowed = allowHosts.includes(host);
  if (url.protocol !== 'https:' && !(allowed && url.protocol === 'http:')) {
    throw urlError('Webhook URLs must use https. Plain http is accepted only for a host listed in AMAIL_WEBHOOK_ALLOW_HOSTS.');
  }
  if (url.username || url.password) {
    throw urlError('Webhook URLs cannot carry a user name or password. The receiver authenticates each request by its signature.');
  }
  if (!host) throw urlError('The webhook URL is not a valid URL.', 'WEBHOOK_URL_INVALID', 400);
  if (!allowed && net.isIP(host) && isBlockedAddress(host)) {
    throw urlError(
      'The webhook URL points at a private, loopback or reserved address. List the host in AMAIL_WEBHOOK_ALLOW_HOSTS to allow a receiver on your own network.',
      'WEBHOOK_PRIVATE_ADDRESS',
    );
  }
  url.hash = '';
  return url;
}

export function createWebhookTransport({
  allowHosts = [],
  timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
  userAgent = 'aMail-Webhook',
  // Injected in tests only.
  resolveHost = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  isBlockedAddress = isNonPublicAddress,
  requestHttps = https.request,
  requestHttp = http.request,
} = {}) {
  const checkUrl = (raw) => checkWebhookUrl(raw, { allowHosts, isBlockedAddress });

  /** The address to connect to, after the public-address check. */
  async function resolveAddress(url) {
    const host = bareHost(url.hostname);
    const family = net.isIP(host);
    if (family) return { address: host, family };
    let addresses;
    try {
      addresses = await resolveHost(host);
    } catch {
      throw urlError(`${host} could not be resolved.`, 'WEBHOOK_DNS_FAILED', 502);
    }
    if (!Array.isArray(addresses) || !addresses.length) {
      throw urlError(`${host} could not be resolved.`, 'WEBHOOK_DNS_FAILED', 502);
    }
    if (!allowHosts.includes(host) && addresses.some(({ address }) => isBlockedAddress(address))) {
      throw urlError(
        `${host} resolves to a private, loopback or reserved address. List the host in AMAIL_WEBHOOK_ALLOW_HOSTS to allow a receiver on your own network.`,
        'WEBHOOK_PRIVATE_ADDRESS',
      );
    }
    return addresses[0];
  }

  /** Full check for a URL about to be saved or tested: syntax, then DNS. */
  async function assertDeliverable(raw) {
    const url = checkUrl(raw);
    await resolveAddress(url);
    return url;
  }

  /**
   * One POST. Resolves `{ status }` for any HTTP answer (the caller decides
   * what counts as success); rejects with WebhookDeliveryError otherwise.
   */
  async function post({ url: rawUrl, headers = {}, body = '' }) {
    let url;
    let address;
    try {
      url = checkUrl(rawUrl);
      address = await resolveAddress(url);
    } catch (error) {
      const reasons = {
        WEBHOOK_DNS_FAILED: 'dns-failed',
        WEBHOOK_PRIVATE_ADDRESS: 'private-address',
        WEBHOOK_URL_INVALID: 'invalid-url',
      };
      throw new WebhookDeliveryError(reasons[error?.code] || 'url-blocked', { code: error?.code || 'WEBHOOK_URL_BLOCKED' });
    }
    const secure = url.protocol === 'https:';
    const host = bareHost(url.hostname);
    const payload = Buffer.from(String(body), 'utf8');
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline = null;
      let status = null;
      let request = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        callback(value);
      };
      const timedOut = () => {
        // Headers already answered: the verdict is known, only the body lags.
        if (status !== null) finish(resolve, { status });
        else finish(reject, new WebhookDeliveryError('timeout', { code: 'WEBHOOK_TIMEOUT' }));
        request?.destroy();
      };
      request = (secure ? requestHttps : requestHttp)({
        method: 'POST',
        hostname: host,
        ...(secure && !net.isIP(host) ? { servername: host } : {}),
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: {
          ...headers,
          'user-agent': userAgent,
          'content-length': String(payload.length),
        },
        timeout: timeoutMs,
        agent: false,
        // Connect to the address that was checked, not a fresh lookup.
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      }, (response) => {
        status = response.statusCode || 0;
        let size = 0;
        // The body is read (and discarded) so a well-behaved receiver sees a
        // clean close, but never past a small cap.
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(resolve, { status });
            request.destroy();
          }
        });
        response.on('end', () => finish(resolve, { status }));
        response.on('error', () => finish(resolve, { status }));
      });
      // `timeout` only catches an idle socket; the deadline also stops a
      // receiver that trickles bytes.
      deadline = setTimeout(timedOut, timeoutMs);
      deadline.unref?.();
      request.once('timeout', timedOut);
      request.on('error', () => finish(reject, new WebhookDeliveryError('connection-failed', { code: 'WEBHOOK_CONNECTION_FAILED' })));
      request.end(payload);
    });
  }

  return { checkUrl, assertDeliverable, post };
}
