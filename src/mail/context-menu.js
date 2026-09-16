import { SHORTCUTS } from '../shortcuts.js';

export const CONTEXT_MENU_MARGIN = 8;

const SHORTCUT_LABELS = Object.fromEntries(SHORTCUTS.map((item) => [item.action, item.keys[0] === 'Escape' ? 'Esc' : item.keys[0]]));

export const SEPARATOR = Object.freeze({ type: 'separator' });

// Right-clicks on these keep the browser's own menu: it offers copy, "open link
// in new tab", "save image", spell-check and text editing that ours cannot.
const NATIVE_MENU_SELECTOR = 'a[href], img, video, audio, input, textarea, select, [contenteditable="true"], [contenteditable=""]';

function shortcut(action) {
  return SHORTCUT_LABELS[action] || undefined;
}

function item(id, label, { icon, action, onSelect, disabled = false, danger = false, checked } = {}) {
  return { id, label, icon, shortcut: shortcut(action), onSelect, disabled, danger, ...(typeof checked === 'boolean' ? { checked } : {}) };
}

function senderEmail(source) {
  return String(source?.from?.email || '').trim();
}

/**
 * Keep a menu of `width` × `height` fully inside the viewport, preferring to
 * open down and to the right of the pointer like native menus do.
 */
export function clampMenuPosition({ x, y, width, height, viewportWidth, viewportHeight, margin = CONTEXT_MENU_MARGIN }) {
  const maxLeft = Math.max(margin, viewportWidth - width - margin);
  const maxTop = Math.max(margin, viewportHeight - height - margin);
  let left = x;
  let top = y;
  if (left + width + margin > viewportWidth) left = Math.max(margin, x - width);
  if (top + height + margin > viewportHeight) top = Math.max(margin, y - height);
  return {
    left: Math.min(Math.max(margin, left), maxLeft),
    top: Math.min(Math.max(margin, top), maxTop),
  };
}

/**
 * Where a context menu should open for a `contextmenu` event. Keyboard
 * invocations (Shift+F10, the Menu key) report no pointer position, so the
 * menu anchors to the element that has focus instead.
 */
export function menuAnchorPoint(event) {
  if (event && (event.clientX || event.clientY)) return { x: event.clientX, y: event.clientY };
  const target = event?.currentTarget || event?.target;
  const rect = typeof target?.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
  if (!rect) return { x: CONTEXT_MENU_MARGIN, y: CONTEXT_MENU_MARGIN };
  return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2 };
}

/**
 * True when a right-click should fall through to the browser's own menu:
 * links, images, form fields, editable regions, or a text selection the user
 * probably wants to copy.
 */
export function shouldDeferToNativeMenu(target, { scope = null, selection = globalThis.getSelection?.() } = {}) {
  const element = target?.nodeType === 3 ? target.parentElement : target;
  if (!element || typeof element.closest !== 'function') return false;
  if (element.closest(NATIVE_MENU_SELECTOR)) return true;
  if (selection && !selection.isCollapsed && String(selection).trim()) {
    const anchor = selection.anchorNode;
    const container = scope || element;
    if (anchor && typeof container.contains === 'function' && container.contains(anchor)) return true;
  }
  return false;
}

export function threadStateItems(thread, handlers) {
  const isDraft = thread.folder === 'drafts' || Boolean(thread.draftId);
  if (isDraft) return [];
  const items = [
    item(thread.unread ? 'read' : 'unread', thread.unread ? 'Mark as read' : 'Mark as unread', {
      icon: thread.unread ? 'mail' : 'unread',
      onSelect: () => handlers.applyAction?.(thread.unread ? 'read' : 'unread', [thread.id]),
    }),
    item('star', thread.starred ? 'Unstar' : 'Star', { icon: 'star', action: 'star', onSelect: () => handlers.toggleStar?.(thread) }),
  ];
  if (handlers.applyAction) {
    const analyzed = thread.analyzed !== false;
    items.push(item(analyzed ? 'unanalyzed' : 'analyzed', analyzed ? 'Mark as not analyzed' : 'Mark as analyzed', {
      icon: 'sparkles',
      onSelect: () => handlers.applyAction(analyzed ? 'unanalyzed' : 'analyzed', [thread.id]),
    }));
  }
  return items;
}

export function threadMoveItems(ids, handlers) {
  return [
    item('archive', 'Archive', { icon: 'archive', action: 'archive', onSelect: () => handlers.applyAction?.('archive', ids) }),
    item('snooze', 'Snooze until tomorrow', { icon: 'snooze', onSelect: () => handlers.applyAction?.('snooze', ids) }),
    item('spam', 'Report spam', { icon: 'spam', onSelect: () => handlers.applyAction?.('spam', ids) }),
    item('trash', 'Move to Trash', { icon: 'trash', action: 'trash', danger: true, onSelect: () => handlers.applyAction?.('trash', ids) }),
  ];
}

/**
 * Menu for one conversation row. When the row is part of a larger checked
 * selection the menu acts on the whole selection instead.
 */
export function threadContextMenu(thread, { selectedIds = [], handlers = {} } = {}) {
  if (!thread) return null;
  if (selectedIds.length > 1 && selectedIds.includes(thread.id)) return selectionContextMenu(selectedIds, handlers);
  const isDraft = thread.folder === 'drafts' || Boolean(thread.draftId);
  const isChecked = selectedIds.includes(thread.id);
  const email = senderEmail(thread);
  const items = [];
  if (isDraft) {
    items.push(item('open', 'Edit draft', { icon: 'compose', action: 'open', onSelect: () => handlers.openThread?.(thread) }));
    if (handlers.deleteDraft) {
      items.push(SEPARATOR, item('delete-draft', 'Delete draft', { icon: 'trash', danger: true, onSelect: () => handlers.deleteDraft(thread) }));
    }
  } else {
    items.push(item('open', 'Open conversation', { icon: 'mail', action: 'open', onSelect: () => handlers.openThread?.(thread) }));
    if (handlers.reply) items.push(item('reply', 'Reply', { icon: 'reply', action: 'reply', onSelect: () => handlers.reply(thread) }));
    if (handlers.forward) items.push(item('forward', 'Forward', { icon: 'forward', onSelect: () => handlers.forward(thread) }));
    items.push(SEPARATOR, ...threadStateItems(thread, handlers), SEPARATOR, ...threadMoveItems([thread.id], handlers));
  }
  const tail = [];
  if (handlers.toggleSelect) tail.push(item('select', isChecked ? 'Deselect' : 'Select', { icon: 'check', action: 'select', onSelect: () => handlers.toggleSelect(thread, !isChecked) }));
  if (email && handlers.copyText) tail.push(item('copy-sender', 'Copy sender address', { icon: 'person', onSelect: () => handlers.copyText(email, 'Sender address copied.') }));
  if (tail.length) items.push(SEPARATOR, ...tail);
  return { title: thread.subject || '(no subject)', items };
}

export function selectionContextMenu(ids, handlers = {}) {
  const count = ids.length;
  const noun = `${count} conversation${count === 1 ? '' : 's'}`;
  const items = [
    item('read', 'Mark as read', { icon: 'mail', onSelect: () => handlers.applyAction?.('read', ids) }),
    item('unread', 'Mark as unread', { icon: 'unread', onSelect: () => handlers.applyAction?.('unread', ids) }),
    item('analyzed', 'Mark as analyzed', { icon: 'sparkles', onSelect: () => handlers.applyAction?.('analyzed', ids) }),
    SEPARATOR,
    ...threadMoveItems(ids, handlers),
  ];
  if (handlers.clearSelection) items.push(SEPARATOR, item('clear-selection', 'Clear selection', { icon: 'close', onSelect: () => handlers.clearSelection() }));
  return { title: `${noun} selected`, items };
}

/**
 * Menu for the open conversation's heading: the same actions as the reader
 * toolbar, plus a subject copy for pasting into tickets or chats.
 */
export function openThreadContextMenu(thread, { handlers = {} } = {}) {
  if (!thread) return null;
  const items = [...threadStateItems(thread, handlers), SEPARATOR, ...threadMoveItems([thread.id], handlers)];
  const tail = [];
  if (thread.subject && handlers.copyText) tail.push(item('copy-subject', 'Copy subject', { icon: 'draft', onSelect: () => handlers.copyText(thread.subject, 'Subject copied.') }));
  if (handlers.back) tail.push(item('back', 'Back to list', { icon: 'back', action: 'back', onSelect: () => handlers.back() }));
  if (tail.length) items.push(SEPARATOR, ...tail);
  return { title: thread.subject || '(no subject)', items };
}

/** Menu for one message card inside the open conversation. */
export function messageContextMenu(message, { expanded = true, canReplyAll = false, handlers = {} } = {}) {
  if (!message) return null;
  const email = senderEmail(message);
  const items = [
    item('reply', 'Reply', { icon: 'reply', action: 'reply', onSelect: () => handlers.reply?.(message) }),
  ];
  if (canReplyAll) items.push(item('reply-all', 'Reply all', { icon: 'reply', onSelect: () => handlers.replyAll?.(message) }));
  items.push(item('forward', 'Forward', { icon: 'forward', onSelect: () => handlers.forward?.(message) }));
  const tail = [];
  if (handlers.toggleExpanded) tail.push(item('toggle', expanded ? 'Collapse message' : 'Expand message', { icon: 'chevronDown', onSelect: () => handlers.toggleExpanded(message) }));
  if (email && handlers.copyText) tail.push(item('copy-sender', 'Copy sender address', { icon: 'person', onSelect: () => handlers.copyText(email, 'Sender address copied.') }));
  if (tail.length) items.push(SEPARATOR, ...tail);
  const sender = message.from?.name || email || 'Message';
  return { title: sender, items };
}

/** Menu for a Fresh Drafts pill. */
export function draftContextMenu(draft, { handlers = {} } = {}) {
  if (!draft) return null;
  const items = [item('open', 'Open draft', { icon: 'compose', onSelect: () => handlers.open?.(draft) })];
  if (handlers.dismiss) items.push(item('dismiss', 'Dismiss from Fresh Drafts', { icon: 'close', onSelect: () => handlers.dismiss(draft) }));
  if (handlers.remove) items.push(SEPARATOR, item('delete', 'Delete draft', { icon: 'trash', danger: true, onSelect: () => handlers.remove(draft) }));
  return { title: draft.subject || '(no subject)', items };
}

/** Menu for a connected account (or the unified row when `account` is null). */
export function accountContextMenu(account, { active = false, handlers = {} } = {}) {
  const unified = !account || account.isUnified;
  const items = [
    item('show', unified ? 'Show all inboxes' : 'Show only this inbox', {
      icon: 'inbox',
      checked: active,
      disabled: active,
      onSelect: () => (unified ? handlers.selectUnified?.() : handlers.selectAccount?.(account)),
    }),
  ];
  if (handlers.sync) items.push(item('sync', unified ? 'Sync all accounts' : 'Sync now', { icon: 'refresh', onSelect: () => handlers.sync(unified ? null : account) }));
  if (!unified && handlers.editAccount) items.push(SEPARATOR, item('edit', 'Edit account', { icon: 'settings', onSelect: () => handlers.editAccount(account) }));
  else if (handlers.openSettings) items.push(SEPARATOR, item('settings', unified ? 'Manage accounts' : 'Manage account in Settings', { icon: 'settings', onSelect: () => handlers.openSettings(unified ? null : account) }));
  return { title: unified ? 'All inboxes' : account.email || account.name || 'Account', items };
}

/** Menu for a flagged-people folder in the sidebar. */
export function flagContextMenu(flag, { active = false, handlers = {} } = {}) {
  if (!flag) return null;
  const items = [
    item('show', active ? 'Clear flag filter' : 'Show flagged mail', { icon: 'person', onSelect: () => handlers.select?.(active ? null : flag.id) }),
  ];
  if (handlers.manage) items.push(SEPARATOR, item('manage', 'Manage flagged people', { icon: 'tune', onSelect: () => handlers.manage(flag) }));
  return { title: flag.label || flag.shortLabel || 'Flag', items };
}

/**
 * Best-effort clipboard write. Resolves to true when the text was copied so
 * callers can choose their own confirmation message.
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  const doc = globalThis.document;
  if (!doc?.body || typeof doc.execCommand !== 'function') return false;
  const field = doc.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  doc.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = doc.execCommand('copy');
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}
