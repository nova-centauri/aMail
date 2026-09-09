import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable } from 'node:stream';
import { loadConfig } from './config.js';
import {
  createLogger,
  errorSerializer,
  normalizeLogLevel,
  requestSerializer,
  responseSerializer,
  scrubLogText,
} from './logging.js';

function captureLogger(config) {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  return { logger: createLogger(config, {}, stream), lines };
}

test('LOG_LEVEL falls back to info and accepts the hosted error-only profile', () => {
  assert.equal(normalizeLogLevel(undefined), 'info');
  assert.equal(normalizeLogLevel('verbose'), 'info');
  assert.equal(normalizeLogLevel(' ERROR '), 'error');
  assert.equal(loadConfig({}).logLevel, 'info');
  assert.equal(loadConfig({ LOG_LEVEL: 'error' }).logLevel, 'error');
  assert.equal(loadConfig({ LOG_LEVEL: 'nonsense' }).logLevel, 'info');
});

test('log text scrubbing removes addresses, credentials, and query strings but keeps prose', () => {
  assert.equal(scrubLogText('Login failed for ada.lovelace@example.test'), 'Login failed for [email]');
  assert.equal(scrubLogText('AUTHENTICATE failed password=hunter2 token: abc.def'), 'AUTHENTICATE failed password=[redacted] token: [redacted]');
  assert.equal(scrubLogText('header Authorization: Bearer eyJhbGciOi.payload'), 'header Authorization: [redacted]');
  assert.equal(scrubLogText('sent Bearer eyJhbGciOi.payload upstream'), 'sent Bearer [redacted] upstream');
  assert.equal(scrubLogText('GET /api/messages?q=from%3Aada+secret+deal failed'), 'GET /api/messages?[query] failed');
  assert.equal(scrubLogText('Did the server respond?'), 'Did the server respond?');
  assert.equal(scrubLogText('access token required.'), 'access token required.');
  assert.equal(scrubLogText('x'.repeat(2000)).length <= 601, true);
});

test('error serializer keeps only structural fields and scrubs their text', () => {
  const upstream = new Error('SMTP 535 rejected user ada@example.test password=hunter2');
  upstream.code = 'EAUTH';
  upstream.status = 503;
  upstream.response = '535 5.7.8 Username and Password not accepted for ada@example.test';
  upstream.command = 'AUTH PLAIN QWRhIHNlY3JldA==';
  const serialized = errorSerializer(upstream);
  assert.deepEqual(Object.keys(serialized).sort(), ['code', 'message', 'stack', 'status', 'type']);
  assert.equal(serialized.message, 'SMTP 535 rejected user [email] password=[redacted]');
  assert.equal(serialized.code, 'EAUTH');
  assert.equal(JSON.stringify(serialized).includes('QWRhIHNlY3JldA'), false);
  assert.equal(JSON.stringify(serialized).includes('example.test'), false);
  assert.equal(errorSerializer('plain text ada@example.test').message, 'plain text [email]');
});

test('request and response serializers drop query strings, headers, and ports', () => {
  const request = {
    id: 7,
    method: 'GET',
    url: '/api/messages?q=from%3Aada&token=capability',
    headers: { authorization: 'Bearer secret', cookie: 'amail_session=secret' },
    socket: { remoteAddress: '10.0.0.5', remotePort: 51234 },
  };
  assert.deepEqual(requestSerializer(request), { id: 7, method: 'GET', url: '/api/messages', remoteAddress: '10.0.0.5' });
  assert.deepEqual(responseSerializer({ statusCode: 500, getHeaders: () => ({ 'set-cookie': 'amail_session=secret' }) }), { statusCode: 500 });
});

test('the error-only profile emits nothing below error and scrubs what it does emit', () => {
  const { logger, lines } = captureLogger({ logLevel: 'error' });
  logger.info({ subject: 'Quarterly numbers' }, 'Request completed');
  logger.warn({ accountId: 'a1' }, 'IMAP sync failed');
  assert.equal(lines.length, 0);
  const error = new Error('Could not sync ada@example.test: password=hunter2');
  logger.error({ err: error, path: '/api/messages', status: 500, reqId: 3, headers: { cookie: 'x' } }, 'Request failed');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 50);
  assert.equal(lines[0].path, '/api/messages');
  assert.equal(lines[0].status, 500);
  assert.equal(lines[0].err.message, 'Could not sync [email]: password=[redacted]');
  assert.equal(Object.hasOwn(lines[0], 'headers'), false);
  const raw = JSON.stringify(lines[0]);
  assert.equal(raw.includes('hunter2'), false);
  assert.equal(raw.includes('example.test'), false);
});
