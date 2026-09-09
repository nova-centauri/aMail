import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { accountTestInput, serializeAccountInput } from '../services/account-input.js';
import { listConversations, parseNumber } from '../services/inbox.js';
import { discoverAccountProvider, mailProviderCatalog } from '../utils/mail.js';
import { loadPersonFlags, publicPersonFlag, savePersonFlags } from '../services/person-flags.js';
import { configuredOpsSources } from '../services/smart-filter.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../errors.js';

function jsonResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error) {
  const exposed = error instanceof AppError && error.expose;
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: {
          code: exposed ? error.code : 'INTERNAL_ERROR',
          message: exposed ? error.message : 'An unexpected tool error occurred.',
        },
      }),
    }],
  };
}

async function runTool(fn) {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return errorResult(error);
  }
}

function publicAccountSummary(account) {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    provider: account.provider,
    syncEnabled: account.syncEnabled,
    lastSyncedAt: account.lastSyncedAt,
    color: account.color,
  };
}

/** Strip ciphertext and any accidental credential fields before returning accounts. */
function sanitizeAccountPayload(account) {
  if (!account || typeof account !== 'object') return account;
  const {
    credential_ciphertext: _ciphertext,
    credentials: _credentials,
    password: _password,
    ...safe
  } = account;
  return safe;
}

function updateTargets(repos, mailService, id, state) {
  const message = repos.messages.get(id);
  if (message) return Promise.all([mailService.updateMessageState(message.id, state)]);
  const thread = repos.threads.get(id);
  if (!thread) throw new NotFoundError('Message or thread not found.');
  return Promise.all(repos.messages.forThread(thread.id).map((item) => mailService.updateMessageState(item.id, state)));
}

/** Match REST /accounts probe limits so MCP cannot become a LAN scanner. */
export function createProbeLimiter({ windowMs = 10 * 60_000, limit = 20 } = {}) {
  let windowStart = 0;
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart > windowMs) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    if (count > limit) {
      throw new ValidationError('Too many account connection probes. Try again later.');
    }
  };
}

/** Process-wide limiter shared across per-request MCP server instances. */
const defaultProbeLimiter = createProbeLimiter();

const recipientSchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional(),
    email: z.string(),
  }),
]);

/**
 * Build a fresh MCP server instance wired to aMail services.
 * Stateless Streamable HTTP creates one of these per request.
 */
export function createAmailMcpServer({ config, repos, mailService, assertProbeAllowed = defaultProbeLimiter }) {
  const server = new McpServer({
    name: 'amail',
    version: '0.1.0',
  }, {
    instructions: 'aMail multi-account inbox tools. Never request or echo IMAP/SMTP passwords; account tools refuse to return stored credentials.',
  });

  server.registerTool('list_accounts', {
    title: 'List mail accounts',
    description: 'List connected mail accounts (id, email, provider, sync status). Never returns secrets.',
  }, async () => runTool(async () => ({
    accounts: repos.accounts.list().map(publicAccountSummary),
  })));

  server.registerTool('list_providers', {
    title: 'List provider presets',
    description: 'Provider presets and optional discovery hints for onboarding a new account.',
    inputSchema: {
      email: z.string().optional().describe('Mailbox email used for provider discovery'),
      serverHost: z.string().optional().describe('Optional IMAP/SMTP hostname hint'),
    },
  }, async ({ email, serverHost }) => runTool(async () => {
    const discoveryInput = {
      email: String(email || '').trim(),
      serverHost: String(serverHost || '').trim(),
    };
    return {
      providers: mailProviderCatalog(),
      discovery: discoverAccountProvider(discoveryInput),
    };
  }));

  server.registerTool('list_flags', {
    title: 'List person flags',
    description: 'Operator-defined people folders (id, label, emails) usable as the `flag` filter in list_messages, plus the configured ops-digest sources.',
  }, async () => runTool(async () => ({
    flags: loadPersonFlags(repos).map(publicPersonFlag),
    opsSources: configuredOpsSources(),
  })));

  server.registerTool('set_flags', {
    title: 'Replace person flags',
    description: 'Replace the full list of person flags. Each flag needs a label and one or more email addresses; ids are derived from the label when omitted.',
    inputSchema: {
      flags: z.array(z.object({
        id: z.string().optional(),
        label: z.string(),
        shortLabel: z.string().optional(),
        description: z.string().optional(),
        color: z.string().optional().describe('Hex color such as #0b57d0'),
        emails: z.array(z.string()).min(1),
      })).max(24),
    },
  }, async ({ flags }) => runTool(async () => ({
    flags: savePersonFlags(repos, flags).map(publicPersonFlag),
  })));

  server.registerTool('list_messages', {
    title: 'List conversations',
    description: 'List or search conversations with folder, accountId, category, q, page, and pageSize.',
    inputSchema: {
      folder: z.string().optional().describe('inbox, starred, snoozed, sent, drafts, all, trash, spam, or archive'),
      accountId: z.string().optional().describe('Limit to one account id'),
      category: z.string().optional().describe('Smart filter: primary, github_ci, logs, status, ops_error'),
      q: z.string().optional().describe('Search query. Gmail-style operators work: from:, to:, subject:, has:attachment, after:, before:, is:unread, is:starred, is:unanalyzed, is:analyzed, in:'),
      page: z.number().int().optional().describe('Page number (1-based)'),
      pageSize: z.number().int().optional().describe('Results per page (1-200)'),
      flag: z.string().optional().describe('Person flag id (see list_flags)'),
    },
  }, async (args) => runTool(async () => listConversations(repos, {
    accountId: args.accountId || null,
    folder: args.folder,
    category: args.category,
    personFlag: args.flag,
    page: args.page,
    pageSize: args.pageSize,
    query: args.q,
  })));

  server.registerTool('get_message', {
    title: 'Get message',
    description: 'Fetch one message by id (sanitized body/snippet as stored by aMail).',
    inputSchema: {
      id: z.string().describe('Message id'),
    },
  }, async ({ id }) => runTool(async () => {
    const message = repos.messages.get(id);
    if (!message) throw new NotFoundError('Message not found.');
    return { message };
  }));

  server.registerTool('get_thread', {
    title: 'Get thread',
    description: 'Fetch a conversation thread and its messages by thread id.',
    inputSchema: {
      id: z.string().describe('Thread id'),
    },
  }, async ({ id }) => runTool(async () => {
    const thread = repos.threads.get(id);
    if (!thread) throw new NotFoundError('Thread not found.');
    const messages = repos.messages.forThread(thread.id);
    return { thread: { ...thread, messages }, messages };
  }));

  server.registerTool('send_message', {
    title: 'Send message',
    description: 'Compose and send mail through an existing account via SMTP.',
    inputSchema: {
      accountId: z.string().describe('Sending account id'),
      to: z.array(recipientSchema).optional().describe('To recipients'),
      cc: z.array(recipientSchema).optional().describe('Cc recipients'),
      bcc: z.array(recipientSchema).optional().describe('Bcc recipients'),
      subject: z.string().optional(),
      textBody: z.string().optional(),
      htmlBody: z.string().optional(),
      replyToMessageId: z.string().optional().describe('RFC Message-ID being replied to'),
      inReplyTo: z.string().optional(),
      includeSignature: z.boolean().optional(),
      attachments: z.array(z.object({
        filename: z.string(),
        contentType: z.string().optional(),
        content: z.string().describe('Base64 file bytes'),
      })).optional().describe('Outbound attachments (base64). Combined size must stay under 8 MB.'),
    },
  }, async (input) => runTool(async () => {
    const message = await mailService.sendMessage(input);
    return { message };
  }));

  server.registerTool('message_action', {
    title: 'Message action',
    description: 'Apply read/unread/star/unstar/archive/unarchive/trash/untrash/spam/unspam/snooze/analyzed/unanalyzed to a message or thread id. Use `analyzed` after processing a message so `is:unanalyzed` searches skip it next time.',
    inputSchema: {
      id: z.string().describe('Message id or thread id'),
      action: z.enum([
        'read', 'unread', 'star', 'unstar', 'archive', 'unarchive',
        'trash', 'untrash', 'spam', 'unspam', 'snooze', 'analyzed', 'unanalyzed',
      ]),
      until: z.string().optional().describe('ISO timestamp for snooze (must be in the future)'),
      by: z.string().optional().describe('Agent or person name recorded with the analyzed flag'),
    },
  }, async ({ id, action, until, by }) => runTool(async () => {
    let state;
    switch (action) {
      case 'analyzed':
        state = { isAnalyzed: true, analyzedBy: String(by || '') };
        break;
      case 'unanalyzed':
        state = { isAnalyzed: false };
        break;
      case 'read':
        state = { isRead: true };
        break;
      case 'unread':
        state = { isRead: false };
        break;
      case 'star':
        state = { isStarred: true };
        break;
      case 'unstar':
        state = { isStarred: false };
        break;
      case 'archive':
        state = { isArchived: true };
        break;
      case 'unarchive':
        state = { isArchived: false };
        break;
      case 'trash':
        state = { isTrashed: true };
        break;
      case 'untrash':
        state = { isTrashed: false };
        break;
      case 'spam':
        state = { isSpam: true, isArchived: true };
        break;
      case 'unspam':
        state = { isSpam: false };
        break;
      case 'snooze': {
        const snoozeUntil = until ? new Date(until) : new Date(Date.now() + 24 * 60 * 60 * 1000);
        if (Number.isNaN(snoozeUntil.valueOf()) || snoozeUntil <= new Date()) {
          throw new ValidationError('Snooze time must be in the future.');
        }
        state = { snoozedUntil: snoozeUntil.toISOString(), isArchived: true };
        break;
      }
      default:
        throw new ValidationError(`Unknown action: ${action}`);
    }
    const messages = await updateTargets(repos, mailService, id, state);
    return { message: messages[0], messages };
  }));

  server.registerTool('sync_mail', {
    title: 'Sync mail',
    description: 'Sync one account (accountId) or all accounts when accountId is omitted.',
    inputSchema: {
      accountId: z.string().optional().describe('Account to sync; omit to sync all'),
      mailbox: z.string().optional(),
      limit: z.number().int().optional().describe('Max messages to fetch this pass'),
      maxAgeSeconds: z.number().int().optional().describe('When syncing all accounts, accept the result of a sync that finished within this many seconds instead of starting another. Use when polling for new mail.'),
    },
  }, async ({ accountId, mailbox, limit, maxAgeSeconds }) => runTool(async () => {
    const options = {
      mailbox: mailbox ? String(mailbox) : undefined,
      limit: parseNumber(limit, config.syncBatchSize, 1, 1000),
    };
    if (accountId) {
      return { result: await mailService.syncAccount(accountId, options) };
    }
    return { results: await mailService.syncAll({ ...options, maxAgeMs: parseNumber(maxAgeSeconds, 0, 0, 3600) * 1000 }) };
  }));

  server.registerTool('test_account', {
    title: 'Test account connection',
    description: 'Test IMAP/SMTP for a saved account id, or probe unsaved settings in memory (never persisted).',
    inputSchema: {
      accountId: z.string().optional().describe('Saved account id to test'),
      email: z.string().optional(),
      provider: z.string().optional(),
      serverHost: z.string().optional(),
      imap: z.record(z.string(), z.unknown()).optional(),
      smtp: z.record(z.string(), z.unknown()).optional(),
      credentials: z.record(z.string(), z.unknown()).optional().describe('In-memory credentials for an unsaved probe; never returned'),
    },
  }, async (input) => runTool(async () => {
    assertProbeAllowed();
    if (input.accountId) {
      return { result: await mailService.testAccount(input.accountId) };
    }
    const { credentials: _credentials, ...safeEcho } = input;
    return {
      result: await mailService.testSettings(input),
      probed: {
        email: safeEcho.email || null,
        provider: safeEcho.provider || null,
        serverHost: safeEcho.serverHost || null,
      },
    };
  }));

  server.registerTool('add_account', {
    title: 'Add account',
    description: 'Add a mail account after IMAP/SMTP checks succeed. Credentials are encrypted at rest and never echoed back.',
    inputSchema: {
      email: z.string(),
      displayName: z.string().optional(),
      provider: z.string().optional(),
      serverHost: z.string().optional(),
      imap: z.record(z.string(), z.unknown()).optional(),
      smtp: z.record(z.string(), z.unknown()).optional(),
      credentials: z.record(z.string(), z.unknown()).describe('Provider credentials; stored encrypted, never returned'),
      signature: z.string().optional().describe('Plain text or HTML signature. HTML is sanitized before storage.'),
      syncEnabled: z.boolean().optional(),
      color: z.string().optional(),
    },
  }, async (body) => runTool(async () => {
    assertProbeAllowed();
    const input = serializeAccountInput(body, null, config);
    if (repos.accounts.getByEmailRaw(input.email)) throw new ConflictError('An account with this email already exists.');
    const connection = await mailService.testSettings(body);
    const account = repos.accounts.create(input);
    return {
      account: sanitizeAccountPayload(publicAccountSummary(account)),
      connection,
    };
  }));

  server.registerTool('update_account', {
    title: 'Update account',
    description: 'Update a saved account. Connection fields re-test before save. Credentials are never echoed back.',
    inputSchema: {
      id: z.string().describe('Account id'),
      displayName: z.string().optional(),
      provider: z.string().optional(),
      serverHost: z.string().optional(),
      imap: z.record(z.string(), z.unknown()).optional(),
      smtp: z.record(z.string(), z.unknown()).optional(),
      credentials: z.record(z.string(), z.unknown()).optional().describe('Replacement credentials; never returned'),
      signature: z.string().optional().describe('Plain text or HTML signature. HTML is sanitized before storage.'),
      syncEnabled: z.boolean().optional(),
      color: z.string().optional(),
    },
  }, async (body) => runTool(async () => {
    const existing = repos.accounts.getRaw(body.id);
    if (!existing) throw new NotFoundError('Mail account not found.');
    const input = serializeAccountInput(body, existing, config);
    const connectionChanged = ['credentials', 'provider', 'serverHost', 'imap', 'smtp']
      .some((field) => Object.hasOwn(body, field) && body[field] !== undefined);
    if (connectionChanged) assertProbeAllowed();
    const connection = connectionChanged
      ? await mailService.testSettings(accountTestInput(body, existing, config))
      : undefined;
    const account = repos.accounts.update(existing.id, input);
    return {
      account: sanitizeAccountPayload(publicAccountSummary(account)),
      ...(connection ? { connection } : {}),
    };
  }));

  server.registerTool('delete_account', {
    title: 'Delete account',
    description: 'Remove a connected mail account and its local mail cache.',
    inputSchema: {
      id: z.string().describe('Account id'),
    },
  }, async ({ id }) => runTool(async () => {
    if (!repos.accounts.remove(id)) throw new NotFoundError('Mail account not found.');
    return { deleted: true, id };
  }));

  return server;
}
