import assert from 'node:assert/strict';
import test from 'node:test';
import { ftsDocument, toFtsMatchQuery } from './fts.js';

test('FTS queries are tokenized and never pass raw operators', () => {
  assert.equal(toFtsMatchQuery(''), '');
  assert.equal(toFtsMatchQuery('   '), '');
  assert.equal(toFtsMatchQuery('Workflow failed'), '"workflow"* AND "failed"*');
  assert.equal(toFtsMatchQuery('priya@printworks.example'), '"priya@printworks.example"*');
  assert.equal(toFtsMatchQuery('hello "OR" world'), '"hello"* AND "or"* AND "world"*');
  assert.equal(toFtsMatchQuery('!!!'), '');
});

test('FTS documents include attachment filenames and a truncated body', () => {
  const parse = (value, fallback = []) => {
    if (!value) return fallback;
    return JSON.parse(value);
  };
  const doc = ftsDocument({
    rowid: 9,
    subject: 'Menu',
    snippet: 'tonight',
    from_name: 'Ada',
    from_email: 'ada@example.test',
    to_json: JSON.stringify([{ name: 'Owner', email: 'owner@example.test' }]),
    cc_json: '[]',
    bcc_json: '[]',
    text_body: `invoice-body ${'x'.repeat(90_000)}`,
    attachments_json: JSON.stringify([
      { filename: 'winter-menu.pdf', contentType: 'application/pdf' },
      { name: 'wine-list.docx' },
    ]),
  }, parse);
  assert.equal(doc.attachments, 'winter-menu.pdf wine-list.docx');
  assert.equal(doc.recipients.includes('owner@example.test'), true);
  assert.equal(doc.text_body.length, 80_000);
  assert.equal(doc.text_body.startsWith('invoice-body'), true);
});
