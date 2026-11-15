import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AppError, ServiceUnavailableError, ValidationError } from '../errors.js';
import { DEFAULT_RENDER_MAX_DIMENSION, flattenExtract, MAX_RENDER_MAX_DIMENSION } from './attachment-extract.js';

/*
 * Read attachments for agents: text in pages an agent can actually take in,
 * and pictures of PDF pages or image files. Bytes come from the caller's
 * fetchBytes (the strict, metadata-checked IMAP fetch), parsing happens in a
 * short-lived worker thread, and recent results are kept in memory so paging
 * through a long file does not refetch and reparse it on every call.
 */

export const DEFAULT_READ_CHARS = 20_000;
export const MAX_READ_CHARS = 100_000;

const WORKER_URL = new URL('./attachment-reader-worker.js', import.meta.url);

function readError(message, code, status = 422) {
  return new AppError(message, { status, code, expose: true });
}

/** Run one job in a fresh worker with a heap cap and a wall-clock timeout. */
export function runAttachmentJob(job, { timeoutMs = 30_000, maxOldGenerationSizeMb = 384 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_URL, {
      resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    // PDF.js prints warnings for damaged files; they are noise, not logs.
    worker.stdout?.resume();
    worker.stderr?.resume();
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new ServiceUnavailableError('Reading this attachment took too long.', 'ATTACHMENT_READ_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();
    worker.once('message', (message) => {
      if (message?.ok) finish(resolve, message.result);
      else finish(reject, readError(message?.message || 'aMail could not read this attachment.', message?.code || 'ATTACHMENT_UNREADABLE'));
    });
    worker.once('error', (error) => {
      const outOfMemory = error?.code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish(reject, readError(
        outOfMemory ? 'This attachment is too complex to read.' : 'aMail could not read this attachment.',
        outOfMemory ? 'ATTACHMENT_TOO_COMPLEX' : 'ATTACHMENT_UNREADABLE',
      ));
    });
    worker.once('exit', () => {
      finish(reject, readError('aMail could not read this attachment.', 'ATTACHMENT_UNREADABLE'));
    });
    // Copy into a standalone ArrayBuffer and transfer it, so the worker gets
    // the bytes without a second copy and the caller's Buffer stays intact.
    const bytes = new Uint8Array(job.bytes).buffer;
    worker.postMessage({ ...job, bytes }, [bytes]);
  });
}

/** Small LRU with a time limit and a size budget. */
export function createBoundedCache({ maxEntries, maxWeight, ttlMs, weigh, now = Date.now }) {
  const entries = new Map();
  let weight = 0;
  const drop = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    weight -= entry.weight;
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        drop(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      drop(key);
      const entryWeight = weigh(value);
      if (entryWeight > maxWeight) return;
      entries.set(key, { value, weight: entryWeight, expiresAt: now() + ttlMs });
      weight += entryWeight;
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries && weight <= maxWeight) break;
        drop(oldest);
      }
    },
    clear() {
      entries.clear();
      weight = 0;
    },
    get size() {
      return entries.size;
    },
  };
}

function boundedInteger(value, { fallback, min, max, name }) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/**
 * @param {object} options
 * @param {(messageId: string, index: number) => Promise<{ body: Buffer, filename: string, contentType: string }>} options.fetchBytes
 * @param {typeof runAttachmentJob} [options.runJob]
 */
export function createAttachmentReader({
  fetchBytes,
  runJob = runAttachmentJob,
  timeoutMs = 30_000,
  maxConcurrent = 2,
  ttlMs = 10 * 60_000,
  now = Date.now,
} = {}) {
  if (typeof fetchBytes !== 'function') throw new TypeError('fetchBytes is required');
  const files = createBoundedCache({
    maxEntries: 16, maxWeight: 64 * 1024 * 1024, ttlMs, now, weigh: (file) => file.body.length,
  });
  const texts = createBoundedCache({
    maxEntries: 32, maxWeight: 8_000_000, ttlMs, now, weigh: (text) => text.text.length + 1,
  });
  const pending = new Map();
  let running = 0;
  const waiting = [];

  async function withSlot(fn) {
    if (running >= maxConcurrent) await new Promise((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await fn();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }

  /** One fetch per file at a time; concurrent callers share it. */
  function once(key, fn) {
    const existing = pending.get(key);
    if (existing) return existing;
    const work = fn().finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  }

  async function loadFile(messageId, index) {
    const key = `${messageId}:${index}`;
    const cached = files.get(key);
    if (cached) return cached;
    return once(`file:${key}`, async () => {
      const fetched = await fetchBytes(messageId, index);
      const file = {
        body: fetched.body,
        filename: fetched.filename,
        contentType: fetched.contentType,
        size: fetched.body.length,
        sha256: createHash('sha256').update(fetched.body).digest('hex'),
      };
      files.set(key, file);
      return file;
    });
  }

  async function loadText(messageId, index) {
    const key = `${messageId}:${index}`;
    const cached = texts.get(key);
    if (cached) return cached;
    return once(`text:${key}`, async () => {
      const file = await loadFile(messageId, index);
      const extract = await withSlot(() => runJob({
        op: 'text', bytes: file.body, contentType: file.contentType, filename: file.filename,
      }, { timeoutMs }));
      const { text, pageStarts } = flattenExtract(extract);
      const value = {
        file,
        kind: extract.kind,
        text,
        pageStarts,
        pageCount: extract.pageCount ?? (Array.isArray(extract.pages) ? extract.pages.length : null),
        noTextLayer: Boolean(extract.noTextLayer),
        // Some of the file was never extracted (text or page limit).
        incomplete: Boolean(extract.incomplete),
        note: extract.note || null,
      };
      texts.set(key, value);
      return value;
    });
  }

  function fileSummary(messageId, index, file) {
    return {
      messageId,
      index,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      sha256: file.sha256,
    };
  }

  /**
   * One window of an attachment's text. Pass page (1-based) to start at a
   * PDF page, slide or sheet, or offset to continue where nextOffset said.
   */
  async function readText({ messageId, index, offset, page, maxChars }) {
    const limit = boundedInteger(maxChars, { fallback: DEFAULT_READ_CHARS, min: 1000, max: MAX_READ_CHARS, name: 'maxChars' });
    if (offset != null && page != null) throw new ValidationError('Pass offset or page, not both.');
    const loaded = await loadText(messageId, index);
    let start = boundedInteger(offset, { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER, name: 'offset' });
    if (page != null) {
      const count = loaded.pageStarts.length;
      if (!count) throw new ValidationError('This attachment has no pages; use offset instead.');
      const wanted = boundedInteger(page, { fallback: 1, min: 1, max: count, name: 'page' });
      start = loaded.pageStarts[wanted - 1];
    }
    start = Math.min(start, loaded.text.length);
    const end = Math.min(loaded.text.length, start + limit);
    const pageAt = (position) => {
      let current = null;
      for (let i = 0; i < loaded.pageStarts.length && loaded.pageStarts[i] <= position; i += 1) current = i + 1;
      return current;
    };
    return {
      attachment: {
        ...fileSummary(messageId, index, loaded.file),
        kind: loaded.kind,
        pageCount: loaded.pageCount,
        noTextLayer: loaded.noTextLayer || undefined,
        totalChars: loaded.text.length,
        offset: start,
        returnedChars: end - start,
        firstPage: loaded.pageStarts.length ? pageAt(start) : undefined,
        lastPage: loaded.pageStarts.length ? pageAt(Math.max(start, end - 1)) : undefined,
        nextOffset: end < loaded.text.length ? end : null,
        truncated: end < loaded.text.length,
        incomplete: loaded.incomplete || undefined,
        note: loaded.note || undefined,
        text: loaded.text.slice(start, end),
      },
    };
  }

  /** A picture of one PDF page, or the image attachment itself (resized). */
  async function renderPicture({ messageId, index, page, maxDimension }) {
    const size = boundedInteger(maxDimension, {
      fallback: DEFAULT_RENDER_MAX_DIMENSION, min: 200, max: MAX_RENDER_MAX_DIMENSION, name: 'maxDimension',
    });
    const file = await loadFile(messageId, index);
    const head = file.body.subarray(0, 1024).toString('latin1');
    const isPdf = head.includes('%PDF-');
    if (!isPdf && page != null && page !== 1) throw new ValidationError('Only PDF attachments have pages.');
    const result = await withSlot(() => runJob(isPdf
      ? { op: 'render-pdf', bytes: file.body, page: page ?? 1, maxDimension: size }
      : { op: 'render-image', bytes: file.body, maxDimension: size }, { timeoutMs }));
    return {
      summary: {
        ...fileSummary(messageId, index, file),
        page: isPdf ? (page ?? 1) : undefined,
        pageCount: result.pageCount ?? undefined,
        width: result.width ?? undefined,
        height: result.height ?? undefined,
        imageType: result.mimeType,
      },
      image: { mimeType: result.mimeType, data: Buffer.from(result.data) },
    };
  }

  return {
    readText,
    renderPicture,
    clear() {
      files.clear();
      texts.clear();
    },
  };
}
