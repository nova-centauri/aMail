# Drafts on the mail server

Status: implemented on branch `claude/project-thread-f275ce` (October 2026).
Owner decision that started it: aMail should not keep drafts of its own; it
should use the Drafts folder that already exists on each account's mail server.

## How aMail stores mail today (the map)

**Accounts** (`accounts` table, `server/db.js`). One row per mailbox: email,
provider preset (`gmail`, `icloud`, `mailinabox`, `custom`, …), IMAP and SMTP
host/port/TLS, signature, and `credential_ciphertext` (an app password or OAuth
access token, encrypted with the instance key). Every provider, Gmail included,
is reached over plain IMAP + SMTP through ImapFlow and Nodemailer; there is no
Gmail REST API path. `buildAuth` (`server/utils/mail.js`) picks password or
XOAUTH2 per protocol.

**Messages** (`messages` table). The local cache of what sync imported, keyed
by `(account_id, mailbox, uid)` with the RFC `Message-ID`, `In-Reply-To` and
`References`. Sync (`createMailService` → `syncMailbox`) discovers mailboxes by
IMAP special-use (`discoverSyncMailboxes`) with name fallbacks: Inbox, Sent,
Drafts, Archive (or Gmail's All Mail), Trash, Junk. Rows from the Drafts
mailbox get `is_draft = 1`. Sync is incremental by UIDNEXT/MODSEQ and, before
this change, never removed a row when the server expunged a message.

**Threads** (`threads` table). Grouped by `In-Reply-To`/`References`, with a
subject fallback for replies only.

**Drafts before this change** (`drafts` table, `server/services/drafts.js`).
`save_draft`, `POST/PATCH /api/drafts` and the composer's Save button wrote a
local row (`id` a UUID, no Message-ID, no reply headers, attachments as base64
JSON). Nothing reached the server, so a draft saved by an agent never showed in
Gmail or Apple Mail. Editing a provider draft made a second, local copy. The
Drafts folder in the UI merged both sources (`listStoredDrafts`).

## What changed

1. **Save = IMAP APPEND to the account's Drafts mailbox.**
   `mailService.saveDraft(input, draftId)`:
   - `prepareDraft` (pure) validates, merges the update over the existing
     draft, and works out reply headers: explicit `replyToMessageId`, else what
     the draft already carries, else the newest real message in `threadId`.
   - Compiles RFC 822 with Nodemailer (same compiler as send). Unlike a sent
     message the draft keeps its `Bcc:` header, since only the owner's server
     holds it and the client that sends it needs the list. No signature is
     added; send adds it.
   - Finds the Drafts mailbox by `\Drafts` special-use, then by name, and
     creates `Drafts` if neither exists.
   - `APPEND` with flags `\Draft \Seen`. UID from `APPENDUID` (UIDPLUS); without
     UIDPLUS, `UID SEARCH HEADER Message-ID`.
   - On update, expunges the version it replaced (`STORE \Deleted` +
     `UID EXPUNGE`), but only if the old UID still holds the old Message-ID.
     A stale UID is left alone and reported as `replaced: "kept"`.
   - Writes the local row in place (`messages.replace`), so the draft id stays
     stable across saves. A new draft is upserted like a synced message.
   - Keeps the editable HTML in `draft_compose_html` (keyed by message id,
     deleted with the row). `messages.html_body` is the display copy, with
     styles removed and remote images made inert, so the composer gets the
     editable HTML back instead and formatting survives repeated saves.
     Drafts written by other clients have no entry and open from the display
     copy, as before.
   - If the server refuses, nothing is stored locally and the caller gets
     `DRAFT_SAVE_FAILED` (no upstream text, which can carry credentials).
     Accounts in `IMAP_WRITE_PROTECTED_ACCOUNTS` cannot save drafts.
2. **Attachments carry over.** Bytes aMail wrote are kept in the row. For a
   draft written by another client, bytes are fetched from the server copy
   before the rewrite, through the strict attachment path (same mailbox,
   UIDVALIDITY, UID, Message-ID and MIME part as the cached row). If a file
   cannot be fetched or verified, the save fails rather than dropping it or
   copying another message's file into the draft. Files over 8 MiB on a draft
   written by another client cannot be carried over this way.
3. **Send retires the draft.** `send_message` / `POST /api/messages` with
   `draftId` removes the server copy (same Message-ID guard) after SMTP accepts.
4. **Drafts reconciliation in sync.** For the Drafts mailbox only, a sync pass
   compares local draft UIDs with `UID SEARCH ALL` and drops local rows the
   server no longer has (sent, discarded or superseded in another client). It
   runs only when the STATUS message count disagrees with the local count or
   new UIDs exist, skips on a UIDVALIDITY change, and only deletes aMail's
   cache rows, never server mail. Before this, every Gmail autosave version
   stayed in aMail's Drafts folder forever.
   - A local draft whose UID is gone is first matched by Message-ID against
     live UIDs aMail does not know (newest 500). On a match the row moves to
     the new UID and keeps its id and editable HTML; only unmatched rows are
     dropped.
   - Live UIDs at or below the sync cursor that aMail has no row for are
     imported in the same pass. One that still cannot be imported is
     recorded in `sync_skips` so it is not downloaded on every sync.
   - Why: Gmail renumbers drafts. On the first live save (Oct 29) a draft
     APPENDed at one UID left it within seconds; the reconcile dropped the
     row, and the UIDNEXT pass had already moved its cursor past the UID the
     draft came back at, so aMail never saw it again although Gmail still
     had it. Which of the two (renumbered and visible, or visible only
     later) happened there is inferred from the sync results, not from
     server logs; the fix covers both.
5. **Migration of local-only drafts.** `mailService.migrateLocalDrafts`, exposed
   as MCP `migrate_local_drafts` and `POST /api/drafts/migrate-local`. Dry run
   is the default and touches no mail server: it lists id, account, subject,
   recipient and attachment counts. `dryRun: false` saves each one through the
   same `saveDraft` path and removes the local row on success. Opening and
   saving an old local draft in the composer migrates it too.

The `drafts` table stays in the schema only so the migration can read it.
Nothing writes to it any more.

## Provider notes

- **Gmail**: `[Gmail]/Drafts` carries `\Drafts`. An APPENDed message there is a
  real Gmail draft (it appears in the web UI and apps). Replies thread in Gmail
  by `References`/`In-Reply-To` plus subject. Expunging a superseded draft from
  `[Gmail]/Drafts` follows the account's "When a message is marked as deleted
  and expunged" IMAP setting, so Gmail may archive or trash the superseded
  version instead of deleting it. Check this on the first live save.
  Gmail also moves drafts to new UIDs on its own, sometimes seconds after an
  APPEND; the Drafts reconciliation follows them by Message-ID.
- **iCloud**: `Drafts` with `\Drafts`; UIDPLUS supported.
- **Mail-in-a-Box / Dovecot**: `Drafts` with `\Drafts`; UIDPLUS supported.

## Rollout (needs the owner's yes at each step)

1. Review and merge the PR.
2. Deploy to the private install. On first sync, the Drafts reconciliation
   removes local rows for drafts that are no longer on the server. Expect the
   Drafts view to shrink a lot on accounts with Gmail autosave history.
3. Run `migrate_local_drafts` with the default dry run and review the list
   of local-only drafts.
4. Run it with `dryRun: false`, then confirm the drafts show in each account's
   own Drafts folder.

## Decisions

- D1. IMAP APPEND for every provider, including Gmail. aMail has no Gmail API
  path and Gmail's IMAP Drafts folder creates real drafts. One code path.
- D2. Replace, not edit: IMAP has no in-place edit, so each save is APPEND new
  + expunge old, guarded by Message-ID. A fresh Message-ID per version keeps
  the no-UIDPLUS lookup unambiguous.
- D3. Fail the save when the server is unreachable instead of falling back to
  a local copy. A silent local fallback is exactly the bug this fixes. The
  composer keeps the text open and shows the error, so nothing is lost.
- D4. Create `Drafts` when the account has no drafts mailbox, as other clients
  do, instead of refusing.
- D5. No signature in drafts (unchanged behaviour). Open question: drafts sent
  from another client (Gmail web, Apple Mail) will not carry the aMail
  signature. An `includeSignature` option on `save_draft` would fix that but
  would double the signature when the same draft is later sent from aMail.
