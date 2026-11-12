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

Two features cross the trust boundary in ways worth knowing before reporting
or deploying. Outbound webhooks make the server send requests to a
caller-supplied URL; the SSRF rules, signing scheme and replay guidance are in
[`docs/webhooks.md`](docs/webhooks.md). The `authentication` verdicts on a
message are copied from a header a sender can forge, and are only meaningful
when `trusted` is true; the trust model is in the same document. A way to make
aMail POST to a private or metadata address without `AMAIL_WEBHOOK_ALLOW_HOSTS`,
to read a stored webhook secret, or to get `trusted: true` from a
sender-supplied header is a vulnerability.
