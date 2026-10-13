const INCIDENTAL_DISMISS = new Set([
  'sync',
  'focus',
  'reload',
  'blur',
  'outside-click',
  'draft-id',
  'autosave-error',
]);

/**
 * An open composer stays up while mail reloads.
 * Sync, focus, and list refresh are not a close.
 * Trash, send, sign-out, and the close control are.
 */
export function shouldDismissCompose(reason, { editing = true } = {}) {
  if (!editing) return false;
  if (INCIDENTAL_DISMISS.has(reason)) return false;
  return reason === 'explicit-close' || reason === 'send' || reason === 'discard' || reason === 'sign-out';
}

/** Session id only. A saved draft id must not remount the composer. */
export function composeWindowKey(sessionId) {
  return `compose:${sessionId || 0}`;
}
