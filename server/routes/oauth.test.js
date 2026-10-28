import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { accessGate, createAuthenticator } from '../middleware/auth.js';
import { createOAuthProvider } from '../services/oauth-provider.js';
import { registerOAuth } from './oauth.js';

test('Claude custom-connector OAuth flow reaches an authenticated MCP request', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-oauth-route-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = {
    dataDir,
    keyMode: 'env',
    accessToken: 'owner-access-token',
    publicOrigin: null,
    webauthnOrigins: [],
  };
  const oauth = createOAuthProvider({ config });
  const auth = createAuthenticator({ config, oauth });
  const app = express();
  app.use(express.json());
  registerOAuth(app, { auth, oauth });
  app.post('/mcp', accessGate(auth, { challenge: (request) => oauth.challenge(request) }), (_request, response) => {
    response.json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'list_messages' }] } });
  });
  app.get('/api/private', accessGate(auth), (_request, response) => response.json({ private: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const denied = await fetch(`${origin}/mcp`, { method: 'POST' });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.well-known/oauth-protected-resource/mcp`));

  const protectedMetadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`).then((response) => response.json());
  assert.equal(protectedMetadata.resource, `${origin}/mcp`);
  const authorizationMetadata = await fetch(`${origin}/.well-known/oauth-authorization-server`).then((response) => response.json());
  assert.equal(authorizationMetadata.token_endpoint, `${origin}/oauth/token`);

  const registration = await fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = 'v'.repeat(64);
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const authorizationUrl = new URL(`${origin}/oauth/authorize`);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'amail',
    resource: `${origin}/mcp`,
    state: 'route-test',
  });
  const consent = await fetch(authorizationUrl);
  assert.equal(consent.status, 200);
  const consentHtml = await consent.text();
  const transaction = consentHtml.match(/name="transaction" value="([^"]+)"/)?.[1];
  assert.ok(transaction);
  assert.equal(consentHtml.includes('owner-access-token'), false);

  const approval = await fetch(`${origin}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ transaction, decision: 'allow', credential: 'owner-access-token' }),
  });
  assert.equal(approval.status, 303);
  const callback = new URL(approval.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'route-test');

  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code: callback.searchParams.get('code'),
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.ok(tokens.refresh_token, 'Claude receives a refresh token without an OIDC-only offline_access scope');

  const connected = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  assert.equal(connected.status, 200);
  assert.equal((await connected.json()).result.tools[0].name, 'list_messages');
  const restDenied = await fetch(`${origin}/api/private`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  assert.equal(restDenied.status, 401, 'an MCP OAuth token is audience-bound and cannot call the REST API');
});
