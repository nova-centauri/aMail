/**
 * Decide what a mailbox pass is allowed to fetch.
 *
 * Periodic / plugin / drain passes are incremental: UIDNEXT and (when the
 * server offers it) CONDSTORE/MODSEQ. Already-synced UIDs are never listed
 * or downloaded. A full window is only for a UIDVALIDITY change or an
 * explicit `mode: 'full'` request.
 */

export function compareModseq(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a === b) return 0;
    return a > b ? 1 : -1;
  } catch {
    const a = String(left);
    const b = String(right);
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }
}

export function planMailboxSync({
  lastUid = 0,
  uidValidity = null,
  previousUidValidity = null,
  uidNext = 0,
  limit = 200,
  role = 'inbox',
  mode = 'incremental',
  mailboxModseq = null,
  previousModseq = null,
} = {}) {
  const latestUid = Math.max(0, (Number(uidNext) || 0) - 1);
  const page = Math.max(1, Number(limit) || 200);
  const previous = Number(previousUidValidity) || 0;
  const current = Number(uidValidity) || 0;
  const uidValidityChanged = Boolean(previous && current && previous !== current);
  const full = mode === 'full' || uidValidityChanged;
  const cursor = full ? 0 : Math.max(0, Number(lastUid) || 0);

  const newestWindow = () => {
    const firstUid = latestUid > 0 ? Math.max(1, latestUid - page + 1) : 1;
    return {
      kind: latestUid > 0 ? 'initial' : 'unchanged',
      firstUid,
      endUid: latestUid,
      scanDrafts: false,
    };
  };

  if (full) {
    if (role === 'drafts') {
      return {
        kind: 'new-uids',
        reason: uidValidityChanged ? 'uidvalidity' : 'full',
        firstUid: 1,
        endUid: Math.max(1, latestUid),
        resetCursor: true,
        uidValidityChanged,
        scanDrafts: true,
      };
    }
    return {
      ...newestWindow(),
      reason: uidValidityChanged ? 'uidvalidity' : 'full',
      resetCursor: true,
      uidValidityChanged,
    };
  }

  // Never-synced mailbox: newest page only. Periodic must not backfill history.
  if ((Number(lastUid) || 0) === 0 && role !== 'drafts') {
    return {
      ...newestWindow(),
      reason: 'first-sync',
      resetCursor: false,
      uidValidityChanged: false,
    };
  }

  if (role === 'drafts' && latestUid > 0) {
    return {
      kind: 'new-uids',
      reason: cursor > 0 && latestUid <= cursor ? 'drafts-backfill' : 'uidnext',
      firstUid: 1,
      endUid: latestUid,
      resetCursor: false,
      uidValidityChanged: false,
      scanDrafts: true,
    };
  }

  if (latestUid <= cursor) {
    if (mailboxModseq != null && previousModseq != null && compareModseq(mailboxModseq, previousModseq) > 0) {
      return {
        kind: 'flags',
        reason: 'condstore',
        firstUid: null,
        endUid: null,
        changedSince: previousModseq,
        resetCursor: false,
        uidValidityChanged: false,
        scanDrafts: false,
      };
    }
    return {
      kind: 'unchanged',
      reason: 'uidnext',
      firstUid: null,
      endUid: null,
      resetCursor: false,
      uidValidityChanged: false,
      scanDrafts: false,
    };
  }

  return {
    kind: 'new-uids',
    reason: 'uidnext',
    firstUid: cursor + 1,
    endUid: latestUid,
    resetCursor: false,
    uidValidityChanged: false,
    scanDrafts: false,
  };
}

/** Inclusive UID pages so a 500k-UID gap is never listed in one FETCH. */
export function uidPages(firstUid, endUid, pageSize) {
  const start = Number(firstUid) || 0;
  const end = Number(endUid) || 0;
  const size = Math.max(1, Number(pageSize) || 1);
  if (start < 1 || end < start) return [];
  const pages = [];
  for (let cursor = start; cursor <= end; cursor += size) {
    pages.push({ firstUid: cursor, endUid: Math.min(end, cursor + size - 1) });
  }
  return pages;
}
