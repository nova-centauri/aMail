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
     the new UID and keeps its id. It is downloaded again in the same pass;
     its editable HTML is kept only if the server copy's HTML (or text, for
     a text-only draft) is unchanged, since another client may have edited
     it under the same Message-ID. Only unmatched rows are dropped.
   - With CONDSTORE, a changed HIGHESTMODSEQ runs the reconciliation even
     when the message count and UIDNEXT look unchanged, which is what a
     draft renumbered below the cursor looks like.
   - Live UIDs at or below the sync cursor that aMail has no row for are
     imported in the same pass, newest first and within the account's
     per-pass message budget; the rest wait for the next pass. One that
     still cannot be imported is recorded in `sync_skips` so it is not
     downloaded on every sync.
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

## Attaching files by URL (November 2026)

Problem: `save_draft` took attachments only as inline base64. A 200 KB quote
PDF is about 270,000 characters, too big to pass through an agent's tool call,
so quote PDFs had to be attached to drafts by hand. A second gap: on an update,
`attachments` replaced the whole list, so adding one file meant restating every
file already on the draft, and forgetting one silently dropped it.

What changed:

1. **`{ url }` attachments.** Any item in `attachments` or `addAttachments`
   may be `{ url, filename?, contentType? }` instead of `{ content }`. The
   aMail server downloads the file (`server/services/attachment-fetch.js`)
   and it then goes through the normal attachment path (8 files, 8 MiB).
   Filename: the caller's, else the response's `Content-Disposition`, else the
   last URL path segment.
2. **`addAttachments`.** Appends files to the draft's current list. Files
   already on the draft keep their bytes (from aMail's copy, or fetched from
   the server copy for a draft written in Gmail or Apple Mail, as before), and
   body, subject and recipients are kept because omitted fields always are.
   `attachments` still means "the whole list" (`[]` removes all).
3. **Order of work.** The draft, account and write policy are checked first,
   then URLs are downloaded outside the per-account draft lock, then the save
   runs as before. A failed download saves nothing.

Network rules for the download (SSRF protection):

- Off unless `AMAIL_DRAFT_ATTACHMENT_URL_HOSTS` lists hosts (comma-separated;
  `*.example.com` matches subdomains, not `example.com`). IP literals are not
  accepted as entries or as URL hosts.
- https only, port 443 only, no `user:pass@`.
- Every address the host resolves to must be public unicast: loopback,
  RFC 1918, CGNAT, link-local (including 169.254.169.254 metadata), multicast,
  reserved, documentation, ULA, NAT64 and 6to4 ranges are refused, IPv4-mapped
  IPv6 included. The socket connects to the address that was checked, with no
  second DNS lookup, so DNS rebinding cannot swap in an internal address.
- At most 3 redirects; each hop must pass the same rules, so an allowed host
  cannot bounce the fetch to an unlisted or internal one.
- 8 MiB cap (declared length and while streaming), 20 s deadline
  (`AMAIL_DRAFT_ATTACHMENT_FETCH_TIMEOUT_MS`).
- An HTML response is refused as "a web page instead of a file" (usually a
  sign-in page or an expired link). A file typed or named as a PDF must
  contain `%PDF-` in its first KB.
- `AMAIL_DRAFT_ATTACHMENT_URL_AUTH` (JSON, host to headers) adds headers such
  as an API token, sent only to that exact host and never to a redirect
  target on another host. The token stays on the aMail server; agents only
  ever pass the URL.
- Errors name the host, never the query string (signed URLs carry tokens) or
  the remote body. The log line records host, size and type only.

How an agent attaches a PDF:

```json
{ "draftId": "<id>",
  "addAttachments": [{ "url": "https://quotes.example.com/q/1042.pdf", "filename": "Quote 1042.pdf" }] }
```

Error codes: `ATTACHMENT_URLS_DISABLED` (no allowlist),
`ATTACHMENT_HOST_NOT_ALLOWED`, `ATTACHMENT_URL_BLOCKED` (scheme, port or
credentials), `ATTACHMENT_URL_PRIVATE_ADDRESS`, `ATTACHMENT_URL_DNS_FAILED`,
`ATTACHMENT_URL_HTTP_ERROR`, `ATTACHMENT_URL_NOT_A_FILE`,
`ATTACHMENT_URL_TYPE_MISMATCH`, `ATTACHMENT_URL_EMPTY`, `ATTACHMENT_TOO_LARGE`,
`ATTACHMENT_URL_TIMEOUT`, `ATTACHMENT_URL_TOO_MANY_REDIRECTS`,
`ATTACHMENT_URL_FAILED`.

Decisions:

- D6. Server-side URL fetch, not an upload endpoint. Agent sessions often
  cannot reach the aMail host directly (the private install sits behind a
  proxy that refuses them), and an upload still needs the bytes to pass
  through the agent. A URL is a few dozen characters.
- D7. No MCC blob references. MCC's `blob_upload` also takes base64 (1 MiB
  max) through a tool call, so it has the same size problem, and its blobs
  have no fetch address aMail could use. If MCC gains a fetchable blob URL,
  listing its host in the allowlist is enough.
- D8. Allowlist off by default, including hosted mode. A fetch-any-URL
  feature on a mail server is an SSRF tool; the operator opts in per host.
- D9. `addAttachments` instead of changing what `attachments` means, so
  existing callers (the composer sends the full list) behave as before.

Known limit: an update builds on aMail's latest synced copy of the draft. If
the draft was edited in another client in the last few minutes and aMail has
not synced Drafts since, run `sync_mail` for that account first. Otherwise
aMail's new version does not include those edits, and because the old UID no
longer matches, the other client's version is left in place too (reported as
`replaced: "kept"`), so Drafts ends up with two copies.

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
