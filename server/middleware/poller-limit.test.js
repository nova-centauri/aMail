import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import {
  MESSAGES_PER_MINUTE,
  SYNC_PER_MINUTE,
  pollerClientKey,
  pollerRateLimit,
  pollerRateLimitEnabled,
  pollerRateLimitedBody,
  retryAfterSeconds,
} from './poller-limit.js';

test('poller limits are on in production and off in tests unless forced', () => {
  assert.equal(pollerRateLimitEnabled({ env: 'production' }), true);
  assert.equal(pollerRateLimitEnabled({ env: 'test' }), false);
  assert.equal(pollerRateLimitEnabled({ env: 'production', pollerRateLimit: false }), false);
  assert.equal(pollerRateLimitEnabled({ env: 'test', pollerRateLimit: true }), true);
});

test('poller keys prefer session cookie, then bearer, then IP', () => {
  assert.equal(
    pollerClientKey({ headers: { cookie: 'amail_session=abc%20123' }, ip: '10.0.0.9' }),
    'session:abc 123',
  );
  assert.equal(
    pollerClientKey({
      headers: { authorization: 'Bearer tok-99' },
      get: () => 'Bearer tok-99',
      ip: '10.0.0.9',
    }),
    'bearer:tok-99',
  );
  assert.match(pollerClientKey({ headers: {}, ip: '127.0.0.1' }), /^ip:/);
});

test('GET /api/messages and POST /api/sync return 429 with Retry-After after the quota', async (t) => {
  const limiter = pollerRateLimit({ limit: 3, windowMs: 60_000 });
  const app = express();
  app.get('/api/messages', limiter, (_request, response) => response.json({ ok: true }));
  app.post('/api/sync', limiter, (_request, response) => response.status(202).json({ accepted: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${origin}/api/messages`);
    assert.equal(response.status, 200);
  }
  const limited = await fetch(`${origin}/api/messages`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), String(retryAfterSeconds(60_000)));
  const body = await limited.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.equal(body.error.retryAfterSec, 60);
  assert.deepEqual(body, pollerRateLimitedBody(60_000));

  const syncLimiterApp = express();
  const syncLimiter = pollerRateLimit({ limit: 2, windowMs: 60_000 });
  syncLimiterApp.post('/api/sync', syncLimiter, (_request, response) => response.status(202).json({ accepted: true }));
  const syncServer = syncLimiterApp.listen(0, '127.0.0.1');
  await once(syncServer, 'listening');
  const syncOrigin = `http://127.0.0.1:${syncServer.address().port}`;
  t.after(() => new Promise((resolve) => syncServer.close(resolve)));
  assert.equal((await fetch(`${syncOrigin}/api/sync`, { method: 'POST' })).status, 202);
  assert.equal((await fetch(`${syncOrigin}/api/sync`, { method: 'POST' })).status, 202);
  const syncLimited = await fetch(`${syncOrigin}/api/sync`, { method: 'POST' });
  assert.equal(syncLimited.status, 429);
  assert.ok(syncLimited.headers.get('retry-after'));

  assert.equal(MESSAGES_PER_MINUTE, 15);
  assert.equal(SYNC_PER_MINUTE, 8);
});
