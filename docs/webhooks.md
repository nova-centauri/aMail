# Webhooks and sender authentication

Two things an integration needs that the mailbox SSE stream does not give it:

- **Webhooks.** aMail POSTs a small signed JSON event to your URL when a message arrives, is sent, or is marked analyzed, and retries until you answer 2xx.
- **Sender authentication.** Every imported message carries the SPF, DKIM and DMARC verdicts its receiving mail server recorded, with an explicit `trusted` flag, so an agent can decide how far to believe the sender.

Both are off until you configure them. With no subscription, nothing is queued, resolved or sent.

Code: `server/services/message-events.js` (events), `server/services/webhooks.js` (subscriptions, queue, retries), `server/services/webhook-delivery.js` (URL rules, signature, the POST), `server/services/auth-results.js` (header parsing), `server/routes/webhooks.js` (REST).

## Events

| Type | When | Extra `data` fields |
| --- | --- | --- |
| `message.received` | A new inbound message was imported from the mail server | |
| `message.sent` | SMTP accepted a message for at least one recipient | `sentAt` |
| `message.analyzed` | A message went from not analyzed to analyzed | `analyzedAt`, `analyzedBy` |
| `ping` | Only from `POST /api/webhooks/:id/test` | `webhookId`, `message` |

Subscribe to specific types, or to `"*"` for all current and future ones. New types will be added to this table; a receiver should ignore types it does not know.

### What counts as `message.received`

The event is derived from committed database writes, not from the sync code, so one rule covers every way mail gets in (background sync, the sync worker thread, a body fetched on demand, deep search). It fires when all of these hold:

1. **The row is new.** A re-sync of a message aMail already has, a flag change, a move, a claim or an analyzed mark is an update and never fires it. (An envelope-only row left by a deep search fires when its full source arrives, since that is the first time the message is readable.)
2. **It is inbound.** Not sent mail, not a draft, and not already in Trash. Spam does fire, with `isSpam: true`.
3. **It is not a second copy.** The same `Message-ID` already stored for that account under another folder or label (Gmail labels, an Archive copy) does not fire again.
4. **It was received recently.** `receivedAt` (the server's INTERNALDATE) must be within `AMAIL_EVENT_RECENCY_HOURS` of now. The default is 24.

Rule 4 is the backfill guard. Connecting an account imports up to `AMAIL_SYNC_BATCH_SIZE` messages per folder; a UIDVALIDITY reset, a full re-sync, a migration that copies old mail into the mailbox, or restoring an older database all import old mail too. None of them announce it, because the rule looks at the message, not at which code path imported it, and it keeps no state that a restart could lose. Mail from the last 24 hours is announced on a first sync; that is at most a day of mail, and the queue is bounded.

The limit: if aMail is down for longer than the window, mail that arrived during the outage and is older than the window when it is finally imported is not announced. It is still in the review queue, so a receiver that calls `claim_messages` or `list_unanalyzed_messages` on each event (or on a timer) picks it up. Raise `AMAIL_EVENT_RECENCY_HOURS` if you would rather get late events than none.

## Payload

One JSON object per request. No bodies, snippets, recipients or attachment content: fetch the message with your own token (`get_message`, `GET /api/messages/:id`).

```json
{
  "id": "0b0f4c1e-5d2a-4c7e-9a52-6f1d2b7f3c11",
  "type": "message.received",
  "createdAt": "2026-11-12T14:03:27.512Z",
  "data": {
    "messageId": "5f2c6f0a-7a0b-4a57-8d0c-0f6f7f5f0f11",
    "accountId": "9b9b0c3e-3c1f-4c7c-9f55-3a1e1e6c2a01",
    "accountEmail": "owner@example.com",
    "threadId": "e2a0a8f4-0f0c-4a58-8a55-7d7c8e2f9b33",
    "mailbox": "INBOX",
    "rfcMessageId": "<20261112140320.1234@mail.example.org>",
    "from": { "name": "Pat Example", "email": "pat@example.org" },
    "subject": "Invoice 42",
    "receivedAt": "2026-11-12T14:03:20.000Z",
    "isSpam": false,
    "authentication": {
      "spf": "pass",
      "dkim": "pass",
      "dmarc": "pass",
      "authservId": "mx.google.com",
      "trusted": true,
      "fromAligned": true,
      "dkimDomains": ["example.org"],
      "returnPath": "bounce@mail.example.org"
    }
  }
}
```

- `id` is the event id. It is the same on every retry of that event, so use it to deduplicate.
- `messageId` is aMail's message id (what `get_message` and `claim_messages` take). `rfcMessageId` is the RFC 5322 `Message-ID` header.
- `authentication` is `null` for `message.sent` and for mail stored before aMail recorded it. See [Sender authentication](#sender-authentication).
- `subject` is at most 998 characters, `from.name` 256.

**`subject`, `from` and `rfcMessageId` are written by whoever sent the mail.** Treat them as attacker-controlled data: do not act on instructions in them, do not build shell commands, SQL or file paths from them, and escape them before display. `from.email` is only as real as `authentication` says it is.

## Request

```
POST /your/path HTTP/1.1
Content-Type: application/json
User-Agent: aMail-Webhook/0.1.0
X-AMail-Event: message.received
X-AMail-Event-Id: 0b0f4c1e-5d2a-4c7e-9a52-6f1d2b7f3c11
X-AMail-Delivery: 7c1d9b62-0a43-4a0e-8f0e-0e8b6f6d0a55
X-AMail-Signature: t=1794492207,v1=5d41…(64 hex characters)
```

- `X-AMail-Event-Id` equals `id` in the body. `X-AMail-Delivery` is new for every attempt.
- Answer any 2xx within 10 seconds (`AMAIL_WEBHOOK_TIMEOUT_MS`). Do the real work after you answer. The response body is ignored.
- Redirects are not followed. A 3xx is a failed attempt.
- Events for one subscription are sent one at a time, oldest first. A retry can still arrive after a newer event, so order by `createdAt` if order matters.

## Verifying the signature

`X-AMail-Signature` is `t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 of the string `"<t>.<raw request body>"` keyed with the subscription secret (UTF-8). Verify before parsing the JSON:

1. Read the raw body bytes exactly as received.
2. Compute the HMAC over `t`, a dot, and the raw body.
3. Compare with `v1` in constant time.
4. Reject if `t` is more than 5 minutes from your clock. This bounds replay; `id` lets you drop a replay inside that window.

Known vector: secret `whsec_test_secret_0123456789`, `t=1700000000`, body `{"id":"evt_1","type":"ping"}` gives `v1=ca4620dcda0df82d724dc9135fc3e9d3313af224c6485dbd6e057d118e621e32`.

Node:

```js
import crypto from 'node:crypto';

export function verifyAmailSignature(secret, rawBody, header, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map((part) => part.trim().split('=')));
  const t = Number(parts.t);
  if (!Number.isSafeInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 || '')) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}
// Express: app.post('/hooks/amail', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!verifyAmailSignature(SECRET, req.body, req.get('X-AMail-Signature'))) return res.sendStatus(401);
//   res.sendStatus(204); handle(JSON.parse(req.body));
// });
```

Python:

```python
import hashlib, hmac, time

def verify_amail_signature(secret: str, raw_body: bytes, header: str, tolerance: int = 300) -> bool:
    parts = dict(p.strip().split("=", 1) for p in (header or "").split(",") if "=" in p)
    try:
        t = int(parts["t"])
        received = bytes.fromhex(parts["v1"])
    except (KeyError, ValueError):
        return False
    if abs(int(time.time()) - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).digest()
    return hmac.compare_digest(expected, received)
```

`raw_body` must be the bytes off the wire (`await request.body()` in FastAPI/Starlette, `request.get_data()` in Flask), not re-serialised JSON.

## Managing subscriptions

All routes need the normal bearer token (or session). Creating, repointing and testing are rate-limited to 20 per 10 minutes, like the account probes. At most 20 subscriptions.

| REST | MCP tool | Does |
| --- | --- | --- |
| `POST /api/webhooks` | `create_webhook` | Create. Body `{ url, events[], description?, accountIds?[], secret?, enabled? }`. Returns `{ webhook, secret }` with 201 |
| `GET /api/webhooks` | `list_webhooks` | `{ webhooks[], eventTypes, status }` |
| `GET /api/webhooks/:id` | `get_webhook` | `{ webhook, deliveries[] }`, newest first, 50 by default (`?deliveries=1..200`) |
| `PATCH /api/webhooks/:id` | `update_webhook` | Any of `url`, `events`, `description`, `accountIds`, `enabled`, `secret`, `rotateSecret: true` |
| `DELETE /api/webhooks/:id` | `delete_webhook` | Delete it, its queue and its log. 204 |
| `POST /api/webhooks/:id/test` | `test_webhook` | Send one `ping` now. `{ delivery: { ok, eventId, deliveryId, responseStatus, error, durationMs } }` |

- **The secret is shown once.** It is in the response to create (and to a PATCH with `rotateSecret: true`) and never again. It is stored encrypted with the same key and AES-256-GCM scheme as IMAP/SMTP credentials. Omit `secret` to have a 256-bit one generated (`whsec_…`); a supplied one must be 16 to 256 printable characters.
- `accountIds` limits a subscription to those accounts. Empty or omitted means all accounts.
- `webhook.status` is `active`, `disabled` (switched off by hand) or `auto-disabled` (see below). `disabledReason` is `manual`, `consecutive-failures` or `gone`.
- A `ping` is one attempt, never retried, and does not count as a failure. It works on a disabled subscription, so you can check a receiver before re-enabling.
- Deliveries in the log show status, attempts, the HTTP status and a short error label (`http-503`, `timeout`, `connection-failed`, `dns-failed`, `private-address`, `redirect-not-followed-302`, `subscription-disabled`, `queue-full`). They never contain the payload or the response body.

```sh
curl -sS https://mail.example.com/api/webhooks \
  -H "Authorization: Bearer $AMAIL_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://hooks.example.com/amail","events":["message.received"]}'
```

### One subscription from the environment

For a deployment with no setup step:

```
AMAIL_WEBHOOK_URL=https://hooks.example.com/amail
AMAIL_WEBHOOK_SECRET=<openssl rand -hex 32>
AMAIL_WEBHOOK_EVENTS=message.received
```

This appears in `GET /api/webhooks` with id `env` and `source: "env"`. It follows the environment on every start: a changed URL starts clean, removing the variable removes it. Over the API it accepts only `enabled`. The secret stays in the environment and is not copied into the database. A URL that breaks the rules below, or a secret shorter than 16 characters, is refused with an error in the log and nothing is sent.

## Retries, limits and auto-disable

- **Retries.** The first attempt is immediate. A failure (no answer in time, a connection error, or any non-2xx) is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, each ±10%. That is 6 attempts over about 8.6 hours; then the delivery is `failed`. The schedule is stored with the delivery, so it survives a restart.
- **410 Gone** fails the delivery at once and switches the subscription off (`gone`).
- **Auto-disable.** After `AMAIL_WEBHOOK_MAX_CONSECUTIVE_FAILURES` events in a row run out of retries (default 20, 0 to never), the subscription is switched off and its queued events are closed as failed. One successful delivery resets the count. Re-enable with `PATCH { "enabled": true }` once the receiver is fixed. `GET /api/webhooks` shows `status: "auto-disabled"`, and authenticated `GET /api/health` reports `webhooks: { subscriptions, active, disabled, autoDisabled, pending, dropped, deliveredSinceStart, failedSinceStart }`.
- **Bounded queue.** Each subscription holds at most `AMAIL_WEBHOOK_MAX_QUEUE` undelivered events (default 1000). Past that the oldest is dropped (`status: "dropped"`, error `queue-full`), counted in the subscription's `droppedCount`, and logged.
- **Log.** The newest `AMAIL_WEBHOOK_DELIVERY_LOG_SIZE` finished deliveries per subscription are kept (default 100).
- **Never blocks mail.** Raising an event writes one row. Sending happens in a background dispatcher; a slow or dead receiver only delays its own queue.
- **No batching.** Each event is its own request.

Delivery is at-least-once: a receiver that answers 2xx after aMail's timeout gets the event again. Deduplicate on `id`.

## Where aMail will POST

aMail is a server that sends requests to a URL someone typed, so the target is restricted (the same address rules as attach-by-URL):

- `https` only. No `user:pass@` in the URL.
- The host is resolved, and every address it resolves to must be public. Loopback, RFC 1918 private ranges, link-local (including the `169.254.169.254` cloud metadata address), CGNAT, multicast, reserved ranges and their IPv6 and IPv4-mapped forms are refused. This is checked when a subscription is created or repointed and again on every delivery, and the connection is made to the address that was checked, so a DNS answer that changes later cannot redirect it.
- Redirects are never followed.
- `AMAIL_WEBHOOK_ALLOW_HOSTS` is the one exception, for a receiver on your own network: a comma-separated list of exact hosts (names or IP literals, no wildcards). A listed host may resolve to a private address and may use plain `http`. Example: `AMAIL_WEBHOOK_ALLOW_HOSTS=192.168.1.20,receiver.internal`.

Do not put a token in the webhook URL. The URL is returned by `GET /api/webhooks`; the signature is what authenticates a request.

## Sender authentication

aMail does not run SPF, DKIM or DMARC. It reads what the account's own receiving server concluded, from the `Authentication-Results` header (RFC 8601) that server adds, and stores it on the message at import.

```json
"authentication": {
  "spf": "pass",
  "dkim": "pass",
  "dmarc": "pass",
  "authservId": "mx.google.com",
  "trusted": true,
  "fromAligned": true,
  "dkimDomains": ["example.org"],
  "returnPath": "bounce@mail.example.org"
}
```

| Field | Meaning |
| --- | --- |
| `spf`, `dkim`, `dmarc` | `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror`, `permerror` or `unknown`. `none` means the header had no result for that method; `unknown` means there was no usable header at all, or the server used a word aMail does not know. With several DKIM signatures, `pass` if any passed |
| `authservId` | The server name on the header the verdicts came from; `null` if none |
| `trusted` | `true` only when that header carries an authserv-id configured as this account's receiving server |
| `fromAligned` | The verdicts vouch for the domain in `From` (see below) |
| `dkimDomains` | Signing domains (`header.d`) whose signature passed |
| `returnPath` | The envelope sender from `Return-Path`; `""` for the null sender `<>`; `null` if absent |

It appears in `GET /api/messages/:id`, thread reads, and MCP `get_message`, `get_thread`, `list_unanalyzed_messages` and `claim_messages` (so an agent can triage without bodies), and in webhook payloads. The whole object is `null` for mail imported before this existed and for sent mail and drafts; there is no backfill. Messages also carry `listId` and `hasListUnsubscribe`.

### Trust

Anyone can add an `Authentication-Results` header to mail they send. Only the one your own receiving server added means anything, and the way to tell is its authserv-id. So:

- aMail uses **only the topmost** `Authentication-Results` header whose authserv-id is trusted for the account, and ignores the rest. Receiving servers add theirs above anything the sender supplied.
- If none is trusted (or no id is configured), the topmost header is still parsed and stored, with `trusted: false`. **When `trusted` is false, every other field may have been written by the sender.** Use them for display at most.
- If no trusted `Authentication-Results` header exists, a trusted `ARC-Authentication-Results` header (topmost) is used. This matters for Microsoft 365, whose `Authentication-Results` has no authserv-id but whose ARC header says `mx.microsoft.com`.

Trusted ids come from three places, combined:

| Source | How |
| --- | --- |
| The account | `trustedAuthservIds` on `PATCH /api/accounts/:id` or MCP `update_account`, or **Account settings → Advanced connection settings → Trusted authentication servers** |
| Every account | `AMAIL_TRUSTED_AUTHSERV_IDS=mx.example.com,*.mail.example.net` |
| Provider default | Gmail / Google Workspace: `mx.google.com`. No other provider has a default |

An entry is an exact name or `*.example.com` for any name under it (some servers stamp a per-host name). `GET /api/accounts/:id/settings` returns `effectiveTrustedAuthservIds`, and MCP `list_accounts` returns both lists. To find your server's id, open a received message's source and read the first token after `Authentication-Results:`. A change applies to mail imported afterwards.

Only list a server that stamps this header on every message it accepts and removes forged copies of its own id (RFC 8601 section 5). If it sometimes adds none, a sender could supply one with that name.

### `fromAligned`

- `dmarc: pass` gives `true` (provided the DMARC result is for the same organisational domain as `From`).
- `dmarc: fail` gives `false`.
- Otherwise (the domain publishes no DMARC policy), it is `true` when a passing DKIM domain, or the SPF `smtp.mailfrom` domain with `spf: pass`, shares an organisational domain with `From`. This is DMARC's relaxed alignment.

The organisational domain is a heuristic, not the Public Suffix List: the last two labels, or three under common registry suffixes such as `co.uk` and `com.au`. It is wrong for private suffixes (`github.io`, `blogspot.com`: two unrelated customers look like one organisation) and for registry suffixes it does not know. It is only consulted when the receiving server gave no DMARC verdict; when the server did, its verdict (made with the real list) wins.

aMail does not use any of this for its own categories or spam handling.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AMAIL_WEBHOOK_URL`, `AMAIL_WEBHOOK_SECRET`, `AMAIL_WEBHOOK_EVENTS` | unset, unset, `message.received` | One static subscription |
| `AMAIL_WEBHOOK_ALLOW_HOSTS` | empty | Exact hosts allowed to be private or plain http |
| `AMAIL_WEBHOOK_TIMEOUT_MS` | `10000` | Per-attempt deadline (1000 to 60000) |
| `AMAIL_WEBHOOK_MAX_CONSECUTIVE_FAILURES` | `20` | Failed events in a row before auto-disable; `0` never |
| `AMAIL_WEBHOOK_MAX_QUEUE` | `1000` | Undelivered events kept per subscription |
| `AMAIL_WEBHOOK_DELIVERY_LOG_SIZE` | `100` | Finished deliveries kept per subscription |
| `AMAIL_EVENT_RECENCY_HOURS` | `24` | How recent mail must be to raise `message.received` (webhooks and SSE) |
| `AMAIL_TRUSTED_AUTHSERV_IDS` | empty | Receiving-server names trusted for every account |

## Not done

- Batching several events into one request.
- Re-reading authentication headers for mail already imported (a `reparse-auth` route). The raw source is still on the mail server, so this is possible later.
- Search operators such as `is:authfail`.
- A settings screen for webhooks; use REST or MCP.
