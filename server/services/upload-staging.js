import crypto from 'node:crypto';
import { AppError, NotFoundError, ValidationError } from '../errors.js';
import { asciiFilename, MAX_COMPOSE_ATTACHMENT_BYTES, safeAttachmentType } from './compose-attachments.js';

/*
 * Upload links for draft attachments. An agent that has the file on its own
 * disk but cannot reach aMail with a shell (a cloud session behind a proxy)
 * can still drive a browser. So:
 *
 * 1. create_upload_link (MCP, authenticated) returns a one-time https page on
 *    this server and an uploadId.
 * 2. The agent opens the page in its browser, picks the file, presses Upload.
 *    The page's token is the only authority for that one upload.
 * 3. save_draft takes { uploadId } in attachments or addAttachments.
 *
 * Nothing leaves this server and no outside host is involved. Rules:
 * - The link is single use and expires (10 minutes by default, 30 at most).
 * - The token is 256 random bits, kept only as a SHA-256 hash.
 * - The uploadId alone cannot upload, and the link alone cannot attach: that
 *   still needs an authenticated save_draft.
 * - Files stay in memory, never on disk, for 30 minutes or until a draft
 *   takes them. A restart drops them.
 * - Size cap (the 8 MiB draft limit), at most 16 links or files waiting, and
 *   at most 32 MiB staged in all. A file named .pdf must be a PDF.
 */

export const DEFAULT_UPLOAD_LINK_MINUTES = 10;
export const MAX_UPLOAD_LINK_MINUTES = 30;
export const STAGED_FILE_TTL_MS = 30 * 60 * 1000;
export const MAX_WAITING_UPLOADS = 16;
export const MAX_STAGED_TOTAL_BYTES = 32 * 1024 * 1024;

const UPLOAD_ID_PATTERN = /^upl_[0-9a-f]{32}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const TYPES_BY_EXTENSION = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function looksLikePdf(buffer) {
  // The PDF header may follow a little junk; readers accept it in the first 1 KB.
  return buffer.subarray(0, 1024).includes('%PDF-');
}

export function inferUploadType(filename, suppliedType) {
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase();
  if (extension && TYPES_BY_EXTENSION[extension]) return TYPES_BY_EXTENSION[extension];
  return safeAttachmentType(suppliedType);
}

function uploadError(message, code, status) {
  return new AppError(message, { status, code, expose: true });
}

export function isUploadId(value) {
  return typeof value === 'string' && UPLOAD_ID_PATTERN.test(value);
}

export function createUploadStaging({ maxBytes = MAX_COMPOSE_ATTACHMENT_BYTES, now = () => Date.now() } = {}) {
  const slots = new Map(); // token hash -> { uploadId, filename, expiresAt }
  const files = new Map(); // uploadId -> { filename, contentType, body, size, sha256, expiresAt }

  function sweep() {
    const time = now();
    for (const [key, slot] of slots) if (slot.expiresAt <= time) slots.delete(key);
    for (const [id, file] of files) if (file.expiresAt <= time) files.delete(id);
  }

  function stagedBytes() {
    let total = 0;
    for (const file of files.values()) total += file.size;
    return total;
  }

  function createLink({ filename = null, minutes = DEFAULT_UPLOAD_LINK_MINUTES } = {}) {
    sweep();
    const span = Number.isInteger(minutes) ? Math.min(Math.max(minutes, 1), MAX_UPLOAD_LINK_MINUTES) : DEFAULT_UPLOAD_LINK_MINUTES;
    if (slots.size + files.size >= MAX_WAITING_UPLOADS) {
      throw uploadError('Too many uploads are waiting. Attach or let the earlier ones expire first.', 'UPLOADS_BUSY', 429);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const uploadId = `upl_${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = now() + span * 60_000;
    slots.set(hashToken(token), { uploadId, filename: filename ? asciiFilename(filename) : null, expiresAt });
    return { token, uploadId, expiresAt, maxBytes };
  }

  /** The waiting slot for a token, or null. Never consumes it. */
  function linkFor(token) {
    if (!TOKEN_PATTERN.test(String(token || ''))) return null;
    sweep();
    return slots.get(hashToken(token)) || null;
  }

  /** Take the bytes for a token. The link is used up whether or not the file is accepted. */
  function acceptUpload(token, { filename, contentType, body }) {
    const slot = linkFor(token);
    if (!slot) throw uploadError('This upload link has expired or was already used. Ask for a new one.', 'UPLOAD_LINK_GONE', 410);
    slots.delete(hashToken(token));
    if (!Buffer.isBuffer(body) || !body.length) throw new ValidationError('The upload was empty. Choose a file and try again.');
    if (body.length > maxBytes) {
      throw uploadError(`The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`, 'ATTACHMENT_TOO_LARGE', 413);
    }
    if (stagedBytes() + body.length > MAX_STAGED_TOTAL_BYTES) {
      throw uploadError('Too many files are waiting to be attached. Try again in a few minutes.', 'UPLOADS_BUSY', 429);
    }
    const name = asciiFilename(slot.filename || filename);
    const type = inferUploadType(name, contentType);
    if (type === 'application/pdf' && !looksLikePdf(body)) {
      throw uploadError(`${name} is not a PDF file.`, 'ATTACHMENT_TYPE_MISMATCH', 422);
    }
    const file = {
      filename: name,
      contentType: type,
      // A copy, so the request's whole raw body is not kept alive by a slice.
      body: Buffer.from(body),
      size: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      expiresAt: now() + STAGED_FILE_TTL_MS,
    };
    files.set(slot.uploadId, file);
    return { uploadId: slot.uploadId, ...describe(file) };
  }

  function describe(file) {
    return {
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      sha256: file.sha256,
      expiresAt: new Date(file.expiresAt).toISOString(),
    };
  }

  /** The staged file for an uploadId, without removing it. */
  function peek(uploadId) {
    sweep();
    const file = isUploadId(uploadId) ? files.get(uploadId) : null;
    if (!file) {
      throw new NotFoundError('No uploaded file has that uploadId. It may not be uploaded yet, may have expired, or was already attached. Make a new upload link.');
    }
    return file;
  }

  /** Has the file for an uploadId arrived? Never throws for a valid id. */
  function status(uploadId) {
    sweep();
    if (!isUploadId(uploadId)) return { state: 'unknown' };
    const file = files.get(uploadId);
    if (file) return { state: 'uploaded', ...describe(file) };
    for (const slot of slots.values()) {
      if (slot.uploadId === uploadId) return { state: 'waiting', expiresAt: new Date(slot.expiresAt).toISOString() };
    }
    return { state: 'unknown' };
  }

  function release(uploadId) {
    files.delete(uploadId);
  }

  return { createLink, linkFor, acceptUpload, peek, status, release };
}

/**
 * Replace every `{ uploadId }` item in `input.attachments` and
 * `input.addAttachments` with the staged bytes. Returns the resolved input and
 * the ids it used, so the caller can release them once the draft is saved.
 */
export function resolveUploadReferences(input, staging) {
  const lists = ['attachments', 'addAttachments'];
  if (!input || typeof input !== 'object'
    || !lists.some((key) => Array.isArray(input[key]) && input[key].some((item) => item?.uploadId))) {
    return { input, used: [] };
  }
  const resolved = { ...input };
  const used = [];
  for (const key of lists) {
    if (!Array.isArray(input[key])) continue;
    resolved[key] = input[key].map((item) => {
      if (!item?.uploadId) return item;
      if (item.content || item.data || item.url) {
        throw new ValidationError('An attachment takes one of uploadId, url or content.');
      }
      if (!staging) throw uploadError('Upload links are not available on this server.', 'UPLOADS_UNAVAILABLE', 503);
      const file = staging.peek(item.uploadId);
      used.push(item.uploadId);
      const { uploadId, ...rest } = item;
      return {
        ...rest,
        filename: item.filename ? asciiFilename(item.filename) : file.filename,
        contentType: file.contentType,
        content: file.body.toString('base64'),
      };
    });
  }
  return { input: resolved, used };
}

/** One staging store per app, shared by the upload page and the MCP tools. */
export function uploadStagingFor(app) {
  if (!app.locals.uploadStaging) app.locals.uploadStaging = createUploadStaging();
  return app.locals.uploadStaging;
}
