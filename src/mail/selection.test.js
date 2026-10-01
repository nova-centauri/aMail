import { describe, expect, it } from 'vitest';
import { mergeOpenThread, nextThreadAfterRemoval, reconcileSelectedThread, sameOpenThread } from './selection.js';

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

describe('nextThreadAfterRemoval', () => {
  const threads = [
    { id: 'a', subject: 'First' },
    { id: 'b', subject: 'Second' },
    { id: 'c', subject: 'Third' },
    { id: 'draft', folder: 'drafts', draftId: 'd1', subject: 'Draft' },
  ];

  it('opens the next message when the open one is deleted or marked spam', () => {
    expect(nextThreadAfterRemoval(threads, threads[0], ['a'])).toEqual({ advance: true, next: threads[1] });
    expect(nextThreadAfterRemoval(threads, threads[1], ['b']).next.id).toBe('c');
  });

  it('skips other rows removed in the same action and drafts', () => {
    expect(nextThreadAfterRemoval(threads, threads[0], ['a', 'b']).next.id).toBe('c');
    expect(nextThreadAfterRemoval(threads, threads[2], ['c'])).toEqual({ advance: true, next: null });
  });

  it('closes when the open message is last or missing from the list', () => {
    expect(nextThreadAfterRemoval(threads, { id: 'missing' }, ['missing'])).toEqual({ advance: true, next: null });
    expect(nextThreadAfterRemoval([], threads[0], ['a'])).toEqual({ advance: true, next: null });
  });

  it('does not move the reader when a different row was removed', () => {
    expect(nextThreadAfterRemoval(threads, threads[0], ['b'])).toEqual({ advance: false, next: null });
    expect(nextThreadAfterRemoval(threads, null, ['a'])).toEqual({ advance: false, next: null });
  });
});

describe('mergeOpenThread', () => {
  it('prefers the side with full HTML when combining a list row and a detailed fetch', () => {
    const merged = mergeOpenThread(listRow, openThread);
    expect(merged.messages[0].bodyHtml).toContain('full write-up');
    expect(mergeOpenThread(openThread, listRow).messages[0].bodyHtml).toContain('full write-up');
  });
});
