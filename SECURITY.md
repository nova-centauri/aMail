# Security policy

aMail processes mailbox credentials, message bodies, attachments, and agent
credentials. Please do not open a public issue for a suspected vulnerability.

Report security issues with a [private GitHub security
advisory](https://github.com/nova-centauri/aMail/security/advisories/new). Include
the affected commit or release, deployment mode (`env` or `keyslot`), impact,
and the smallest safe reproduction. Do not attach real email, production
tokens, passwords, recovery codes, database files, or `.env` contents; use
synthetic fixtures and redact logs.

Security fixes target the current `release` branch. Older snapshots may not
receive fixes, so operators should stay on the newest CI-promoted release after
reviewing the deployment notes. Public disclosure should wait until a fix and
upgrade guidance are available.

The supported deployment boundary and operator checklist are documented in
[`docs/security-hardening.md`](docs/security-hardening.md).
