import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createDatabase, createRepositories } from '../db.js';
import { errorHandler } from '../middleware/errors.js';
import { registerApi } from './api.js';

test('session logout clears the cookie with matching attributes so later requests are unauthenticated', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-session-'));
  const accessToken = 'session-test-token';
  const config = {
    env: 'test',
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    credentialKey: Buffer.alloc(32, 5),
    accessToken,
    syncBatchSize: 50,
    remoteContentProxyUrl: null,
    allowDirectRemoteContent: false,
  };
  const database = createDatabase(config);
  const repos = createRepositories(database);
  const app = express();
  app.use(express.json());
  registerApi(app, { config, repos, mailService: {}, remoteContent: { canIssueTokens: false } });
  app.use(errorHandler({ error() {} }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const unlocked = await fetch(`${origin}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    });
    assert.equal(unlocked.status, 204);
    const setCookie = unlocked.headers.getSetCookie?.() || [];
    assert.equal(setCookie.some((value) => value.startsWith('amail_session=')), true);

    const cookieAuth = await fetch(`${origin}/api/session`, {
      headers: { Cookie: `amail_session=${encodeURIComponent(accessToken)}` },
    });
    assert.equal(cookieAuth.status, 200);
    assert.deepEqual(await cookieAuth.json(), { protected: true, authenticated: true, passkeys: 0, keyMode: 'env', locked: false, initialized: true });

    const legacyCookieAuth = await fetch(`${origin}/api/session`, {
      headers: { Cookie: `gigamail_session=${encodeURIComponent(accessToken)}` },
    });
    assert.deepEqual(await legacyCookieAuth.json(), { protected: true, authenticated: true, passkeys: 0, keyMode: 'env', locked: false, initialized: true });

    const logout = await fetch(`${origin}/api/session`, { method: 'DELETE' });
    assert.equal(logout.status, 204);
    const cleared = logout.headers.getSetCookie?.() || [logout.headers.get('set-cookie')].filter(Boolean);
    assert.equal(cleared.some((value) => /amail_session=/i.test(value)), true, `logout cookies: ${cleared.join(' || ')}`);
    assert.equal(cleared.some((value) => /SameSite=Strict/i.test(value) && (/Max-Age=0/i.test(value) || /Expires=/i.test(value))), true, `logout cookies: ${cleared.join(' || ')}`);

    const afterLogout = await fetch(`${origin}/api/session`);
    assert.equal(afterLogout.status, 200);
    assert.deepEqual(await afterLogout.json(), { protected: true, authenticated: false, passkeys: 0, keyMode: 'env', locked: false, initialized: true });
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
