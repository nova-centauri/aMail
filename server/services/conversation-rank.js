/**
 * Cross-account conversation identity and stable merge for streamed search.
 * RFC Message-ID is the strong key; subject+from+day is a last-resort fallback.
 */
import { normalizeSubject } from '../utils/mail.js';

export function conversationDedupeKey(conversation) {
  const rfc = String(
    conversation?.messageId
    || conversation?.rfcMessageId
    || conversation?.latest?.messageId
    || '',
  ).trim().toLowerCase();
  if (rfc) return `rfc:${rfc}`;
  const subject = normalizeSubject(conversation?.subject || conversation?.latest?.subject || '');
  const from = String(conversation?.from?.email || conversation?.latest?.from?.email || '').trim().toLowerCase();
  const day = String(conversation?.latestAt || conversation?.sentAt || conversation?.receivedAt || '').slice(0, 10);
  if (subject && from && day) return `approx:${from}|${subject}|${day}`;
  return `id:${conversation?.id || conversation?.threadId || ''}`;
}

function timestamp(conversation) {
  const raw = conversation?.latestAt || conversation?.sentAt || conversation?.receivedAt || conversation?.updatedAt || '';
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

function preferConversation(current, incoming) {
  const currentImported = current?.sourceImported !== false;
  const incomingImported = incoming?.sourceImported !== false;
  if (incomingImported && !currentImported) return incoming;
  if (currentImported && !incomingImported) return current;
  return timestamp(incoming) >= timestamp(current) ? incoming : current;
}

export function dedupeConversations(conversations = []) {
  const chosen = new Map();
  const order = [];
  for (const item of conversations) {
    if (!item?.id) continue;
    const key = conversationDedupeKey(item);
    const existing = chosen.get(key);
    if (!existing) {
      chosen.set(key, item);
      order.push(key);
      continue;
    }
    chosen.set(key, preferConversation(existing, item));
  }
  return order.map((key) => chosen.get(key));
}

/**
 * Keep already-shown conversations in place and insert new unique hits by recency.
 * Does not reshuffle the existing list, so streamed results stay stable.
 */
export function mergeSearchResults(existing = [], incoming = []) {
  const current = Array.isArray(existing) ? existing.filter((item) => item?.id) : [];
  const seenIds = new Set(current.map((item) => item.id));
  const seenKeys = new Set(current.map((item) => conversationDedupeKey(item)));
  const additions = [];
  for (const item of incoming || []) {
    if (!item?.id || seenIds.has(item.id)) continue;
    const key = conversationDedupeKey(item);
    if (seenKeys.has(key)) continue;
    seenIds.add(item.id);
    seenKeys.add(key);
    additions.push(item);
  }
  if (!additions.length) return current;
  const merged = [...current];
  for (const item of additions) {
    const time = timestamp(item);
    const index = merged.findIndex((row) => timestamp(row) < time);
    if (index < 0) merged.push(item);
    else merged.splice(index, 0, item);
  }
  return merged;
}

export function scoreConversation(conversation, parsed) {
  const text = String(parsed?.text || '').trim().toLowerCase();
  if (!text) return timestamp(conversation) / 1e13;
  const tokens = text.split(/\s+/).filter(Boolean);
  const subject = String(conversation?.subject || '').toLowerCase();
  const snippet = String(conversation?.snippet || '').toLowerCase();
  const from = `${conversation?.from?.name || ''} ${conversation?.from?.email || ''}`.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (subject.includes(token)) score += 8;
    if (from.includes(token)) score += 4;
    if (snippet.includes(token)) score += 2;
  }
  if (conversation?.sourceImported !== false) score += 1;
  return score + (timestamp(conversation) / 1e15);
}
