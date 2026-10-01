export const ATTACHMENT_STAGE_CONCURRENCY = 2;
export const ATTACHMENT_STAGE_MAX_BYTES = 8 * 1024 * 1024;
export const PREVIEW_DOWNLOAD_MS = 1200;

export function attachmentByteSize(attachment) {
  const raw = attachment?.size ?? attachment?.sizeBytes ?? attachment?.bytes;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

export function attachmentDownloadKey(messageId, attachment, index = 0) {
  const part = Number.isInteger(attachment?.index) ? attachment.index : index;
  return `${messageId || 'message'}:${part}`;
}

/** Signed attachment URLs under the existing byte cap. Nothing else is staged. */
export function canStageAttachment(attachment) {
  if (!attachment?.url) return false;
  const size = attachmentByteSize(attachment);
  if (size != null && size > ATTACHMENT_STAGE_MAX_BYTES) return false;
  return true;
}

export function stageableAttachments(messages = []) {
  const items = [];
  for (const message of messages) {
    (message?.attachments || []).forEach((attachment, index) => {
      if (!canStageAttachment(attachment)) return;
      items.push({
        messageId: message.id,
        attachment,
        index,
        key: attachmentDownloadKey(message.id, attachment, index),
      });
    });
  }
  return items;
}

/**
 * One in-flight task per key. A repeat start joins the pending promise and
 * does not run the task again. After it settles, the key can run again.
 */
export function createDownloadLane() {
  const inflight = new Map();
  return {
    has(key) {
      return inflight.has(key);
    },
    start(key, task) {
      const existing = inflight.get(key);
      if (existing) return existing;
      const promise = new Promise((resolve, reject) => {
        try {
          resolve(task());
        } catch (error) {
          reject(error);
        }
      }).finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      });
      inflight.set(key, promise);
      return promise;
    },
    clear() {
      inflight.clear();
    },
  };
}

export function beginDownload(busy, key) {
  if (busy.has(key)) return false;
  busy.add(key);
  return true;
}

export async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const cap = Math.max(1, Number(limit) || 1);
  let cursor = 0;
  let active = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const pump = () => {
      if (settled) return;
      if (cursor >= queue.length && active === 0) {
        finish();
        return;
      }
      while (active < cap && cursor < queue.length) {
        const item = queue[cursor];
        cursor += 1;
        active += 1;
        Promise.resolve()
          .then(() => worker(item))
          .then(() => {
            active -= 1;
            pump();
          }, (error) => {
            active -= 1;
            finish(error);
          });
      }
    };
    pump();
  });
}

export async function fetchAttachmentBlob(url, { signal, onProgress } = {}) {
  const response = await fetch(url, { credentials: 'same-origin', signal, cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`Download failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const headerTotal = Number(response.headers.get('content-length')) || 0;
  if (!response.body || typeof response.body.getReader !== 'function') {
    const blob = await response.blob();
    onProgress?.({ loaded: blob.size, total: headerTotal || blob.size });
    return blob;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total: headerTotal });
  }
  const type = response.headers.get('content-type') || 'application/octet-stream';
  return new Blob(chunks, { type });
}

export function saveBlob(blob, filename) {
  if (!blob || typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'attachment';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has the bytes for this save. Do not keep an object URL around.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Preview mail has no bytes. The button still shows one in-flight download. */
export function previewAttachmentDownload({ signal, onProgress, duration = PREVIEW_DOWNLOAD_MS } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(timer);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const elapsed = Date.now() - started;
      const loaded = Math.min(duration, elapsed);
      onProgress?.({ loaded, total: duration });
      if (elapsed >= duration) {
        clearInterval(timer);
        resolve(null);
      }
    }, 80);
  });
}
