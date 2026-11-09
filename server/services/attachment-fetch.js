import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { AppError } from '../errors.js';
import { asciiFilename, MAX_COMPOSE_ATTACHMENT_BYTES, safeAttachmentType } from './compose-attachments.js';

/*
 * Attach-by-reference for drafts. An agent (a Claude session, a script) can
 * name a file by https URL instead of pasting its bytes as base64, which does
 * not fit in a tool call for anything bigger than a few hundred KB. The aMail
 * server downloads the file itself, under these rules:
 *
 * - Off unless the operator lists hosts in AMAIL_DRAFT_ATTACHMENT_URL_HOSTS.
 * - https only, port 443, no user:pass@ in the URL.
 * - The host must match the allowlist on every hop; redirects to a host off
 *   the list are refused, and at most 3 are followed.
 * - Every address the host resolves to must be public. The connection uses
 *   the address that was checked (no second DNS lookup), so DNS rebinding
 *   cannot swap in an internal address between check and connect.
 * - Size cap (the 8 MiB draft limit), timeout, and a content-type check: an
 *   HTML response (a login or error page) is refused, and a file that says it
 *   is a PDF must start with %PDF-.
 * - Optional per-host auth headers (AMAIL_DRAFT_ATTACHMENT_URL_AUTH) are sent
 *   only to that exact host, never to a redirect target on another host.
 * - Errors never echo the URL's query string or the remote body; signed URLs
 *   carry tokens there.
 */

export const MAX_ATTACHMENT_REDIRECTS = 3;
export const DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS = 20_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function fetchError(message, code, status = 422) {
  return new AppError(message, { status, code, expose: true });
}

// Everything that is not ordinary public unicast. IPv4-mapped IPv6
// (::ffff:a.b.c.d, also in hex form) is checked against the IPv4 rules by
// BlockList itself.
const NON_PUBLIC = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NON_PUBLIC.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
]) NON_PUBLIC.addSubnet(address, prefix, 'ipv6');

/** True for loopback, private, link-local, CGNAT, multicast, reserved and
 * documentation ranges, and anything that is not an IP address at all. */
export function isNonPublicAddress(address) {
  const family = net.isIP(String(address || ''));
  if (!family) return true;
  if (family === 6 && !/^[23]/i.test(String(address).replace(/^0+/, '')) && !String(address).startsWith('::ffff:')) {
    // Outside 2000::/3 global unicast: reserved, unless it is IPv4-mapped.
    return true;
  }
  return NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** "a.example.com, *.files.example.com" -> lowercase patterns. IP literals are
 * not accepted; list a DNS name. */
export function parseHostAllowlist(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ''))
    .filter((entry) => entry && !net.isIP(entry) && /^(\*\.)?[a-z0-9.-]+$/.test(entry) && entry.includes('.'));
}

export function hostAllowed(hostname, patterns = []) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || net.isIP(host) || host.startsWith('[')) return false;
  return patterns.some((pattern) => (
    pattern.startsWith('*.')
      ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
      : host === pattern
  ));
}

/**
 * AMAIL_DRAFT_ATTACHMENT_URL_AUTH: JSON object mapping an exact host to the
 * headers to send it, e.g. {"workboard.example.com":{"Authorization":"Bearer …"}}.
 * Invalid JSON is ignored (logged by the caller) rather than crashing boot.
 */
export function parseAuthHeaders(value) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const result = {};
  for (const [host, headers] of Object.entries(parsed)) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) continue;
    const clean = {};
    for (const [name, headerValue] of Object.entries(headers)) {
      if (/^[A-Za-z0-9-]+$/.test(name) && typeof headerValue === 'string' && !/[\r\n]/.test(headerValue)) {
        clean[name.toLowerCase()] = headerValue;
      }
    }
    if (Object.keys(clean).length) result[host.trim().toLowerCase().replace(/\.$/, '')] = clean;
  }
  return result;
}

/** Where a URL points, for logs and errors: host and path, never the query. */
export function describeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return 'an invalid URL';
  }
}

function filenameFromDisposition(header) {
  const value = String(header || '');
  const star = value.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = value.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
  return plain ? (plain[2] ?? plain[1]).trim() : '';
}

function filenameFromPath(url) {
  const last = url.pathname.split('/').filter(Boolean).at(-1) || '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function looksLikePdf(buffer) {
  return buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

export function createDraftAttachmentFetcher({
  allowHosts = [],
  authHeaders = {},
  maxBytes = MAX_COMPOSE_ATTACHMENT_BYTES,
  timeoutMs = DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS,
  logger = null,
  // Injected in tests only.
  resolveHost = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  isBlockedAddress = isNonPublicAddress,
  request = https.request,
  port = 443,
} = {}) {
  const enabled = allowHosts.length > 0;
  const tooLarge = () => fetchError(
    `The attachment is larger than ${Math.round((maxBytes / (1024 * 1024)) * 10) / 10} MB.`,
    'ATTACHMENT_TOO_LARGE',
    413,
  );

  function checkUrl(raw) {
    let url;
    try {
      url = new URL(String(raw || ''));
    } catch {
      throw fetchError('The attachment URL is not a valid URL.', 'ATTACHMENT_URL_INVALID', 400);
    }
    if (url.protocol !== 'https:') {
      throw fetchError('Attachment URLs must use https.', 'ATTACHMENT_URL_BLOCKED');
    }
    if (url.username || url.password) {
      throw fetchError('Attachment URLs cannot carry a user name or password.', 'ATTACHMENT_URL_BLOCKED');
    }
    if (url.port && url.port !== '443') {
      throw fetchError('Attachment URLs must use the standard https port.', 'ATTACHMENT_URL_BLOCKED');
    }
    if (!hostAllowed(url.hostname, allowHosts)) {
      throw fetchError(
        `${url.hostname || 'That host'} is not on this server's list of hosts aMail may fetch attachments from (AMAIL_DRAFT_ATTACHMENT_URL_HOSTS).`,
        'ATTACHMENT_HOST_NOT_ALLOWED',
      );
    }
    return url;
  }

  async function publicAddresses(hostname) {
    let addresses;
    try {
      addresses = await resolveHost(hostname);
    } catch {
      throw fetchError(`${hostname} could not be resolved.`, 'ATTACHMENT_URL_DNS_FAILED', 502);
    }
    if (!Array.isArray(addresses) || !addresses.length) {
      throw fetchError(`${hostname} could not be resolved.`, 'ATTACHMENT_URL_DNS_FAILED', 502);
    }
    if (addresses.some(({ address }) => isBlockedAddress(address))) {
      throw fetchError(`${hostname} resolves to a private or reserved address.`, 'ATTACHMENT_URL_PRIVATE_ADDRESS');
    }
    return addresses;
  }

  function getOnce(url, address) {
    const headers = {
      accept: '*/*',
      'accept-encoding': 'identity',
      'user-agent': 'aMail-Draft-Attachments/1.0',
      ...(authHeaders[url.hostname.toLowerCase()] || {}),
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        callback(value);
      };
      const req = request({
        method: 'GET',
        hostname: url.hostname,
        servername: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: timeoutMs,
        // Connect to the address that was checked, not a fresh lookup.
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      }, (response) => {
        const status = response.statusCode || 0;
        if (REDIRECT_STATUSES.has(status)) {
          response.resume();
          finish(resolve, { redirect: response.headers.location });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          finish(reject, fetchError(
            `${url.hostname} answered HTTP ${status} for the attachment.`,
            'ATTACHMENT_URL_HTTP_ERROR',
            502,
          ));
          return;
        }
        const declared = Number.parseInt(response.headers['content-length'], 10);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.resume();
          finish(reject, tooLarge());
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            finish(reject, tooLarge());
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(resolve, { body: Buffer.concat(chunks), headers: response.headers }));
        response.on('error', () => finish(reject, fetchError(
          `The attachment download from ${url.hostname} was interrupted.`,
          'ATTACHMENT_URL_FAILED',
          502,
        )));
      });
      const timedOut = () => {
        finish(reject, fetchError('Downloading the attachment timed out.', 'ATTACHMENT_URL_TIMEOUT', 504));
        req.destroy();
      };
      // `timeout` only catches an idle socket; the deadline also stops a
      // server that trickles bytes.
      deadline = setTimeout(timedOut, timeoutMs);
      deadline.unref?.();
      req.once('timeout', timedOut);
      req.on('error', () => finish(reject, fetchError(
        `The attachment could not be downloaded from ${url.hostname}.`,
        'ATTACHMENT_URL_FAILED',
        502,
      )));
      req.end();
    });
  }

  /**
   * Download one file. Returns an attachment input with base64 `content`,
   * ready for the ordinary draft attachment path.
   */
  async function fetchAttachment({ url: rawUrl, filename, contentType } = {}) {
    if (!enabled) {
      throw fetchError(
        'Attaching files by URL is turned off on this server. Set AMAIL_DRAFT_ATTACHMENT_URL_HOSTS to the hosts aMail may fetch from.',
        'ATTACHMENT_URLS_DISABLED',
        503,
      );
    }
    let url = checkUrl(rawUrl);
    let result = null;
    for (let hop = 0; hop <= MAX_ATTACHMENT_REDIRECTS; hop += 1) {
      const [address] = await publicAddresses(url.hostname);
      result = await getOnce(url, address);
      if (!result.redirect) break;
      if (hop === MAX_ATTACHMENT_REDIRECTS) {
        throw fetchError('The attachment URL redirected too many times.', 'ATTACHMENT_URL_TOO_MANY_REDIRECTS', 502);
      }
      let next;
      try {
        next = new URL(String(result.redirect || ''), url).toString();
      } catch {
        throw fetchError('The attachment URL sent an invalid redirect.', 'ATTACHMENT_URL_BAD_REDIRECT', 502);
      }
      // A redirect has to pass the same rules, so an allowed host cannot
      // bounce the fetch to an internal address or an unlisted host.
      url = checkUrl(next);
    }

    const { body, headers } = result;
    if (!body?.length) throw fetchError('The attachment URL returned an empty file.', 'ATTACHMENT_URL_EMPTY', 502);
    const served = String(headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (served === 'text/html' || served === 'application/xhtml+xml') {
      throw fetchError(
        `${url.hostname} returned a web page instead of a file. The link may need a sign-in or may have expired.`,
        'ATTACHMENT_URL_NOT_A_FILE',
        502,
      );
    }
    const name = asciiFilename(filename || filenameFromDisposition(headers['content-disposition']) || filenameFromPath(url));
    const type = safeAttachmentType(contentType || (served && served !== 'application/octet-stream' ? served : '')
      || (/\.pdf$/i.test(name) ? 'application/pdf' : 'application/octet-stream'));
    if (type === 'application/pdf' && !looksLikePdf(body)) {
      throw fetchError(`${name} is not a PDF file.`, 'ATTACHMENT_URL_TYPE_MISMATCH', 422);
    }
    logger?.info?.({ attachment: { host: url.hostname, bytes: body.length, contentType: type } }, 'Fetched draft attachment by URL');
    return { filename: name, contentType: type, content: body.toString('base64') };
  }

  return { enabled, fetchAttachment };
}

/**
 * Replace every `{ url }` item in `input.attachments` and
 * `input.addAttachments` with downloaded bytes. Other items pass through.
 * Runs before the draft lock so a slow download does not block other saves.
 */
export async function resolveAttachmentReferences(input, fetcher) {
  if (!input || typeof input !== 'object') return input;
  const lists = ['attachments', 'addAttachments'];
  if (!lists.some((key) => Array.isArray(input[key]) && input[key].some((item) => item?.url))) return input;
  const resolved = { ...input };
  for (const key of lists) {
    if (!Array.isArray(input[key])) continue;
    resolved[key] = [];
    for (const item of input[key]) {
      if (!item?.url) {
        resolved[key].push(item);
        continue;
      }
      if (item.content || item.data) {
        throw fetchError('An attachment takes either content or url, not both.', 'VALIDATION_ERROR', 400);
      }
      if (!fetcher) throw fetchError('Attaching files by URL is not available.', 'ATTACHMENT_URLS_DISABLED', 503);
      const { url, ...rest } = item;
      resolved[key].push({ ...rest, ...(await fetcher.fetchAttachment({ url, filename: item.filename, contentType: item.contentType })) });
    }
  }
  return resolved;
}
