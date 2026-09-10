# aMail Docker deployment

This Compose bundle is isolated from other Docker workloads: it uses its own
project-scoped containers, networks, and named volumes, never mounts the
Docker socket, and never uses `down`, `prune`, or `--remove-orphans` in its
launch helper. Its normal operations are scoped to this project.

## First launch

On the host, install Docker Compose 2.33.1 or newer, place this repository in
a directory owned by the deployment user, then create the private runtime
configuration:

```sh
cd /path/to/amail
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Put a distinct generated value into each of `AMAIL_ENCRYPTION_KEY` and
`AMAIL_ACCESS_TOKEN`. The encryption key protects the saved email-account
credentials in the SQLite database. Losing it makes those credentials
unreadable; expose it only through the protected `.env` file or an equivalent
secret manager. The access token is what you (and your agents) present to log
in, so keep it in a password manager.

Start the privacy-preserving configuration (the recommended default):

```sh
sh deploy/launch.sh
docker compose ps
```

The first command validates the resolved Compose configuration and then builds
and starts aMail plus its internal Tor/Privoxy proxy. Application data lives in
the named `amail-data` volume (prefixed by `COMPOSE_PROJECT_NAME`) rather than
in the repository or any host bind mount.

Open `http://127.0.0.1:3080`, sign in with the access token, and the first-run
wizard walks you through connecting mailboxes and pointing an agent at the MCP
endpoint.

The supplied `.env.example` polls enabled accounts every five minutes and keeps
one IMAP connection per account pooled (with ImapFlow auto-IDLE on INBOX)
instead of reconnecting on every pass. A focused mailbox tab checks every inbox
immediately when it becomes visible, then polls `GET /api/changes` about every
60 seconds. Hosted keyslot tenants default to a 15-minute unattended poll
instead; copy `deploy/hosted.env.example` rather than this file. Set
`SYNC_INTERVAL_MINUTES=0` only if you want no server-side fallback.
`AMAIL_RETAIN_DAYS` (default 0) can drop stored bodies of old mail while keeping
headers and flags.

On its first pass, aMail imports the newest `AMAIL_SYNC_BATCH_SIZE` messages
from each supported folder (200 by default). This is a recent-mail client
rather than a full historical migration tool; increase the value (up to 1000)
before connecting an account if you need a larger initial window.

## Upgrading from GigaMail

aMail is the open-source continuation of GigaMail and is a drop-in upgrade:

- Every `GIGAMAIL_*` variable is still read when the matching `AMAIL_*`
  variable is unset, so an existing `.env` works unchanged.
- An existing `gigamail.sqlite` is opened in place; no export/import step.
- The old `gigamail_session` cookie stays valid until it expires.
- Keep your data by pointing the `amail-data` volume at the old named volume
  (see the commented `external:` block in `docker-compose.yml`), or keep
  `COMPOSE_PROJECT_NAME` and the old volume name in your `.env`.

## Access without opening a port

By default aMail binds to `127.0.0.1:3080` on the host, not the LAN or
internet. From your workstation, create a tunnel:

```sh
ssh -N -L 3080:127.0.0.1:3080 user@your-server
```

Then open `http://127.0.0.1:3080` locally and authenticate using
`AMAIL_ACCESS_TOKEN`. Keep that token secret: this application has access to
stored mail-provider credentials. The UI keeps the token only for the current
browser session and sends it as a Bearer token, so `AMAIL_COOKIE_SECURE` can
remain enabled even when the SSH tunnel itself uses local HTTP.

For a reverse proxy, leave the aMail port loopback-only and run the proxy as a
separately authenticated, TLS-terminating service on the same host. Only set
`AMAIL_TRUST_PROXY=true` when that proxy is local and strips any
client-supplied forwarding headers; do not publish aMail directly.

## Behind a reverse proxy (Caddy, Nginx, Nginx Proxy Manager, Traefik)

If the proxy runs on another host, bind aMail to this machine's private
address instead of loopback and restart the project:

```sh
# .env
AMAIL_BIND_ADDRESS=192.168.1.20
AMAIL_PORT=3080
```

Configure the public host (for example `mail.example.com`) with a valid TLS
certificate and force HTTPS before sending traffic upstream over plain `http`
to `192.168.1.20:3080`. Do not make a public HTTP-only route. Keep
`AMAIL_ACCESS_TOKEN` set: it is the application-level gate for every mailbox
API request. A proxy-level access list or SSO is a useful additional layer.

Passkeys need to know the public origin, because the container only sees the
proxy's internal `Host`. Pin it:

```sh
# .env
AMAIL_RP_ID=mail.example.com
AMAIL_ORIGIN=https://mail.example.com
```

`AMAIL_TRUST_PROXY` can remain `false` for this configuration because aMail
uses Bearer-token authentication and does not need forwarded client addresses.

## Optional Tor/Privoxy remote-content path

The default `deploy/launch.sh` mode routes remote content through an internal
Tor/Privoxy service. aMail fetches sanitized remote content server-side, so a
sender does not learn the browser's IP address or the host's public IP. To
start that configuration explicitly:

```sh
sh deploy/launch.sh privacy
docker compose --profile privacy ps
```

This starts `tor-proxy` and passes
`REMOTE_CONTENT_PROXY_URL=http://tor-proxy:8118` only to that launch. Neither
its SOCKS nor HTTP proxy port is published to the Docker host. aMail can reach
Privoxy over an internal network; Tor alone has a separate egress network,
selected explicitly as Tor's default gateway. If the proxy is unavailable,
remote-content requests fail closed rather than silently going direct.

Tor is a privacy aid, not a complete anonymity system. It does not anonymize
IMAP/SMTP traffic, and remote images can still reveal message-specific data
once explicitly loaded. Keep tracker blocking enabled and expect some image
hosts to reject Tor exits.

If you run `sh deploy/launch.sh direct`, aMail starts without Tor/Privoxy, but
production builds keep remote content blocked. They do **not** fall back to
direct remote fetching, so a stopped or omitted proxy cannot accidentally
expose the host's public IP.

## Routine operations

```sh
docker compose logs --follow amail
docker compose ps
docker compose exec amail node -e "fetch('http://127.0.0.1:3000/api/health').then(r => r.text()).then(console.log)"
```

To update, pull the new source, review `.env.example` for new settings, then
rerun the same `deploy/launch.sh` command. Set `AMAIL_FORCE_RECREATE=1` to
recreate the application container without restarting a healthy Tor relay.
Database migrations are backward-compatible and run automatically at startup.

Before upgrading, take an online SQLite backup from inside the volume:

```sh
docker compose exec amail node server/tools/backup.js
```

The tool reads the container's environment, so an encrypted database (see
below) is opened with its key and the copy stays encrypted under that same
key. Pass a path as the first argument to choose the destination; the default
is `/data/backup-<timestamp>.sqlite`.

Backups accumulate: each one is a full copy of the database, so a week of
pre-upgrade copies can outweigh the live data several times over. Keep the
last two or three and delete the rest, for example:

```sh
docker compose exec amail sh -c 'ls -t /data/backup-*.sqlite | tail -n +3 | xargs -r rm --'
```

The volume also holds the SQLite write-ahead log (`*.sqlite-wal`). aMail caps
it at 64 MiB and truncates it at startup, so a large one left by an earlier
release shrinks on the next restart.

Do not delete the `amail-data` volume unless intentionally discarding all
accounts, cached mail metadata, and settings.

## Whole-database encryption

Saved mail credentials are always encrypted with `AMAIL_ENCRYPTION_KEY`. The
cached mail itself (bodies, the search index, settings) is stored in plaintext
unless you opt in:

```sh
# .env
AMAIL_ENCRYPT_DATABASE=true
```

On the next start aMail derives a separate database key from
`AMAIL_ENCRYPTION_KEY` and encrypts the existing SQLite file in place (SQLCipher
format via `better-sqlite3-multiple-ciphers`). This is a one-time migration:
take a backup first, expect the start to take a little longer on a large
mailbox, and note that from then on the file is unreadable without the key.
Setting the flag back to `false` makes the server refuse to start rather than
create an empty database next to the encrypted one; turn it back on with the
original key. `/api/health` reports `databaseEncrypted` so you can confirm the
state after the restart.

## Keyslot mode (hosted tenants)

`AMAIL_KEY_MODE=keyslot` runs the same image with **no key material in the
environment**. It is the model hosted aMail uses for each tenant container and
is available to self-hosters who want the operator (or a stolen volume) to be
unable to read the cache. Everything in this section is inert for a plain
`.env`.

**How it works.** At provisioning the container generates a random 32-byte
data key (DEK) in memory. The DEK keys the whole SQLite file (SQLCipher
format) and, through HKDF, the credential and remote-content token keys. It is
never written anywhere. Instead every credential the tenant holds *wraps* the
DEK (AES-256-GCM) into a keyslot in `/data/keyslots.json`, which contains only
ciphertext, salts, and labels:

| Slot | Credential | Notes |
| --- | --- | --- |
| `token` | MCP/REST bearer token (`amk1_…`) | Verifying the token *is* unwrapping the DEK; there is no separate token hash. One per agent; mint and revoke freely |
| `passphrase` | Human UI passphrase (≥ 12 chars) | scrypt-stretched before wrapping |
| `passkey` | WebAuthn credential with the PRF extension | The PRF secret wraps the DEK; the credential is stored in the keyslot file so it can be verified while locked |
| `recovery` | Recovery code shown once | Forgiving about case, separators, and O/0, I/1/L look-alikes |
| `escrow` | Operator key from `AMAIL_ESCROW_KEY` | **Opt-in per harness.** Lets the container unlock itself after a restart. Not offered when the variable is unset |

The container boots **locked**. `/api/health` reports
`{"keyMode":"keyslot","locked":true,"initialized":…}` and stays reachable so
edge health checks work; anything that needs the database answers
`503 HARNESS_LOCKED`. Presenting any keyslot credential unlocks:

- a bearer token on any `/api` or `/mcp` request (an agent's first MCP call is
  the unlock; no separate login step),
- a token, passphrase, or recovery code through `POST /api/session`
  (`{"accessToken": …}`, the field the web client already sends), which also
  starts an opaque in-memory browser session,
- a passkey through the normal passkey login.

Unlocked, the harness behaves exactly like env mode until the process exits,
`POST /api/keyslots/lock` is called, or a restart happens. Browser sessions
live in RAM and end with the process, so a restart always needs a credential
again unless the tenant enabled escrow or the deploy used the handoff below.

**Provisioning.**

```sh
# .env — no AMAIL_ENCRYPTION_KEY, no AMAIL_ACCESS_TOKEN
AMAIL_KEY_MODE=keyslot
AMAIL_PROVISION_SECRET=<random, ≥ 32 chars>
```

```sh
curl -X POST -H "Authorization: Bearer $AMAIL_PROVISION_SECRET" \
  http://127.0.0.1:3080/api/keyslots/init
# → {"token":"amk1_…","recoveryCode":"XXXXX-XXXXX-…","keyslots":[…],"status":{…}}
```

The call works exactly once, returns the first bearer token and the recovery
code, and unlocks the harness. Nothing keeps a copy: show both to the tenant
immediately. Without `AMAIL_PROVISION_SECRET` the endpoint is disabled rather
than first-come-first-served. Setting `AMAIL_ENCRYPTION_KEY`,
`AMAIL_ACCESS_TOKEN`, `AMAIL_REMOTE_TOKEN_KEY`, or `AMAIL_ENCRYPT_DATABASE`
alongside keyslot mode refuses to start, so a copy-pasted env-mode `.env`
cannot silently downgrade a tenant.

**Managing keyslots** (authenticated, harness unlocked):

| Call | Effect |
| --- | --- |
| `GET /api/keyslots` | List slots (ids, types, labels, timestamps; never key material) |
| `POST /api/keyslots/tokens {"label"}` | Mint a bearer token for another agent; returned once |
| `POST /api/keyslots/recovery` | Add a recovery code; returned once |
| `POST /api/keyslots/passphrase {"passphrase"}` | Add a UI passphrase |
| `POST /api/keyslots/escrow` | Opt in to operator escrow (`503` when the server offers none) |
| `DELETE /api/keyslots/:id` | Revoke. The last credential able to unlock cannot be deleted; escrow never counts |
| `POST /api/keyslots/lock` | Drop the DEK now and end browser sessions |

Rotating a token is mint-then-revoke, in-container; the DEK itself never
changes. Adding a passkey from the web UI links it to the DEK automatically:
the browser requests the PRF extension, and if the authenticator only
evaluates PRF on assertions the client runs one immediately after
registration. Authenticators without PRF support register but are reported
with `canUnlock: false` and cannot unlock.

**Restarts and deploys.** Three ways a tenant comes back unlocked:

1. **Handoff (recommended for upgrades).** Set `AMAIL_HANDOFF_SOCKET`
   (a path inside `/data`, e.g. `/data/handoff.sock`) and a shared
   `AMAIL_HANDOFF_SECRET` on both the old and the new container. An unlocked
   process listens on the socket; a starting process asks it for the DEK,
   proving it holds the secret with an HMAC over a server nonce. Start the new
   container while the old one is still running, wait until its `/api/health`
   reports `"locked":false`, then stop the old one. The DEK crosses a local
   socket once, in memory; nothing is written. Plain `docker compose up`
   recreation stops the old container first and therefore cannot hand off.
2. **Escrow.** If the tenant enabled it and `AMAIL_ESCROW_KEY` is present,
   the container unlocks itself at boot (`"unlockedVia":"escrow"`). The same
   volume on a node without that key stays locked.
3. **A credential.** Otherwise the harness waits; the next agent call with a
   valid token unlocks it.

**Backups, moves, deletion.** The volume is ciphertext plus `keyslots.json`;
snapshot it as-is. `server/tools/backup.js` refuses to run in keyslot mode
because no tooling can obtain the key. Moving a tenant is stop, copy the
volume, start elsewhere. Deleting a tenant is deleting the volume: without the
keyslots the cache is unrecoverable, and the tenant's mail still lives on
their IMAP servers.

**Logging.** Keyslot mode defaults to `LOG_LEVEL=error`. The logging policy
(path only, no headers, scrubbed error text) applies at every level; a locked
harness answering `503` is not logged as an error.

**Hosted density profile.** Keyslot containers apply these when the variable is
unset (see `deploy/hosted.env.example` for the tenant-node copy). The image
entrypoint also sets `NODE_OPTIONS=--max-old-space-size=384` and
`UV_THREADPOOL_SIZE=2` in keyslot mode unless they are already present. Explicit
environment always wins, so a compose file that still pins
`SYNC_INTERVAL_MINUTES=5` or `LOG_LEVEL=info` from the OSS `.env.example` keeps
those OSS values — drop those pins or use `hosted.env.example`.

| Setting | Keyslot default | OSS `.env.example` |
| --- | --- | --- |
| `LOG_LEVEL` | `error` | `info` |
| `SYNC_INTERVAL_MINUTES` | `15` | `5` |
| `AMAIL_SYNC_BATCH_SIZE` | `100` | `200` |
| `AMAIL_SYNC_MAX_MESSAGE_BYTES` | `5 MiB` | `10 MiB` |
| `AMAIL_SYNC_MIN_INTERVAL_MS` | `60000` | `60000` |
| `AMAIL_IMAP_POOL_IDLE_MS` | `480000` | `480000` |
| `AMAIL_RETAIN_DAYS` | `0` (off) | `0` (off) |
| `NODE_OPTIONS` | `--max-old-space-size=384` | unset |
| `UV_THREADPOOL_SIZE` | `2` | unset |

## Sizing

One instance's steady-state footprint is dominated by account count: a
21-account, 15k-message mailbox measured about 1.1 GiB of RAM, a background
pass over all its mailboxes took about a minute, and a two- or three-account
mailbox is a small fraction of that. The Compose file caps the application
container at `AMAIL_MEMORY_LIMIT` (default 1.5 GiB) and the Tor relay at
`AMAIL_TOR_MEMORY_LIMIT` (default 256 MiB) so one runaway instance cannot
starve a shared host; raise the first for very large mailboxes.

CPU is spent almost entirely in IMAP passes. The web client asks for a focused
refresh immediately, then polls `GET /api/changes` about every 60 seconds. The
server coalesces concurrent syncs, enforces a 60-second minimum interval
(`AMAIL_SYNC_MIN_INTERVAL_MS`), and returns a pass that finished inside that
window. Agents that poll should pass `maxAgeSeconds` to `sync_mail` (or
`POST /api/sync`) for the same reason. `SYNC_INTERVAL_MINUTES` governs the pass
that runs with no tab open (15 minutes in keyslot mode, 5 in the supplied
`.env.example`).

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`: the Node
tests, production build, dependency audit, Compose validation, both Docker
builds, a live health check of the started image, an unauthenticated API
check, a boot with a GigaMail-era `.env` to prove the compatibility
fallbacks, and a boot of the same image in keyslot mode (locked, provisioned,
unlocked by the returned token, locked again after a restart).

When all of that passes for a push to `main`, a final job fast-forwards the
**`release`** branch to that commit. `release` therefore only ever points at
a fully verified revision, and it is the branch deployments should follow;
`main` may be ahead of it while a run is in progress or after a failure.

## Continuous delivery (unattended updates)

Nothing on GitHub reaches your server. Instead the server pulls: a timer runs
`deploy/autoupdate.sh`, which fetches `release`, and when it has moved
redeploys with the same `deploy/launch.sh` you used the first time, waits for
`/api/health` to report the new `releaseSha`, and rolls back to the previous
revision if it does not.

```sh
# One-time setup on the server, from the checkout you deploy from.
sudo cp deploy/systemd/amail-autoupdate.service deploy/systemd/amail-autoupdate.timer /etc/systemd/system/
sudo systemctl edit amail-autoupdate.service   # set WorkingDirectory, User, ExecStart path and mode
sudo systemctl daemon-reload
sudo systemctl enable --now amail-autoupdate.timer

systemctl list-timers amail-autoupdate.timer   # next run
journalctl -u amail-autoupdate.service         # what it did
```

Details worth knowing:

- The script is idempotent and cheap when nothing changed (one `git fetch`),
  so a five-minute cadence is fine. Overlapping runs are prevented with a lock.
- It refuses to run over local modifications to tracked files; `.env` is
  untracked and never touched.
- After a rollback it records the failed revision and will not retry it. The
  next `release` movement clears that. `journalctl` has the reason.
- `launch.sh` now stamps every deploy with the checked-out commit, so
  `curl -s http://127.0.0.1:3080/api/health | grep -o '"releaseSha":"[0-9a-f]*"'`
  tells you what is serving even when you deploy by hand.
- Prefer `cron`? `*/5 * * * * cd /opt/amail && sh deploy/autoupdate.sh privacy`
  does the same job, just without `journalctl`.
- To pin a server, stop the timer. To follow a different branch (a staging
  server following `main`, say), set `AMAIL_RELEASE_BRANCH` in the unit's
  `Environment=`.

Each deploy still rebuilds the image on the server, exactly as a manual
`launch.sh` does, so nothing about the trust model changes: the server only
ever runs what it built from the commit it checked out.
