import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, parseSseBlock } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api etag', () => {
  it('sends If-None-Match and returns notModified on 304', async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 304,
      headers: { ETag: 'W/"abc"' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await api('/messages?folder=inbox', { etag: 'W/"abc"', acceptNotModified: true });
    expect(result).toEqual({ notModified: true, etag: 'W/"abc"' });
    expect(fetchMock.mock.calls[0][1].headers['If-None-Match']).toBe('W/"abc"');
  });
});

describe('parseSseBlock', () => {
  it('reads event name and JSON data', () => {
    expect(parseSseBlock('event: progress\ndata: {"done":2,"total":5}')).toEqual({
      event: 'progress',
      data: { done: 2, total: 5 },
    });
  });
});
