import { describe, expect, it } from 'vitest';
import { composeWindowKey, shouldDismissCompose } from './compose-session.js';

describe('shouldDismissCompose', () => {
  it('keeps an open composer through sync, focus, and list reload', () => {
    for (const reason of ['sync', 'focus', 'reload', 'blur', 'outside-click', 'draft-id', 'autosave-error']) {
      expect(shouldDismissCompose(reason, { editing: true })).toBe(false);
    }
  });

  it('still closes for an explicit close, send, trash, or sign-out', () => {
    expect(shouldDismissCompose('explicit-close', { editing: true })).toBe(true);
    expect(shouldDismissCompose('send', { editing: true })).toBe(true);
    expect(shouldDismissCompose('discard', { editing: true })).toBe(true);
    expect(shouldDismissCompose('sign-out', { editing: true })).toBe(true);
  });

  it('does not dismiss a composer that is not open', () => {
    expect(shouldDismissCompose('explicit-close', { editing: false })).toBe(false);
    expect(shouldDismissCompose('sync', { editing: false })).toBe(false);
  });
});

describe('composeWindowKey', () => {
  it('ignores draft identity so a new draft id does not remount the window', () => {
    expect(composeWindowKey(3)).toBe('compose:3');
    expect(composeWindowKey(3)).toBe(composeWindowKey(3));
    expect(composeWindowKey(3)).not.toBe(composeWindowKey(4));
  });
});
