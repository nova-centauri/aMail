import assert from 'node:assert/strict';
import test from 'node:test';
import { browserOriginGuard, needsLargeJsonBody } from './request-security.js';

function guardedRequest({
  method = 'POST',
  origin,
  fetchSite,
  authorization,
  host = 'mail.example.test',
  protocol = 'https',
  config = { webauthnOrigins: ['https://mail.example.test'] },
} = {}) {
  const headers = { origin, 'sec-fetch-site': fetchSite, authorization, host };
  const request = {
    method,
    protocol,
    get(name) { return headers[String(name).toLowerCase()] || ''; },
  };
  let nextCalled = false;
  let status = 200;
  let body = null;
  const response = {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  browserOriginGuard(config)(request, response, () => { nextCalled = true; });
  return { nextCalled, status, body };
}

test('browser origin guard blocks cookie-backed sibling and cross-site mutations', () => {
  assert.equal(guardedRequest({ origin: 'https://mail.example.test', fetchSite: 'same-origin' }).nextCalled, true);
  const sibling = guardedRequest({ origin: 'https://evil.example.test', fetchSite: 'same-site' });
  assert.equal(sibling.status, 403);
  assert.equal(sibling.body.error.code, 'ORIGIN_FORBIDDEN');
  assert.equal(guardedRequest({ origin: 'https://mail.example.test', fetchSite: 'cross-site' }).status, 403);
});

test('origin guard preserves non-browser and explicit bearer clients', () => {
  assert.equal(guardedRequest({}).nextCalled, true);
  assert.equal(guardedRequest({
    origin: 'https://client.example.test',
    fetchSite: 'cross-site',
    authorization: 'Bearer explicit-client-token',
  }).nextCalled, true);
});

test('only authenticated attachment-capable routes receive the large JSON parser', () => {
  const request = (method, path) => ({ method, path });
  assert.equal(needsLargeJsonBody(request('POST', '/api/messages')), true);
  assert.equal(needsLargeJsonBody(request('PATCH', '/api/drafts/id')), true);
  assert.equal(needsLargeJsonBody(request('PUT', '/api/accounts/id/avatar')), true);
  assert.equal(needsLargeJsonBody(request('POST', '/mcp')), true);
  assert.equal(needsLargeJsonBody(request('POST', '/api/session')), false);
  assert.equal(needsLargeJsonBody(request('GET', '/api/messages')), false);
});
