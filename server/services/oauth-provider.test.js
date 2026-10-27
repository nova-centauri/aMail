import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOAuthProvider } from './oauth-provider.js';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-oauth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = {
    dataDir,
    keyMode: 'env',
    accessToken: 'owner-secret',
    publicOrigin: 'https://mail.example.test',
    webauthnOrigins: ['https://mail.example.test'],
  };
  const provider = createOAuthProvider({ config });
  const request = { protocol: 'https', get: (name) => (name === 'host' ? 'internal.invalid' : '') };
  return { dataDir, config, provider, request };
}

function registerClaude(provider) {
  return provider.registerClient({
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

test('OAuth discovery points Claude at the exact protected MCP resource', (t) => {
  const { provider, request } = setup(t);
  assert.deepEqual(provider.protectedResourceMetadata(request), {
    resource: 'https://mail.example.test/mcp',
    authorization_servers: ['https://mail.example.test'],
    scopes_supported: ['amail'],
    bearer_methods_supported: ['header'],
    resource_name: 'aMail MCP connector',
  });
  const metadata = provider.authorizationServerMetadata(request);
  assert.equal(metadata.issuer, 'https://mail.example.test');
  assert.equal(metadata.registration_endpoint, 'https://mail.example.test/oauth/register');
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(metadata.revocation_endpoint_auth_methods_supported, ['none']);
  assert.match(provider.challenge(request), /resource_metadata="https:\/\/mail\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test('DCR + authorization code + PKCE issues, refreshes, and revokes connector tokens', (t) => {
  const { dataDir, config, provider, request } = setup(t);
  const client = registerClaude(provider);
  assert.match(client.client_id, /^amail_client_/);
  const verifier = 'a'.repeat(64);
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const authorization = provider.beginAuthorization({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Claude follows the resource challenge and requests the MCP scope. A
    // generic OAuth client does not need OIDC's `offline_access` scope in
    // order to receive the refresh token it registered for.
    scope: 'amail',
    resource: 'https://mail.example.test/mcp',
    state: 'claude-state',
  }, request);
  const callback = new URL(provider.finishAuthorization(authorization.id, { approved: true }));
  assert.equal(callback.origin + callback.pathname, client.redirect_uris[0]);
  assert.equal(callback.searchParams.get('state'), 'claude-state');
  assert.equal(callback.searchParams.get('iss'), 'https://mail.example.test');

  const tokens = provider.exchangeToken({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code: callback.searchParams.get('code'),
    code_verifier: verifier,
    resource: 'https://mail.example.test/mcp',
  });
  assert.match(tokens.access_token, /^amo1_/);
  assert.match(tokens.refresh_token, /^amr1_/);
  assert.equal(tokens.scope, 'amail');
  assert.equal(provider.verifyAccessToken(tokens.access_token), true);

  const restarted = createOAuthProvider({ config });
  assert.equal(restarted.verifyAccessToken(tokens.access_token, request), true, 'hashed grants survive a server restart');
  const refreshed = restarted.exchangeToken({
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource: 'https://mail.example.test/mcp',
  });
  assert.notEqual(refreshed.access_token, tokens.access_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token, 'public-client refresh tokens rotate');
  assert.throws(() => provider.exchangeToken({
    grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token,
  }), (error) => error.code === 'invalid_grant');

  restarted.revoke(refreshed.access_token);
  assert.equal(provider.verifyAccessToken(refreshed.access_token), false);
  const statePath = path.join(dataDir, 'oauth.json');
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  const serialized = fs.readFileSync(statePath, 'utf8');
  for (const secret of [callback.searchParams.get('code'), tokens.access_token, tokens.refresh_token, refreshed.access_token, refreshed.refresh_token]) {
    assert.equal(serialized.includes(secret), false, 'OAuth state stores only credential hashes');
  }
});

test('OAuth rejects unsafe redirects and a bad PKCE exchange', (t) => {
  const { provider, request } = setup(t);
  assert.throws(() => provider.registerClient({
    redirect_uris: ['http://attacker.example/callback'],
  }), (error) => error.code === 'invalid_redirect_uri');
  const client = registerClaude(provider);
  const verifier = 'b'.repeat(64);
  const authorization = provider.beginAuthorization({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    code_challenge_method: 'S256',
  }, request);
  const callback = new URL(provider.finishAuthorization(authorization.id, { approved: true }));
  assert.throws(() => provider.exchangeToken({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code: callback.searchParams.get('code'),
    code_verifier: 'c'.repeat(64),
  }), (error) => error.code === 'invalid_grant');
});

test('keyslot OAuth credentials are purpose-bound wrappers that can unlock on later requests', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-oauth-keyslot-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const slots = new Map();
  const removed = [];
  const vault = {
    isUnlocked: () => true,
    addTokenSlot(options) {
      const token = `amk1_${crypto.randomBytes(32).toString('base64url')}`;
      const slot = { id: crypto.randomUUID(), options, token };
      slots.set(token, slot);
      return { token, slot };
    },
    authenticateToken(token, options) {
      return slots.get(token)?.options.oauth.kind === options.oauthKind ? slots.get(token).id : null;
    },
    removeSlot(id) {
      removed.push(id);
      for (const [token, slot] of slots) if (slot.id === id) slots.delete(token);
      return true;
    },
  };
  const provider = createOAuthProvider({
    config: {
      dataDir,
      keyMode: 'keyslot',
      accessToken: null,
      publicOrigin: 'https://mail.example.test',
      webauthnOrigins: ['https://mail.example.test'],
    },
    vault,
  });
  const request = { protocol: 'https', get: () => 'mail.example.test' };
  const client = registerClaude(provider);
  const verifier = 'd'.repeat(64);
  const transaction = provider.beginAuthorization({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    code_challenge_method: 'S256',
    scope: 'amail',
  }, request);
  const callback = new URL(provider.finishAuthorization(transaction.id, { approved: true }));
  const tokens = provider.exchangeToken({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code: callback.searchParams.get('code'),
    code_verifier: verifier,
  });
  assert.match(tokens.access_token, /^amk1_/);
  assert.equal(slots.get(tokens.access_token).options.hidden, true);
  assert.equal(slots.get(tokens.access_token).options.oauth.kind, 'access');
  assert.equal(slots.get(tokens.refresh_token).options.oauth.kind, 'refresh');
  assert.equal(provider.verifyAccessToken(tokens.access_token), true);

  const refreshed = provider.exchangeToken({
    grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token,
  });
  assert.ok(removed.length >= 1, 'rotating a refresh token removes its old keyslot wrapper');
  assert.equal(provider.verifyAccessToken(refreshed.access_token), true);
});
