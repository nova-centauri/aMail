import { mailboxQueryIsActive, parseMailboxQuery } from '../mail/search-query.js';
import { isSmartCategory } from './smart-filter.js';
import { parseNumber, parsePageSize } from './inbox.js';

const FOLDERS = new Set(['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'all', 'trash', 'spam', 'archive']);

export const SLOW_MESSAGES_MS = 500;

function normalizeLoggedFolder(value) {
  const folder = String(value || 'inbox').toLowerCase();
  return FOLDERS.has(folder) ? folder : 'inbox';
}

/**
 * Allowlisted /api/messages query shape for slow-path logs. Search text,
 * addresses, and raw query strings stay out.
 */
export function sanitizeMessagesQuery(query = {}) {
  const raw = String(query?.q ?? query?.query ?? '');
  const parsed = parseMailboxQuery(raw.slice(0, 800));
  const category = String(query?.category || '').trim().toLowerCase();
  const mailbox = String(query?.mailbox || '').trim();
  const operators = [];
  if (parsed.from.length || parsed.notFrom.length) operators.push('from');
  if (parsed.to.length || parsed.notTo.length) operators.push('to');
  if (parsed.subject.length || parsed.notSubject.length) operators.push('subject');
  if (parsed.hasAttachment != null) operators.push('has');
  if (parsed.after) operators.push('after');
  if (parsed.before) operators.push('before');
  if (parsed.isUnread != null) operators.push('is:read');
  if (parsed.isStarred != null) operators.push('is:starred');
  if (parsed.isAnalyzed != null) operators.push('is:analyzed');
  if (parsed.folder || parsed.anywhere) operators.push('in');
  if (parsed.text) operators.push('text');
  return {
    folder: normalizeLoggedFolder(parsed.folder || query?.folder),
    page: parseNumber(query?.page, 1, 1, 100_000),
    pageSize: parsePageSize(query?.pageSize || query?.limit),
    category: category && isSmartCategory(category) ? category : (category ? 'other' : null),
    hasQuery: mailboxQueryIsActive(parsed),
    queryChars: raw.length,
    operators,
    hasFlag: Boolean(query?.flag || query?.personFlag),
    hasAccountId: Boolean(query?.accountId),
    mailbox: mailbox ? (mailbox === 'INBOX' ? 'INBOX' : 'other') : null,
  };
}

export const MCP_TOOL_SLOW_MS = 1_000;

/**
 * MCP tool args for logs: operators, lengths, and limits only. No query
 * text, addresses, message bodies, or ids.
 */
export function sanitizeMcpToolArgs(name, args = {}) {
  const tool = String(name || '');
  const input = args && typeof args === 'object' ? args : {};
  switch (tool) {
    case 'list_messages':
    case 'start_deep_search':
      return {
        tool,
        ...sanitizeMessagesQuery({
          q: input.q,
          folder: input.folder,
          page: input.page,
          pageSize: input.pageSize,
          category: input.category,
          flag: input.flag,
          accountId: input.accountId,
        }),
      };
    case 'get_thread':
    case 'get_message':
    case 'get_attachment':
      return {
        tool,
        idChars: String(input.id || '').length,
        ...(tool === 'get_attachment' ? { index: Number.isInteger(input.index) ? input.index : null } : {}),
      };
    case 'get_deep_search':
    case 'cancel_deep_search':
      return { tool, jobIdChars: String(input.jobId || '').length };
    case 'list_providers':
      return {
        tool,
        hasEmail: Boolean(input.email),
        serverHostChars: String(input.serverHost || '').length,
      };
    case 'set_flags':
      return { tool, flagCount: Array.isArray(input.flags) ? input.flags.length : 0 };
    case 'list_unanalyzed_messages':
      return {
        tool,
        hasAccountId: Boolean(input.accountId),
        pageSize: parsePageSize(input.pageSize),
        hasCursor: Boolean(input.cursor),
      };
    case 'get_analysis_status':
    case 'mark_messages_analyzed':
      return { tool, idCount: Array.isArray(input.ids) ? input.ids.length : 0 };
    case 'message_action':
      return {
        tool,
        action: String(input.action || '').slice(0, 32),
        idChars: String(input.id || '').length,
        hasUntil: Boolean(input.until),
      };
    case 'send_message':
      return {
        tool,
        toCount: Array.isArray(input.to) ? input.to.length : 0,
        ccCount: Array.isArray(input.cc) ? input.cc.length : 0,
        bccCount: Array.isArray(input.bcc) ? input.bcc.length : 0,
        subjectChars: String(input.subject || '').length,
        textChars: String(input.textBody || '').length,
        attachmentCount: Array.isArray(input.attachments) ? input.attachments.length : 0,
      };
    case 'add_account':
    case 'update_account':
    case 'test_account':
      return { tool, hasEmail: Boolean(input.email || input.accountId), providerSet: Boolean(input.provider) };
    case 'delete_account':
      return { tool, idChars: String(input.id || input.accountId || '').length };
    default:
      return { tool, argKeys: Object.keys(input).sort().slice(0, 24) };
  }
}

export function logMcpToolCall(logger, name, args, durationMs) {
  const fields = {
    event: 'mcp_tool',
    tool: String(name || ''),
    args: sanitizeMcpToolArgs(name, args),
    durationMs: Math.round(Number(durationMs) || 0),
  };
  if (fields.durationMs >= MCP_TOOL_SLOW_MS) {
    logger?.warn?.(fields, 'Slow MCP tool');
    return fields;
  }
  logger?.info?.(fields, 'MCP tool');
  return fields;
}
