import express from 'express';
import { AppError } from '../errors.js';
import { parseSingleFileUpload } from '../services/multipart.js';
import { uploadStagingFor } from '../services/upload-staging.js';
import { COMPOSE_ATTACHMENT_LIMIT_LABEL, MAX_COMPOSE_ATTACHMENT_BYTES } from '../services/compose-attachments.js';

/*
 * The one-time upload page behind create_upload_link. It sits outside the
 * Bearer gate on purpose, like /api/content/attachment: a browser opening a
 * link cannot attach a header, so the single-use token in the query is the
 * page's only authority. The token is checked before any body is read, and
 * the page is plain HTML with no script.
 */

const PAGE_STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1f1f1f}'
  + 'h1{font-size:1.4rem}form{display:grid;gap:1rem}button{font:inherit;padding:.5rem 1rem;width:max-content}'
  + 'code{word-break:break-all}.muted{color:#555}';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function sendPage(response, status, title, bodyHtml) {
  response.status(status);
  response.set('Content-Type', 'text/html; charset=utf-8');
  response.set('Cache-Control', 'private, no-store');
  // Not helmet's no-referrer: under it a browser posts the form with
  // `Origin: null`, which the origin guard refuses (see sendConsentPage in
  // oauth.js). same-origin keeps the real Origin and still sends nothing
  // to other sites.
  response.set('Referrer-Policy', 'same-origin');
  response.set('X-Robots-Tag', 'noindex, nofollow');
  response.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`);
}

function gonePage(response) {
  sendPage(response, 410, 'Upload link expired', '<p>This upload link has expired or was already used. Ask for a new one.</p>');
}

export function registerUploadRoutes(app, { staging = uploadStagingFor(app), maxBodyBytes = null } = {}) {
  const limit = maxBodyBytes || MAX_COMPOSE_ATTACHMENT_BYTES + (256 * 1024);
  const formBody = express.raw({ type: 'multipart/form-data', limit, inflate: false });

  app.get('/api/upload', (request, response) => {
    const token = String(request.query.token || '');
    const slot = staging.linkFor(token);
    if (!slot) return gonePage(response);
    const wanted = slot.filename ? `<p class="muted">Expected file: <code>${escapeHtml(slot.filename)}</code></p>` : '';
    return sendPage(response, 200, 'Upload a file to aMail', `${wanted}`
      + `<form method="post" enctype="multipart/form-data" action="/api/upload?token=${encodeURIComponent(token)}">`
      + '<label>File <input type="file" name="file" required></label>'
      + '<button type="submit">Upload</button></form>'
      + `<p class="muted">Up to ${COMPOSE_ATTACHMENT_LIMIT_LABEL}. This link works once and expires at ${escapeHtml(new Date(slot.expiresAt).toISOString())}.</p>`);
  });

  app.post('/api/upload', (request, response, next) => {
    // Refuse before reading a byte of body when the token is not live.
    if (!staging.linkFor(String(request.query.token || ''))) return gonePage(response);
    return formBody(request, response, next);
  }, (request, response) => {
    const token = String(request.query.token || '');
    try {
      const part = parseSingleFileUpload(request.body, request.get('content-type'));
      const stored = staging.acceptUpload(token, part);
      return sendPage(response, 201, 'Uploaded', `<p>aMail has <code>${escapeHtml(stored.filename)}</code> `
        + `(${stored.size.toLocaleString('en-US')} bytes).</p>`
        + `<p class="muted">SHA-256 <code id="sha256">${stored.sha256}</code></p>`
        + `<p class="muted">Upload id <code id="upload-id">${stored.uploadId}</code></p>`);
    } catch (error) {
      const status = error instanceof AppError && error.expose ? error.status : 400;
      const message = error instanceof AppError && error.expose ? error.message : 'The upload could not be read.';
      return sendPage(response, status, 'Upload failed', `<p>${escapeHtml(message)}</p>`);
    }
  });

  // A body over the limit, or a malformed one, from express.raw.
  app.use('/api/upload', (error, _request, response, next) => {
    if (!error) return next();
    if (error.type === 'entity.too.large') return sendPage(response, 413, 'Upload failed', `<p>The file is larger than ${COMPOSE_ATTACHMENT_LIMIT_LABEL}.</p>`);
    return sendPage(response, 400, 'Upload failed', '<p>The upload could not be read.</p>');
  });
}
