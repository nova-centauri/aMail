import { Worker } from 'node:worker_threads';
import { QueryDeadlineError, ServiceUnavailableError } from '../errors.js';

export const DEFAULT_SEARCH_DEADLINE_MS = 10_000;

export function searchReadWorkerEnabled(config = {}) {
  if (config.searchReadWorker === false) return false;
  if (config.searchReadWorker !== true && config.env === 'test') return false;
  const dbPath = String(config.dbPath || '');
  if (!config.dataDir || !dbPath) return false;
  if (dbPath === ':memory:' || dbPath.includes('mode=memory')) return false;
  return true;
}

/**
 * Read-only SQLCipher connection on a worker thread. Search and get_thread
 * never run on the HTTP event loop. A deadline terminates the worker so a
 * pathological LIKE/CTE cannot freeze health checks.
 */
export function createSearchRead({ config = {}, logger } = {}) {
  const enabled = searchReadWorkerEnabled(config);
  const deadlineMs = Number(config.searchQueryDeadlineMs) > 0
    ? Number(config.searchQueryDeadlineMs)
    : DEFAULT_SEARCH_DEADLINE_MS;
  let worker = null;
  let seq = 0;
  const pending = new Map();

  function failAll(error) {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }

  function start() {
    if (!enabled || worker) return;
    try {
      worker = new Worker(new URL('./search-read-worker.js', import.meta.url), {
        workerData: {
          dataDir: config.dataDir,
          dbPath: config.dbPath,
          databaseKey: config.databaseKey || null,
          encryptDatabase: Boolean(config.encryptDatabase),
          testHangMs: Number(config.searchReadTestHangMs) || 0,
        },
      });
    } catch (error) {
      logger?.warn?.({ err: String(error?.message || error) }, 'Search read worker could not start');
      return;
    }
    worker.on('message', (msg) => {
      const waiter = pending.get(msg?.id);
      if (!waiter) return;
      pending.delete(msg.id);
      waiter.resolve(msg);
    });
    worker.on('error', (error) => {
      logger?.warn?.({ err: String(error?.message || error) }, 'Search read worker failed');
      failAll(error);
      worker = null;
    });
    worker.on('exit', () => {
      if (pending.size) failAll(new Error('Search read worker exited'));
      worker = null;
    });
  }

  async function killAndRespawn(reason) {
    const current = worker;
    worker = null;
    failAll(reason);
    if (current) await current.terminate().catch(() => {});
  }

  async function run(type, payload) {
    start();
    if (!worker) {
      throw new ServiceUnavailableError(
        'Mail search is temporarily unavailable. Retry a narrower query.',
        'SEARCH_WORKER_UNAVAILABLE',
      );
    }
    const id = seq += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new QueryDeadlineError();
        killAndRespawn(error).catch(() => {});
        reject(error);
      }, deadlineMs);
      pending.set(id, {
        resolve(msg) {
          clearTimeout(timer);
          if (!msg?.ok) {
            const err = new Error(msg?.error?.message || 'Search failed');
            err.code = msg?.error?.code;
            err.status = msg?.error?.status;
            err.expose = msg?.error?.expose;
            reject(err);
            return;
          }
          resolve(msg.result);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.postMessage({ type, id, ...payload });
    });
  }

  return {
    enabled,
    deadlineMs,
    searchConversations: enabled
      ? (args) => run('searchConversations', { args })
      : undefined,
    getThread: enabled
      ? (threadId) => run('getThread', { threadId })
      : undefined,
    async close() {
      const current = worker;
      worker = null;
      failAll(new Error('Search read worker closed'));
      if (current) await current.terminate().catch(() => {});
    },
  };
}
