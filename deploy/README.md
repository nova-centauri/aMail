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

The supplied `.env.example` polls enabled accounts every five minutes without
keeping long-lived IMAP IDLE sockets open. That interval is the unattended
fallback: a focused mailbox tab checks every inbox immediately when it becomes
visible and then about every 15 seconds while it stays in use. Set
`SYNC_INTERVAL_MINUTES=0` only if you want no server-side fallback.

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
docker compose exec amail node -e "
  const Database = require('better-sqlite3');
  const fs = require('node:fs');
  const src = fs.existsSync('/data/amail.sqlite') ? '/data/amail.sqlite' : '/data/gigamail.sqlite';
  new Database(src, { readonly: true }).backup('/data/backup-' + Date.now() + '.sqlite').then(() => console.log('ok'));
"
```

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

### Sizing

One instance's steady-state footprint is dominated by account count: a
21-account, 15k-message mailbox measured about 1.1 GiB of RAM, a background
pass over all its mailboxes took about a minute, and a two- or three-account
mailbox is a small fraction of that. The Compose file caps the application
container at `AMAIL_MEMORY_LIMIT` (default 1.5 GiB) and the Tor relay at
`AMAIL_TOR_MEMORY_LIMIT` (default 256 MiB) so one runaway instance cannot
starve a shared host; raise the first for very large mailboxes.

CPU is spent almost entirely in IMAP passes. The web client asks for one on a
timer only while its tab is focused, waits at least 30 seconds and at least
twice the previous pass's duration between requests, and accepts a pass that
finished within the last 20 seconds instead of starting another; the server
runs one pass at a time and shares it between concurrent callers. Agents that
poll should pass `maxAgeSeconds` to `sync_mail` (or `POST /api/sync`) for the
same reason. `SYNC_INTERVAL_MINUTES` governs the pass that runs with no tab
open.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`: the Node
tests, production build, dependency audit, Compose validation, both Docker
builds, a live health check of the started image, an unauthenticated API
check, and a boot with a GigaMail-era `.env` to prove the compatibility
fallbacks. It deploys nothing; how a tested `main` reaches your server is up
to you (a self-hosted runner, a cron `git pull && sh deploy/launch.sh`, or
Watchtower against your own registry all work).
