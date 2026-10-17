import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  clientIp,
  clientUserAgent,
  isPollerPath,
  requestTiming,
  requestTimingFields,
  shouldLogRequestTiming,
} from './request-timing.js';

test('poller paths are identified without treating every API route as a poller', () => {
  assert.equal(isPollerPath('/api/messages'), true);
  assert.equal(isPollerPath('/api/messages/abc'), true);
  assert.equal(isPollerPath('/api/changes'), true);
  assert.equal(isPollerPath('/api/sync'), true);
  assert.equal(isPollerPath('/api/health'), false);
  assert.equal(isPollerPath('/api/accounts'), false);
});

test('slow requests always log; poller samples are rate-limited', () => {
  assert.deepEqual(shouldLogRequestTiming('/api/health', 250), { log: true, event: 'slow_request' });
  assert.deepEqual(shouldLogRequestTiming('/api/messages', 12, { random: () => 0.01 }), { log: true, event: 'poller_sample' });
  assert.deepEqual(shouldLogRequestTiming('/api/messages', 12, { random: () => 0.9 }), { log: false, event: null });
  assert.deepEqual(shouldLogRequestTiming('/api/health', 12, { random: () => 0 }), { log: false, event: null });
});

test('timing fields keep the path, user-agent, and forwarded IP and drop query strings', () => {
  const fields = requestTimingFields({
    method: 'GET',
    originalUrl: '/api/messages?folder=inbox&q=from%3Aada',
    headers: {
      'user-agent': 'Mozilla/5.0 aMail-web',
      'x-forwarded-for': '203.0.113.9, 10.0.0.2',
    },
    ip: '10.0.0.8',
  }, { statusCode: 200 }, 312.6);
  assert.deepEqual(fields, {
    method: 'GET',
    path: '/api/messages',
    status: 200,
    durationMs: 313,
    userAgent: 'Mozilla/5.0 aMail-web',
    ip: '203.0.113.9',
  });
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(clientUserAgent({ headers: {} }), '');
});

test('requestTiming emits one info line for a slow poller request', async () => {
  const lines = [];
  const request = {
    method: 'GET',
    originalUrl: '/api/messages?folder=inbox',
    headers: { 'user-agent': 'vitest', 'x-forwarded-for': '198.51.100.4' },
    log: { info(fields, message) { lines.push({ fields, message }); } },
  };
  const response = new EventEmitter();
  response.statusCode = 200;
  requestTiming({
    slowMs: 50,
    now: (() => {
      let tick = 0n;
      return () => {
        tick += 80_000_000n;
        return tick;
      };
    })(),
  })(request, response, () => {});
  response.emit('finish');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'Slow request');
  assert.equal(lines[0].fields.event, 'slow_request');
  assert.equal(lines[0].fields.path, '/api/messages');
  assert.equal(lines[0].fields.ip, '198.51.100.4');
  assert.equal(lines[0].fields.userAgent, 'vitest');
  assert.equal(Object.hasOwn(lines[0].fields, 'headers'), false);
});
