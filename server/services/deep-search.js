/**
 * Long-running mailbox search: local index first, then paced IMAP SEARCH.
 * Jobs emit progress and incremental conversation pages for SSE / polling.
 */
import { randomUUID } from 'node:crypto';
import { mailboxQueryIsActive, parseMailboxQuery } from '../mail/search-query.js';
import { shouldDeepSearchProvider } from '../mail/imap-search.js';
import { mergeSearchResults } from './conversation-rank.js';
import { listConversations, normalizeFolder, parseNumber } from './inbox.js';
import { ValidationError } from '../errors.js';

export const DEEP_SEARCH_PAGE_SIZE = 100;
export const DEEP_SEARCH_JOB_TTL_MS = 15 * 60_000;
export const DEFAULT_FOLDERS_PER_ACCOUNT = 3;
const MAX_JOBS = 8;

/**
 * Real work remaining: local index + known/estimated folders across accounts.
 * Unseen accounts are counted at DEFAULT_FOLDERS_PER_ACCOUNT so the bar does
 * not sit at 100% after the first mailbox list returns.
 */
export function estimateDeepSearchWork({
  accountCount = 0,
  accountPlans = new Map(),
  completedMailboxes = 0,
  defaultFoldersPerAccount = DEFAULT_FOLDERS_PER_ACCOUNT,
} = {}) {
  const plannedIds = new Set();
  let plannedFolders = 0;
  for (const [accountId, plan] of accountPlans) {
    plannedIds.add(accountId);
    const known = Number(plan?.folderCount);
    const seen = Number(plan?.seen) || 0;
    plannedFolders += Number.isFinite(known) && known > 0
      ? known
      : Math.max(seen, defaultFoldersPerAccount);
  }
  plannedFolders += Math.max(0, Number(accountCount) - plannedIds.size) * defaultFoldersPerAccount;
  const total = Math.max(1, 1 + plannedFolders);
  const done = Math.min(total, 1 + Math.max(0, Number(completedMailboxes) || 0));
  return { done, total, ratio: done / total };
}

function nowIso() {
  return new Date().toISOString();
}

export function planDeepSearchUnits(accounts = [], folderCounts = []) {
  const units = [{ id: 'local', kind: 'local', label: 'Searching the local index' }];
  for (const account of accounts) {
    units.push({
      id: `list:${account.id}`,
      kind: 'list',
      accountId: account.id,
      email: account.email,
      label: `Listing folders on ${account.email || 'account'}`,
    });
    const folders = folderCounts.find((item) => item.accountId === account.id)?.folders
      || [{ mailbox: 'INBOX' }];
    for (const folder of folders) {
      units.push({
        id: `imap:${account.id}:${folder.mailbox}`,
        kind: 'imap',
        accountId: account.id,
        email: account.email,
        mailbox: folder.mailbox,
        label: `Searching ${folder.mailbox} on ${account.email || 'account'}`,
      });
    }
  }
  return units;
}

export function progressSnapshot(job) {
  const total = Math.max(1, Number(job.progress.total) || 1);
  const done = Math.min(total, Math.max(0, Number(job.progress.done) || 0));
  return {
    done,
    total,
    ratio: done / total,
    phase: job.progress.phase,
    label: job.progress.label,
    accountId: job.progress.accountId || null,
    mailbox: job.progress.mailbox || null,
    found: job.messages.length,
  };
}

export function jobSnapshot(job) {
  return {
    jobId: job.id,
    status: job.status,
    query: job.query,
    folder: job.folder,
    accountId: job.accountId,
    cancelled: job.status === 'cancelled',
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: progressSnapshot(job),
    messages: job.messages,
    total: job.total,
    page: job.page,
    pageSize: job.pageSize,
    categoryCounts: job.categoryCounts,
    folderCounts: job.folderCounts,
  };
}

function writeEvent(job, event, data) {
  job.updatedAt = nowIso();
  const payload = { event, data, at: job.updatedAt };
  job.events.push(payload);
  if (job.events.length > 200) job.events.splice(0, job.events.length - 200);
  for (const listener of job.listeners) {
    try { listener(event, data); } catch { /* A dead SSE client must not stop the job. */ }
  }
}

export function createDeepSearchService({ repos, mailService, logger = null } = {}) {
  const jobs = new Map();

  function expire(id) {
    const job = jobs.get(id);
    if (!job) return;
    if (job.status === 'running') job.abort.abort();
    jobs.delete(id);
  }

  function collectGarbage() {
    const cutoff = Date.now() - DEEP_SEARCH_JOB_TTL_MS;
    for (const [id, job] of jobs) {
      if (Date.parse(job.updatedAt) < cutoff) expire(id);
    }
    while (jobs.size > MAX_JOBS) {
      const oldest = [...jobs.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
      if (!oldest) break;
      expire(oldest.id);
    }
  }

  function requireJob(id) {
    const job = jobs.get(String(id || ''));
    if (!job) throw new ValidationError('Deep search job not found.');
    return job;
  }

  async function refreshPage(job, extraThreadIds) {
    const page = await listConversations(repos, {
      accountId: job.accountId,
      folder: job.folder,
      category: job.category,
      personFlag: job.personFlag,
      page: 1,
      pageSize: job.pageSize,
      query: job.query,
      mailbox: job.mailbox,
      extraThreadIds,
    });
    job.messages = mergeSearchResults(job.messages, page.messages || []);
    job.total = Math.max(Number(page.total) || 0, job.messages.length);
    job.page = page.page;
    job.pageSize = page.pageSize;
    job.categoryCounts = page.categoryCounts;
    job.folderCounts = page.folderCounts;
    return page;
  }

  async function runJob(job) {
    const parsed = parseMailboxQuery(job.query);
    const extraThreadIds = new Set();
    try {
      job.progress = { done: 0, total: 1, phase: 'local', label: 'Searching the local index' };
      writeEvent(job, 'progress', progressSnapshot(job));
      const local = await refreshPage(job, []);
      writeEvent(job, 'result', {
        messages: job.messages,
        total: job.total,
        added: local.messages || [],
        categoryCounts: job.categoryCounts,
        folderCounts: job.folderCounts,
        progress: progressSnapshot(job),
      });
      if (job.abort.signal.aborted) {
        job.status = 'cancelled';
        writeEvent(job, 'done', jobSnapshot(job));
        return;
      }

      const accounts = job.accountId
        ? [repos.accounts.get(job.accountId)].filter(Boolean)
        : repos.accounts.list();
      const canSearchImap = Boolean(
        mailService?.searchAndMaterialize
        && shouldDeepSearchProvider(parsed, { folder: job.folder })
        && accounts.length
      );
      if (!canSearchImap) {
        job.progress = { ...job.progress, done: 1, total: 1, phase: 'done', label: 'Search complete' };
        job.status = 'complete';
        writeEvent(job, 'progress', progressSnapshot(job));
        writeEvent(job, 'done', jobSnapshot(job));
        return;
      }

      const planned = estimateDeepSearchWork({ accountCount: accounts.length, completedMailboxes: 0 });
      job.progress = {
        done: planned.done,
        total: planned.total,
        phase: 'imap',
        label: `Searching ${accounts[0]?.email || 'connected accounts'}`,
        accountId: accounts[0]?.id || null,
      };
      writeEvent(job, 'progress', progressSnapshot(job));

      const knownFolders = new Map();
      const folderCounts = new Map();
      const applyImapProgress = (progress = {}) => {
        if (progress.accountId && Number(progress.folderCount) > 0) {
          folderCounts.set(progress.accountId, Number(progress.folderCount));
        }
        if (progress.accountId && progress.mailbox) {
          if (!knownFolders.has(progress.accountId)) knownFolders.set(progress.accountId, new Set());
          knownFolders.get(progress.accountId).add(progress.mailbox);
        } else if (progress.accountId && !knownFolders.has(progress.accountId)) {
          knownFolders.set(progress.accountId, new Set());
        }
        const accountPlans = new Map(accounts.map((account) => [account.id, {
          folderCount: folderCounts.get(account.id),
          seen: knownFolders.get(account.id)?.size || 0,
        }]));
        const completedMailboxes = [...knownFolders.values()].reduce((sum, set) => sum + set.size, 0);
        const work = estimateDeepSearchWork({
          accountCount: accounts.length,
          accountPlans,
          completedMailboxes,
        });
        const listing = progress.phase === 'list' || !progress.mailbox;
        job.progress = {
          done: work.done,
          total: work.total,
          phase: 'imap',
          label: progress.mailbox
            ? `Searching ${progress.mailbox} on ${progress.email || 'account'}`
            : listing
              ? `Listing folders on ${progress.email || 'account'}`
              : `Searching ${progress.email || 'account'}`,
          accountId: progress.accountId || null,
          mailbox: progress.mailbox || null,
        };
        writeEvent(job, 'progress', progressSnapshot(job));
      };
      await mailService.searchAndMaterialize({
        accounts,
        parsed,
        folder: job.folder,
        signal: job.abort.signal,
        mode: 'deep',
        paceMs: job.paceMs,
        onHits: async ({ threadIds }) => {
          if (job.abort.signal.aborted) return;
          for (const id of threadIds || []) extraThreadIds.add(id);
          const before = job.messages.length;
          await refreshPage(job, [...extraThreadIds]);
          if (job.messages.length !== before) {
            writeEvent(job, 'result', {
              messages: job.messages,
              total: job.total,
              added: job.messages.slice(before),
              categoryCounts: job.categoryCounts,
              folderCounts: job.folderCounts,
              progress: progressSnapshot(job),
            });
          }
        },
        onProgress: applyImapProgress,
      });
      if (job.abort.signal.aborted) {
        job.status = 'cancelled';
        writeEvent(job, 'done', jobSnapshot(job));
        return;
      }
      await refreshPage(job, [...extraThreadIds]);
      job.progress = {
        done: job.progress.total,
        total: job.progress.total,
        phase: 'done',
        label: 'Search complete',
        accountId: null,
        mailbox: null,
      };
      job.status = 'complete';
      writeEvent(job, 'progress', progressSnapshot(job));
      writeEvent(job, 'result', {
        messages: job.messages,
        total: job.total,
        added: [],
        categoryCounts: job.categoryCounts,
        folderCounts: job.folderCounts,
        progress: progressSnapshot(job),
      });
      writeEvent(job, 'done', jobSnapshot(job));
    } catch (error) {
      if (job.abort.signal.aborted) {
        job.status = 'cancelled';
        writeEvent(job, 'done', jobSnapshot(job));
        return;
      }
      logger?.warn?.({ err: error, jobId: job.id }, 'Deep search failed');
      job.status = 'error';
      job.error = 'Deep search could not finish. Local matches are still shown.';
      writeEvent(job, 'error', { message: job.error, progress: progressSnapshot(job) });
      writeEvent(job, 'done', jobSnapshot(job));
    }
  }

  return {
    start(input = {}, { owner = 'human' } = {}) {
      collectGarbage();
      const query = String(input.query || input.q || '').trim().slice(0, 800);
      const parsed = parseMailboxQuery(query);
      if (!mailboxQueryIsActive(parsed)) {
        throw new ValidationError('Enter a search query before starting a deep search.');
      }
      if (owner === 'human') {
        for (const job of jobs.values()) {
          if (job.owner === 'human' && job.status === 'running') {
            job.abort.abort();
            job.status = 'cancelled';
            writeEvent(job, 'done', jobSnapshot(job));
          }
        }
      }
      const job = {
        id: `ds_${randomUUID()}`,
        owner,
        status: 'running',
        query,
        folder: normalizeFolder(parsed.folder || input.folder || 'inbox'),
        accountId: input.accountId ? String(input.accountId) : null,
        category: input.category || '',
        personFlag: input.personFlag || input.flag || '',
        mailbox: input.mailbox || 'INBOX',
        pageSize: parseNumber(input.pageSize, DEEP_SEARCH_PAGE_SIZE, 1, 200),
        paceMs: input.paceMs == null ? null : Number(input.paceMs),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        progress: { done: 0, total: 1, phase: 'local', label: 'Starting deep search' },
        messages: [],
        total: 0,
        page: 1,
        categoryCounts: {},
        folderCounts: {},
        error: null,
        abort: new AbortController(),
        listeners: new Set(),
        events: [],
      };
      jobs.set(job.id, job);
      job.tail = runJob(job);
      return job;
    },
    get(id) {
      return requireJob(id);
    },
    snapshot(id) {
      return jobSnapshot(requireJob(id));
    },
    cancel(id) {
      const job = requireJob(id);
      if (job.status === 'running') {
        job.abort.abort();
        job.status = 'cancelled';
        writeEvent(job, 'done', jobSnapshot(job));
      }
      return jobSnapshot(job);
    },
    subscribe(id, listener) {
      const job = requireJob(id);
      job.listeners.add(listener);
      return () => job.listeners.delete(listener);
    },
    whenSettled(id) {
      return requireJob(id).tail;
    },
  };
}
