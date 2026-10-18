# GET /api/events — mailbox SSE

Omarchy aMail bar plugin `io.github.nova-centauri.amail` v0.2.0 (`daemon.mjs`, User-Agent `node`) polls `GET /api/messages` every `pollSeconds` (default 10) and `POST /api/sync` every `syncSeconds` (default 45) **unless** `GET /api/health` lists `events` in `features`. This stream is that signal.

## Discovery

`GET /api/health` is unauthenticated (container probes). Capability flags only; no accounts or mailbox contents. The handler does not query SQLite or take mailbox/IMAP locks — it must answer while a long IMAP pass is on the event loop.

```json
{
  "status": "ok",
  "features": ["events"]
}
```

`features` includes `idle` only when the server’s background receipt plan is on (`SYNC_INTERVAL_MINUTES` > 0). The plugin then skips its `POST /api/sync` nudge. Env-mode installs default that interval to 0, so they advertise `events` only and the plugin still nudges sync; HTTP now returns 202 and the IMAP pass is single-flighted in the background.

## Auth

Same gate as the rest of `/api` (everything except `/api/health` and a few tokenized `<img>` routes).

The plugin sends **no cookies**. It authenticates with the env-mode access token (or a keyslot token) as a bearer:

```
GET /api/events HTTP/1.1
Authorization: Bearer <AMAIL_ACCESS_TOKEN>
Accept: text/event-stream
Last-Event-ID: 12
```

`Last-Event-ID` is optional. A browser session cookie is also accepted, but the plugin does not use it. Missing/wrong credentials return `401` `{ "error": { "code": "AUTH_REQUIRED" } }` with JSON, not a stream.

## Wire format

Standard Server-Sent Events. Each event is:

```
id: 12
event: <name>
data: <json>

```

Heartbeats are comment frames so proxies and the plugin’s quiet-stream watchdog stay alive:

```
: heartbeat

```

Default heartbeat is **20s**. The plugin aborts a quiet stream after 60s (`hello` resets that to `max(30s, heartbeatMs * 3)`). Comment frames reset it to 60s; named events reset it to 75s.

Reconnect: exponential backoff **2s → 60s**. On drop, the plugin refreshes the list once, then reconnects with `Last-Event-ID` set to the last numeric `id` it saw. If that id is no longer in the server’s ring buffer (64 events), `hello.gap` is `true` and the plugin refetches.

## Event names

Two naming sets are emitted together so this server matches both the plugin’s `daemon.mjs` switch and the operator-facing names.

| Name | When | JSON payload |
| --- | --- | --- |
| `hello` | On every connect | `{ heartbeatMs, gap, changedAt }` |
| `change-version` | listing content stamp (`messageAt` / `accountAt`) moved | `{ changedAt }` |
| `new-mail` | `messages.updated_at` max moved | `{ changedAt }` |
| `message.new` | same as `new-mail` (plugin) | `{ changedAt }` |
| `sync-status` | global sync `inFlight` flipped | `{ changedAt, state, inFlight? }` |
| `sync.mailbox` | same as `sync-status` (plugin) | `{ changedAt, state?, inFlight? }` |
| `account.updated` | `accounts.updated_at` max moved | `{ changedAt }` |

`state` on sync events is `started` / `done` for in-flight transitions. Cursor-only `sync_state.synced_at` progress does **not** emit and does **not** bump the listing/`changedAt` stamp the plugin uses to refetch. `changedAt` on these events is `max(messageAt, accountAt)` — the same value hashed into the `/api/messages` ETag — not the raw `repos.changes.stamp().changedAt` (which also tracks the IMAP cursor).

Named refetch events are coalesced: the first burst in a quiet window goes out immediately, then at most one flush every **15s**. Writers push stamp changes; the hub does not poll SQL on a timer.

The plugin treats `message.new`, `message.state`, `message.sent`, `sync.mailbox`, and `account.added|removed|updated` as “refetch the inbox list”. Unknown names (including `change-version` / `new-mail` / `sync-status`) only keep the connection alive. Payloads do not include bodies.

`hello.gap` is `true` when `Last-Event-ID` points at an event the server has already dropped. First connect (no header) sets `gap: false`; the plugin already listed mail at startup.

## Cheap list fetches (plugin poll fallback)

The plugin’s list call is:

```
GET /api/messages?folder=inbox&pageSize=60
Authorization: Bearer <token>
Accept: application/json
```

(`pageSize` comes from `listSize`, default 60. No `accountId`, `q`, or cookies.)

That route is ETag-backed. Send the previous `ETag` as `If-None-Match` (weak `W/"…"` tags compare equal to the strong form; comma lists and `*` work). Unchanged change-version returns **304** with an empty body. Node `fetch` with only the Authorization header is enough; the cache does not use cookies.

Until the plugin itself sends `If-None-Match`, 304 is for other `node` callers and a future plugin revision. This server still answers 200 with the cached listing SQL from the change-version map.

`GET /api/messages` is rate-limited in production to **15/min** per bearer token, session cookie, or IP. `POST /api/sync` is **8/min**. Over quota: **429** + `Retry-After: 60` + `{ error: { code: "RATE_LIMITED", retryAfterSec: 60 } }`.

## Why `/api/sync` was 2ms or 41–86s

On the image that awaited IMAP inside the HTTP handler:

- **~2ms 200** — cache hit. `syncMinIntervalMs` (60s) and/or `maxAgeSeconds` returned the previous pass. No IMAP.
- **41–86s 200** — cache miss. The request started or joined a real pass. `syncPassBudgetMs` is 60s; TLS connect + LIST push the wall clock into the 41–86s band. Those are the NPM 504s.

`POST /api/sync` now returns **202** immediately (`{ accepted, state, jobId, sync }`). `state` is `started` | `in-flight` | `queued` | `recent` | `cooling`. MCP `sync_mail` returns `{ status: "queued"|"already_running", jobId }` without waiting for IMAP; poll `get_sync_job`. One global `syncAll` mutex; identical in-flight keys join. Failing accounts cool down 15s → 15min. IMAP still runs; watch `GET /api/health` `sync.oldestAgeMs` and `watchdog`. Health is **503** when loop lag or a stuck single-flight exceeds its deadline.
