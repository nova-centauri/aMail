import { describe, expect, it } from 'vitest';
import {
  editorHtmlToStored,
  extractHtmlDocumentBody,
  looksLikeHtml,
  sanitizeSignatureHtml,
  storedSignatureToEditorHtml,
  htmlToPlainText,
  validateSignatureLength,
} from './signature.js';

describe('signature helpers', () => {
  it('detects HTML tags without treating comparisons as markup', () => {
    expect(looksLikeHtml('<p>Best</p>')).toBe(true);
    expect(looksLikeHtml('Best,\nSam')).toBe(false);
    expect(looksLikeHtml('Price < 100')).toBe(false);
    expect(looksLikeHtml('Sam <Rivera>')).toBe(false);
  });

  it('extracts the body from a full HTML document', () => {
    const html = extractHtmlDocumentBody('<!doctype html><html><head><title>Sig</title></head><body><strong>Sam</strong></body></html>');
    expect(html).toContain('Sam');
    expect(html).not.toContain('<title>');
  });

  it('strips scripts, handlers, and unsafe CSS while keeping signature formatting', () => {
    const html = sanitizeSignatureHtml([
      '<div style="color:#0b57d0;background:url(https://evil.test/x.png)">',
      '<strong onclick="alert(1)">Sam</strong>',
      '<script>alert(1)</script>',
      '<a href="javascript:alert(1)">bad</a>',
      '<a href="https://rivera.example">site</a>',
      '<img src="https://rivera.example/logo.png" alt="Logo">',
      '</div>',
    ].join(''));
    expect(html).toContain('Sam');
    expect(html).toContain('https://rivera.example');
    expect(html).toContain('logo.png');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/url\(/i);
  });

  it('converts stored plain text for the visual editor and back', () => {
    expect(storedSignatureToEditorHtml('Best,\nSam')).toBe('Best,<br>Sam');
    expect(editorHtmlToStored('<div>Best,<br>Sam</div>')).toContain('Best');
    expect(editorHtmlToStored('<div><br></div>')).toBe('');
  });

  it('rejects signatures over the stored length cap', () => {
    expect(validateSignatureLength('short')).toBe('');
    expect(validateSignatureLength('x'.repeat(200_001))).toMatch(/too long/i);
  });

  it('turns stored HTML into plain text for the SMTP text part', () => {
    expect(htmlToPlainText('<p>Hello <strong>Maya</strong></p><p>See you tomorrow.</p>')).toMatch(/Hello Maya/);
    expect(htmlToPlainText('<p>Hello <strong>Maya</strong></p><p>See you tomorrow.</p>')).toMatch(/See you tomorrow/);
    expect(htmlToPlainText('Still writing.&nbsp;')).toBe('Still writing.');
  });
});
