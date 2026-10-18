import { yieldEventLoop } from '../services/mail-service.js';

export const MCP_MAX_THREAD_MESSAGES = 40;
export const MCP_MAX_BODY_CHARS = 20_000;
export const MCP_MAX_THREAD_ACTIONS = 40;

export function clipMcpText(value, limit = MCP_MAX_BODY_CHARS) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/** Drop or clip bodies so a huge thread cannot JSON.stringify on the HTTP thread. */
export function clipMcpMessage(message, { includeBodies = true, limit = MCP_MAX_BODY_CHARS } = {}) {
  if (!message || typeof message !== 'object') return message;
  const html = clipMcpText(includeBodies ? message.htmlBody : '', limit);
  const text = clipMcpText(includeBodies ? message.textBody : '', limit);
  return {
    ...message,
    htmlBody: html.text,
    textBody: text.text,
    bodyTruncated: html.truncated || text.truncated,
  };
}

export async function mapYielding(items, mapFn, { yieldFn = yieldEventLoop } = {}) {
  const out = [];
  for (const item of items) {
    out.push(await mapFn(item));
    await yieldFn();
  }
  return out;
}
