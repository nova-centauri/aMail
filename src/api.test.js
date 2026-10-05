import { describe, expect, it } from 'vitest';
import { parseSseBlock } from './api.js';

describe('parseSseBlock', () => {
  it('reads event name and JSON data', () => {
    expect(parseSseBlock('event: progress\ndata: {"done":2,"total":5}')).toEqual({
      event: 'progress',
      data: { done: 2, total: 5 },
    });
  });
});
