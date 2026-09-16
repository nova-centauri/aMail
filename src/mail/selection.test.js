import { describe, expect, it } from 'vitest';
import { mergeOpenThread, reconcileSelectedThread, sameOpenThread } from './selection.js';

const openThread = {
  id: 'thread-1',
  threadId: 'thread-1',
  subject: 'Quarterly numbers',
  snippet: 'See attached',
  unread: false,
  messages: [{
    id: 'm1',
    body: 'See attached for the full write-up of the quarter.',
    bodyHtml: '<p>See attached for the full write-up of the quarter.</p>',
  }],
};

const listRow = {
  id: 'thread-1',
  threadId: 'thread-1',
  subject: 'Quarterly numbers',
  snippet: 'See attached',
  unread: false,
  messages: [{ id: 'm1', body: 'See attached' }],
};

describe('sameOpenThread', () => {
  it('matches list rows to a detailed reader thread by id or threadId', () => {
    expect(sameOpenThread(openThread, { id: 'thread-1' })).toBe(true);
    expect(sameOpenThread(openThread, { threadId: 'thread-1' })).toBe(true);
    expect(sameOpenThread(openThread, { id: 'other' })).toBe(false);
    expect(sameOpenThread(null, openThread)).toBe(false);
  });
});

describe('reconcileSelectedThread', () => {
  it('closes only when keepSelection is false', () => {
    expect(reconcileSelectedThread(openThread, [listRow], { keepSelection: false })).toBeNull();
  });

  it('keeps an open thread that a stale reload never saw selected', () => {
    expect(reconcileSelectedThread(openThread, [listRow], { keepSelection: true })).toMatchObject({
      id: 'thread-1',
      messages: openThread.messages,
    });
  });

  it('keeps the open thread even when it is missing from the current list page', () => {
    expect(reconcileSelectedThread(openThread, [{ id: 'thread-2', threadId: 'thread-2' }], { keepSelection: true })).toBe(openThread);
  });

  it('does not invent a selection when nothing is open', () => {
    expect(reconcileSelectedThread(null, [listRow], { keepSelection: true })).toBeNull();
  });

  it('merges list metadata without replacing the loaded message bodies', () => {
    const next = reconcileSelectedThread(openThread, [{ ...listRow, unread: true, starred: true }], { keepSelection: true });
    expect(next.unread).toBe(true);
    expect(next.starred).toBe(true);
    expect(next.messages[0].bodyHtml).toContain('full write-up');
  });
});

describe('mergeOpenThread', () => {
  it('prefers the side with full HTML when combining a list row and a detailed fetch', () => {
    const merged = mergeOpenThread(listRow, openThread);
    expect(merged.messages[0].bodyHtml).toContain('full write-up');
    expect(mergeOpenThread(openThread, listRow).messages[0].bodyHtml).toContain('full write-up');
  });
});
