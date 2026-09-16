import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { ValidationError } from '../errors.js';
import { renderSignatureForSend } from './signature.js';

const PROVIDERS = {
  gmail: {
    label: 'Gmail / Google Workspace',
    domains: ['gmail.com', 'googlemail.com'],
    credentialLabel: 'Google app password',
    credentialHelp: 'Use the full Google email address and an app password created after enabling 2-Step Verification.',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    credentialLabel: 'App password',
    credentialHelp: 'Use the full Microsoft email address and an app password if the account requires multi-factor authentication.',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  },
  yahoo: {
    label: 'Yahoo Mail',
    domains: ['yahoo.com', 'ymail.com'],
    credentialLabel: 'Yahoo app password',
    credentialHelp: 'Use the full Yahoo email address and an app password generated in Yahoo account security.',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  },
  icloud: {
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    credentialLabel: 'Apple app-specific password',
    credentialHelp: 'Use an Apple app-specific password. IMAP usually uses the address before @ (with the full address as a fallback); SMTP uses the full iCloud address.',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
  },
  mailinabox: {
    label: 'Mail-in-a-Box',
    domains: [],
    credentialLabel: 'Mailbox password',
    credentialHelp: 'Use the public TLS hostname of the box, your full mailbox address, and its mailbox or app password.',
    requiresServerHost: true,
    imap: { port: 993, secure: true },
    smtp: { port: 587, secure: false },
  },
  custom: {
    label: 'Custom IMAP + SMTP',
    domains: [],
    credentialLabel: 'App or mailbox password',
    credentialHelp: 'Use the provider\'s TLS hostnames and app password when one is available.',
    requiresServerHost: true,
    imap: { port: 993, secure: true },
    smtp: { port: 587, secure: false },
  },
};

const PROVIDER_ALIASES = {
  apple: 'icloud',
  google: 'gmail',
  'google-workspace': 'gmail',
  hotmail: 'outlook',
  imap: 'custom',
  'mail-in-a-box': 'mailinabox',
  mail_in_a_box: 'mailinabox',
  miab: 'mailinabox',
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const DEFAULT_ACCOUNT_COLOR = '#1a73e8';

export function isEmail(value) {
  return typeof value === 'string' && emailPattern.test(value.trim());
}

function emailDomain(value) {
  if (!isEmail(value)) return '';
  return String(value).trim().toLowerCase().split('@').at(-1);
}

function looseHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function normalizeMailHost(value, fieldName = 'mail server') {
  const raw = looseHost(value);
  if (!raw || raw.length > 253 || /[\s/@?#]/.test(raw) || raw.includes('://')) {
    throw new ValidationError(`A valid ${fieldName} hostname is required.`);
  }
  if (isIP(raw)) return raw;
  const host = domainToASCII(raw).toLowerCase();
  const labels = host.split('.');
  if (!host || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    throw new ValidationError(`A valid ${fieldName} hostname is required.`);
  }
  return host;
}

export function discoverAccountProvider(input = {}) {
  const domain = emailDomain(typeof input === 'string' ? input : input.email);
  for (const [provider, preset] of Object.entries(PROVIDERS)) {
    if (preset.domains.includes(domain)) {
      return { provider, confidence: 'domain', reason: `Known ${provider} email domain.` };
    }
  }

  const hosts = [
    input.serverHost,
    input.host,
    input.imap?.host,
    input.smtp?.host,
  ].map(looseHost).filter(Boolean);
  for (const [provider, preset] of Object.entries(PROVIDERS)) {
    if (preset.imap?.host && hosts.includes(preset.imap.host)) {
      return { provider, confidence: 'server', reason: `Known ${provider} mail server.` };
    }
    if (preset.smtp?.host && hosts.includes(preset.smtp.host)) {
      return { provider, confidence: 'server', reason: `Known ${provider} mail server.` };
    }
  }
  if (hosts.some((host) => /^box\.[a-z0-9.-]+$/i.test(host))) {
    return { provider: 'mailinabox', confidence: 'server-pattern', reason: 'Mail-in-a-Box commonly uses a box.* TLS hostname.' };
  }
  return { provider: 'custom', confidence: 'none', reason: 'No hosted-provider preset matched.' };
}

export function mailProviderCatalog() {
  return Object.entries(PROVIDERS).map(([id, preset]) => ({
    id,
    label: preset.label,
    domains: [...preset.domains],
    credentialLabel: preset.credentialLabel,
    credentialHelp: preset.credentialHelp,
    requiresServerHost: Boolean(preset.requiresServerHost),
    imap: { ...preset.imap },
    smtp: { ...preset.smtp },
  }));
}

const REPLY_PREFIX = /^(?:(?:re|fw|fwd|aw|sv|antw)\s*:\s*)/i;

/** True when the subject carries a reply/forward prefix such as "Re:". */
export function hasReplyPrefix(value) {
  return REPLY_PREFIX.test(String(value || '').trim());
}

export function normalizeSubject(value) {
  let subject = String(value || '').trim();
  // Collapse common repeated reply/forward prefixes but leave the actual subject
  // intact. This is only a fallback; RFC Message-ID references take precedence.
  while (REPLY_PREFIX.test(subject)) {
    subject = subject.replace(REPLY_PREFIX, '').trim();
  }
  return subject.toLocaleLowerCase();
}

export function normalizeMessageIds(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeMessageIds);
  if (!value) return [];
  const matches = String(value).match(/<[^>]+>/g);
  return matches ? matches.map((item) => item.trim()) : [String(value).trim()].filter(Boolean);
}

export function addressList(value) {
  const list = Array.isArray(value) ? value : value?.value || [];
  return list
    .map((item) => ({ name: String(item?.name || ''), email: String(item?.address || item?.email || '').trim() }))
    .filter((item) => isEmail(item.email));
}

export function recipientList(value, fieldName = 'recipient') {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const recipients = values.map((item) => {
    if (typeof item === 'object' && item) {
      return { name: String(item.name || ''), email: String(item.email || item.address || '').trim() };
    }
    const raw = String(item).trim();
    const match = raw.match(/^(?:"?([^<"]+)"?\s*)?<([^>]+)>$/);
    return match ? { name: match[1]?.trim() || '', email: match[2].trim() } : { name: '', email: raw };
  }).filter((item) => item.email);
  if (recipients.some((item) => !isEmail(item.email))) {
    throw new ValidationError(`A ${fieldName} address is invalid.`);
  }
  return recipients;
}

export function recipientsToHeader(recipients) {
  return recipients.map(({ name, email }) => name ? `"${name.replaceAll('"', '')}" <${email}>` : email).join(', ');
}

export function accountConnection(input) {
  const requestedProvider = String(input.provider || 'auto').trim().toLowerCase();
  const provider = requestedProvider === 'auto'
    ? discoverAccountProvider(input).provider
    : (PROVIDER_ALIASES[requestedProvider] || requestedProvider);
  const defaults = PROVIDERS[provider];
  if (!defaults) {
    throw new ValidationError(`Unsupported mail provider "${requestedProvider}". Choose a provider preset or custom IMAP + SMTP.`);
  }
  const sharedHost = input.serverHost ?? input.host;
  const imap = { ...defaults.imap, ...(sharedHost ? { host: sharedHost } : {}), ...(input.imap || {}) };
  const smtp = { ...defaults.smtp, ...(sharedHost ? { host: sharedHost } : {}), ...(input.smtp || {}) };
  const positivePort = (value) => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535;
  if (!imap.host || !positivePort(imap.port) || !smtp.host || !positivePort(smtp.port)) {
    const hostHint = defaults.requiresServerHost ? ' Add serverHost, or provide both protocol hosts.' : '';
    throw new ValidationError(`A valid IMAP and SMTP host and port are required.${hostHint}`);
  }
  const secureFlag = (value, fallback, fieldName) => {
    const resolved = value === undefined ? fallback : value;
    if (typeof resolved === 'boolean') return resolved;
    if (resolved === 1 || resolved === '1' || String(resolved).toLowerCase() === 'true') return true;
    if (resolved === 0 || resolved === '0' || String(resolved).toLowerCase() === 'false') return false;
    throw new ValidationError(`${fieldName} secure must be true or false.`);
  };
  return {
    provider,
    imap: {
      host: normalizeMailHost(imap.host, 'IMAP server'),
      port: Number(imap.port),
      secure: secureFlag(imap.secure, true, 'IMAP'),
    },
    smtp: {
      host: normalizeMailHost(smtp.host, 'SMTP server'),
      port: Number(smtp.port),
      secure: secureFlag(smtp.secure, false, 'SMTP'),
    },
  };
}

export function buildAuth(credentials, fallbackEmail, protocol = '') {
  const protocolName = ['imap', 'smtp'].includes(String(protocol).toLowerCase()) ? String(protocol).toLowerCase() : '';
  const prefix = protocolName || null;
  const user = String(
    (prefix && (credentials?.[`${prefix}Username`] || credentials?.[`${prefix}User`]))
      || credentials?.username
      || credentials?.user
      || fallbackEmail
      || '',
  ).trim();
  if (!user || user.length > 320 || /[\r\n\0]/.test(user)) {
    throw new ValidationError('Account credentials need a valid username.');
  }
  const accessToken = (prefix && credentials?.[`${prefix}AccessToken`]) || credentials?.accessToken;
  if (accessToken) {
    return { type: 'OAuth2', user, accessToken: String(accessToken) };
  }
  const password = (prefix && credentials?.[`${prefix}Password`]) || credentials?.password;
  if (!password || typeof password !== 'string') {
    throw new ValidationError('Account credentials need an app password or OAuth access token.');
  }
  return { user, pass: password };
}

export function appendSignature({ html = '', text = '', signature = '', includeSignature = true }) {
  if (!includeSignature || !String(signature || '').trim()) return { html, text };
  const rendered = renderSignatureForSend(signature);
  if (!rendered.html && !rendered.text) return { html, text };
  return {
    html: `${html || ''}<br><br><div data-amail-signature="true">${rendered.html}</div>`,
    text: `${text || ''}${text ? '\n\n' : ''}-- \n${rendered.text}`,
  };
}

export function folderForMailbox(mailbox, isSent = false) {
  const value = String(mailbox || '').toLowerCase();
  if (isSent || /(?:^|\/|\\)(sent|sent items)(?:$|\/|\\)/i.test(value)) return 'sent';
  if (/(?:trash|deleted)/i.test(value)) return 'trash';
  if (/(?:spam|junk|bulk mail)/i.test(value)) return 'spam';
  if (/(?:draft)/i.test(value)) return 'drafts';
  if (/(?:archive|all mail)/i.test(value)) return 'archive';
  return 'inbox';
}
