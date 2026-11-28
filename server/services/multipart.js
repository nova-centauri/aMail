import { ValidationError } from '../errors.js';

/*
 * The smallest multipart/form-data reader that serves the upload page: one
 * form, one file field. A full parser is a dependency this server does not
 * otherwise need. Any part that is not the expected file field is ignored,
 * and a second file is refused.
 */

const MAX_HEADER_BYTES = 4096;

function boundaryOf(contentType) {
  const match = /boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(String(contentType || ''));
  return match ? (match[1] || match[2]) : null;
}

function headerValue(headers, name) {
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'im');
  return pattern.exec(headers)?.[1]?.trim() || '';
}

function dispositionParam(disposition, name) {
  const match = new RegExp(`(?:^|;)\\s*${name}="([^"]*)"`, 'i').exec(disposition)
    || new RegExp(`(?:^|;)\\s*${name}=([^;\\s]+)`, 'i').exec(disposition);
  return match ? match[1] : null;
}

export function parseSingleFileUpload(body, contentType, fieldName = 'file') {
  if (!Buffer.isBuffer(body)) throw new ValidationError('The upload had no form data.');
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new ValidationError('The upload was not a file form.');
  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.from(`\r\n--${boundary}`);
  if (!body.subarray(0, delimiter.length).equals(delimiter)) throw new ValidationError('The upload form was malformed.');

  let cursor = delimiter.length;
  let file = null;
  for (;;) {
    // After a delimiter: "--" closes the form, CRLF starts a part.
    if (body.subarray(cursor, cursor + 2).toString('latin1') === '--') break;
    if (body.subarray(cursor, cursor + 2).toString('latin1') !== '\r\n') throw new ValidationError('The upload form was malformed.');
    const headerStart = cursor + 2;
    const headerEnd = body.indexOf('\r\n\r\n', headerStart, 'latin1');
    if (headerEnd < 0 || headerEnd - headerStart > MAX_HEADER_BYTES) throw new ValidationError('The upload form was malformed.');
    const headers = body.subarray(headerStart, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(separator, contentStart);
    if (contentEnd < 0) throw new ValidationError('The upload was cut short. Try again.');

    const disposition = headerValue(headers, 'content-disposition');
    const filename = dispositionParam(disposition, 'filename');
    if (dispositionParam(disposition, 'name') === fieldName && filename !== null) {
      if (file) throw new ValidationError('Upload one file at a time.');
      file = {
        filename,
        contentType: headerValue(headers, 'content-type') || 'application/octet-stream',
        body: body.subarray(contentStart, contentEnd),
      };
    }
    cursor = contentEnd + separator.length;
  }
  if (!file || !file.body.length) throw new ValidationError('No file was chosen. Choose a file and press Upload.');
  return file;
}
