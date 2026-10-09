import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDraftAttachments, normalizeComposeAttachments } from './compose-attachments.js';

test('compose attachments accept base64 bytes and reject oversize payloads', () => {
  const content = Buffer.from('hello notes').toString('base64');
  const [attachment] = normalizeComposeAttachments([
    { filename: 'notes.txt', contentType: 'text/plain', content },
  ]);
  assert.equal(attachment.filename, 'notes.txt');
  assert.equal(attachment.size, 11);
  assert.equal(attachment.contentType, 'text/plain');

  assert.throws(
    () => normalizeComposeAttachments([{ filename: 'empty.txt', content: '' }]),
    /missing file bytes/i,
  );
  assert.throws(
    () => normalizeComposeAttachments(Array.from({ length: 9 }, (_, index) => ({
      filename: `file-${index}.txt`,
      content,
    }))),
    /at most 8/i,
  );
});

test('saving an open draft keeps stored bytes and provider metadata', () => {
  const content = Buffer.from('hello notes').toString('base64');
  const [kept] = mergeDraftAttachments(
    [{ filename: 'notes.txt', contentType: 'text/plain', size: 11 }],
    [{ index: 0, filename: 'notes.txt', contentType: 'text/plain', size: 11, content }],
  );
  assert.equal(kept.content, content);
  assert.equal(kept.size, 11);

  const [providerPart] = mergeDraftAttachments(
    [{ filename: 'quote.pdf', contentType: 'application/pdf', size: 4096, contentId: 'part-1' }],
    [{ index: 0, filename: 'quote.pdf', contentType: 'application/pdf', size: 4096, contentId: 'part-1' }],
  );
  assert.equal(providerPart.filename, 'quote.pdf');
  assert.equal(providerPart.size, 4096);
  assert.equal(providerPart.contentId, 'part-1');
  assert.equal(providerPart.content, undefined);

  const [replaced] = mergeDraftAttachments(
    [{ filename: 'notes.txt', contentType: 'text/plain', content }],
    [{ index: 0, filename: 'other.txt', contentType: 'text/plain', size: 4, content: Buffer.from('nope').toString('base64') }],
  );
  assert.equal(replaced.content, content);
  assert.equal(replaced.filename, 'notes.txt');

  assert.throws(
    () => mergeDraftAttachments([{ filename: 'broken.txt', content: '@@@' }]),
    /missing file bytes/i,
  );
});

test('dangerous compose attachment types are stored as octet-stream', () => {
  const content = Buffer.from('<svg></svg>').toString('base64');
  const [attachment] = normalizeComposeAttachments([
    { filename: 'image.svg', contentType: 'image/svg+xml', content },
  ]);
  assert.equal(attachment.contentType, 'application/octet-stream');
});
