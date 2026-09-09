import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from './config.js';
import { createHarness } from './bootstrap.js';
import { createLogger } from './logging.js';

const silent = createLogger({ logLevel: 'silent' });

async function boot(t, env) {
  const config = loadConfig({ NODE_ENV: 'test', AMAIL_SYNC_INTERVAL_MINUTES: '0', ...env });
  const harness = createHarness({ config, logger: silent });
  const server = await new Promise((resolve) => {
    const listener = harness.app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    await harness.stop();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(() => stop().catch(() => {}));
  await harness.start();
  return { config, harness, origin, stop };
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

test('keyslot mode refuses env-mode secrets and reports its mode', () => {
  const config = loadConfig({ AMAIL_KEY_MODE: 'keyslot', AMAIL_ENCRYPTION_KEY: 'x'.repeat(32), AMAIL_ACCESS_TOKEN: 'y'.repeat(32) });
  assert.deepEqual(config.keyModeConflicts, ['ENCRYPTION_KEY', 'ACCESS_TOKEN']);
  assert.equal(config.credentialKey, null);
  assert.equal(config.accessToken, null);
  assert.equal(config.encryptDatabase, true);
  const plain = loadConfig({ AMAIL_ENCRYPTION_KEY: 'x'.repeat(32), AMAIL_ACCESS_TOKEN: 'y'.repeat(32) });
  assert.equal(plain.keyMode, 'env');
  assert.deepEqual(plain.keyModeConflicts, []);
  assert.equal(plain.provisionSecret, null);
});

test('a keyslot harness boots locked, provisions once, and gates everything on a keyslot credential', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-harness-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { origin, harness } = await boot(t, { AMAIL_DATA_DIR: dataDir, AMAIL_KEY_MODE: 'keyslot', AMAIL_PROVISION_SECRET: 'provision-secret-value' });

  const health = await (await fetch(`${origin}/api/health`)).json();
  assert.equal(health.keyMode, 'keyslot');
  assert.equal(health.locked, true);
  assert.equal(health.initialized, false);
  assert.equal(health.authProtected, true);
  assert.equal(health.databaseEncrypted, true);
  assert.equal(Object.hasOwn(health, 'accounts'), false);

  const session = await (await fetch(`${origin}/api/session`)).json();
  assert.equal(session.protected, true);
  assert.equal(session.authenticated, false);
  assert.equal(session.locked, true);

  // Public routes that need the database answer with a clear locked code.
  const avatar = await fetch(`${origin}/api/accounts/some-id/avatar`);
  assert.equal(avatar.status, 503);
  assert.equal((await avatar.json()).error.code, 'HARNESS_UNINITIALIZED');
  assert.equal((await fetch(`${origin}/api/accounts`)).status, 401);

  // Provisioning requires the secret and happens exactly once.
  assert.equal((await fetch(`${origin}/api/keyslots/init`, { method: 'POST' })).status, 401);
  const init = await fetch(`${origin}/api/keyslots/init`, {
    method: 'POST',
    headers: { authorization: 'Bearer provision-secret-value', 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'control plane' }),
  });
  assert.equal(init.status, 201);
  const provisioned = await init.json();
  assert.match(provisioned.token, /^amk1_/);
  assert.ok(provisioned.recoveryCode);
  assert.equal(provisioned.status.locked, false);
  const again = await fetch(`${origin}/api/keyslots/init`, { method: 'POST', headers: { authorization: 'Bearer provision-secret-value' } });
  assert.equal(again.status, 409);
  const keyslotFile = fs.readFileSync(path.join(dataDir, 'keyslots.json'), 'utf8');
  assert.equal(keyslotFile.includes(provisioned.token), false);
  assert.equal(keyslotFile.includes(provisioned.recoveryCode), false);

  // The bearer token is the keyslot credential.
  const bearer = { authorization: `Bearer ${provisioned.token}` };
  const accounts = await fetch(`${origin}/api/accounts`, { headers: bearer });
  assert.equal(accounts.status, 200);
  assert.deepEqual(await accounts.json(), { accounts: [] });
  assert.equal((await fetch(`${origin}/api/accounts`, { headers: { authorization: 'Bearer amk1_wrong' } })).status, 401);

  // MCP shares the gate.
  const mcp = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { ...bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
  });
  assert.equal(mcp.status, 200);

  // Keyslot management: mint a second token, a passphrase, list, revoke.
  const minted = await (await fetch(`${origin}/api/keyslots/tokens`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'triage agent' }) })).json();
  assert.match(minted.token, /^amk1_/);
  assert.equal(minted.keyslot.label, 'triage agent');
  const passphrase = await fetch(`${origin}/api/keyslots/passphrase`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 'a passphrase for the ui' }) });
  assert.equal(passphrase.status, 201);
  const escrow = await fetch(`${origin}/api/keyslots/escrow`, { method: 'POST', headers: bearer });
  assert.equal(escrow.status, 503, 'escrow is not offered without an operator KEK');
  const listed = await (await fetch(`${origin}/api/keyslots`, { headers: bearer })).json();
  assert.deepEqual(listed.keyslots.map((slot) => slot.type), ['token', 'recovery', 'token', 'passphrase']);
  assert.equal(JSON.stringify(listed).includes('wrapped'), false);
  assert.equal((await fetch(`${origin}/api/keyslots/${minted.keyslot.id}`, { method: 'DELETE', headers: bearer })).status, 204);
  assert.equal((await fetch(`${origin}/api/accounts`, { headers: { authorization: `Bearer ${minted.token}` } })).status, 401, 'revoked token');

  // Browser session with the passphrase, then lock: sessions die with the DEK.
  const login = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: 'a passphrase for the ui' }) });
  assert.equal(login.status, 204);
  const cookie = cookieFrom(login);
  assert.match(cookie, /^amail_session=/);
  assert.equal(cookie.includes('a passphrase'), false, 'the cookie is an opaque session id, not the credential');
  assert.equal((await fetch(`${origin}/api/accounts`, { headers: { cookie } })).status, 200);
  const badLogin = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: 'not the passphrase' }) });
  assert.equal(badLogin.status, 401);

  const lock = await fetch(`${origin}/api/keyslots/lock`, { method: 'POST', headers: { cookie } });
  assert.equal(lock.status, 200);
  assert.equal((await lock.json()).status.locked, true);
  assert.equal(harness.vault.isUnlocked(), false);
  assert.equal((await fetch(`${origin}/api/accounts`, { headers: { cookie } })).status, 401, 'old session is gone');
  assert.equal((await fetch(`${origin}/api/accounts/x/avatar`)).status, 503);
  assert.equal((await (await fetch(`${origin}/api/accounts/x/avatar`)).json()).error.code, 'HARNESS_LOCKED');

  // A bearer token unlocks on its first call, exactly like an agent's first MCP request.
  assert.equal((await fetch(`${origin}/api/accounts`, { headers: bearer })).status, 200);
  assert.equal(harness.vault.isUnlocked(), true);
  assert.equal((await (await fetch(`${origin}/api/health`)).json()).locked, false);

  // Recovery code through the session endpoint.
  await fetch(`${origin}/api/keyslots/lock`, { method: 'POST', headers: bearer });
  const recovered = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recoveryCode: provisioned.recoveryCode.toLowerCase() }) });
  assert.equal(recovered.status, 204);
  assert.equal(harness.vault.isUnlocked(), true);
});

test('provisioning is disabled without a provision secret', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-harness-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { origin } = await boot(t, { AMAIL_DATA_DIR: dataDir, AMAIL_KEY_MODE: 'keyslot' });
  const init = await fetch(`${origin}/api/keyslots/init`, { method: 'POST', headers: { authorization: 'Bearer anything' } });
  assert.equal(init.status, 503);
  assert.equal((await init.json()).error.code, 'PROVISIONING_DISABLED');
});

test('escrow lets a restarted container unlock itself only when the tenant opted in', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-harness-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const env = { AMAIL_DATA_DIR: dataDir, AMAIL_KEY_MODE: 'keyslot', AMAIL_PROVISION_SECRET: 'p'.repeat(32), AMAIL_ESCROW_KEY: 'node-kek-'.repeat(4) };

  const first = await boot(t, env);
  const provisioned = await (await fetch(`${first.origin}/api/keyslots/init`, { method: 'POST', headers: { authorization: `Bearer ${env.AMAIL_PROVISION_SECRET}` } })).json();
  const bearer = { authorization: `Bearer ${provisioned.token}` };
  await first.stop();

  // Restart without escrow: locked until a credential arrives.
  const second = await boot(t, env);
  assert.equal(second.harness.vault.isUnlocked(), false);
  assert.equal((await fetch(`${second.origin}/api/keyslots/escrow`, { method: 'POST', headers: bearer })).status, 201);
  assert.equal((await (await fetch(`${second.origin}/api/health`)).json()).locked, false);
  await second.stop();

  // Restart with escrow enabled: unlocked at boot.
  const third = await boot(t, env);
  assert.equal(third.harness.vault.isUnlocked(), true);
  assert.equal(third.harness.vault.status().unlockedVia, 'escrow');
  await third.stop();

  // The same volume on a node without the KEK stays locked.
  const elsewhere = await boot(t, { ...env, AMAIL_ESCROW_KEY: undefined });
  assert.equal(elsewhere.harness.vault.isUnlocked(), false);
  await elsewhere.stop();
});
