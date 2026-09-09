# Contributing to aMail

Thanks for helping build an agentic, privacy-first mail client.

## Ground rules

- **Nothing private in the repo.** No real hostnames, addresses, names, tokens, or organisation-specific rules. Anything that varies per installation belongs in `.env.example` (documented) or in a database setting with a UI/API to edit it. Tests and demo data use `example.com`/`.example`/`.test` domains and fictional people.
- **Agents are first-class users.** Every capability the UI has should be reachable through the REST API and, where it makes sense, an MCP tool. New message state must be exposed in `publicMessage`/`publicThread`, searchable if agents will filter on it, and covered by a test.
- **Backward compatible upgrades.** Database migrations run in `initSchema` and must be additive. Renamed environment variables keep a fallback (see `readEnv` in `server/config.js`).
- **Fail closed on privacy.** Remote content, credentials, and forwarded headers are untrusted by default; do not add escape hatches that are on in production.

## Development

```sh
npm install
cp .env.example .env      # set AMAIL_ENCRYPTION_KEY and AMAIL_ACCESS_TOKEN; AMAIL_COOKIE_SECURE=false for http
npm run dev               # Vite on http://127.0.0.1:5173, API on :3000
```

Node 22 or newer is required (`better-sqlite3-multiple-ciphers`, `node:test`).

## Tests and checks

```sh
npm test         # node --test server/**/*.test.js && vitest run
npm run check    # vite build + node --check server/index.js
```

- Server tests live next to the module they cover (`server/**/*.test.js`) and use `node:test`; they spin up a real SQLite database in a temp directory and, for routes, a real Express listener.
- Client tests use Vitest + Testing Library (`src/**/*.test.{js,jsx}`). Mock `../api.js` rather than `fetch`.
- CI runs both suites, the production build, `npm audit --omit=dev --audit-level=high`, Compose validation, both Docker builds, a live health check, and a boot with a GigaMail-era `.env`.

## Project layout

| Path | What lives there |
| --- | --- |
| `server/config.js` | Environment parsing with `AMAIL_*`/`GIGAMAIL_*` fallbacks |
| `server/db.js` | Schema, migrations, repositories, FTS |
| `server/services/` | Mail sync/send, smart filtering, person flags, crypto, passkeys, remote content |
| `server/routes/api.js` | REST API |
| `server/mcp/server.js` | MCP tools (same repositories and services as REST) |
| `server/mail/search-query.js` | Search operator parser shared with the client |
| `src/` | React UI; `src/mail/` is framework-free logic, `src/components/` are views |
| `src/styles/` | Token-based stylesheet (see `src/styles/README.md`) |
| `deploy/` | Compose launcher, Tor/Privoxy image, deployment docs |

## Pull requests

- Keep each PR to one logical change with tests.
- Run `npm test` and `npm run check` before opening it.
- Describe user-visible behaviour, API changes, and any new environment variables in the PR body, and update `README.md` / `.env.example` accordingly.
- Security issues: please report privately to the maintainers instead of opening a public issue.
