import { ValidationError } from '../errors.js';

export const MAX_COMPOSE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_COMPOSE_ATTACHMENT_COUNT = 8;
export const MAX_COMPOSE_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

const DANGEROUS_TYPES = new Set([
  'text/html',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/xhtml+xml',
]);

export function asciiFilename(value) {
  const cleaned = String(value || 'attachment').replace(/[\r\n"]/g, '').replace(/[/\\]/g, '_').slice(0, 180);
  return cleaned || 'attachment';
}

export function safeAttachmentType(type) {
  const normalized = String(type || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
  if (DANGEROUS_TYPES.has(normalized)) return 'application/octet-stream';
  return normalized || 'application/octet-stream';
}

function decodeBase64Content(value) {
  const raw = String(value || '').replace(/\s+/g, '');
  if (!raw) return null;
  if (!/^[A-Za-z0-9+/]+=*$/.test(raw) || raw.length % 4 !== 0) return null;
  try {
    const buffer = Buffer.from(raw, 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

export function publicAttachmentMeta(attachment, index = 0) {
  return {
    index: Number.isInteger(attachment?.index) ? attachment.index : index,
    filename: asciiFilename(attachment?.filename || attachment?.name),
    contentType: safeAttachmentType(attachment?.contentType || attachment?.type),
    size: Number(attachment?.size) || 0,
    contentId: attachment?.contentId || attachment?.cid || null,
  };
}

function assertAttachmentList(raw) {
  if (!Array.isArray(raw)) throw new ValidationError('Attachments must be an array.');
  if (raw.length > MAX_COMPOSE_ATTACHMENT_COUNT) {
    throw new ValidationError(`Attach at most ${MAX_COMPOSE_ATTACHMENT_COUNT} files.`);
  }
}

function contentBuffer(item) {
  return decodeBase64Content(item?.content || item?.data);
}

function attachmentRecord({ index, filename, contentType, size, content, contentId }) {
  const record = { index, filename, contentType, size };
  if (content) record.content = content;
  if (contentId) record.contentId = contentId;
  return record;
}

function storedFilename(item) {
  return asciiFilename(item?.filename || item?.name);
}

export function normalizeComposeAttachments(raw) {
  if (raw == null) return [];
  assertAttachmentList(raw);
  let total = 0;
  return raw.map((item, index) => {
    const filename = storedFilename(item);
    const contentType = safeAttachmentType(item?.contentType || item?.type);
    const buffer = contentBuffer(item);
    if (!buffer) throw new ValidationError(`Attachment ${index + 1} is missing file bytes.`);
    if (buffer.length > MAX_COMPOSE_ATTACHMENT_BYTES) {
      throw new ValidationError(`${filename} is larger than 8 MB.`);
    }
    total += buffer.length;
    if (total > MAX_COMPOSE_ATTACHMENT_TOTAL_BYTES) {
      throw new ValidationError('Attached files together must stay under 8 MB.');
    }
    return attachmentRecord({
      index,
      filename,
      contentType,
      size: buffer.length,
      content: buffer.toString('base64'),
      contentId: item?.contentId || item?.cid || null,
    });
  });
}

/**
 * Save path for a draft that is already open. New uploads still need bytes.
 * Parts the composer already has — stored compose bytes, or provider metadata
 * that never included bytes — are kept so closing the draft does not fail.
 */
export function mergeDraftAttachments(incoming, existing = []) {
  if (incoming == null) return [];
  assertAttachmentList(incoming);
  const pool = (Array.isArray(existing) ? existing : []).map((item, index) => ({
    item,
    index: Number.isInteger(item?.index) ? item.index : index,
    filename: storedFilename(item),
    used: false,
  }));
  const claimStored = (item, index) => {
    const filename = storedFilename(item);
    const wantedIndex = Number.isInteger(item?.index) ? item.index : index;
    const available = pool.filter((entry) => !entry.used && entry.filename === filename);
    const match = available.find((entry) => entry.index === wantedIndex) || available[0] || null;
    if (match) match.used = true;
    return match?.item || null;
  };
  let uploadedBytes = 0;
  return incoming.map((item, index) => {
    const filename = storedFilename(item);
    const presented = item?.content ?? item?.data;
    const buffer = contentBuffer(item);
    if (presented != null && presented !== '' && !buffer) {
      throw new ValidationError(`Attachment ${index + 1} is missing file bytes.`);
    }
    if (buffer) {
      if (buffer.length > MAX_COMPOSE_ATTACHMENT_BYTES) {
        throw new ValidationError(`${filename} is larger than 8 MB.`);
      }
      uploadedBytes += buffer.length;
      if (uploadedBytes > MAX_COMPOSE_ATTACHMENT_TOTAL_BYTES) {
        throw new ValidationError('Attached files together must stay under 8 MB.');
      }
      return attachmentRecord({
        index,
        filename,
        contentType: safeAttachmentType(item?.contentType || item?.type),
        size: buffer.length,
        content: buffer.toString('base64'),
        contentId: item?.contentId || item?.cid || null,
      });
    }
    const stored = claimStored(item, index);
    const storedBuffer = stored ? contentBuffer(stored) : null;
    if (storedBuffer) {
      return attachmentRecord({
        index,
        filename,
        contentType: safeAttachmentType(stored.contentType || item?.contentType || item?.type),
        size: storedBuffer.length,
        content: storedBuffer.toString('base64'),
        contentId: item?.contentId || item?.cid || stored.contentId || stored.cid || null,
      });
    }
    const declared = Number(item?.size ?? stored?.size);
    return attachmentRecord({
      index,
      filename,
      contentType: safeAttachmentType(item?.contentType || item?.type || stored?.contentType),
      size: Number.isFinite(declared) && declared >= 0 ? declared : 0,
      contentId: item?.contentId || item?.cid || stored?.contentId || stored?.cid || null,
    });
  });
}

export function mailerAttachments(attachments = []) {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    content: Buffer.from(attachment.content, 'base64'),
    contentDisposition: 'attachment',
  }));
}

export function storedAttachmentRecords(attachments = []) {
  return attachments.map((attachment, index) => ({
    index,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    content: attachment.content,
  }));
}

export function attachmentContentBuffer(attachment) {
  if (!attachment?.content) return null;
  try {
    const buffer = Buffer.from(String(attachment.content), 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}
