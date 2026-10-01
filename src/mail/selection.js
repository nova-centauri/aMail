function threadIds(thread) {
  if (!thread) return [];
  return [...new Set([thread.id, thread.threadId].filter(Boolean).map(String))];
}

export function sameOpenThread(left, right) {
  if (!left || !right) return false;
  const rightIds = new Set(threadIds(right));
  return threadIds(left).some((id) => rightIds.has(id));
}

export function findLoadedThread(current, loadedThreads = []) {
  if (!current) return null;
  return loadedThreads.find((item) => sameOpenThread(current, item)) || null;
}

function messageDetailScore(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  return messages.reduce((score, message) => {
    const html = String(message.bodyHtml || '').trim();
    const text = String(message.body || '').trim();
    return score + (html ? 100 : 0) + Math.min(text.length, 80) + 1;
  }, 0);
}

export function mergeOpenThread(current, incoming) {
  if (!current) return incoming || null;
  if (!incoming) return current;
  const keepCurrentMessages = messageDetailScore(current) >= messageDetailScore(incoming);
  return {
    ...current,
    ...incoming,
    messages: keepCurrentMessages
      ? (current.messages?.length ? current.messages : incoming.messages)
      : (incoming.messages?.length ? incoming.messages : current.messages),
  };
}

/**
 * Decide what the reader should show after a mailbox reload.
 * keepSelection false is an explicit navigation (folder/filter change).
 * keepSelection true must never dismiss an open conversation: live sync and
 * overlapping loads used to do that when the closure was stale or the row
 * had fallen off the current list page.
 */
/**
 * After spam or delete of the open conversation, the reader should land on the
 * next row that is still in the list. No next row means the reader closes.
 * Drafts are not a reader target. Actions that do not include the open row
 * leave the selection alone (`advance: false`).
 */
export function nextThreadAfterRemoval(visibleThreads, openThread, removedIds) {
  const removed = new Set((removedIds || []).map((id) => String(id)));
  const openId = openThread?.id != null ? String(openThread.id) : '';
  if (!openId || !removed.has(openId)) return { advance: false, next: null };
  const list = Array.isArray(visibleThreads) ? visibleThreads : [];
  const index = list.findIndex((thread) => String(thread?.id) === openId);
  if (index < 0) return { advance: true, next: null };
  for (let cursor = index + 1; cursor < list.length; cursor += 1) {
    const candidate = list[cursor];
    if (!candidate || removed.has(String(candidate.id))) continue;
    if (candidate.folder === 'drafts' || candidate.draftId) continue;
    return { advance: true, next: candidate };
  }
  return { advance: true, next: null };
}

export function reconcileSelectedThread(current, loadedThreads = [], { keepSelection = true } = {}) {
  if (!keepSelection) return null;
  if (!current) return current;
  const replacement = findLoadedThread(current, loadedThreads);
  if (!replacement) return current;
  return mergeOpenThread(current, replacement);
}
