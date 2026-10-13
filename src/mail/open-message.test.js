import { describe, expect, it } from 'vitest';
import { bodiesToFill } from './open-message.js';

describe('bodiesToFill', () => {
  it('fills the newest unimported message first and skips cached bodies', () => {
    const pending = bodiesToFill([
      { id: 'old', sourceImported: false, timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'cached', sourceImported: true, timestamp: '2026-02-01T00:00:00.000Z' },
      { id: 'latest', sourceImported: false, timestamp: '2026-03-01T00:00:00.000Z' },
      { id: 'missing-flag', timestamp: '2026-04-01T00:00:00.000Z' },
    ]);
    expect(pending.map((message) => message.id)).toEqual(['latest', 'old']);
  });
});
