import { Worker } from 'node:worker_threads';

export function syncWorkerEnabled(config = {}) {
  if (config.syncWorker === false) return false;
  if (config.env === 'test') return false;
  if (!config.dbPath || !config.dataDir) return false;
  return true;
}

/**
 * Parse RFC822 and write rows on a worker thread with its own SQLCipher
 * connection so the HTTP event loop can answer /api/health during a sync.
 */
export function createSyncIngest({ config, logger, onStamp } = {}) {
  const enabled = syncWorkerEnabled(config);
  let worker = null;
  let seq = 0;
  const pending = new Map();
  let broken = false;

  function failAll(error) {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }

  function start() {
    if (!enabled || worker || broken) return;
    try {
      worker = new Worker(new URL('./sync-ingest-worker.js', import.meta.url), {
        workerData: {
          dataDir: config.dataDir,
          dbPath: config.dbPath,
          databaseKey: config.databaseKey || null,
          encryptDatabase: Boolean(config.encryptDatabase),
          keyMode: config.keyMode || 'env',
        },
      });
    } catch (error) {
      broken = true;
      logger?.warn?.({ err: String(error?.message || error) }, 'Sync ingest worker could not start; using the HTTP thread');
      return;
    }
    worker.on('message', (msg) => {
      if (msg?.stamp && typeof onStamp === 'function') {
        try { onStamp(msg.stamp); } catch { /* listing stamp must not fail ingest */ }
      }
      const waiter = pending.get(msg?.id);
      if (!waiter) return;
      pending.delete(msg.id);
      waiter.resolve(msg);
    });
    worker.on('error', (error) => {
      logger?.warn?.({ err: String(error?.message || error) }, 'Sync ingest worker failed; using the HTTP thread');
      failAll(error);
      broken = true;
      worker = null;
    });
    worker.on('exit', (code) => {
      if (pending.size) failAll(new Error(`Sync ingest worker exited (${code})`));
      worker = null;
    });
  }

  return {
    enabled,
    get live() {
      return Boolean(worker);
    },
    async ingest(job) {
      start();
      if (!worker) return { fallback: true };
      const id = seq += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Sync ingest worker timed out'));
        }, 120_000);
        pending.set(id, {
          resolve(msg) {
            clearTimeout(timer);
            resolve(msg);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        worker.postMessage({
          type: 'ingest',
          id,
          source: job.source,
          account: { id: job.account.id },
          mailbox: job.mailbox,
          role: job.role,
          allMailMirror: Boolean(job.allMailMirror),
          message: {
            uid: job.message?.uid,
            flags: job.message?.flags ? [...job.message.flags] : [],
            labels: job.message?.labels ? [...job.message.labels] : [],
            envelope: job.message?.envelope || null,
            internalDate: job.message?.internalDate || null,
          },
        });
      });
    },
    async close() {
      const current = worker;
      worker = null;
      failAll(new Error('Sync ingest worker closed'));
      if (current) await current.terminate().catch(() => {});
    },
  };
}
