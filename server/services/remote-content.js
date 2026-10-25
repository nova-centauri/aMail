import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { AppError, NotFoundError, ValidationError } from '../errors.js';
import { createCapabilityToken, readCapabilityToken } from './crypto.js';

const MAX_REDIRECTS = 3;
const PROXY_FAILURE_THRESHOLD = 3;
const PROXY_COOLDOWN_MS = 60_000;

export function nextProxyCooldown({
  failures = 0,
  now = Date.now(),
  threshold = PROXY_FAILURE_THRESHOLD,
  cooldownMs = PROXY_COOLDOWN_MS,
} = {}) {
  const nextFailures = failures + 1;
  return {
    failures: nextFailures,
    coolingUntil: nextFailures >= threshold ? now + cooldownMs : 0,
  };
}
const IMAGE_TYPES = new Set([
  'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
]);

const requestHeaders = {
  accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.5',
  'accept-encoding': 'identity',
  'user-agent': 'aMail-Remote-Content/1.0',
};

function remoteError(message, code = 'REMOTE_CONTENT_BLOCKED', status = 422) {
  return new AppError(message, { status, code, expose: true });
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 2 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isPrivateIp(address) {
  if (net.isIP(address) === 4) return isPrivateIpv4(address);
  const value = String(address).toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  // Unspecified, loopback, unique-local, link-local, multicast, and the
  // documentation range must never be reachable through the content proxy.
  return value === '::'
    || value === '::1'
    || value.startsWith('fc')
    || value.startsWith('fd')
    || /^fe[89ab]/.test(value)
    || value.startsWith('ff')
    || value.startsWith('2001:db8:');
}

function assertAllowedHostname(hostname) {
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.docker') || hostname === 'metadata.google.internal') {
    throw remoteError('Remote content URL resolves to a private host.', 'REMOTE_CONTENT_PRIVATE_HOST');
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isPrivateIp(hostname)) throw remoteError('Remote content URL points to a private address.', 'REMOTE_CONTENT_PRIVATE_HOST');
    return [{ address: hostname, family: literalFamily }];
  }
  // A bare hostname can resolve through Docker's internal DNS (for example a
  // Compose service name). Never allow the privacy relay to reach a sibling
  // container just because resolving DNS through Tor is intentionally skipped.
  if (!hostname.includes('.')) {
    throw remoteError('Remote content URL resolves to a private host.', 'REMOTE_CONTENT_PRIVATE_HOST');
  }
  return null;
}

async function resolvePublic(hostname) {
  const literal = assertAllowedHostname(hostname);
  if (literal) return literal;

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw remoteError('Remote content host could not be resolved.', 'REMOTE_CONTENT_DNS_FAILED');
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw remoteError('Remote content host resolves to a private address.', 'REMOTE_CONTENT_PRIVATE_HOST');
  }
  return addresses;
}

async function validateUrl(rawUrl, { resolveDns = true } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('Remote content URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw remoteError('Only anonymous HTTP(S) image URLs are allowed.', 'REMOTE_CONTENT_URL_BLOCKED');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw remoteError('Remote content uses a blocked network port.', 'REMOTE_CONTENT_PORT_BLOCKED');
  }
  const literal = assertAllowedHostname(url.hostname);
  // Resolving destinations locally would leak email-image hostnames outside a
  // configured Tor/Privoxy relay. Direct development fetches resolve and pin an
  // address; privacy-proxy mode deliberately leaves DNS to that isolated proxy.
  const addresses = resolveDns ? (literal || await resolvePublic(url.hostname)) : literal;
  return { url, addresses };
}

function assertImageResponse(headers) {
  const type = String(headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) {
    throw remoteError('Remote response was not a supported image.', 'REMOTE_CONTENT_NOT_IMAGE');
  }
  return type;
}

function contentLengthIsAllowed(headers, maxBytes) {
  const contentLength = Number.parseInt(headers['content-length'], 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw remoteError('Remote image exceeds the configured size limit.', 'REMOTE_CONTENT_TOO_LARGE', 413);
  }
}

function getDirect(url, addresses, config) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = transport.request(url, {
      method: 'GET',
      headers: requestHeaders,
      timeout: config.remoteContentTimeoutMs,
      lookup: (_hostname, _options, callback) => {
        const selected = addresses[0];
        callback(null, selected.address, selected.family);
      },
    }, (response) => {
      const headers = response.headers;
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        finish(resolve, { redirect: headers.location });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(reject, remoteError('Remote image server returned an error.', 'REMOTE_CONTENT_HTTP_ERROR', 502));
        return;
      }
      let type;
      try {
        contentLengthIsAllowed(headers, config.remoteContentMaxBytes);
        type = assertImageResponse(headers);
      } catch (error) {
        response.resume();
        finish(reject, error);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > config.remoteContentMaxBytes) {
          request.destroy(remoteError('Remote image exceeds the configured size limit.', 'REMOTE_CONTENT_TOO_LARGE', 413));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, { body: Buffer.concat(chunks), contentType: type }));
      response.on('error', (error) => finish(reject, error));
    });
    request.once('timeout', () => request.destroy(remoteError('Remote image request timed out.', 'REMOTE_CONTENT_TIMEOUT', 504)));
    request.once('error', (error) => finish(reject, error));
    request.end();
  });
}

async function readUndiciBody(response, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw remoteError('Remote image exceeds the configured size limit.', 'REMOTE_CONTENT_TOO_LARGE', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function getViaProxy(url, config, proxyAgent) {
  let response;
  try {
    response = await undiciFetch(url, {
      method: 'GET',
      headers: requestHeaders,
      dispatcher: proxyAgent,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.remoteContentTimeoutMs),
    });
  } catch (error) {
    throw remoteError('The configured remote-content proxy could not retrieve the image.', 'REMOTE_CONTENT_PROXY_FAILED', 502);
  }
  const headers = Object.fromEntries(response.headers.entries());
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    return { redirect: headers.location };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw remoteError('Remote image server returned an error.', 'REMOTE_CONTENT_HTTP_ERROR', 502);
  }
  contentLengthIsAllowed(headers, config.remoteContentMaxBytes);
  const contentType = assertImageResponse(headers);
  return { body: await readUndiciBody(response, config.remoteContentMaxBytes), contentType };
}

export function createRemoteContentService({ config, repos, logger }) {
  let proxyFailures = 0;
  let proxyCoolingUntil = 0;
  let proxyAgent = null;
  if (config.remoteContentProxyUrl) {
    let proxy;
    try {
      proxy = new URL(config.remoteContentProxyUrl);
    } catch {
      throw new Error('REMOTE_CONTENT_PROXY_URL must be a valid HTTP proxy URL.');
    }
    if (!['http:', 'https:'].includes(proxy.protocol)) {
      throw new Error('REMOTE_CONTENT_PROXY_URL must use http:// or https://.');
    }
    proxyAgent = new ProxyAgent(config.remoteContentProxyUrl);
    logger.info({ remoteContentProxy: true }, 'Remote images will use the configured privacy proxy');
  } else if (config.allowDirectRemoteContent) {
    logger.warn('REMOTE_CONTENT_PROXY_URL is not configured; anonymous image fetches will use the server network directly');
  } else {
    logger.info('Remote image retrieval is disabled until REMOTE_CONTENT_PROXY_URL is configured');
  }

  function issueToken(messageId, url) {
    const expiresAt = Math.floor(Date.now() / 1000) + config.remoteContentTokenTtlSeconds;
    return createCapabilityToken({ v: 1, m: messageId, u: url, e: expiresAt }, config.remoteTokenKey);
  }

  function issueAttachmentToken(messageId, index) {
    const expiresAt = Math.floor(Date.now() / 1000) + config.remoteContentTokenTtlSeconds;
    return createCapabilityToken({ v: 1, t: 'a', m: messageId, i: index, e: expiresAt }, config.remoteTokenKey);
  }

  async function fetchToken(token) {
    const payload = readCapabilityToken(token, config.remoteTokenKey);
    if (payload?.v !== 1 || !payload.m || !payload.u || !Number.isInteger(payload.e)) {
      throw new ValidationError('The remote-content token is invalid.');
    }
    if (payload.e < Math.floor(Date.now() / 1000)) {
      throw remoteError('The remote-content token has expired. Reload the message to create a new one.', 'REMOTE_CONTENT_TOKEN_EXPIRED', 410);
    }
    if (!repos.messages.getRaw(payload.m)) throw new NotFoundError('Message for this remote-content token no longer exists.');
    if (!proxyAgent && !config.allowDirectRemoteContent) {
      throw remoteError(
        'Remote image retrieval requires REMOTE_CONTENT_PROXY_URL to protect your network identity.',
        'REMOTE_CONTENT_PROXY_REQUIRED',
        503,
      );
    }
    if (proxyAgent && Date.now() < proxyCoolingUntil) {
      throw remoteError(
        'The privacy proxy is temporarily unavailable. Mail still works; remote images are skipped.',
        'REMOTE_CONTENT_PROXY_UNAVAILABLE',
        503,
      );
    }

    let current = payload.u;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const { url, addresses } = await validateUrl(current, { resolveDns: !proxyAgent });
      let result;
      try {
        result = proxyAgent
          ? await getViaProxy(url, config, proxyAgent)
          : await getDirect(url, addresses, config);
      } catch (error) {
        if (proxyAgent) {
          const cooled = nextProxyCooldown({ failures: proxyFailures, now: Date.now() });
          proxyFailures = cooled.failures;
          proxyCoolingUntil = cooled.coolingUntil;
        }
        throw error;
      }
      if (proxyAgent) {
        proxyFailures = 0;
        proxyCoolingUntil = 0;
      }
      if (!result.redirect) return result;
      if (redirects === MAX_REDIRECTS) throw remoteError('Remote image redirected too many times.', 'REMOTE_CONTENT_TOO_MANY_REDIRECTS');
      try {
        current = new URL(result.redirect, url).toString();
      } catch {
        throw remoteError('Remote image sent an invalid redirect.', 'REMOTE_CONTENT_BAD_REDIRECT');
      }
    }
    throw remoteError('Remote image could not be retrieved.');
  }

  return {
    canIssueTokens: Boolean(config.remoteTokenKey),
    issueToken,
    issueAttachmentToken,
    fetchToken,
    close: async () => { await proxyAgent?.close?.(); },
  };
}
