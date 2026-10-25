import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, createRepositories } from '../db.js';
import { createPasskeyService, webauthnContext } from './passkeys.js';

test('passkey registration and login persist credentials without echoing public keys', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-passkey-'));
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'mail.sqlite'),
    webauthnRpName: 'aMail',
    webauthnRpId: 'localhost',
    webauthnOrigins: ['http://localhost:3080'],
  };
  const database = createDatabase(config);
  const repos = createRepositories(database);
  t.after(() => {
    repos.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const service = createPasskeyService({
    config,
    repos,
    generateRegistration: async () => ({ challenge: 'reg-challenge', rp: { id: 'localhost' } }),
    verifyRegistration: async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-1',
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: ['internal'],
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    }),
    generateAuthentication: async () => ({ challenge: 'login-challenge' }),
    verifyAuthentication: async () => ({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    }),
  });

  const request = {
    get(name) {
      if (name === 'host') return 'localhost:3080';
      return '';
    },
  };

  const options = await service.registrationOptions(request);
  assert.ok(options.challengeId);
  assert.equal(options.options.challenge, 'reg-challenge');

  const registered = await service.register(request, {
    challengeId: options.challengeId,
    name: 'Laptop',
    response: { id: 'cred-1' },
  });
  assert.equal(registered.verified, true);
  assert.equal(registered.passkey.name, 'Laptop');
  assert.equal(registered.passkey.id, 'cred-1');
  assert.equal(Object.hasOwn(registered.passkey, 'publicKey'), false);
  assert.equal(service.count(), 1);

  const login = await service.loginOptions(request);
  const verified = await service.login(request, {
    challengeId: login.challengeId,
    response: { id: 'cred-1' },
  });
  assert.equal(verified.verified, true);
  assert.equal(repos.passkeys.getRaw('cred-1').counter, 1);
  assert.equal(service.remove('cred-1'), true);
  assert.equal(service.count(), 0);
});

test('WebAuthn derives forwarded host/protocol only when the proxy is trusted', () => {
  const request = {
    protocol: 'https',
    get(name) {
      if (name === 'host') return '192.0.2.15:3080';
      if (name === 'x-forwarded-host') return 'mail.attacker.example';
      if (name === 'x-forwarded-proto') return 'http';
      return '';
    },
  };
  const derived = webauthnContext(request, {
    trustProxy: false, webauthnRpId: '', webauthnOrigins: [], webauthnRpName: 'aMail',
  });
  assert.equal(derived.rpID, '192.0.2.15');
  assert.equal(derived.origin, 'https://192.0.2.15:3080');

  const trusted = webauthnContext(request, {
    trustProxy: true, webauthnRpId: '', webauthnOrigins: [], webauthnRpName: 'aMail',
  });
  assert.equal(trusted.rpID, 'mail.attacker.example');
  assert.equal(trusted.origin, 'http://mail.attacker.example');

  const pinned = webauthnContext(request, {
    trustProxy: false,
    webauthnRpId: 'mail.example.test',
    webauthnOrigins: ['https://mail.example.test'],
    webauthnRpName: 'aMail',
  });
  assert.equal(pinned.rpID, 'mail.example.test');
  assert.equal(pinned.origin, 'https://mail.example.test');
  assert.deepEqual(pinned.origins, ['https://mail.example.test']);
});
