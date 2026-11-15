# Attachments for agents

Status: implemented on branch `claude/project-thread-yr9x84` (November 2026).
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
- Up to 500 PDF pages and 5 million characters of text per file.
- ZIP parts of Office files are read by a small reader in
  `server/services/zip-reader.js` that refuses ZIP64, encryption and any entry
  that inflates past its declared size or 16 MB (zip bombs).
- Results are cached in memory for 10 minutes (16 files / 64 MB of bytes,
  32 texts / 8 M characters), so paging through a long PDF fetches and parses
  it once. Failures are never cached.
- Rendered pictures: longest side 1600 px by default (200 to 2400), at most
  12 megapixels and 3.5 MB.
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
