import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories, isPlaintextSqliteFile } from './db.js';
import { createKeyslotStore, passkeyStoreFromKeyslots } from './services/keyslots.js';
import { HarnessLockedError, HarnessUninitializedError, createVault, deriveRuntimeKeys, lazyProxy } from './vault.js';

const silent = { info() {}, warn() {}, error() {} };

function setup(t, configExtra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-vault-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = { dataDir, dbPath: path.join(dataDir, 'amail.sqlite'), keyMode: 'keyslot', escrowKey: null, ...configExtra };
  const keyslots = createKeyslotStore({ dataDir });
  const events = [];
  const vault = createVault({
    config,
    keyslots,
    logger: silent,
    buildRuntime(keys) {
      const runtimeConfig = { ...config, ...keys };
      const repos = createRepositories(createDatabase(runtimeConfig));
      return { config: runtimeConfig, repos, mailService: { ping: () => 'pong' }, remoteContent: {}, close: () => repos.close() };
    },
    onUnlock: () => events.push('unlock'),
    onLock: (_runtime, reason) => events.push(`lock:${reason}`),
  });
  t.after(() => vault.lock({ reason: 'test' }));
  return { config, keyslots, vault, events };
}

test('runtime keys derive independently from the DEK', () => {
  const dek = Buffer.alloc(32, 7);
  const keys = deriveRuntimeKeys(dek);
  assert.deepEqual(keys.databaseKey, dek);
  assert.equal(keys.credentialKey.length, 32);
  assert.equal(keys.remoteTokenKey.length, 32);
  assert.notDeepEqual(keys.credentialKey, keys.remoteTokenKey);
  assert.notDeepEqual(keys.credentialKey, dek);
  assert.deepEqual(deriveRuntimeKeys(Buffer.alloc(32, 7)).credentialKey, keys.credentialKey);
});

test('a fresh harness is uninitialized, provisions once, and every runtime access is gated on unlock', (t) => {
  const { config, vault, events } = setup(t);
  assert.equal(vault.isInitialized(), false);
  assert.throws(() => vault.runtime.repos.accounts.list(), HarnessUninitializedError);
  assert.throws(() => vault.runtime.config.credentialKey, HarnessUninitializedError);
  assert.equal(vault.runtime.config.dataDir, config.dataDir, 'static settings stay readable while locked');

  const provisioned = vault.init({ label: 'first agent' });
  assert.match(provisioned.token, /^amk1_/);
  assert.match(provisioned.recoveryCode, /^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/);
  assert.deepEqual(provisioned.keyslots.map((slot) => slot.type), ['token', 'recovery']);
  assert.equal(vault.isUnlocked(), true);
  assert.equal(vault.status().locked, false);
  assert.equal(vault.status().unlockedVia, 'provision');
  assert.throws(() => vault.init(), /already provisioned/);

  vault.runtime.repos.settings.set('probe', 'value');
  assert.equal(vault.runtime.repos.settings.get('probe'), 'value');
  assert.equal(vault.runtime.mailService.ping(), 'pong');
  assert.equal(vault.runtime.config.credentialKey.length, 32);
  assert.equal(isPlaintextSqliteFile(config.dbPath), false, 'the database is keyed by the DEK');

  vault.lock({ reason: 'manual' });
  assert.equal(vault.isUnlocked(), false);
  assert.throws(() => vault.runtime.repos.settings.get('probe'), HarnessLockedError);
  assert.throws(() => vault.exportDek(), HarnessLockedError);
  assert.deepEqual(events, ['unlock', 'lock:manual']);

  // Every credential type unlocks; wrong ones do not.
  assert.throws(() => vault.unlockWithSecret('amk1_not-a-real-token-value-0123456789abcdefghijklmnop'), /does not unlock/);
  assert.throws(() => vault.unlockWithSecret(''), /credential is required/);
  assert.equal(vault.isUnlocked(), false);
  const viaToken = vault.unlockWithSecret(provisioned.token);
  assert.equal(viaToken.slot.type, 'token');
  assert.equal(vault.runtime.repos.settings.get('probe'), 'value', 'the same database opens again');
  assert.ok(vault.listSlots()[0].lastUsedAt);
  vault.lock();
  const viaRecovery = vault.unlockWithSecret(provisioned.recoveryCode.toLowerCase());
  assert.equal(viaRecovery.slot.type, 'recovery');
});

test('bearer tokens authenticate by unwrapping, are cached, and stop working once revoked', (t) => {
  const { vault } = setup(t);
  const { token } = vault.init();
  vault.lock();
  assert.equal(vault.authenticateToken('nonsense'), null);
  assert.equal(vault.isUnlocked(), false);
  const slotId = vault.authenticateToken(token);
  assert.ok(slotId);
  assert.equal(vault.isUnlocked(), true, 'a valid bearer unlocks a locked harness');
  assert.equal(vault.authenticateToken(token), slotId, 'cached path');

  const second = vault.addTokenSlot({ label: 'second agent' });
  assert.equal(second.slot.type, 'token');
  assert.equal(vault.authenticateToken(second.token), second.slot.id);
  assert.equal(vault.removeSlot(slotId), true);
  assert.equal(vault.authenticateToken(token), null, 'revoked token is rejected even though it was cached');
  assert.equal(vault.authenticateToken(second.token), second.slot.id);
  assert.equal(vault.removeSlot(second.slot.id), true, 'the recovery code still counts as a usable credential');
  const recovery = vault.listSlots().find((slot) => slot.type === 'recovery');
  assert.throws(() => vault.removeSlot(recovery.id), /Refusing/);
});

test('passphrase, escrow, and passkey slots wrap the same DEK', (t) => {
  const { vault, keyslots } = setup(t, { escrowKey: 'operator-kek-for-this-node' });
  const { token } = vault.init();
  assert.throws(() => vault.addPassphraseSlot({ passphrase: 'short' }), /at least 12/);
  const { slot: passphraseSlot } = vault.addPassphraseSlot({ passphrase: 'a long enough passphrase' });
  assert.equal(passphraseSlot.type, 'passphrase');
  assert.equal(vault.status().escrow, false);
  vault.addEscrowSlot();
  assert.equal(vault.status().escrow, true);
  assert.throws(() => vault.addEscrowSlot(), /already enabled/);

  vault.lock();
  assert.equal(vault.unlockWithSecret('a long enough passphrase').slot.id, passphraseSlot.id);
  vault.lock();
  assert.equal(vault.unlockFromEscrow(), true, 'escrow unlock works when the operator KEK is present');
  assert.equal(vault.status().unlockedVia, 'escrow');
  vault.lock();
  vault.removeSlot(vault.listSlots().find((slot) => slot.type === 'escrow').id);
  assert.equal(vault.unlockFromEscrow(), false, 'without the escrow slot the operator cannot unlock');
  vault.unlockWithSecret(token);

  // Passkey: registered credential first, PRF secret linked afterwards.
  const passkeys = passkeyStoreFromKeyslots(keyslots);
  passkeys.create({ id: 'cred-1', public_key: Buffer.from([9]), counter: 0, transports_json: '[]', name: 'Phone' });
  const prf = Buffer.alloc(32, 5).toString('base64url');
  vault.lock();
  assert.throws(() => vault.unlockWithPasskey('cred-1', prf), /not been linked/);
  vault.unlockWithSecret(token);
  assert.throws(() => vault.completePasskeySlot('cred-1', 'tooshort'), /PRF secret/);
  const completed = vault.completePasskeySlot('cred-1', prf);
  assert.equal(completed.slot.canUnlock, true);
  vault.lock();
  assert.throws(() => vault.unlockWithPasskey('cred-1', Buffer.alloc(32, 6).toString('base64url')), /does not unlock/);
  assert.equal(vault.unlockWithPasskey('cred-1', prf).slot.passkeyId, 'cred-1');
  assert.equal(vault.status().unlockedVia, 'passkey');
});

test('a handed-off DEK unlocks without any keyslot credential', (t) => {
  const { vault } = setup(t);
  vault.init();
  const dek = vault.exportDek();
  vault.lock();
  assert.throws(() => vault.unlockWithDek(Buffer.alloc(32, 1), { via: 'handoff' }), /could not be opened/, 'a wrong DEK cannot open the database');
  assert.equal(vault.isUnlocked(), false);
  vault.unlockWithDek(dek, { via: 'handoff' });
  assert.equal(vault.status().unlockedVia, 'handoff');
  assert.throws(() => vault.unlockWithDek(Buffer.alloc(32, 2)), /different DEK/);
});

test('lazyProxy resolves on every access and binds methods to the live target', () => {
  let target = null;
  const proxy = lazyProxy(() => {
    if (!target) throw new HarnessLockedError();
    return target;
  });
  assert.throws(() => proxy.nested.value, HarnessLockedError);
  target = { count: 1, nested: { value: 'a' }, increment() { this.count += 1; return this.count; } };
  assert.equal(proxy.count, 1);
  assert.equal(proxy.nested.value, 'a');
  assert.equal(proxy.increment(), 2);
  assert.equal(target.count, 2);
  target = { count: 10, nested: { value: 'b' }, increment() { return 0; } };
  assert.equal(proxy.count, 10);
  assert.equal(proxy.nested.value, 'b');
  assert.equal('count' in proxy, true);
});
