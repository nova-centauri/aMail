// Shared with the Vite client via src/mail/search-query.js. Keep this file
// free of Node-only APIs so the production image and browser bundle can both
// import it. The runtime image copies /server, not /src.
const OPERATOR_KEYS = new Set([
  'from', 'to', 'subject', 'has', 'after', 'before', 'is', 'in', 'older_than', 'newer_than',
]);

const FOLDER_ALIASES = {
  inbox: 'inbox',
  starred: 'starred',
  star: 'starred',
  snoozed: 'snoozed',
  sent: 'sent',
  drafts: 'drafts',
  draft: 'drafts',
  trash: 'trash',
  spam: 'spam',
  junk: 'spam',
  archive: 'archive',
  all: 'all',
  anywhere: 'all',
};

export function emptyMailboxQuery() {
  return {
    raw: '',
    text: '',
    from: [],
    to: [],
    subject: [],
    notFrom: [],
    notTo: [],
    notSubject: [],
    hasAttachment: null,
    after: null,
    before: null,
    isUnread: null,
    isStarred: null,
    // Agent-side counterpart of unread: null = ignore, true = only analyzed.
    isAnalyzed: null,
    folder: null,
    anywhere: false,
  };
}

export function tokenizeSearch(raw) {
  return String(raw || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
}

export function unquoteSearchValue(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteSearchValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /[\s"']/.test(text) ? `"${text.replace(/"/g, '')}"` : text;
}

export function parseSearchDate(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

export function parseRelativeAge(value, nowMs) {
  const match = String(value || '').trim().toLowerCase().match(/^(\d+)\s*(d|w|m|y)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount < 1 || amount > 3650) return null;
  const unitMs = {
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    m: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  }[match[2]];
  return new Date(nowMs - (amount * unitMs));
}

function splitOperator(token) {
  const match = String(token || '').match(/^(-)?(from|to|subject|has|after|before|is|in|older_than|newer_than):(.*)$/i);
  if (!match) return null;
  return {
    negated: Boolean(match[1]),
    key: match[2].toLowerCase(),
    value: unquoteSearchValue(match[3]),
  };
}

export function parseMailboxQuery(raw, { now = Date.now() } = {}) {
  const source = String(raw || '').trim();
  const parsed = emptyMailboxQuery();
  parsed.raw = source;
  if (!source) return parsed;

  const textParts = [];
  for (const token of tokenizeSearch(source)) {
    const operator = splitOperator(token);
    if (!operator || !OPERATOR_KEYS.has(operator.key)) {
      textParts.push(unquoteSearchValue(token));
      continue;
    }
    const value = operator.value;
    if (operator.key === 'from' && value) {
      (operator.negated ? parsed.notFrom : parsed.from).push(value);
      continue;
    }
    if (operator.key === 'to' && value) {
      (operator.negated ? parsed.notTo : parsed.to).push(value);
      continue;
    }
    if (operator.key === 'subject' && value) {
      (operator.negated ? parsed.notSubject : parsed.subject).push(value);
      continue;
    }
    if (operator.key === 'has') {
      if (/^attachments?$/.test(value)) parsed.hasAttachment = !operator.negated;
      continue;
    }
    if (operator.key === 'after') {
      const date = parseSearchDate(value);
      if (date) parsed.after = date.toISOString();
      continue;
    }
    if (operator.key === 'before') {
      const date = parseSearchDate(value);
      if (date) parsed.before = date.toISOString();
      continue;
    }
    if (operator.key === 'newer_than') {
      const date = parseRelativeAge(value, now);
      if (date) parsed.after = date.toISOString();
      continue;
    }
    if (operator.key === 'older_than') {
      const date = parseRelativeAge(value, now);
      if (date) parsed.before = date.toISOString();
      continue;
    }
    if (operator.key === 'is') {
      if (value === 'unread') parsed.isUnread = !operator.negated;
      else if (value === 'read') parsed.isUnread = operator.negated;
      else if (value === 'starred') parsed.isStarred = !operator.negated;
      else if (value === 'unstarred') parsed.isStarred = operator.negated;
      else if (value === 'analyzed' || value === 'analysed') parsed.isAnalyzed = !operator.negated;
      else if (value === 'unanalyzed' || value === 'unanalysed') parsed.isAnalyzed = operator.negated;
      continue;
    }
    if (operator.key === 'in') {
      const folder = FOLDER_ALIASES[value.toLowerCase()] || null;
      parsed.folder = folder;
      if (value.toLowerCase() === 'anywhere') parsed.anywhere = true;
    }
  }
  parsed.text = textParts.filter(Boolean).join(' ').trim();
  return parsed;
}

export function mailboxQueryIsActive(parsed) {
  if (!parsed) return false;
  return Boolean(
    parsed.text
    || parsed.from.length
    || parsed.to.length
    || parsed.subject.length
    || parsed.notFrom.length
    || parsed.notTo.length
    || parsed.notSubject.length
    || parsed.hasAttachment != null
    || parsed.after
    || parsed.before
    || parsed.isUnread != null
    || parsed.isStarred != null
    || parsed.isAnalyzed != null
    || parsed.folder
    || parsed.anywhere,
  );
}

export function serializeMailboxQuery(parsed) {
  if (!parsed) return '';
  const parts = [];
  for (const value of parsed.from) parts.push(`from:${quoteSearchValue(value)}`);
  for (const value of parsed.to) parts.push(`to:${quoteSearchValue(value)}`);
  for (const value of parsed.subject) parts.push(`subject:${quoteSearchValue(value)}`);
  for (const value of parsed.notFrom) parts.push(`-from:${quoteSearchValue(value)}`);
  for (const value of parsed.notTo) parts.push(`-to:${quoteSearchValue(value)}`);
  for (const value of parsed.notSubject) parts.push(`-subject:${quoteSearchValue(value)}`);
  if (parsed.hasAttachment === true) parts.push('has:attachment');
  if (parsed.hasAttachment === false) parts.push('-has:attachment');
  if (parsed.after) {
    const date = new Date(parsed.after);
    if (!Number.isNaN(date.valueOf())) {
      parts.push(`after:${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`);
    }
  }
  if (parsed.before) {
    const date = new Date(parsed.before);
    if (!Number.isNaN(date.valueOf())) {
      parts.push(`before:${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`);
    }
  }
  if (parsed.isUnread === true) parts.push('is:unread');
  if (parsed.isUnread === false) parts.push('is:read');
  if (parsed.isStarred === true) parts.push('is:starred');
  if (parsed.isStarred === false) parts.push('is:unstarred');
  if (parsed.isAnalyzed === true) parts.push('is:analyzed');
  if (parsed.isAnalyzed === false) parts.push('is:unanalyzed');
  if (parsed.anywhere) parts.push('in:anywhere');
  else if (parsed.folder) parts.push(`in:${parsed.folder}`);
  if (parsed.text) parts.push(parsed.text);
  return parts.join(' ');
}

function personHaystack(person) {
  if (!person) return '';
  if (typeof person === 'string') return person.toLowerCase();
  return `${person.name || ''} ${person.email || person.address || ''}`.toLowerCase();
}

function peopleMatch(people, needle) {
  const want = String(needle || '').trim().toLowerCase();
  if (!want) return false;
  return people.some((person) => personHaystack(person).includes(want));
}

function textIncludes(value, needle) {
  return String(value || '').toLowerCase().includes(String(needle || '').trim().toLowerCase());
}

function conversationPeople(conversation) {
  const latest = conversation.latest || conversation;
  const messages = conversation.messages || conversation._threadMessages || [];
  const from = [latest.from, conversation.from, ...messages.map((message) => message.from)].filter(Boolean);
  const to = [
    ...(latest.to || []),
    ...(latest.cc || []),
    ...(conversation.to || []),
    ...(conversation.cc || []),
    ...messages.flatMap((message) => [...(message.to || []), ...(message.cc || [])]),
  ];
  return { from, to };
}

function conversationHasAttachments(conversation) {
  if (conversation.hasAttachments) return true;
  const latest = conversation.latest || conversation;
  if ((latest.attachments || []).length || (conversation.attachments || []).length) return true;
  return (conversation.messages || conversation._threadMessages || []).some((message) => (message.attachments || []).length);
}

function conversationTimestamp(conversation) {
  const latest = conversation.latest || conversation;
  const raw = latest.latestAt || latest.sentAt || latest.receivedAt || latest.updatedAt || latest.createdAt
    || conversation.latestAt || conversation.timestamp || conversation.sentAt || conversation.receivedAt;
  const time = Date.parse(raw || '');
  return Number.isNaN(time) ? 0 : time;
}

function conversationIsUnread(conversation) {
  if (conversation.unread === true || Number(conversation.unreadCount) > 0) return true;
  if (conversation.isRead === false) return true;
  const latest = conversation.latest || conversation;
  if (latest.isRead === false) return true;
  const messages = conversation.messages || conversation._threadMessages || [];
  return messages.some((message) => message.isRead === false || message.unread === true);
}

function conversationIsStarred(conversation) {
  if (conversation.starred === true || conversation.isStarred === true) return true;
  const latest = conversation.latest || conversation;
  if (latest.isStarred === true || latest.starred === true) return true;
  return (conversation.messages || conversation._threadMessages || []).some((message) => message.isStarred || message.starred);
}

function conversationIsAnalyzed(conversation) {
  if (Number(conversation.unanalyzedCount) > 0) return false;
  if (conversation.isAnalyzed === false || conversation.analyzed === false) return false;
  const messages = conversation.messages || conversation._threadMessages || [];
  if (messages.length) return messages.every((message) => message.isAnalyzed !== false && message.analyzed !== false);
  const latest = conversation.latest || conversation;
  return latest.isAnalyzed !== false && latest.analyzed !== false;
}

export function conversationMatchesMailboxQuery(conversation, parsed, { skipText = false } = {}) {
  if (!parsed || !mailboxQueryIsActive(parsed)) return true;
  const latest = conversation.latest || conversation;
  const { from, to } = conversationPeople(conversation);
  const subject = latest.subject || conversation.subject || '';
  const snippet = latest.snippet || conversation.snippet || '';
  const haystack = [subject, snippet, personHaystack(latest.from), ...from.map(personHaystack), ...to.map(personHaystack)].join(' ');

  if (!skipText && parsed.text) {
    const tokens = parsed.text.split(/\s+/).filter(Boolean);
    if (!tokens.every((token) => textIncludes(haystack, token))) return false;
  }
  if (parsed.from.some((value) => !peopleMatch(from, value))) return false;
  if (parsed.notFrom.some((value) => peopleMatch(from, value))) return false;
  if (parsed.to.some((value) => !peopleMatch(to, value))) return false;
  if (parsed.notTo.some((value) => peopleMatch(to, value))) return false;
  if (parsed.subject.some((value) => !textIncludes(subject, value))) return false;
  if (parsed.notSubject.some((value) => textIncludes(subject, value))) return false;
  if (parsed.hasAttachment === true && !conversationHasAttachments(conversation)) return false;
  if (parsed.hasAttachment === false && conversationHasAttachments(conversation)) return false;
  const timestamp = conversationTimestamp(conversation);
  if (parsed.after && timestamp < Date.parse(parsed.after)) return false;
  if (parsed.before && timestamp >= Date.parse(parsed.before)) return false;
  if (parsed.isUnread === true && !conversationIsUnread(conversation)) return false;
  if (parsed.isUnread === false && conversationIsUnread(conversation)) return false;
  if (parsed.isStarred === true && !conversationIsStarred(conversation)) return false;
  if (parsed.isStarred === false && conversationIsStarred(conversation)) return false;
  if (parsed.isAnalyzed === true && !conversationIsAnalyzed(conversation)) return false;
  if (parsed.isAnalyzed === false && conversationIsAnalyzed(conversation)) return false;
  return true;
}
