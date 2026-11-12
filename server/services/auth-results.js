import { domainToASCII } from 'node:url';
import { ValidationError } from '../errors.js';

/*
 * Sender authentication verdicts, read from the headers the receiving mail
 * server stamps on a message (RFC 8601 Authentication-Results, and RFC 8617
 * ARC-Authentication-Results as a fallback).
 *
 * aMail does not run SPF, DKIM or DMARC itself. It records what the account's
 * own mail server concluded, under these rules:
 *
 * - A header is only believed when its authserv-id is one the operator (or a
 *   provider default) names as the account's receiving server. Anyone can put
 *   an Authentication-Results header on a message they send, so a header with
 *   any other authserv-id is recorded as `trusted: false`.
 * - Only the TOPMOST header with a trusted authserv-id is used. Receiving
 *   servers prepend, so their header sits above anything the sender supplied.
 * - With no trusted id configured, or no header carrying one, the topmost
 *   header is still parsed and stored, marked `trusted: false`.
 * - Nothing here changes aMail's own categories or spam handling.
 */

export const AUTH_RESULT_VALUES = Object.freeze([
  'pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'unknown',
]);

/**
 * Receiving-server authserv-ids aMail is confident about, keyed by provider
 * preset. Gmail and Google Workspace stamp `mx.google.com`. Other providers
 * vary by host or omit the id, so they start empty and the operator sets
 * `trustedAuthservIds` on the account or AMAIL_TRUSTED_AUTHSERV_IDS.
 */
export const PROVIDER_AUTHSERV_IDS = Object.freeze({
  gmail: Object.freeze(['mx.google.com']),
});

const MAX_HEADER_CHARS = 8 * 1024;
const MAX_HEADERS = 20;
const MAX_RESULTS = 24;
const MAX_TOKEN_CHARS = 255;
const MAX_DKIM_DOMAINS = 10;
const MAX_TRUSTED_IDS = 20;
const AUTHSERV_ID_PATTERN = /^(\*\.)?[a-z0-9](?:[a-z0-9._-]{0,252}[a-z0-9])?$/;

const RESULT_ALIASES = {
  // Pre-RFC 7001 SPF wording, still emitted by some servers.
  hardfail: 'fail',
  error: 'temperror',
  // DKIM "policy": the signature verified but local policy refused it.
  policy: 'fail',
  // Microsoft: no DMARC record is published for the From domain.
  bestguesspass: 'none',
};

function normalizeResult(value) {
  const result = String(value || '').trim().toLowerCase();
  if (AUTH_RESULT_VALUES.includes(result)) return result;
  return RESULT_ALIASES[result] || 'unknown';
}

/** Remove RFC 5322 comments, keeping quoted strings intact. */
function stripComments(value) {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      out += char;
      if (char === '\\' && index + 1 < value.length) {
        index += 1;
        out += value[index];
      } else if (char === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (char === '\\') index += 1;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      out += char;
    } else if (char === '(') {
      depth = 1;
      out += ' ';
    } else out += char;
  }
  return out;
}

function splitOutsideQuotes(value, separator) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      current += char;
      if (char === '\\' && index + 1 < value.length) {
        index += 1;
        current += value[index];
      } else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
    } else if (char === separator) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

function cleanToken(value) {
  let token = String(value || '').trim();
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    token = token.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return token.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_TOKEN_CHARS);
}

/** Lowercase ASCII domain, or '' when the value is not a plausible domain. */
export function normalizeDomain(value) {
  let domain = cleanToken(value).toLowerCase().replace(/\.$/, '');
  if (domain.includes('@')) domain = domain.slice(domain.lastIndexOf('@') + 1);
  domain = domain.replace(/^[<\s]+|[>\s]+$/g, '');
  if (!domain || domain.length > 253) return '';
  const ascii = /^[a-z0-9._-]+$/.test(domain) ? domain : domainToASCII(domain).toLowerCase();
  if (!ascii || !/^[a-z0-9_](?:[a-z0-9._-]*[a-z0-9])?$/.test(ascii) || ascii.includes('..')) return '';
  return ascii;
}

const PAIR_PATTERN = /([A-Za-z0-9][A-Za-z0-9._/-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s"]+)/g;

function parseResinfo(segment) {
  const pairs = [...segment.matchAll(PAIR_PATTERN)];
  if (!pairs.length) return null;
  const [first, ...rest] = pairs;
  const method = first[1].split('/', 1)[0].toLowerCase();
  if (!method || method.includes('.')) return null;
  const props = {};
  for (const pair of rest) {
    const key = pair[1].toLowerCase();
    if (!(key in props)) props[key] = cleanToken(pair[2]);
  }
  return { method, result: normalizeResult(cleanToken(first[2])), props };
}

/**
 * Parse one Authentication-Results header value (no header name), or an
 * ARC-Authentication-Results value with `{ arc: true }`.
 * Returns `{ authservId, results: [{ method, result, props }] }`; authservId
 * is '' when the server omitted it (Microsoft 365 does). Null when the value
 * holds nothing usable.
 */
export function parseAuthenticationResults(value, { arc = false } = {}) {
  const raw = String(value || '').replace(/\r?\n[ \t]*/g, ' ').slice(0, MAX_HEADER_CHARS);
  const segments = splitOutsideQuotes(stripComments(raw), ';').map((segment) => segment.trim());
  let instance = null;
  if (arc) {
    const match = /^i\s*=\s*(\d{1,3})$/.exec(segments[0] || '');
    if (!match) return null;
    instance = Number(match[1]);
    segments.shift();
  }
  if (!segments.length || !segments[0]) return null;
  let authservId = '';
  if (!segments[0].includes('=')) {
    authservId = cleanToken(segments.shift().split(/\s+/, 1)[0]).toLowerCase().replace(/\.$/, '');
    if (!authservId) return null;
  }
  const results = [];
  for (const segment of segments) {
    if (results.length >= MAX_RESULTS) break;
    if (!segment || /^none$/i.test(segment)) continue;
    const resinfo = parseResinfo(segment);
    if (resinfo) results.push(resinfo);
  }
  return { authservId, results, ...(arc ? { instance } : {}) };
}

/** Lenient list parser for env values and stored JSON. Invalid ids drop out. */
export function parseAuthservIdList(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  const ids = items
    .map((item) => String(item ?? '').trim().toLowerCase().replace(/\.$/, ''))
    .filter((item) => AUTHSERV_ID_PATTERN.test(item));
  return [...new Set(ids)].slice(0, MAX_TRUSTED_IDS);
}

/** Strict parser for API input: one bad entry rejects the request. */
export function validateAuthservIdList(value) {
  if (value === null) return [];
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (!items) throw new ValidationError('trustedAuthservIds must be a list of server names.');
  const cleaned = items.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (cleaned.length > MAX_TRUSTED_IDS) {
    throw new ValidationError(`trustedAuthservIds accepts at most ${MAX_TRUSTED_IDS} entries.`);
  }
  const ids = parseAuthservIdList(cleaned);
  if (ids.length !== new Set(cleaned.map((item) => item.toLowerCase().replace(/\.$/, ''))).size) {
    throw new ValidationError('trustedAuthservIds entries must be server names such as mx.example.com or *.example.com.');
  }
  return ids;
}

/** Exact match, or `*.example.com` for any name under example.com. */
export function authservIdTrusted(authservId, trustedIds = []) {
  const id = String(authservId || '').toLowerCase().replace(/\.$/, '');
  if (!id) return false;
  return trustedIds.some((pattern) => (
    pattern.startsWith('*.')
      ? id.endsWith(pattern.slice(1)) && id.length > pattern.length - 1
      : id === pattern
  ));
}

/**
 * The ids believed for one account: the account's own list, the global
 * AMAIL_TRUSTED_AUTHSERV_IDS, and the provider default.
 */
export function resolveTrustedAuthservIds(account, config = {}) {
  let own = account?.trustedAuthservIds;
  if (own === undefined) {
    try {
      own = JSON.parse(account?.trusted_authserv_ids || '[]');
    } catch {
      own = [];
    }
  }
  return parseAuthservIdList([
    ...(Array.isArray(own) ? own : []),
    ...(config?.trustedAuthservIds || []),
    ...(PROVIDER_AUTHSERV_IDS[account?.provider] || []),
  ]);
}

// Second-level labels registries commonly sell names under (co.uk, com.au).
// This is a heuristic, not the Public Suffix List; see docs/webhooks.md.
const REGISTRY_SECOND_LEVELS = new Set([
  'ac', 'co', 'com', 'edu', 'gob', 'gouv', 'gov', 'govt', 'ltd', 'me', 'mil', 'ne', 'net', 'nom', 'or',
  'org', 'plc', 'sch',
]);

/** Organisational domain by heuristic: last two labels, three under co.uk-style suffixes. */
export function organizationalDomain(value) {
  const domain = normalizeDomain(value);
  if (!domain) return '';
  const labels = domain.split('.');
  if (labels.length <= 2) return domain;
  const tld = labels.at(-1);
  const take = tld.length === 2 && REGISTRY_SECOND_LEVELS.has(labels.at(-2)) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** DMARC relaxed alignment: both names share an organisational domain. */
export function domainsAligned(left, right) {
  const a = organizationalDomain(left);
  const b = organizationalDomain(right);
  return Boolean(a) && a === b;
}

function headerValues(headerLines, name) {
  const values = [];
  for (const header of Array.isArray(headerLines) ? headerLines : []) {
    if (String(header?.key || '').toLowerCase() !== name) continue;
    const line = String(header.line || '');
    const colon = line.indexOf(':');
    values.push((colon === -1 ? line : line.slice(colon + 1)).replace(/\r?\n[ \t]*/g, ' ').trim());
    if (values.length >= MAX_HEADERS) break;
  }
  return values;
}

function angleAddress(value) {
  const text = cleanToken(String(value || '').slice(0, 1024));
  const match = /<([^<>]*)>/.exec(text);
  return (match ? match[1] : text).trim();
}

function summarize(parsed, fromDomain) {
  const byMethod = (method) => parsed.results.filter((item) => item.method === method);
  const dkimResults = byMethod('dkim');
  const dkimDomains = [...new Set(dkimResults
    .filter((item) => item.result === 'pass')
    .map((item) => normalizeDomain(item.props['header.d'] || item.props['header.i']))
    .filter(Boolean))].slice(0, MAX_DKIM_DOMAINS);
  const dkim = dkimResults.some((item) => item.result === 'pass')
    ? 'pass'
    : (dkimResults[0]?.result || 'none');
  const spfResult = byMethod('spf')[0] || null;
  const spf = spfResult?.result || 'none';
  const dmarcResult = byMethod('dmarc')[0] || null;
  const dmarc = dmarcResult?.result || 'none';

  // The receiving server's DMARC verdict wins when it has one: it used the
  // real Public Suffix List. The heuristic only fills in for domains that
  // publish no DMARC policy.
  let fromAligned = false;
  if (fromDomain) {
    const dmarcFrom = normalizeDomain(dmarcResult?.props['header.from']);
    if (dmarc === 'pass') fromAligned = !dmarcFrom || domainsAligned(dmarcFrom, fromDomain);
    else if (dmarc !== 'fail') {
      const spfDomain = normalizeDomain(spfResult?.props['smtp.mailfrom'] || spfResult?.props['smtp.helo']);
      fromAligned = dkimDomains.some((domain) => domainsAligned(domain, fromDomain))
        || (spf === 'pass' && domainsAligned(spfDomain, fromDomain));
    }
  }
  return { spf, dkim, dmarc, dkimDomains, fromAligned };
}

/**
 * Work out the stored authentication columns for one parsed message.
 *
 * @param {object} input
 * @param {Array<{key: string, line: string}>} input.headerLines mailparser's raw header lines, topmost first
 * @param {string} input.fromEmail the From address aMail stores for the message
 * @param {string[]} input.trustedIds from resolveTrustedAuthservIds
 */
export function authenticationColumns({ headerLines, fromEmail = '', trustedIds = [] } = {}) {
  const fromDomain = normalizeDomain(fromEmail);
  const direct = headerValues(headerLines, 'authentication-results')
    .map((value) => parseAuthenticationResults(value)).filter(Boolean);
  const arc = headerValues(headerLines, 'arc-authentication-results')
    .map((value) => parseAuthenticationResults(value, { arc: true })).filter(Boolean);
  const trustedHeader = direct.find((item) => authservIdTrusted(item.authservId, trustedIds))
    || arc.find((item) => authservIdTrusted(item.authservId, trustedIds))
    || null;
  const chosen = trustedHeader || direct[0] || arc[0] || null;
  const summary = chosen
    ? summarize(chosen, fromDomain)
    : { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', dkimDomains: [], fromAligned: false };

  const returnPaths = headerValues(headerLines, 'return-path');
  const listIds = headerValues(headerLines, 'list-id');
  return {
    auth_spf: summary.spf,
    auth_dkim: summary.dkim,
    auth_dmarc: summary.dmarc,
    auth_authserv_id: chosen?.authservId || null,
    auth_trusted: trustedHeader ? 1 : 0,
    auth_dkim_domains: JSON.stringify(summary.dkimDomains),
    auth_from_aligned: summary.fromAligned ? 1 : 0,
    // '' is the null reverse-path (<>), which bounces and auto-replies use.
    return_path: returnPaths.length ? angleAddress(returnPaths[0]).slice(0, 320) : null,
    list_id: listIds.length ? (angleAddress(listIds[0]).slice(0, MAX_TOKEN_CHARS) || null) : null,
    list_unsubscribe: headerValues(headerLines, 'list-unsubscribe').length ? 1 : 0,
  };
}

export const AUTHENTICATION_COLUMNS = Object.freeze([
  'auth_spf', 'auth_dkim', 'auth_dmarc', 'auth_authserv_id', 'auth_trusted', 'auth_dkim_domains',
  'auth_from_aligned', 'return_path', 'list_id', 'list_unsubscribe',
]);

/**
 * The `authentication` object on a public message. Null for mail stored
 * before aMail recorded these headers, and for sent mail and drafts.
 */
export function publicAuthentication(row) {
  if (!row || row.auth_spf === null || row.auth_spf === undefined) return null;
  let dkimDomains = [];
  try {
    const parsed = JSON.parse(row.auth_dkim_domains || '[]');
    if (Array.isArray(parsed)) dkimDomains = parsed.filter((item) => typeof item === 'string');
  } catch {
    dkimDomains = [];
  }
  const verdict = (value) => (AUTH_RESULT_VALUES.includes(value) ? value : 'unknown');
  return {
    spf: verdict(row.auth_spf),
    dkim: verdict(row.auth_dkim),
    dmarc: verdict(row.auth_dmarc),
    authservId: row.auth_authserv_id || null,
    trusted: Boolean(row.auth_trusted),
    fromAligned: Boolean(row.auth_from_aligned),
    dkimDomains,
    returnPath: row.return_path ?? null,
  };
}
