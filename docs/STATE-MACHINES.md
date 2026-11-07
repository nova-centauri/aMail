# Implicit state machines in aMail

This is a map of every place where aMail keeps state that moves through stages without a written-down state machine: flag combinations, nullable timestamps, status strings, in-memory maps, files on disk and sync cursors. For each one it says where the state lives, what the states are, what moves it, who writes it, and where it breaks.

**How this was made**

- The code was read on branch `claude/project-thread-e1sdf7`, based on `main` at `4891acd` (2026-11-07). Paths are relative to the repo root. Line numbers are approximate and will drift.
- Reading only. No mail, account or live-server writes were made against mail.xer0.io.
- **Confirmed** means the behavior was reproduced by running the real repository code against a scratch database, or is plain from a single line of code (for example a missing import). **Inferred** means it follows from reading the code but depends on timing or deploy setup and has not been exercised.
- The map describes the code before the fixes listed under Fix status below.

**Count:** 58 machines: 16 rated high, 24 medium (including the medium-low and low-medium ones) and 18 low.

## The short version

The single biggest pattern: **aMail treats its local SQLite copy as the truth and the IMAP server as something it tells, not something it listens to.** Local state changes first, the server call may fail with no retry, undo never reaches the server, and sync never notices when other clients move or delete mail. Over weeks, aMail and the real mailbox drift apart, and nothing in the app can tell you by how much.

The second pattern: **many machines live only in memory** (sync jobs, deep-search jobs, cooldowns, sessions, metering, Typesense pending writes). Every deploy or restart silently resets them, and callers can't tell "gone because of a restart" from "never existed".

The third: **the same state is defined in several places that must agree** (five copies of the folder predicates, five definitions of "unanalyzed", two copies of the threading logic, OAuth expiry stored twice). They already disagree in places.

## Ranking

| # | Machine | Section | Risk | Status |
|---|---|---|---|---|
| 1 | Message placement flags: local-first, undo never reaches the server | 1.1 | High | Confirmed |
| 2 | Snooze never wakes up and can't be cleared | 1.2 | High | Confirmed |
| 3 | Sync cursor: lost flag changes, no expunge or move detection | 1.3 | High | Inferred |
| 4 | Connector OAuth grants: the owner can't revoke them | 4.2 | High | Confirmed in code |
| 5 | Vault lock is not durable: any bearer token re-unlocks | 4.4 | High | Confirmed in code |
| 6 | Harness first-time setup is not atomic: can brick the install | 4.1 | High | Confirmed in code |
| 7 | Draft save vs Drafts reconcile race | 1.4 | High | Inferred |
| 8 | Analyzed flag: no claim, five definitions, double billing | 2.1 | High | Confirmed in code |
| 9 | Envelope-only messages never load their bodies in the UI | 3.1 | High | Confirmed in code |
| 10 | Sign out then sign in shows an empty mailbox (stale ETag) | 3.2 | High | Confirmed in code |
| 11 | Sign-out undone by an in-flight request; Escape dismisses the lock | 3.4 | High | Confirmed in code |
| 12 | Closing the reader while images load blanks the app | 3.3 | High | Confirmed in code |
| 13 | Refresh then switch folder shows the wrong folder's mail | 3.5 | High | Inferred |
| 14 | Search-read worker: stale exit handler leaks workers | 2.2 | High | Inferred |
| 15 | Send has no idempotency or durable progress | 1.5 | High | Inferred |
| 16 | Typesense index drops failed updates and never deletes | 2.3 | High | Confirmed in code |

Everything else is listed in its section with its rating.

## Fix status (2026-11-07)

Fixed in the same pull request as this map, each with a test that fails before the fix:

- **1.1 placement.** Archive, trash and spam changes, and their undo, now move the message on the server to wherever the resulting local state says it belongs. Restoring from Gmail's All Mail copies it to the inbox. Spam no longer sets the archive flag, Archive excludes spam in every folder predicate, and not-spam returns the message to the inbox. Thread archive and snooze skip your own Sent copies and drafts.
- **1.2 snooze.** Snooze no longer archives, so it returns to the inbox when its time passes. `snoozedUntil: null` clears it (new `unsnooze` API route and MCP action). A one-time migration (`migration.snooze_unarchive_v1`) un-archives INBOX rows the old snooze had archived.
- **1.3 sync cursor.** A pass that imports new UIDs applies CONDSTORE read/star changes before saving the new modseq. The stored `last_uid` never moves backwards within one UIDVALIDITY.
- **1.4 drafts.** Draft saves and Drafts-mailbox syncs take turns per account (a save waits at most 30 seconds). A row removed mid-save is stored again instead of throwing.
- **2.2 search-read worker.** A terminated worker's late error or exit no longer fails the replacement's searches.
- **2.3 Typesense.** A failed flush keeps its changes and retries. (Deleting documents for removed messages is still open.)
- **3.1-3.4 frontend.** `normalizeMessage` is imported, sign-out clears the list ETag, load id and deep search, `loadRemoteContent` tolerates a closed reader, and Escape can't dismiss a required unlock.
- **Keyslots.** Temp files get a random suffix.

Still open, because each needs a product decision or is risky to change on the live mailbox without one:

- A durable outbox with retry for remote moves (1.1). Moves are still best-effort; a failure is reported in `remoteSync`.
- Expunge and remote-move detection (1.3).
- Connector grant list and revoke, and OAuth tokens unlocking a locked vault (4.2, 4.4).
- Atomic harness init (4.1).
- Analyzed-flag claim and one definition of "unanalyzed" (2.1).
- Send idempotency and durable progress (1.5).
- Refresh-then-switch-folder race (3.5).

---

## 1. Server: mail placement, sync and drafts

### 1.1 Message placement flags (inbox, archive, trash, spam, snoozed, sent, draft) — HIGH

- **Where.**
  - Schema in `server/db.js` (~261-416): `messages.is_archived`, `is_trashed`, `is_spam`, `is_sent`, `is_draft`, `snoozed_until`, `mailbox`.
  - Writers: `repos.messages.setState` (~1530), `relocate` (~1606), `upsert` (~1465).
  - API: `updateMessageState` in `server/services/mail-service.js` (~3239), `syncMessageStateToImap` (~2896), `remoteMoveAction` (~389).
  - Thread fan-out: `updateTargets` in `server/routes/api.js` (~103), and the MCP equivalent in `server/mcp/server.js` (~94-101).
- **States.** There is no folder column. A message's folder is derived from five booleans, one nullable timestamp and the IMAP `mailbox` string. Most combinations are meaningless (archived, trashed and spam at once is representable).
- **Who decides the folder.** The same predicates are hand-written in at least five places that must agree:
  - `db.js` `messageList` / `messageCount` (~1700, ~1742) and `folderBadgeCounts` (~1410)
  - the partial indexes in `db.js` (~540-560)
  - `server/services/conversation-search.js` (~10-18)
  - `server/services/search-engine.js`, both the JS filter (~142-153) and the Typesense filter strings (~178-192)
- **Transitions.** Archive, trash, spam, snooze, read and star from the UI, MCP `message_action` / `set_flags`, and sync import (flags set from the source mailbox role).
- **Weak spots.**
  - **Local first, remote maybe.** `setState` runs before the IMAP call. If IMAP fails, the API returns `remoteSync: 'failed'` and nothing retries. Local and server state stay apart for good. There is no outbox.
  - **Undo is local only (confirmed).** `remoteMoveAction` only acts on `true` values. Unarchive, untrash and unspam clear the local flag but never move the message back on the server. After archive then unarchive on Gmail, the message shows only under All (not Inbox) and its `mailbox` is still `[Gmail]/All Mail`. After untrash it stays in `[Gmail]/Trash` on the server, where Gmail purges it after 30 days (inferred).
  - **Spam shows in Archive (confirmed).** The spam action also sets `is_archived = 1`, and the archive predicate has no `is_spam = 0`. `unspam` only clears `is_spam`, so the message stays in Archive locally and in Junk on the server.
  - **Thread actions hit your own Sent copies and drafts (inferred).** Thread actions expand to every message in the thread. Archiving a thread on Gmail would move the Sent copies out of Sent.
  - **Predicate drift.** A fix in one copy of the folder rules (say, adding `is_spam = 0` to archive) silently leaves badges, search or Typesense disagreeing with the list. Typesense already disagrees on drafts (see 2.3).
- **Suggestion.** One derived `folder` function (or a generated column) used by every reader, plus a small outbox table for remote moves that retries and can be inspected.

### 1.2 Snooze — HIGH (confirmed)

- **Where.** `messages.snoozed_until`. `repos.messageState` SQL (`db.js` ~1096-1102) uses `snoozed_until = COALESCE(@snoozed_until, snoozed_until)`. `setState` (~1530). The snooze path in `updateMessageState` returns `'local-only'` early.
- **States.** Not snoozed (null), snoozed (future time), expired (past time). Snoozing also sets `is_archived = 1`.
- **Transitions.** Snooze sets the time and the archive flag. There is no wake job; "expired" is only a time comparison inside the folder predicates.
- **Weak spots.**
  - **Snooze never wakes up.** When the time passes, the message still has `is_archived = 1`, so it shows in Archive, not the inbox. Nothing clears the flag.
  - **Snooze can't be cleared.** `COALESCE(null, snoozed_until)` keeps the old value, so `setState({ snoozedUntil: null })` does nothing. Unsnooze is impossible through the repository.
  - **Local only.** The server copy stays in INBOX, so every other client still shows it.
  - Typesense never re-indexes a thread when its snooze expires (see 2.3).

### 1.3 Mailbox sync cursor — HIGH

- **Where.** `sync_state` table (`last_uid`, `uid_validity`, `highest_modseq`, `last_error`, `synced_at`). Planner: `server/services/mailbox-sync-plan.js` (`planMailboxSync`). Executor: `syncMailbox` in `mail-service.js` (~1022-1543). `sync_skips` table.
- **States (plan kinds).**
  - `initial`: first sync, a UIDVALIDITY change, or `mode: 'full'`
  - `unchanged`
  - `flags`: CONDSTORE says something changed and there are no new UIDs
  - `new-uids`
  - `new-uids` with `jumpCursor`: Drafts, Trash and Spam when the gap is bigger than one page
  - Per mailbox status: ok, partial or error (from `last_error`)
- **Weak spots.**
  - **Flag changes lost when new mail arrives (inferred, high confidence).** The `flags` plan only runs when there are no new UIDs. On a `new-uids` pass, the success path saves the mailbox's current `highest_modseq` (~1389) without calling `applyFlagChanges` (only the flags plan does, ~1429). Read or star changes made in another client during that window are skipped forever, because the saved MODSEQ is now past them.
  - **No expunge or move detection (inferred).** Outside Drafts, nothing notices that a UID vanished. Mail you archive, move or delete in Gmail web or on your phone stays in aMail's inbox forever.
  - **Copies become new rows.** `upsert` matches by UID, then by Message-ID only within the same mailbox. A message that turns up in Trash, Spam or Sent after moving elsewhere becomes a second row, marked unanalyzed, so agents review it again.
  - **Silent skips.** `last_uid` moves past messages that were too large or unavailable (~1479) without writing to `sync_skips`. They never import, and the mailbox only says "partial".
  - **The cursor can go backwards (inferred).** `previousSync` is read before the mailbox lock. Two syncs of the same mailbox with different limits get different `accountInFlight` keys and both run. The slower one writes an older `last_uid`, and the next pass re-imports.
  - `jumpCursor` deliberately skips old UIDs in Drafts, Trash and Spam. That is a design choice, but it means older messages there are never imported.
- **Suggestion.** Always apply CONDSTORE changes on `new-uids` passes, and add a cheap periodic `UID SEARCH ALL` diff (or QRESYNC `VANISHED` where offered) to detect expunges.

### 1.4 Draft lifecycle (server drafts) — HIGH

- **Where.** `saveDraft` (`mail-service.js` ~2595-2700), `reconcileDrafts` (~1231-1300) and `importReconciledDrafts`, `retireSentDraft`, `DELETE /drafts/:id` (`api.js` ~745), `server/services/drafts.js` `prepareDraft`, `draft_compose_html` table. See also `docs/drafts.md`.
- **States.** Legacy local draft (`drafts` table, read only for migration), server draft (`is_draft = 1`, `mailbox` = Drafts, `uid` set), saving (APPEND in flight), sent (retired), trashed.
- **Transitions.** Each save APPENDs a new copy with a new Message-ID (`createMessageId` per save, ~2599), expunges the old UID and updates the row in place. Reconcile, during a Drafts sync, removes local rows whose UID is gone and imports new ones.
- **Weak spots.**
  - **Save vs reconcile race (inferred).** `saveDraft` uses its own IMAP connection, not the pool, so nothing serializes it with a Drafts sync. The sequence:
    1. Reconcile reads the set of known drafts.
    2. Save appends the new copy and expunges the old UID.
    3. Reconcile's SEARCH finds the old UID gone and an unknown Message-ID, so it deletes the row.
    4. `saveDraft`'s `replace(...)` returns null, and `setComposeHtml(saved.id, ...)` (~2681) throws a TypeError after the server already has the draft.
    The UI reports a failed save and loses the draft id. The next sync imports the draft under a new id.
  - **Two saves at once (inferred).** There is no per-draft lock. Two concurrent saves (two tabs, or MCP plus UI) both APPEND, only one old copy is removed, and a duplicate is left on the server.
  - **Delete is a move.** If the move to Trash fails, the draft is hidden locally but stays in the server's Drafts.
  - Known gap from earlier work: drafts don't carry the aMail signature.
- **Suggestion.** A per-draft mutex shared by save and reconcile, and a stable draft identity (for example an `X-aMail-Draft-Id` header) instead of matching on a Message-ID that changes every save.

### 1.5 Send — HIGH

- **Where.** `sendMessage` (`mail-service.js` ~2766-2894), `appendProviderSentCopy`, `retireSentDraft`.
- **States.** Composing, SMTP accepted, local Sent row written (`uid` null), provider Sent copy appended (skipped on Gmail), draft retired.
- **Weak spots.**
  - **No idempotency key.** A UI or MCP retry after a timeout sends the mail twice. The compose UI invites exactly that retry (see 3.8).
  - **No durable progress.** A crash after SMTP accepts and before the Sent row is written leaves a sent mail with no local record. If `retireSentDraft` fails, the draft stays after it was sent, inviting a second send.
  - The local Sent row starts as unanalyzed.

### 1.6 IMAP connection pool and account cooldown — MEDIUM

- **Where.** `mail-service.js` ~573-833 (pool), ~625-674 (cooldown), `invalidateAccount` (~2206), `accountGenerations`.
- **States per connection.** Connecting, in use (`refs > 0`), idle (`closeTimer` set), invalidated (`usable = false` after an error or close event), evicted. Per account: a generation number and a cooldown with failure count and backoff capped at 15 minutes.
- **Weak spots.**
  - Cooldown is memory only and resets on restart.
  - Auth failures are treated like transient errors, so a bad password retries every 15 minutes forever (see 4.8).
  - The generation guard protects the main thread's cache, but the ingest worker (1.8) does not check it.

### 1.7 Account sync runs, in-flight dedupe and the sync job board — MEDIUM

- **Where.** `syncAccount` / `syncAll` (`mail-service.js` ~1713-2034): `accountInFlight`, `inFlightSync`, `accountLastSync`, `lastFullSync`, `withSyncDeadline` / `withImapDeadline`, and the inbox probe state (`inboxProbeTimers`, `inboxProbeInFlight`, `inboxFollowUp`, `idlePending`). Job board: `server/services/sync-jobs.js` and `mail-service.js` ~2138-2192.
- **States.** Per account: idle, in flight, recent (cached result), cooling. Jobs: `queued`, `running`, `done`, `error`.
- **Weak spots.**
  - **The deadline doesn't cancel.** When it fires, the in-flight entry is deleted but the run keeps going. The next request starts a second, overlapping run, which feeds the cursor race in 1.3.
  - **Jobs vanish on restart.** The board is memory only and capped at 32. `get_sync_job` returns NOT_FOUND after a deploy, which an agent can't tell from a bad id.
  - `queued` is overwritten to `running` straight away, so nobody ever sees it.

### 1.8 Sync ingest worker — MEDIUM

- **Where.** `server/services/sync-ingest.js`, `server/services/sync-ingest-worker.js`.
- **States.** Disabled (test env or no paths), not started, live, broken (permanent fallback to the HTTP thread for the life of the process), closed. Per job: pending (120-second timer), resolved, rejected or timed out.
- **Weak spots.**
  - **Worker writes skip Typesense.** The worker opens its own repositories and never calls `setSearchIndexer`, so its `queueSearch` is the default no-op. With Typesense on, mail ingested by the worker isn't searchable there until the next restart backfill (inferred).
  - **The timeout doesn't cancel.** After 120 seconds the main thread gives up and re-parses, but the worker may still write the same message, leaving an extra thread or row.
  - **Duplicated threading logic.** The worker has its own `resolveThread` and payload builder, already different from the main thread's. Two copies of "which thread does this mail belong to" will keep drifting.
  - No account-generation check, so a late job can write mail for an account that was just deleted or re-added.
  - One `error` event marks the worker broken for the life of the process, with no retry.

### 1.9 Schema migrations and startup reclassification — MEDIUM

- **Where.** `db.js` ~418-521 (column-presence checks and the legacy CHECK rebuild), ~569-608 (smart-category reclassification, fingerprint stored in `settings`; `server/services/smart-filter.js` ~15, ~154-156), ~861-872 (plaintext to SQLCipher).
- **States.** The schema version is inferred from which columns exist. There is no version number and no record of which migrations ran.
- **Weak spots.**
  - The legacy CHECK rebuild copies a column list that leaves out `is_draft` and `source_imported`. They come back with defaults, so old drafts become normal mail and every row is marked imported. Only affects old databases.
  - When smart-filter rules change, startup loads every message including its body into memory in one query and rewrites them in one transaction (inferred risk of running out of memory on a large mailbox). It also skips `queueSearch`, so Typesense categories stay stale.
  - A half-applied migration can't be detected.

### 1.10 Smaller server machines — LOW

- **Change version** (`server/services/change-version.js`): an in-memory counter plus a one-row table, merged by max between the main thread and the worker. Sound.
- **SSE event hub** (`server/services/mailbox-events.js`): in-memory sequence and a 64-event replay buffer. A restart resets the sequence; clients see a gap and refetch. Sound.
- **Legacy `drafts` table**: read only for migration, but `prepareDraft` still branches on it.
- **Account create** (`api.js` ~451-484): checks uniqueness, awaits the connection test, then inserts. The UNIQUE constraint is the only backstop for two concurrent creates. PATCH has a proper re-read guard.

---

## 2. Analysis, search and runtime health

### 2.1 Analyzed flag (the agent review queue) — HIGH

- **Where.**
  - Columns `messages.analyzed_at` (null means pending) and `analyzed_by` (`db.js` ~332-333, migrations ~426-427).
  - Derived `threads.unanalyzed_count` (~293, first fill ~433-437, recompute ~1222).
  - Write path: `setState` (~1528-1548). Metering hook: `mail-service.js` ~3239-3252.
  - Writers: MCP `message_action` and `mark_messages_analyzed` (`server/mcp/server.js` ~500-505, ~552-578), REST `POST /messages/:id/analyzed` and `/unanalyzed` (`api.js` ~662-673), and the UI (`src/App.jsx` ~869-912).
- **States.** Unanalyzed (`analyzed_at IS NULL` and `source_imported = 1`), analyzed (with author and time), and a third, unnamed state: envelope-only (`source_imported = 0`), which is neither. When an envelope-only message is hydrated it moves into the queue.
- **Weak spots.**
  - **No claim or lease.** Two agents (an MCC sweep, Duet, any other connector) both list pending mail, both work it and both mark it. Duplicate SITUs and duplicate drafts are the expected result when sweeps overlap.
  - **Five definitions of "unanalyzed".**
    - Sidebar badge: inbox only, not snoozed, excludes `ops_quiet`, counts threads (`db.js` ~1450-1455).
    - `is:unanalyzed` search: thread level, scoped to the current folder (`conversation-search.js` ~471).
    - MCP `list_unanalyzed_messages`: per message, every folder including spam and trash (`db.js` ~918).
    - `threads.unanalyzed_count`: every message in the thread, any folder.
    - The first migration's fill ignores `source_imported`.
    The onboarding screen tells agents to use `is:unanalyzed` (inbox only), while the MCP tool covers all folders. An agent can be "caught up" by one and not by another.
  - **Envelope-only threads show as analyzed**, because the count excludes them and the UI defaults to analyzed when it has no data.
  - **Re-marking rewrites history.** Each mark overwrites the original time and author; with no `by`, the author becomes empty.
  - **Toggling bills twice.** The metering check fires again after analyzed, unanalyzed, analyzed. Copies imported from other folders (1.3) are billed again too.
  - **Thread actions over MCP are capped at 40 messages** (`MCP_MAX_THREAD_ACTIONS`) with no warning, so larger threads stay partly unanalyzed while the call looks successful.
  - `mark_messages_analyzed` applies a batch one row at a time; a row removed mid-batch throws partway and no receipts come back.
  - The review cursor sorts on `received_at`, which re-sync can rewrite, so a message can slip behind the cursor.
- **Suggestion.** Decide which definition "caught up" means, make the others derive from it, and add a claim (`claimed_by`, `claimed_until`) for agent sweeps.

### 2.2 Search-read worker thread — HIGH (inferred timing)

- **Where.** `server/services/search-read.js` (`worker`, `pending`, `seq`), `search-read-worker.js`.
- **States.** Not started, running, killing (after a deadline), errored or exited, and a hidden "orphaned but alive" state.
- **Weak spots.**
  - **A stale exit handler kills the new worker.** The `exit` and `error` handlers set the shared `worker` variable to null instead of checking their own worker. After a deadline, `terminate()` runs asynchronously while the next request starts a new worker. When the old worker's exit fires, it fails the new worker's queries and drops the reference. The new thread is never terminated and keeps its SQLCipher connection. Every later deadline can leak another one.
  - One slow query takes every queued query down with it (`failAll`).
  - The deadline timer starts before the request reaches the single worker, so queued requests time out because of whatever ran before them.
  - No backoff when the worker can't open the database: every request spawns another.

### 2.3 Typesense index sync — HIGH

- **Where.** `server/services/search-engine.js` (`wanted`, `ready`, `stopped`, `tail`, `retryTimer`, `pendingIds`, `removedAccounts`, ~451-457; `flushPending` ~523-535). Wiring: `server/bootstrap.js` ~78-131 and the `queueSearch` calls in `db.js`.
- **States.** Disabled (decided once), backfilling, ready, retrying every 15 seconds after a backfill error, stopped. A per-thread "stale in the index" state exists in practice but is never represented.
- **Weak spots.**
  - **Failed updates are lost (confirmed in code).** `flushPending` clears the pending ids before the network call. A failure is only logged, `ready` stays true and nothing retries. Search then serves stale trash, archive, read and analyzed state until the next restart.
  - **Deletes never reach the index.** A fully deleted thread queues nothing, `replace()` deletes the old row without telling the index, and backfill only adds and updates.
  - **Drafts leak into Inbox and All search.** The index has no `is_draft` field; SQL search excludes drafts.
  - Readiness is never re-checked. If Typesense restarts empty, the collection is recreated empty while `ready` stays true (inferred).
  - Snooze expiry and smart-category changes never re-index the thread.
  - Every search waits behind pending index writes (`await tail`), up to 60 seconds per import batch during a big sync.
  - Bodies pruned by local retention stay in Typesense.
  - Mail written by the ingest worker is never indexed (1.8).
  - Whether mail.xer0.io runs Typesense at all wasn't checked; it is only enabled with an unencrypted database or `AMAIL_SEARCH_ENGINE=typesense`.

### 2.4 Deep-search jobs — MEDIUM

- **Where.** `server/services/deep-search.js` (job `status`, `jobs` map ~121, cleanup ~123-140). Provider calls go through one global `searchChain` (`mail-service.js` ~3234). Routes: `api.js` ~607-627, SSE ~160-186, MCP `server/mcp/server.js` ~230-268.
- **States.** Running (which secretly includes "waiting in the global queue"), complete (which includes partial failure), cancelled, error, evicted (looks like "not found"). A separate progress `phase` can disagree with `status`.
- **Weak spots.**
  - **Cancel can turn into complete.** If cancel lands while the job awaits its last page, the job then sets `complete` and emits a second `done`. Even a normal cancel emits `done` twice.
  - **Eviction aborts without finishing.** The ninth job of an owner evicts the oldest, even while it runs, without a final event.
  - **One human slot for everyone.** Starting a human search cancels every other running human search, across tabs and users.
  - A job queued more than 15 minutes behind `searchChain` is aborted and deleted.
  - Per-account errors are swallowed, so a failed account looks like "no results".
  - A client can set `paceMs = 0` and remove IMAP pacing.
  - Hit ids grow without limit and go into one SQL `IN` list per batch (inferred risk of the parameter limit).
  - Everything is memory only and lost on restart; garbage collection only runs when a new job starts.

### 2.5 Metering batcher — MEDIUM

- **Where.** `server/services/metering.js` (`openCount`, `openSince`, `pending`, `flushing`, `closed`, `timer`, `consecutiveFailures`, ~57-63).
- **States.** Idle, open, sealed, in flight, delivered or requeued, dropped (over 240 batches), closed.
- **Weak spots.**
  - No idempotency key, so a timed-out request that the server actually accepted is sent again (double count).
  - `close()` during an in-flight flush loses counts recorded meanwhile.
  - Memory only: a crash loses everything queued. Retries every 15 seconds forever with no backoff.
  - Over-counting also comes from 2.1.

### 2.6 Event-loop watchdog and `/api/health` — MEDIUM

- **Where.** `server/services/event-loop-watchdog.js`, `runtime-health.js` ~68-70, `api.js` ~209-212.
- **States.** Healthy, lag high, sync stuck, all derived from a histogram window that is reset on read.
- **Weak spots.**
  - Both the one-second interval and every health probe reset the same histogram. After a stall the interval usually reads first, so the probe sees an empty window and reports ok (inferred). Health almost never returns 503 for event-loop lag, so container restarts don't fire when they should.
  - Stuck-sync detection is off in the interval path and only runs when a probe happens to arrive.
  - Long-lived SSE connections always look like stuck requests in stall logs.

### 2.7 SQLite full-text index rebuild — MEDIUM-LOW

- **Where.** `db.js` ~693-763. "In sync" means the FTS row count equals the messages row count.
- **Weak spots.**
  - One row that fails to index (errors are swallowed on purpose) means the counts never match again, so every boot deletes and rebuilds the whole index.
  - A rebuild drops the search terms that retention deliberately kept for pruned bodies, so old-mail search depends on whether a rebuild ever happened.
  - On older SQLite builds the fallback table may reject the plain `DELETE` in the trigger (inferred).

### 2.8 Typesense mode decision (deploy script vs server) — LOW-MEDIUM

- **Where.** `deploy/typesense-mode.sh` ~45-81, `search-engine.js` `resolveSearchBackend` ~79-93, `deploy/launch.sh` ~80-101, `docker-compose.yml`.
- **Weak spots.** The script counts `ENCRYPT_DATABASE=true` as encrypted even without a key; the server needs both. The script never checks that the app's API key matches the container's default key, so search can silently run on SQLite FTS, or retry against Typesense every 15 seconds forever (inferred).

### 2.9 Provider search queue (`searchGeneration`, `searchChain`) — LOW-MEDIUM

- **Where.** `mail-service.js` ~602-604, ~3176-3235.
- **Weak spots.** Every provider search in the process (human, MCP, deep, shallow) runs strictly one at a time, so one long MCP deep search blocks everyone. Deep searches can't be superseded, an IMAP SEARCH in flight can't be interrupted, and envelope rows stored by a cancelled job stay.

### 2.10 Smaller ones — LOW

- **Poller rate limiter** (`server/middleware/poller-limit.js` ~73-91): fixed windows in memory. Any `If-None-Match` header skips the bare limiter. The bearer key is the first 80 characters of the token. MCP `list_messages` isn't limited.
- **Person flags** (`server/services/person-flags.js` ~144-157): each save replaces the whole setting, so concurrent REST and MCP `set_flags` calls lose updates, and a corrupt setting silently becomes an empty list.

---

## 3. Frontend (React app)

### 3.1 Opening a thread and filling in bodies — HIGH (confirmed in code)

- **Where.** `src/App.jsx`: `selectedThread` (~51), `threadLoadRef` (~76), `openThread` (~814-847), `fillMessageBodies` (~793-812), imports (~26). `src/components/ThreadView.jsx` ~217 reads `bodiesPending`.
- **States.** Closed, provisional (the list row), detailed (after `/threads/:id`), hydrated (after each `/messages/:id`), draft (routed to compose).
- **Weak spots.**
  - **Bodies never hydrate.** `fillMessageBodies` calls `normalizeMessage`, which `App.jsx` never imports. The ReferenceError lands in an empty catch ("The envelope stays on screen"). Every envelope-only message (for example deep-search hits) shows only its snippet forever, and attachment pre-download never runs because `bodiesPending` stays true.
  - Opening any unread thread, in any folder, takes one off the Inbox badge, with no rollback if `/read` fails.

### 3.2 Mailbox load and ETag cache — HIGH

- **Where.** `loadMailbox` (`App.jsx` ~308-502), refs ~99-106, `src/mail/mailbox-load.js` ~28-40, `src/api.js` ~19-21 (304 becomes `{ notModified: true }`).
- **States.** Idle, loading, published, not modified, locked, unauthorized, rate limited, offline, demo or fresh setup.
- **Weak spots.**
  - **Sign out then sign in shows an empty mailbox (confirmed in code).** `lockSession` (~1103-1131) empties the thread list but never clears `mailEtagRef`; only the 401 paths do (~474, ~528). On unlock, the reload sends the old ETag, the server answers 304, and `loadMailbox` returns before publishing anything. The list stays empty until new mail arrives.
  - A 304 on a non-silent load returns before resetting deep search, so the deep-search banner sticks (3.6).
  - The 304 shortcut ignores local edits, so optimistic changes that the server never made are never reconciled.
  - **Cold-start failures never recover on their own.** Live sync only starts once a load has succeeded. If the first load fails, you get an offline banner that claims to show "the last mailbox loaded" when nothing was loaded, and no automatic retry. A 429 on the first load shows "Your inbox is clear".

### 3.3 Loading remote images — HIGH (confirmed in code)

- **Where.** `App.jsx` ~980-991, button in `ThreadView.jsx` ~103-111.
- **Weak spot.** The response handler runs `setSelectedThread((current) => update(current))`, and `update` reads `current.messages`. If the reader was closed while the relay request was pending (the relay goes through Tor, so it is slow), `current` is null and the updater throws. There is no error boundary anywhere in `src/`, so the whole app goes blank. There is also no busy state, so a double click sends two requests.

### 3.4 Sign-in, session and lock — HIGH

- **Where.** `App.jsx` ~85-94 (`authRequired`, `authenticated`, `accessOpen`, `accessToken`, `keyMode`, `passkeyCount`, `sessionStamp`), `lockSession` ~1103, `unlockServer` ~1133, `loginWithPasskey` ~1154, `handleLiveSyncUnauthorized` ~527, `src/components/AccessPanel.jsx`, `src/storage.js` ~4-19.
- **Weak spots.**
  - **Sign-out can undo itself.** `lockSession` neither bumps the load request id nor aborts deep search. A load that started before sign-out still passes its staleness check, sets `authenticated` back to true and republishes the mail. A running deep search keeps writing threads into the locked screen.
  - **Escape dismisses the required lock dialog.** The Escape shortcut closes the access panel with no check that it is mandatory. The user is left at a locked, empty app.
  - **Silent reloads reset `passkeyCount` to 0**, because they skip `/session`. When the session later expires, the lock screen shows no passkey button. The same reset clears the unlock form while the user is typing.
  - A token is saved to sessionStorage before it is verified, so a rejected token keeps being sent on later calls (inferred).
  - Two sources of truth for the token: React state and sessionStorage.

### 3.5 Reloads that run stale code after a long sync — HIGH (inferred)

- **Where.** `syncMailbox` (`App.jsx` ~609-641), `accountAdded` (~1243-1264).
- **Weak spot.** Both await a long POST and then call the `loadMailbox` they captured when they started. Press Refresh, switch to Sent, and a few seconds later the old folder's threads are published under the Sent heading. After adding an account, "All inboxes" shows only one account's mail.

### 3.6 Deep search in the UI — MEDIUM

- **Where.** `App.jsx` ~111-115, `beginDeepSearch` ~247-297, `cancelDeepSearch` ~299-306, `commitSearch` ~682-696, `src/components/DeepSearchProgress.jsx`, SSE reader `src/api.js` ~63-96.
- **States.** None, running (job id unknown until `hello`), complete, cancelled, error, or any string the server sends.
- **Weak spots.** Status sticks at running after an abort or a stream that ends without `done`. Every changed silent reload restarts the search and orphans the old server job. Pressing Enter repeatedly, or cancelling before `hello`, leaves server jobs that are never cancelled.

### 3.7 Live sync polling and backoff — MEDIUM

- **Where.** `src/mail/live-sync.js` ~53-172, `App.jsx` ~504-549.
- **States.** Stopped, armed (every 20 seconds focused, 5 minutes visible but unfocused), hidden, running, backing off (2 seconds up to 5 minutes), stopped for auth.
- **Weak spots.**
  - **No fetch has a timeout.** One hung `/changes` or `/messages` request stops live updates until the page is reloaded, and manual Refresh then says "Sync is already running".
  - Change notices are consumed before the reload is attempted, so a refused reload loses the change until the next one.
  - Every alt-tab fires `/changes` twice. The manual sync and the passive tick share one in-flight flag. The offline banner only clears on a successful load.

### 3.8 Compose session — MEDIUM

- **Where.** `App.jsx` ~70-77, ~166-180, `openSavedDraft` ~731-791, `src/components/ComposeModal.jsx` ~37-283, `src/mail/compose-session.js`.
- **States.** Closed; new, reply, reply-all, forward or draft; pristine or dirty; saving, discarding (reuses the saving flag), sending; error; saved with an id; closing.
- **Weak spots.**
  - No autosave and no `beforeunload` guard: closing or reloading the tab loses the message.
  - If the connection drops after the server accepted a send, the modal shows "try again", with no idempotency key (see 1.5).
  - App and the modal track different draft ids, so deleting a draft created in this session doesn't close the composer, and later saves fail against a deleted id.
  - Two detail fetches race for non-imported drafts.

### 3.9 Fresh-draft dismissals (localStorage) — MEDIUM

- **Where.** `App.jsx` ~110, ~419-454, `dismissFreshDraft` ~1078-1084, `src/storage.js` ~42-53, `src/mail/fresh-drafts.js` ~46-74.
- **Weak spots.** `loadMailbox` captures an old copy of the dismissals and writes it back, so recent dismissals return. Pruning is per account but the write is global. A failed `/drafts` call wipes every dismissal. Tabs overwrite each other.

### 3.10 Optimistic mail actions — MEDIUM

- **Where.** `toggleStar` (`App.jsx` ~849-858), `applyAction` (~860-927), `selectedIds` (~52).
- **Weak spots.** No rollback on failure, only a notice. Archive, trash and spam take the whole selection off the unread badge whether or not those threads were unread. Starring from the list replaces the open reader with the list copy and drops loaded bodies. Selected ids aren't reconciled after a reload. Deleting a fresh draft has no double-click guard.

### 3.11 Global keyboard mode — MEDIUM

- **Where.** `handleKeys` (`App.jsx` ~929-978), `src/mail/shortcuts.js` ~28-46.
- **Weak spots.** Enter on any focused button outside compose is cancelled and opens the cursor thread instead, so dialog buttons can't be pressed with Enter. Shortcuts act on the list behind the lock screen, wizard and add-account dialog. A 401 while the account editor is open leaves every shortcut, Escape included, dead.

### 3.12 Toast timer — MEDIUM-LOW

- **Where.** `src/components/ui.jsx` ~62-67, `App.jsx` ~1422.
- **Weak spot.** The close callback is a new function on every render, which restarts the 4.2-second timer, so toasts can stay up indefinitely during activity. One slot for every writer; last one wins.

### 3.13 Attachment downloads — LOW-MEDIUM

- **Where.** `ThreadView.jsx` ~209-301, `src/mail/attachment-download.js`.
- **Weak spots.** Clicked downloads may not be cancellable (the abort controller is only set by the pre-download effect, which 3.1 keeps from running), so they can save a file after the view closes. A refresh of the open thread silently cancels a user's download.

### 3.14 Passkey management in Settings — LOW-MEDIUM

- **Where.** `src/passkeys.js` ~49-75, `App.jsx` ~1165-1181, `src/components/SettingsPanel.jsx` ~161-178.
- **Weak spots.** Errors are never shown (no catch). Registration runs two ceremonies; cancelling the second leaves a server passkey that can't unlock, and the UI list isn't updated.

### 3.15 Smaller UI machines — LOW

- **Account connect form** (`src/components/AccountConnectForm.jsx` ~65-199, `AddAccountModal.jsx` keeps a second copy of the step): any error without protocol details, such as "already connected", shows "IMAP failed, SMTP failed".
- **Account editor** (`EditAccountModal.jsx`): well guarded. Escape discards a dirty form without asking, and a save closes the open conversation.
- **Onboarding wizard** (`OnboardingWizard.jsx` ~244): Close isn't disabled while an account is being added; the step resets to 0 if the wizard unmounts.
- **Signature save** (`SignatureEditor.jsx`, `App.jsx` ~1183-1209): two quick saves can resolve out of order; a failed save resets the editor and erases the edit.
- **Flagged-people editor** (`PersonFlagsEditor.jsx` ~44-48): unsaved edits are dropped when Settings closes.
- **Open and close animation** (`src/mail/presence.js`): state set during render from a ref; fragile under StrictMode in development (inferred).
- **UI prefs and token storage** (`src/storage.js`): read once at mount, no cross-tab sync.

---

## 4. Auth, vault, credentials and deploy

All store transitions here are synchronous within one process, so real races need two processes at once, which the deploy handoff creates on purpose, or an `await` in the middle of a flow.

### 4.1 Harness first-time setup (uninitialized, initialized, unlocked) — HIGH (confirmed in code)

- **Where.** `server/services/keyslots.js` ~232 (`initialized` means "there is at least one slot"), `server/vault.js` ~261-271 (`init`), `server/routes/keyslots.js` ~20-36.
- **Weak spots.**
  - **Not atomic.** `init` writes the token slot, then the recovery slot, then opens the database. If the open throws (disk full, bad volume), the slots stay written, the response is a 500, and the token and recovery code are never shown to anyone. Every later init refuses with `HARNESS_ALREADY_INITIALIZED`. The install is stuck.
  - **Losing `keyslots.json` resets "initialized".** A re-init mints a fresh key that can't open the existing encrypted database, and the new slots are already saved, so the install is bricked until someone deletes the file by hand.
  - No cross-process lock between two provisioners (inferred).

### 4.2 Connector OAuth grants — HIGH (confirmed in code)

- **Where.** `server/services/oauth-store.js` (`oauth.json`), `server/services/oauth-provider.js` (`issueTokens` ~323-362, `refreshAccessToken` ~384-411, `verifyAccessToken` ~420-426, `revoke` ~428-431). In keyslot mode each token also gets a hidden keyslot (~308-321).
- **States per token.** Active, expired, consumed, revoked. The hidden keyslot has its own present or removed state.
- **Weak spots.**
  - **The owner can't revoke a connector.** The hidden slots are filtered out of every owner-facing list, `oauth.json` has no API, and Settings has no control. Each refresh mints a new 30-day refresh token, so a grant lives forever while the client keeps refreshing.
  - **In env mode, rotating `AMAIL_ACCESS_TOKEN` doesn't touch OAuth grants** (`verifyAccessToken` returns true outside keyslot mode).
  - **No refresh-reuse detection.** A replayed refresh token only gets "already used"; the tokens descended from it stay live.
  - Two parallel refreshes: the second gets `invalid_grant` and the connector drops. Any failure after the consume step burns the grant.
  - Expiry is stored twice (in `oauth.json` and on the slot); the vault never checks the slot copy, and pruning only runs on issue. Abandoned wrappers stay in `keyslots.json` and still decrypt the database offline for anyone holding the token and the file.

### 4.3 Cross-process writes to `keyslots.json` and `oauth.json` — MEDIUM (inferred)

- **Where.** `keyslots.js` ~214-228, `oauth-store.js` ~80-94. The overlap comes from the deploy handoff (`server/handoff.js` ~6-25, `bootstrap.js` ~164-178).
- **Weak spots.**
  - During a deploy, old and new processes both serve and both do read-modify-rename with no lock. One can overwrite the other: an issued token loses its slot (401), or a consumed refresh token reappears.
  - The keyslot temp file name uses only the process id (`${filePath}.${process.pid}.tmp`, confirmed). Two containers sharing a volume usually have the same pid, so they can write the same temp file and rename a torn `keyslots.json`, which locks the tenant out entirely. The OAuth store adds random bytes; the keyslot store does not.

### 4.4 Vault locked or unlocked — HIGH (confirmed in code)

- **Where.** `server/vault.js` ~110-185 (`dek`, `runtime`, `unlockedAt`, `unlockedVia`), lock route `routes/keyslots.js` ~75-79.
- **Weak spots.**
  - **A lock doesn't hold.** `authenticateToken` unlocks the vault whenever any matching bearer token arrives, including an OAuth access or refresh wrapper (`if (!isUnlocked()) unlockWithDek(...)`, ~233). That contradicts the comment a few lines above it saying OAuth tokens must not unlock. The next MCP call after the owner presses Lock silently re-opens the mailbox. A restart re-unlocks from escrow regardless. Nothing records "the owner locked it; stay locked".
  - `lock()` doesn't wait for the old runtime to close, so an immediate re-unlock can build a second database connection, sync worker and IMAP pool while the first is still tearing down (inferred).
  - Decrypted in-memory state (deep-search results, the event hub) survives a lock.

### 4.5 Keyslots: add, use, remove, recovery code — MEDIUM

- **Where.** `keyslots.js` ~240-276, `vault.js` ~256-333.
- **Weak spots.**
  - **Removing a slot is not real revocation.** The data key never rotates. Any older copy of `keyslots.json` (for example the volume backup `tools/backup.js` tells operators to take) plus the removed credential still unlocks the database.
  - The recovery code is "shown once" but never consumed or rotated after use.
  - Contradictory slot shapes are representable (hidden without oauth, oauth without hidden), and "has credentials" means different things to `initialized()` and the remove guard.

### 4.6 Browser session (keyslot mode) — MEDIUM

- **Where.** `server/middleware/auth.js` ~86-137 (in-memory `sessions` map).
- **Weak spots.** The session records which slot created it but never checks it, so removing a compromised passphrase leaves its browser sessions alive for up to 12 hours. Passkey sessions store no slot at all. Sessions are lost on restart.

### 4.7 Self-hosted auto-update and rollback — MEDIUM

- **Where.** `deploy/autoupdate.sh` (git `HEAD` plus `.git/amail-autoupdate-failed`), `amail-autoupdate.service`.
- **Weak spots.**
  - "Deployed" is inferred from `HEAD`, which moves before the build and health check. If the run is killed after checkout (the 15-minute systemd timeout, a reboot, out of memory), the previous version is lost and the next run sees "up to date" and exits, never checking health or rolling back.
  - A failed rollback is a terminal, silent state: later runs see the marker and exit 0.

### 4.8 Mail-account credentials and health — MEDIUM

- **Where.** `accounts.credential_ciphertext` (`db.js`), `server/services/account-input.js` ~35-69, `buildAuth` in `server/utils/mail.js` ~243-265, cooldown in `mail-service.js`.
- **Weak spots.**
  - A stored OAuth token always beats a password, and a PATCH that sets only the IMAP or SMTP password keeps the old token, which still wins.
  - No refresh or expiry handling for IMAP/SMTP OAuth tokens.
  - **No "needs reconnect" state.** Auth failures retry every 15 minutes forever and aren't stored, which can trigger provider lockouts, and the user never sees a clear "reconnect this account".

### 4.9 Smaller auth machines — LOW

- **Deploy key handoff** (`server/handoff.js` ~141-211): the handed-over key isn't checked against any slot, so with a missing database a wrong key creates a new database nothing can reopen (inferred). A fast lock then unlock can delete the new socket, so the next deploy comes up locked.
- **OAuth authorization codes** (`oauth-provider.js` ~218-293): single use, which is good. Transactions are memory only, so a deploy mid-consent fails it; expiry uses wall-clock string comparison.
- **Passkey pending vs linked and WebAuthn challenges** (`server/services/passkeys.js` ~85-105): an authenticator without PRF leaves a passkey pending forever; the challenge map has no cap.
- **Env-mode startup and encryption mode** (`server/config.js` ~56-95): no `ACCESS_TOKEN` opens everything (`npm start` outside Compose); changing `ENCRYPTION_KEY` boots fine and then every account fails to decrypt; the remote-content key defaults to the credential key.
- **Env-mode browser session** (`auth.js` ~52-77): the cookie is the static access token, so logout logs nothing out on the server.

---

## Suggested order of fixes

1. Make remote moves durable and reversible: an outbox with retry for placement changes, and undo that moves mail back on the server (1.1).
2. Fix snooze: clear the archive flag on wake (or don't set it), and make `snoozedUntil: null` clear the field (1.2).
3. Apply CONDSTORE flag changes on every pass and detect expunges (1.3).
4. Add an owner-visible list and revoke for connector grants, and stop OAuth tokens from unlocking a locked vault (4.2, 4.4).
5. Make harness init atomic (write slots only after the database opens) (4.1).
6. Serialize draft save with Drafts reconcile (1.4).
7. One-line frontend fixes: import `normalizeMessage` (3.1), clear the ETag on sign-out (3.2), null-check in `loadRemoteContent` and add an error boundary (3.3), bump the load id in `lockSession` (3.4).
8. Agree on one meaning of "unanalyzed" and add a claim for agent sweeps (2.1).
