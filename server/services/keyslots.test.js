import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createKeyslotStore,
  generateDek,
  generateRecoveryCode,
  generateToken,
  looksLikeRecoveryCode,
  looksLikeToken,
  normalizeRecoveryCode,
  passkeyStoreFromKeyslots,
  unwrapDek,
  wrapDek,
} from './keyslots.js';

function tempStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-keyslots-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createKeyslotStore({ dataDir }) };
}

test('wrapping stores only ciphertext and unwraps with the exact credential', () => {
  const dek = generateDek();
  const token = generateToken();
  assert.equal(looksLikeToken(token), true);
  const slot = wrapDek(dek, { type: 'token', secret: token, label: 'agent' });
  const serialized = JSON.stringify(slot);
  assert.equal(serialized.includes(dek.toString('base64url')), false);
  assert.equal(serialized.includes(dek.toString('hex')), false);
  assert.equal(serialized.includes(token), false);
  assert.deepEqual(unwrapDek(slot, token), dek);
  assert.equal(unwrapDek(slot, `${token}x`), null);
  assert.equal(unwrapDek(slot, generateToken()), null);
  assert.equal(unwrapDek({ ...slot, id: 'other' }, token), null, 'ciphertext is bound to its slot id');
  assert.equal(unwrapDek({ ...slot, type: 'recovery' }, token), null, 'ciphertext is bound to its slot type');
});

test('recovery codes are forgiving about case, separators, and look-alike characters', () => {
  const code = generateRecoveryCode();
  assert.match(code, /^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/);
  assert.equal(looksLikeRecoveryCode(code), true);
  assert.equal(looksLikeRecoveryCode('short'), false);
  const dek = generateDek();
  const slot = wrapDek(dek, { type: 'recovery', secret: code });
  assert.deepEqual(unwrapDek(slot, code.toLowerCase().replaceAll('-', ' ')), dek);
  assert.equal(normalizeRecoveryCode('abcde-0O1Il'), 'ABCDE00111');
});

test('passphrases are stretched with scrypt and normalized', () => {
  const dek = generateDek();
  const slot = wrapDek(dek, { type: 'passphrase', secret: '  correct horse battery staple  ' });
  assert.equal(slot.kdf, 'scrypt');
  assert.deepEqual(unwrapDek(slot, 'correct horse battery staple'), dek);
  assert.equal(unwrapDek(slot, 'correct horse battery stapl'), null);
});

test('the store writes atomically, re-reads external changes, and protects the last usable slot', (t) => {
  const { dataDir, store } = tempStore(t);
  assert.equal(store.initialized(), false);
  const dek = generateDek();
  const token = wrapDek(dek, { type: 'token', secret: generateToken(), label: 'first' });
  const recovery = wrapDek(dek, { type: 'recovery', secret: generateRecoveryCode() });
  store.add(token);
  store.add(recovery);
  assert.equal(store.initialized(), true);
  assert.equal((fs.statSync(store.filePath).mode & 0o777), 0o600);
  assert.equal(fs.readdirSync(dataDir).some((name) => name.endsWith('.tmp')), false);
  assert.deepEqual(store.list().map((slot) => slot.type), ['token', 'recovery']);
  assert.equal(Object.hasOwn(store.list()[0], 'wrapped'), false);

  assert.equal(store.remove(token.id), true);
  assert.throws(() => store.remove(recovery.id), /last credential/);
  const escrow = wrapDek(dek, { type: 'escrow', secret: 'operator-kek' });
  store.add(escrow);
  assert.throws(() => store.remove(recovery.id), /last credential/, 'escrow does not count as a tenant credential');
  assert.equal(store.remove(escrow.id), true);

  // A second store instance (or an external provisioning step) is visible
  // without restarting because the file is re-read on mtime change.
  const other = createKeyslotStore({ dataDir });
  other.add(wrapDek(dek, { type: 'token', secret: generateToken(), label: 'external' }));
  assert.deepEqual(store.list().map((slot) => slot.label), ['', 'external']);

  const handle = store.userHandle();
  assert.equal(handle.length, 32);
  assert.deepEqual(other.userHandle(), handle);
});

test('the passkey adapter keeps WebAuthn credentials in keyslots without a wrapped DEK until PRF arrives', (t) => {
  const { store } = tempStore(t);
  const dek = generateDek();
  store.add(wrapDek(dek, { type: 'recovery', secret: generateRecoveryCode() }));
  const passkeys = passkeyStoreFromKeyslots(store);
  assert.equal(passkeys.count(), 0);
  const created = passkeys.create({
    id: 'cred-1',
    public_key: Buffer.from([1, 2, 3]),
    counter: 0,
    device_type: 'multiDevice',
    backed_up: 1,
    transports_json: '["internal"]',
    name: 'Laptop',
  });
  assert.equal(created.id, 'cred-1');
  assert.equal(created.canUnlock, false);
  assert.deepEqual(passkeys.getRaw('cred-1').public_key, Buffer.from([1, 2, 3]));
  assert.equal(passkeys.getRaw('cred-1').transports_json, '["internal"]');
  assert.throws(() => passkeys.create({ id: 'cred-1', public_key: Buffer.alloc(1), transports_json: '[]' }), /already registered/);
  passkeys.touch('cred-1', 7);
  assert.equal(passkeys.getRaw('cred-1').counter, 7);
  assert.ok(passkeys.getRaw('cred-1').last_used_at);
  assert.equal(store.list().find((slot) => slot.type === 'passkey').canUnlock, false);
  assert.equal(passkeys.remove('cred-1'), true);
  assert.equal(passkeys.getRaw('cred-1'), null);
  assert.equal(passkeys.remove('missing'), false);
});
