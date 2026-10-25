import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCapabilityToken,
  createSignedToken,
  decryptJson,
  encryptJson,
  readCapabilityToken,
  readSignedToken,
} from './crypto.js';

const key = Buffer.alloc(32, 7);

test('encrypted credentials round-trip and reject tampering', () => {
  const encrypted = encryptJson({ username: 'mail@example.test', password: 'not-in-logs' }, key);
  assert.doesNotMatch(encrypted, /not-in-logs/);
  assert.deepEqual(decryptJson(encrypted, key), { username: 'mail@example.test', password: 'not-in-logs' });
  const tampered = encrypted.split('.');
  const last = tampered.at(-1);
  tampered[tampered.length - 1] = `${last.slice(0, -1)}${last.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => decryptJson(tampered.join('.'), key), { code: 'CREDENTIAL_DECRYPTION_FAILED' });
});

test('signed remote-content tokens reject a changed signature', () => {
  assert.throws(() => readSignedToken('payload.invalid', key), { code: 'VALIDATION_ERROR' });
});

test('capability tokens conceal their payload, reject tampering, and accept in-flight legacy tokens', () => {
  const payload = {
    v: 1,
    m: 'private-message-id',
    u: 'https://tracker.example/pixel.png?recipient=private@example.test',
    e: 2_000_000_000,
  };
  const token = createCapabilityToken(payload, key);
  assert.match(token, /^v2\./);
  assert.doesNotMatch(token, /private|tracker|recipient/i);
  assert.deepEqual(readCapabilityToken(token, key), payload);

  const changed = token.split('.');
  const ciphertext = changed.at(-1);
  changed[changed.length - 1] = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;
  assert.throws(() => readCapabilityToken(changed.join('.'), key), { code: 'VALIDATION_ERROR' });

  const legacy = createSignedToken(payload, key);
  assert.deepEqual(readCapabilityToken(legacy, key), payload);
});
