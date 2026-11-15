import { parentPort } from 'node:worker_threads';
import { extractText, renderImage, renderPdfPage } from './attachment-extract.js';

/*
 * One job per worker, then exit. Parsing hostile PDFs and Office files here
 * keeps a slow or memory-hungry file away from the HTTP thread: the parent
 * enforces a heap limit and a wall-clock timeout and terminates this worker
 * when either is crossed.
 */
parentPort.once('message', async (job) => {
  try {
    const bytes = Buffer.from(job.bytes);
    let result;
    if (job.op === 'text') {
      result = await extractText({ bytes, contentType: job.contentType, filename: job.filename });
    } else if (job.op === 'render-pdf') {
      result = await renderPdfPage(bytes, job.page, { maxDimension: job.maxDimension });
    } else if (job.op === 'render-image') {
      result = await renderImage(bytes, { maxDimension: job.maxDimension });
    } else {
      throw Object.assign(new Error('Unknown attachment job.'), { code: 'ATTACHMENT_UNREADABLE' });
    }
    if (result?.data) {
      const data = Buffer.from(result.data);
      parentPort.postMessage({ ok: true, result: { ...result, data } });
    } else {
      parentPort.postMessage({ ok: true, result });
    }
  } catch (error) {
    // Only known, user-facing messages cross back; parser internals do not.
    const known = error?.name === 'ExtractError';
    parentPort.postMessage({
      ok: false,
      code: known ? error.code : 'ATTACHMENT_UNREADABLE',
      message: known ? error.message : 'aMail could not read this attachment.',
    });
  }
});
