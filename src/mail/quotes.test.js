import { describe, expect, it } from 'vitest';
import { messageTimelineContent, stripQuotedHtml, stripQuotedPlain } from './quotes.js';

describe('stripQuotedPlain', () => {
  it('keeps the new reply and separates the On wrote quote', () => {
    const result = stripQuotedPlain([
      'Perfect — see you tomorrow.',
      '',
      'On Tue, Sep 1, 2026 at 9:00 AM Maya Chen <maya@studio.com> wrote:',
      '> Hi Sam,',
      '> The desktop flow is ready.',
    ].join('\n'));
    expect(result.stripped).toBe(true);
    expect(result.text).toBe('Perfect — see you tomorrow.');
    expect(result.quoted).toContain('Hi Sam');
  });

  it('keeps a forwarded message as the body of that card', () => {
    const text = 'FYI\n\n---------- Forwarded message ----------\nFrom: Maya\n\nThe notes are attached.';
    expect(stripQuotedPlain(text)).toMatchObject({ stripped: false, text });
  });

  it('drops a trailing quoted block and an Outlook reply header', () => {
    const quoted = stripQuotedPlain('Thanks!\n\n> earlier line\n> second line');
    expect(quoted.text).toBe('Thanks!');
    expect(quoted.stripped).toBe(true);
    const outlook = stripQuotedPlain([
      'Sounds good.',
      '',
      'From: Maya Chen <maya@studio.com>',
      'Sent: Tuesday, September 1, 2026 9:00 AM',
      'To: Sam Rivera',
      'Subject: Design sync',
      '',
      'Original notes.',
    ].join('\n'));
    expect(outlook.text).toBe('Sounds good.');
    expect(outlook.quoted).toContain('Original notes.');
  });

  it('keeps the original when the message is only a quote', () => {
    const text = '> just a quote';
    expect(stripQuotedPlain(text)).toMatchObject({ stripped: false, text });
  });
});

describe('stripQuotedHtml', () => {
  it('removes a Gmail quote wrapper and keeps the new paragraph', () => {
    const html = '<div>See you tomorrow.</div><div class="gmail_quote"><div>On Tue, Maya wrote:</div><blockquote class="gmail_quote">Earlier note</blockquote></div>';
    const result = stripQuotedHtml(html);
    expect(result.stripped).toBe(true);
    expect(result.html).toContain('See you tomorrow.');
    expect(result.html).not.toContain('Earlier note');
    expect(result.quotedHtml).toContain('Earlier note');
  });

  it('keeps HTML that has no reply quote', () => {
    const html = '<p>Only this message.</p>';
    expect(stripQuotedHtml(html)).toMatchObject({ stripped: false, html });
  });
});

describe('messageTimelineContent', () => {
  it('uses the stripped copy for the card and keeps the quote for later', () => {
    const content = messageTimelineContent({
      body: 'New note\n\nOn Mon, Ada wrote:\n> old',
      bodyHtml: '<p>New note</p><blockquote type="cite">old</blockquote>',
    });
    expect(content.stripped).toBe(true);
    expect(content.body).toBe('New note');
    expect(content.bodyHtml).toContain('New note');
    expect(content.bodyHtml).not.toContain('old');
  });
});
