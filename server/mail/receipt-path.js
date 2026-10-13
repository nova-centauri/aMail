/**
 * How new mail shows up, and what is allowed to use the privacy proxy.
 *
 * IMAP and SMTP stay on the provider network. The Tor/Privoxy sidecar is only
 * for remote images the reader explicitly loads. New mail is noticed with
 * IMAP IDLE when the server offers it, plus a short INBOX UIDNEXT probe that
 * does not download bodies unless the mailbox actually moved.
 */

/** Fallback inbox check while IDLE is quiet or the server has no IDLE. */
export const INBOX_PROBE_INTERVAL_MS = 60_000;

/** Collapse a burst of EXISTS events into one inbox probe. */
export const IDLE_WAKE_COALESCE_MS = 200;

/** First probe after polling starts, so a fresh process is not IDLE-less for a full minute. */
export const INBOX_PROBE_START_DELAY_MS = 5_000;

/** Continue an inbox backlog without waiting for the next quiet probe. */
export const INBOX_BACKLOG_DELAY_MS = 5_000;

/**
 * Proxy decision for the three outbound paths. IMAP and SMTP are always
 * direct. `remoteContent` is the configured privacy proxy, or null when
 * image loading is left fail-closed.
 */
export function transportProxyDecision(config = {}) {
  const configured = typeof config.remoteContentProxyUrl === 'string' ? config.remoteContentProxyUrl.trim() : '';
  return {
    imap: null,
    smtp: null,
    remoteContent: configured || null,
  };
}

/**
 * Background receipt schedule. `syncIntervalMinutes` remains the full-folder
 * pass (other mailboxes, backlog). It is not how long new inbox mail waits.
 * `0` disables both the probe and the full pass.
 */
export function backgroundReceiptPlan(config = {}) {
  const minutes = Number(config.syncIntervalMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { enabled: false, inboxProbeMs: 0, fullSyncMs: 0, preferIdle: false };
  }
  return {
    enabled: true,
    inboxProbeMs: INBOX_PROBE_INTERVAL_MS,
    fullSyncMs: minutes * 60_000,
    preferIdle: true,
  };
}

/**
 * Pooled sessions should IDLE when the server advertises it, and also when
 * capability data is not available yet (ImapFlow no-ops if IDLE is missing).
 * One-shot connections never IDLE. An explicit capability list without IDLE
 * stays on the probe.
 */
export function imapAutoIdleEnabled({ pooled = false, capabilities = null } = {}) {
  if (!pooled) return false;
  if (capabilities == null) return true;
  const names = typeof capabilities?.[Symbol.iterator] === 'function' ? [...capabilities] : [];
  if (!names.length && typeof capabilities?.has !== 'function') return true;
  if (typeof capabilities.has === 'function') return capabilities.has('IDLE') || capabilities.has('idle');
  return names.some((name) => String(name).toUpperCase() === 'IDLE');
}
