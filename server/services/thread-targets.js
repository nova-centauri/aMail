/**
 * The messages a thread-wide action applies to.
 *
 * Archiving or snoozing a conversation takes it out of the inbox. Your own
 * Sent copies and drafts were never in the inbox, and moving them would pull
 * them out of Sent or Drafts on the server (on Gmail, moving a Sent copy to All
 * Mail strips its Sent label). Trash, spam and flag changes still apply to
 * every message in the conversation.
 */
export function threadActionTargets(messages, state = {}) {
  const keys = Object.keys(state).filter((key) => state[key] !== undefined);
  const inboxOnly = keys.length > 0 && keys.every((key) => key === 'isArchived' || key === 'snoozedUntil');
  if (!inboxOnly) return messages;
  return messages.filter((message) => !message.isSent && !message.isDraft);
}
