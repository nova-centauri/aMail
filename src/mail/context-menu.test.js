import { describe, expect, it, vi } from 'vitest';
import {
  accountContextMenu,
  clampMenuPosition,
  copyText,
  draftContextMenu,
  flagContextMenu,
  menuAnchorPoint,
  messageContextMenu,
  openThreadContextMenu,
  selectionContextMenu,
  shouldDeferToNativeMenu,
  threadContextMenu,
} from './context-menu.js';

const labels = (menu) => menu.items.filter((entry) => entry.type !== 'separator').map((entry) => entry.label);
const find = (menu, id) => menu.items.find((entry) => entry.id === id);

const thread = {
  id: 't1',
  subject: 'Deploy window',
  from: { name: 'Ada', email: 'ada@example.com' },
  unread: true,
  starred: false,
  analyzed: false,
  folder: 'inbox',
};

describe('clampMenuPosition', () => {
  const viewport = { viewportWidth: 1000, viewportHeight: 800, width: 200, height: 300 };

  it('opens down and to the right when there is room', () => {
    expect(clampMenuPosition({ x: 100, y: 100, ...viewport })).toEqual({ left: 100, top: 100 });
  });

  it('flips to the other side of the pointer near the right and bottom edges', () => {
    expect(clampMenuPosition({ x: 950, y: 700, ...viewport })).toEqual({ left: 750, top: 400 });
  });

  it('never leaves the viewport margin, even for tiny viewports', () => {
    expect(clampMenuPosition({ x: 5, y: 2, ...viewport })).toEqual({ left: 8, top: 8 });
    expect(clampMenuPosition({ x: 100, y: 100, width: 500, height: 900, viewportWidth: 320, viewportHeight: 400 })).toEqual({ left: 8, top: 8 });
  });
});

describe('menuAnchorPoint', () => {
  it('uses the pointer position when the event has one', () => {
    expect(menuAnchorPoint({ clientX: 40, clientY: 60 })).toEqual({ x: 40, y: 60 });
  });

  it('falls back to the focused element for keyboard invocations', () => {
    const currentTarget = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 400, height: 40 }) };
    expect(menuAnchorPoint({ clientX: 0, clientY: 0, currentTarget })).toEqual({ x: 124, y: 220 });
  });
});

describe('shouldDeferToNativeMenu', () => {
  it('keeps the browser menu for links, images, and editable fields', () => {
    document.body.innerHTML = '<article id="row"><a href="https://example.com" id="link">x</a><img id="img" alt=""><input id="field"><div contenteditable="true" id="editor">y</div><span id="plain">z</span></article>';
    const collapsed = { isCollapsed: true, toString: () => '' };
    expect(shouldDeferToNativeMenu(document.getElementById('link'), { selection: collapsed })).toBe(true);
    expect(shouldDeferToNativeMenu(document.getElementById('img'), { selection: collapsed })).toBe(true);
    expect(shouldDeferToNativeMenu(document.getElementById('field'), { selection: collapsed })).toBe(true);
    expect(shouldDeferToNativeMenu(document.getElementById('editor'), { selection: collapsed })).toBe(true);
    expect(shouldDeferToNativeMenu(document.getElementById('plain'), { selection: collapsed })).toBe(false);
  });

  it('keeps the browser menu when the user has selected text inside the target', () => {
    document.body.innerHTML = '<article id="row"><span id="plain">hello</span></article><p id="elsewhere">other</p>';
    const plain = document.getElementById('plain');
    const inside = { isCollapsed: false, anchorNode: plain.firstChild, toString: () => 'hello' };
    const outside = { isCollapsed: false, anchorNode: document.getElementById('elsewhere').firstChild, toString: () => 'other' };
    expect(shouldDeferToNativeMenu(plain, { scope: document.getElementById('row'), selection: inside })).toBe(true);
    expect(shouldDeferToNativeMenu(plain, { scope: document.getElementById('row'), selection: outside })).toBe(false);
  });
});

describe('threadContextMenu', () => {
  it('offers open, reply, state, and move actions with Gmail-style shortcut hints', () => {
    const handlers = { openThread: vi.fn(), reply: vi.fn(), forward: vi.fn(), applyAction: vi.fn(), toggleStar: vi.fn(), toggleSelect: vi.fn(), copyText: vi.fn() };
    const menu = threadContextMenu(thread, { handlers });
    expect(menu.title).toBe('Deploy window');
    expect(labels(menu)).toEqual([
      'Open conversation', 'Reply', 'Forward',
      'Mark as read', 'Star', 'Mark as analyzed',
      'Archive', 'Snooze until tomorrow', 'Report spam', 'Move to Trash',
      'Select', 'Copy sender address',
    ]);
    expect(find(menu, 'archive').shortcut).toBe('e');
    expect(find(menu, 'trash').shortcut).toBe('#');
    expect(find(menu, 'trash').danger).toBe(true);
    find(menu, 'archive').onSelect();
    expect(handlers.applyAction).toHaveBeenCalledWith('archive', ['t1']);
    find(menu, 'analyzed').onSelect();
    expect(handlers.applyAction).toHaveBeenCalledWith('analyzed', ['t1']);
    find(menu, 'select').onSelect();
    expect(handlers.toggleSelect).toHaveBeenCalledWith(thread, true);
    find(menu, 'copy-sender').onSelect();
    expect(handlers.copyText).toHaveBeenCalledWith('ada@example.com', 'Sender address copied.');
  });

  it('flips read, star, analyzed, and select labels to match the current state', () => {
    const menu = threadContextMenu({ ...thread, unread: false, starred: true, analyzed: true }, { selectedIds: ['t1'], handlers: { applyAction: vi.fn(), toggleSelect: vi.fn() } });
    expect(labels(menu)).toContain('Mark as unread');
    expect(labels(menu)).toContain('Unstar');
    expect(labels(menu)).toContain('Mark as not analyzed');
    expect(labels(menu)).toContain('Deselect');
  });

  it('acts on the whole checked selection when the row is part of it', () => {
    const applyAction = vi.fn();
    const clearSelection = vi.fn();
    const menu = threadContextMenu(thread, { selectedIds: ['t1', 't2', 't3'], handlers: { applyAction, clearSelection } });
    expect(menu.title).toBe('3 conversations selected');
    expect(labels(menu)).toEqual(['Mark as read', 'Mark as unread', 'Mark as analyzed', 'Archive', 'Snooze until tomorrow', 'Report spam', 'Move to Trash', 'Clear selection']);
    find(menu, 'trash').onSelect();
    expect(applyAction).toHaveBeenCalledWith('trash', ['t1', 't2', 't3']);
  });

  it('keeps single-row actions when other rows are checked but not this one', () => {
    const menu = threadContextMenu(thread, { selectedIds: ['t2', 't3'], handlers: { applyAction: vi.fn() } });
    expect(menu.title).toBe('Deploy window');
    expect(labels(menu)).toContain('Open conversation');
  });

  it('shows draft-specific actions for saved drafts', () => {
    const deleteDraft = vi.fn();
    const draft = { id: 'draft:9', draftId: '9', folder: 'drafts', subject: 'Notes', from: { email: 'me@example.com' } };
    const menu = threadContextMenu(draft, { handlers: { openThread: vi.fn(), applyAction: vi.fn(), deleteDraft, copyText: vi.fn() } });
    expect(labels(menu)).toEqual(['Edit draft', 'Delete draft', 'Copy sender address']);
    find(menu, 'delete-draft').onSelect();
    expect(deleteDraft).toHaveBeenCalledWith(draft);
  });

  it('returns null without a thread', () => {
    expect(threadContextMenu(null)).toBeNull();
  });
});

describe('selectionContextMenu', () => {
  it('uses singular wording for one conversation', () => {
    expect(selectionContextMenu(['t1'], {}).title).toBe('1 conversation selected');
  });
});

describe('openThreadContextMenu', () => {
  it('mirrors the reader toolbar and adds subject copy and back', () => {
    const handlers = { applyAction: vi.fn(), toggleStar: vi.fn(), copyText: vi.fn(), back: vi.fn() };
    const menu = openThreadContextMenu(thread, { handlers });
    expect(labels(menu)).toEqual(['Mark as read', 'Star', 'Mark as analyzed', 'Archive', 'Snooze until tomorrow', 'Report spam', 'Move to Trash', 'Copy subject', 'Back to list']);
    find(menu, 'copy-subject').onSelect();
    expect(handlers.copyText).toHaveBeenCalledWith('Deploy window', 'Subject copied.');
    expect(find(menu, 'back').shortcut).toBe('u');
  });
});

describe('messageContextMenu', () => {
  const message = { id: 'm1', from: { name: 'Ada', email: 'ada@example.com' }, to: [{ email: 'me@example.com' }] };

  it('only offers Reply all when there are multiple recipients', () => {
    const handlers = { reply: vi.fn(), replyAll: vi.fn(), forward: vi.fn(), toggleExpanded: vi.fn(), copyText: vi.fn() };
    const single = messageContextMenu(message, { expanded: true, canReplyAll: false, handlers });
    expect(single.title).toBe('Ada');
    expect(labels(single)).toEqual(['Reply', 'Forward', 'Collapse message', 'Copy sender address']);
    const multi = messageContextMenu(message, { expanded: false, canReplyAll: true, handlers });
    expect(labels(multi)).toEqual(['Reply', 'Reply all', 'Forward', 'Expand message', 'Copy sender address']);
    find(multi, 'reply-all').onSelect();
    expect(handlers.replyAll).toHaveBeenCalledWith(message);
    find(multi, 'toggle').onSelect();
    expect(handlers.toggleExpanded).toHaveBeenCalledWith(message);
  });
});

describe('draftContextMenu', () => {
  it('offers open, dismiss, and delete', () => {
    const handlers = { open: vi.fn(), dismiss: vi.fn(), remove: vi.fn() };
    const draft = { id: 'd1', subject: 'Press window' };
    const menu = draftContextMenu(draft, { handlers });
    expect(labels(menu)).toEqual(['Open draft', 'Dismiss from Fresh Drafts', 'Delete draft']);
    find(menu, 'delete').onSelect();
    expect(handlers.remove).toHaveBeenCalledWith(draft);
  });
});

describe('accountContextMenu', () => {
  it('opens the exact account editor while unified still opens account settings', () => {
    const account = { id: 'a1', email: 'ops@example.com' };
    const handlers = { editAccount: vi.fn(), openSettings: vi.fn() };
    const menu = accountContextMenu(account, { handlers });
    find(menu, 'edit').onSelect();
    expect(handlers.editAccount).toHaveBeenCalledWith(account);
    expect(handlers.openSettings).not.toHaveBeenCalled();
    const unified = accountContextMenu(null, { handlers });
    expect(find(unified, 'edit')).toBeUndefined();
    find(unified, 'settings').onSelect();
    expect(handlers.openSettings).toHaveBeenCalledWith(null);
  });

  it('describes a connected account and syncs just that account', () => {
    const handlers = { selectAccount: vi.fn(), selectUnified: vi.fn(), sync: vi.fn(), openSettings: vi.fn() };
    const account = { id: 'a1', email: 'ops@example.com', name: 'Ops' };
    const menu = accountContextMenu(account, { active: false, handlers });
    expect(menu.title).toBe('ops@example.com');
    expect(labels(menu)).toEqual(['Show only this inbox', 'Sync now', 'Manage account in Settings']);
    find(menu, 'show').onSelect();
    expect(handlers.selectAccount).toHaveBeenCalledWith(account);
    find(menu, 'sync').onSelect();
    expect(handlers.sync).toHaveBeenCalledWith(account);
  });

  it('marks the active inbox and syncs everything for the unified row', () => {
    const handlers = { selectUnified: vi.fn(), sync: vi.fn() };
    const menu = accountContextMenu(null, { active: true, handlers });
    expect(menu.title).toBe('All inboxes');
    expect(find(menu, 'show')).toMatchObject({ label: 'Show all inboxes', checked: true, disabled: true });
    find(menu, 'sync').onSelect();
    expect(handlers.sync).toHaveBeenCalledWith(null);
  });
});

describe('flagContextMenu', () => {
  it('toggles the flag filter and links to management', () => {
    const handlers = { select: vi.fn(), manage: vi.fn() };
    const flag = { id: 'ops', label: 'Ops team' };
    const inactive = flagContextMenu(flag, { active: false, handlers });
    expect(labels(inactive)).toEqual(['Show flagged mail', 'Manage flagged people']);
    find(inactive, 'show').onSelect();
    expect(handlers.select).toHaveBeenCalledWith('ops');
    const active = flagContextMenu(flag, { active: true, handlers });
    expect(labels(active)[0]).toBe('Clear flag filter');
    find(active, 'show').onSelect();
    expect(handlers.select).toHaveBeenCalledWith(null);
  });
});

describe('copyText', () => {
  it('writes through the async clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('ada@example.com')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('ada@example.com');
    vi.unstubAllGlobals();
  });

  it('refuses empty text', async () => {
    await expect(copyText('')).resolves.toBe(false);
  });
});
