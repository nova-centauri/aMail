import { describe, expect, it } from 'vitest';
import { querySupportsDeepSearch } from './deep-search.js';

describe('querySupportsDeepSearch', () => {
  it('allows leftover text and people operators, but not analyzed-only filters', () => {
    expect(querySupportsDeepSearch('invoice')).toBe(true);
    expect(querySupportsDeepSearch('from:ada@example.com')).toBe(true);
    expect(querySupportsDeepSearch('invoice is:unanalyzed')).toBe(false);
    expect(querySupportsDeepSearch('is:unanalyzed')).toBe(false);
    expect(querySupportsDeepSearch('invoice', 'drafts')).toBe(false);
    expect(querySupportsDeepSearch('')).toBe(false);
  });
});
