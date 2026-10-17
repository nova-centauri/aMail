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

  const newestWindow = (kind = 'initial', extra = {}) => {
    const firstUid = latestUid > 0 ? Math.max(1, latestUid - page + 1) : 1;
    return {
      kind: latestUid > 0 ? kind : 'unchanged',
      firstUid,
      endUid: latestUid,
      scanDrafts: false,
      jumpCursor: false,
      ...extra,
    };
  };

  const jumpHoles = ['drafts', 'trash', 'spam'].includes(role);

  if (full) {
    return {
      ...newestWindow('initial'),
      reason: uidValidityChanged ? 'uidvalidity' : 'full',
      resetCursor: true,
      uidValidityChanged,
    };
  }

  // Never-synced mailbox: newest page only. Periodic must not backfill history.
  if ((Number(lastUid) || 0) === 0) {
    return {
      ...newestWindow('initial'),
      reason: 'first-sync',
      resetCursor: false,
      uidValidityChanged: false,
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

  const firstUid = cursor + 1;
  const gap = latestUid - firstUid + 1;
  // Gmail Drafts/Trash UIDNEXT races ahead of sparse live UIDs. Walking the
  // hole with FETCH 1:latest (or lastUid+1:latest) is the 50-100s pass.
  if (jumpHoles && gap > page) {
    return {
      ...newestWindow('new-uids', { jumpCursor: true }),
      reason: 'uidnext-window',
      resetCursor: false,
      uidValidityChanged: false,
    };
  }
  return {
    kind: 'new-uids',
    reason: 'uidnext',
    firstUid,
    endUid: latestUid,
    resetCursor: false,
    uidValidityChanged: false,
    scanDrafts: false,
    jumpCursor: false,
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
