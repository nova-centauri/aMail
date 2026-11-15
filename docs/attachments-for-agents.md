# Attachments for agents

Status: live since PR 55 (November 2026); the large-message follow-up is at the end.
Owner request that started it: agents had poor access to attachments; open up
agentic access so an agent can download a file like a PDF and read it.

## What was wrong

Reproduced on the private install with a real 1.5 MB quote PDF:

1. **`get_attachment` was the only way in, and it returns base64.** The PDF
   came back as 2,116,727 characters of JSON. Claude's connector refuses a tool
   result that large, so a chat agent could not read the file at all. A shell
   agent could decode it, but only by saving the oversized result to disk
   first. Nothing turned a PDF into text.
2. **The ids from `list_messages` did not work with `get_message`.** Each row
   is a conversation and its `id` is the thread id. `get_message` with that id
   said only "Message not found.", and rows carry `hasAttachments: true` with
   an empty `attachments` array, so the attachment index was never visible.
3. `has:attachment` searches over a whole account hit the query deadline
   (separate issue, not changed here).

## What agents can do now

| Need | Tool | Returns |
| --- | --- | --- |
| Read what a file says | `read_attachment { id, index, offset?, page?, maxChars? }` | Text in windows (default 20,000 characters, max 100,000), with `totalChars`, `nextOffset`, `truncated`, `pageCount`, `firstPage`/`lastPage`, `kind`, `sha256`. |
| See a page or a picture | `view_attachment { id, index, page?, maxDimension? }` | MCP image content: a PDF page rendered to PNG (JPEG if large), or the image attachment scaled so the longest side is at most 1600 px. |
| Get the original file | `get_attachment_link { id, index, minutes? }` | An https URL on the server's public origin that downloads the bytes, valid 5 minutes by default, 10 at most. |
| Exact bytes in the result | `get_attachment` (unchanged) | Base64, for scripts and small files. |

Readable types for `read_attachment`: PDF (`[Page N of M]` markers), Word
`.docx`, Excel `.xlsx` (one tab-separated row per line, `[Sheet N of M: name]`
markers; dates stay Excel serial numbers), PowerPoint `.pptx` (`[Slide N of M]`),
HTML, plain text, CSV, JSON, XML, iCalendar and forwarded `.eml` (headers, body,
and the names of files inside). The type is decided by magic bytes first, then
the declared type and file name, since both come from the sender. A PDF with
almost no text reports `noTextLayer: true` (a scan): use `view_attachment`.

How an agent finds the index: `get_message` or `get_thread` list each
message's `attachments` with `index`. A `list_messages` row is a conversation;
use its `latestMessageId` with `get_message`, or its `id` with `get_thread`.
`get_message` given a thread id now says so instead of a bare not-found.

## Defaults and limits (chosen in this change)

- 8 MiB per file, the same strict, metadata-checked IMAP fetch as
  `get_attachment` (exact index, UID and Message-ID checks; no upstream detail
  in errors).
- Parsing runs in a fresh `worker_threads` worker per job: 384 MB heap cap,
  30-second timeout, at most 2 jobs at once. A hostile or huge file kills its
  worker, not the server. PDF.js runs with eval disabled, no font loading from
  the system, no network, XFA off.
- Up to 500 PDF pages and 5 million characters of text per file. When either limit cuts
  a file short, the result says `incomplete: true` with a note, so an agent never takes
  part of a file for all of it.
- ZIP parts of Office files are read by a small reader in
  `server/services/zip-reader.js` that refuses ZIP64, encryption and any entry
  that inflates past its declared size or 16 MB (zip bombs).
- Results are cached in memory for 10 minutes (16 files / 64 MB of bytes,
  32 texts / 8 M characters), so paging through a long PDF fetches and parses
  it once. Failures are never cached.
- Rendered pictures: longest side 1600 px by default (200 to 2400), at most
  12 megapixels and 3.5 MB.
- Pictures larger than 25 megapixels are refused from their header before
  decoding (decoded bitmaps use native memory the worker's heap cap does not
  cover), and PDF.js skips embedded images above the same size.
- Nothing here syncs, marks mail read or analyzed, or changes a mailbox.

New dependency: `pdfjs-dist` (Mozilla PDF.js) for PDF text and rendering. It
pulls `@napi-rs/canvas` as an optional dependency for rendering; if that
native module is missing, text reading still works and `view_attachment`
returns `ATTACHMENT_RENDER_UNAVAILABLE` (small image attachments still come
back as-is).

## The download link

`get_attachment_link` reuses the encrypted capability token and the
`/api/content/attachment` route the web client already uses for attachment
downloads. The token is AES-256-GCM encrypted with the instance's remote-token
key, names one message id and one attachment index, and carries its expiry.
Agent links add `d: 1`, which makes the route:

- re-verify the exact attachment with the strict fetch, and
- always answer `Content-Disposition: attachment` (never inline), with
  `Cache-Control: private, no-store`, `nosniff`, and `Referrer-Policy: no-referrer`.

Tradeoffs to know:

- **Not single-use.** Anyone holding the URL can download that one file until
  it expires (at most 10 minutes). The tool description tells agents to pass
  it only to the tool that downloads it, never into chat, drafts or notes.
- **The token is in the query string.** aMail's own logs strip query strings,
  but a reverse proxy in front of aMail may log full URLs. Turn that off for
  `/api/content/attachment` (for example nginx `access_log off;` in that
  location) if the proxy logs are kept or shipped anywhere.
- Needs `AMAIL_ORIGIN` (already required for the Claude connector) so the link
  points at the public address. In keyslot mode links work only while the
  vault is unlocked.

## Large messages and 0-byte attachments (follow-up)

Found on the private install: a school newsletter with a large Canva PDF
showed its file at 0 bytes and every attachment tool said "attachment
unavailable", in three copies (INBOX, All Mail, Important). An earlier one
from the same sender was missing from aMail altogether.

Why:

1. **Sync skipped every message larger than `AMAIL_SYNC_MAX_MESSAGE_BYTES`
   (10 MiB by default) without saving anything**, only counting it as
   `IMAP_MESSAGE_TOO_LARGE`. The earlier newsletter's UID is simply absent.
2. A search (deep search or `in:anywhere`) later saved the newer one as an
   envelope-only row: no body, and files named from BODYSTRUCTURE with
   `size: 0` and `application/octet-stream`.
3. Opening it tried to download the full source, which was over the cap, so it
   quietly stayed empty. The strict attachment fetch then refused it twice
   over: the source was over its 12 MiB cap, and the stored 0-byte metadata
   could never match the real file. Every failure surfaced as the same
   `ATTACHMENT_UNAVAILABLE`.

What changed:

- **Large mail is imported in parts.** Sync, opening a message and repair
  fetch headers, BODYSTRUCTURE and the first plain and HTML body parts (up to
  1 MiB each, `BODY.PEEK`, mailbox opened read-only). The file list keeps each
  file's IMAP part number, real type and a decoded-size estimate. These rows
  read like any other message and join the not-yet-analyzed queue. If the
  server lists a body part but does not deliver it, the row stays incomplete
  (out of the queue) so opening it or the repair tool tries again. These
  imports count against the per-account sync budget like any other.
- **Files download by part.** For a row without its full source, the
  attachment tools fetch BODYSTRUCTURE, check the UID, Message-ID, part number
  and filename against the cached row, and download that one part. A file is
  refused early only when its encoded size proves it is over the limit
  (quoted-printable can be three times its decoded size); otherwise the
  decoded download enforces the limit exactly. Nothing
  else in the message is downloaded. Rows a search saves now list each file's
  real type, part and estimated size instead of 0 bytes.
- **Readable size is 25 MiB.** `read_attachment`, `view_attachment` and
  `get_attachment_link` take files up to 25 MiB (Gmail's whole-message cap).
  `get_attachment`, which returns base64 inside the tool result, stays at 8 MiB.
- **Errors say what happened** with fixed codes and sentences only:
  `ATTACHMENT_TOO_LARGE` (as a validation error), `ATTACHMENT_NOT_ON_SERVER`,
  `ATTACHMENT_IDENTITY_UNVERIFIED`, `ATTACHMENT_IMAP_UID_MISSING`,
  `ATTACHMENT_SOURCE_UNAVAILABLE`, `ATTACHMENT_IMAP_FAILED`, else
  `ATTACHMENT_UNAVAILABLE`. Nothing from the server or parser is passed on.
- **`repair_incomplete_messages`** counts envelope-only rows per account
  (`dryRun`, the default) and re-imports up to 25 per call, newest first. With
  `includeSkipped` and an `accountId` it also runs `SEARCH SINCE <sinceDays>
  LARGER <cap>` in each synced mailbox (not Trash or Spam) and imports the
  UIDs sync already moved past without saving. On a Gmail All Mail mirror,
  copies aMail already holds under another mailbox are not counted.

Not changed: copies of one Gmail message saved from several label folders by a
search (INBOX, All Mail, Important) stay separate rows.
