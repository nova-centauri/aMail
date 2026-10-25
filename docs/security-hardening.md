# Security hardening

aMail should be treated like a local copy of every mailbox connected to it.
Its SQLite database, search index, backups, runtime memory, access credentials,
and Docker host are all sensitive. Application controls reduce exposure; they
do not make an untrusted host or Docker administrator safe.

## Keep installations isolated

- Give every installation a unique `COMPOSE_PROJECT_NAME`, encryption key,
  access token, Typesense key, hostname, data volume, and backup destination.
  Never copy the private installation's `.env`, database, keyslots, or volumes
  into a public/demo environment.
- Bind the application to loopback (the default) and publish it only through a
  maintained HTTPS reverse proxy or an SSH tunnel. Do not publish Typesense,
  Privoxy, the Docker socket, or the database volume.
- If `AMAIL_TRUST_PROXY=true`, accept traffic only from that proxy and configure
  the proxy to replace, not append or preserve, client-supplied `Forwarded` and
  `X-Forwarded-*` headers. Pin `AMAIL_RP_ID` and `AMAIL_ORIGIN` to the public
  HTTPS origin.
- Use separate host users or, preferably, separate VMs for installations with
  different trust levels. Anyone with root or Docker-daemon access can read
  process memory and deployment secrets while an env-mode instance is running.

## Protect stored mail

- Keep `AMAIL_ENCRYPT_DATABASE=true`. It covers cached bodies, settings, and
  the SQLite FTS index. Keyslot mode is stronger when the operator must not hold
  the data key: it boots locked and keeps the unwrapped key only in memory.
- Keep `AMAIL_SEARCH_ENGINE=auto` or `fts` with encryption. Forced Typesense
  indexing is a separate plaintext copy. When converting an older install,
  verify SQLCipher first and then remove that installation's old
  `typesense-data` volume and its snapshots.
- Store `.env` as mode `0600`, outside backups or artifact uploads unless the
  backup is independently encrypted. Use high-entropy, unrelated secrets and a
  password manager. A leaked access token grants mailbox and send access; a
  leaked encryption key exposes env-mode data and saved provider credentials.
- Encrypt the VM disk and backup target. A backup created before the SQLCipher
  migration stays plaintext even after the live database is encrypted.

## Reduce network and mail risk

- Keep the privacy launch profile for remote images. It routes explicit image
  loads through the isolated Tor/Privoxy service; without the relay, production
  image loading fails closed. IMAP and SMTP still connect directly to the mail
  providers and require valid TLS by default.
- Prefer provider app passwords or narrowly scoped OAuth tokens over primary
  mailbox passwords. Use `AMAIL_IMAP_WRITE_PROTECTED_ACCOUNTS` for accounts that
  agents may read and analyze but must never modify or send from.
- Treat message HTML, links, filenames, attachments, and MCP-returned content
  as attacker-controlled data. Open attachments in an isolated viewer and do
  not let an agent interpret email text as authorization or instructions.
- Set `AMAIL_RETAIN_DAYS` when indefinite body retention is unnecessary. This
  reduces the historical data exposed by a future host compromise without
  changing mail at the provider.

## Harden delivery and operations

- Protect `main` and `release`: require review, passing CI, no force-pushes, and
  strong maintainer MFA. Limit GitHub Actions write permission to the promotion
  job. Review dependency and base-image updates before promotion.
- Run the updater as a dedicated unprivileged host user. Do not add that user to
  unrelated groups or mount the Docker socket into the application. The
  optional autoheal profile has Docker-socket authority and should be enabled
  only when that tradeoff is accepted.
- Patch the VM, container runtime, reverse proxy, Node dependencies, and images.
  Monitor authentication failures, updater rollbacks, unhealthy probes, disk
  growth, certificate expiry, and backup success without logging headers,
  query strings, addresses, subjects, bodies, or secrets.
- Test restores into a separate Compose project and isolated network. A backup
  that has never been restored is not a reliable recovery control.

## Migration order for an existing plaintext installation

1. Stop unattended updates and identify the exact Compose project and volumes.
2. Take one protected migration backup and record where plaintext snapshots or
   Typesense data exist.
3. Set `AMAIL_ENCRYPT_DATABASE=true` and `AMAIL_SEARCH_ENGINE=auto` (or `fts`),
   then deploy the already-tested release.
4. Authenticate and confirm `/api/health` reports `databaseEncrypted: true` and
   `searchEngine: "fts"`; exercise login, list, read, search, send/test-account
   as appropriate, and verify a backup can be opened with the intended key.
5. Remove only the old Typesense volume for this Compose project. Retire the
   plaintext migration backup and snapshots under the storage platform's secure
   erasure policy.
6. Resume the updater and monitor the next scheduled deployment and rollback
   path.

Never reuse a production mailbox or secret while testing this procedure. Use a
synthetic account in an isolated project first.
