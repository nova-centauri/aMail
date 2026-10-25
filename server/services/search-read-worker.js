import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase, createRepositories } from '../db.js';

// worker_threads uses structured clone, which turns a Node Buffer into a
// Uint8Array. Restore the Buffer before the database layer validates and
// applies the raw 32-byte SQLCipher key.
const databaseKey = workerData.databaseKey ? Buffer.from(workerData.databaseKey) : null;
const db = openDatabase(workerData.dbPath, {
  key: databaseKey,
  readonly: true,
});
db.pragma('busy_timeout = 5000');
db.pragma('query_only = ON');
db.pragma('cache_size = -16000');
const repos = createRepositories(db);

function maybeHang() {
  const ms = Number(workerData.testHangMs) || 0;
  if (ms <= 0) return;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Burn only this worker so the host deadline can terminate it.
  }
}

parentPort.on('message', (msg) => {
  const id = msg?.id;
  try {
    maybeHang();
    if (msg?.type === 'searchConversations') {
      parentPort.postMessage({ id, ok: true, result: repos.messages.searchConversations(msg.args || {}) });
      return;
    }
    if (msg?.type === 'getThread') {
      const thread = repos.threads.get(msg.threadId);
      if (!thread) {
        parentPort.postMessage({ id, ok: true, result: { thread: null, messages: [] } });
        return;
      }
      parentPort.postMessage({
        id,
        ok: true,
        result: { thread, messages: repos.messages.forThread(thread.id) },
      });
      return;
    }
    throw new Error(`Unknown search-read worker message: ${msg?.type}`);
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        message: String(error?.message || error),
        code: error?.code || 'INTERNAL_ERROR',
        status: error?.status || 500,
        expose: Boolean(error?.expose),
        name: error?.name || 'Error',
      },
    });
  }
});
