import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  clientIp,
  clientUserAgent,
  isPollerPath,
  requestStartFields,
  requestTiming,
  requestTimingFields,
  sanitizeMessagesQuery,
  shouldLogRequestTiming,
} from './request-timing.js';
import { createInFlightRegistry } from '../services/in-flight-requests.js';

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
  assert.equal(lines.length, 2);
  assert.equal(lines[0].message, 'Request started');
  assert.equal(lines[0].fields.event, 'request_start');
  assert.equal(lines[0].fields.path, '/api/messages');
  assert.equal(lines[1].message, 'Slow request');
  assert.equal(lines[1].fields.event, 'slow_request');
  assert.equal(lines[1].fields.path, '/api/messages');
  assert.equal(lines[1].fields.ip, '198.51.100.4');
  assert.equal(lines[1].fields.userAgent, 'vitest');
  assert.equal(Object.hasOwn(lines[1].fields, 'headers'), false);
  assert.equal(Object.hasOwn(lines[1].fields, 'query'), false);
});

test('sanitizeMessagesQuery keeps folder/page/operators and drops search text', () => {
  const sanitized = sanitizeMessagesQuery({
    folder: 'inbox',
    page: '3',
    pageSize: '60',
    category: 'github_ci',
    q: 'from:ada@example.test invoice secret-deal',
    flag: 'ada',
    accountId: 'acct-1',
    mailbox: 'INBOX',
  });
  assert.deepEqual(sanitized, {
    folder: 'inbox',
    page: 3,
    pageSize: 60,
    category: 'github_ci',
    hasQuery: true,
    queryChars: 'from:ada@example.test invoice secret-deal'.length,
    operators: ['from', 'text'],
    hasFlag: true,
    hasAccountId: true,
    mailbox: 'INBOX',
  });
  assert.equal(JSON.stringify(sanitized).includes('ada@example.test'), false);
  assert.equal(JSON.stringify(sanitized).includes('secret-deal'), false);
});

test('GET /api/messages slower than 500ms logs sanitized query params', () => {
  const lines = [];
  const request = {
    method: 'GET',
    originalUrl: '/api/messages?folder=inbox&q=from%3Aada@example.test',
    query: { folder: 'inbox', q: 'from:ada@example.test quarterly numbers' },
    headers: { 'user-agent': 'vitest' },
    log: { info(fields, message) { lines.push({ fields, message }); } },
  };
  const response = new EventEmitter();
  response.statusCode = 200;
  requestTiming({
    slowMs: 50,
    now: (() => {
      let tick = 0n;
      return () => {
        tick += 600_000_000n;
        return tick;
      };
    })(),
  })(request, response, () => {});
  response.emit('finish');
  const slow = lines.find((line) => line.fields.event === 'slow_request');
  assert.ok(slow);
  assert.equal(slow.fields.path, '/api/messages');
  assert.ok(slow.fields.durationMs >= 500);
  assert.equal(slow.fields.query.folder, 'inbox');
  assert.equal(slow.fields.query.hasQuery, true);
  assert.deepEqual(slow.fields.query.operators, ['from', 'text']);
  assert.equal(JSON.stringify(slow.fields).includes('ada@example.test'), false);
  assert.equal(JSON.stringify(slow.fields).includes('quarterly'), false);
});

test('request start records MCP tool name and leaves an in-flight row until finish', () => {
  const lines = [];
  const inFlight = createInFlightRegistry();
  const request = {
    id: 'req_mcp_1',
    method: 'POST',
    originalUrl: '/mcp',
    body: { method: 'tools/call', params: { name: 'get_thread', arguments: { id: 't1' } } },
    headers: {},
    log: { info(fields, message) { lines.push({ fields, message }); } },
  };
  const response = new EventEmitter();
  response.statusCode = 200;
  requestTiming({ inFlight, now: () => 0n })(request, response, () => {});
  assert.equal(lines[0].fields.mcpTool, 'get_thread');
  assert.equal(inFlight.list()[0].mcpTool, 'get_thread');
  response.emit('finish');
  assert.equal(inFlight.size(), 0);
});

test('requestStartFields never copies MCP arguments', () => {
  const fields = requestStartFields({
    id: 'r1',
    method: 'POST',
    originalUrl: '/mcp',
    body: { method: 'tools/call', params: { name: 'list_messages', arguments: { q: 'from:ada' } } },
  });
  assert.equal(fields.mcpTool, 'list_messages');
  assert.equal(JSON.stringify(fields).includes('from:ada'), false);
});
