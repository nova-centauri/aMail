import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  createDraftAttachmentFetcher,
  hostAllowed,
  isNonPublicAddress,
  parseAuthHeaders,
  parseHostAllowlist,
  resolveAttachmentReferences,
} from './attachment-fetch.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');

// A plain HTTP server stands in for the https host: the fetcher is given
// http.request and the server's port, and DNS answers 127.0.0.1. The address
// check is relaxed for these tests only (isBlockedAddress); the real check
// has its own tests below.
async function localHost(t, handler) {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ host: request.headers.host, url: request.url, headers: request.headers });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, seen };
}

function fetcherFor(port, options = {}) {
  const lookups = [];
  const fetcher = createDraftAttachmentFetcher({
    allowHosts: parseHostAllowlist('files.example.test, *.cdn.example.test'),
    request: http.request,
    port,
    resolveHost: async (hostname) => {
      lookups.push(hostname);
      return [{ address: '127.0.0.1', family: 4 }];
    },
    isBlockedAddress: () => false,
    ...options,
  });
  return { fetcher, lookups };
}

test('allowlist parsing ignores IP literals and junk; wildcards match subdomains only', () => {
  const patterns = parseHostAllowlist(' Files.Example.test ,*.cdn.example.test, 10.0.0.1, localhost, bad host, ');
  assert.deepEqual(patterns, ['files.example.test', '*.cdn.example.test']);
  assert.equal(hostAllowed('files.example.test', patterns), true);
  assert.equal(hostAllowed('FILES.example.test.', patterns), true);
  assert.equal(hostAllowed('evilfiles.example.test', patterns), false);
  assert.equal(hostAllowed('a.cdn.example.test', patterns), true);
  assert.equal(hostAllowed('cdn.example.test', patterns), false);
  assert.equal(hostAllowed('a.cdn.example.test.evil.test', patterns), false);
  assert.equal(hostAllowed('[::1]', patterns), false);
});

test('auth header config keeps only well-formed headers and rejects bad JSON', () => {
  assert.deepEqual(parseAuthHeaders(''), {});
  assert.equal(parseAuthHeaders('{not json'), null);
  assert.deepEqual(parseAuthHeaders(JSON.stringify({
    'WB.example.test': { Authorization: 'Bearer abc', 'Bad Header': 'x', 'X-Split': 'a\r\nb' },
  })), { 'wb.example.test': { authorization: 'Bearer abc' } });
});

test('non-public addresses are refused, including mapped and translated IPv4', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1',
    '0:0:0:0:0:ffff:7f00:1', 'not-an-ip', '',
  ]) assert.equal(isNonPublicAddress(address), true, address);
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:93.184.216.34']) {
    assert.equal(isNonPublicAddress(address), false, address);
  }
});

test('URL attachments are off until the operator lists hosts', async () => {
  const fetcher = createDraftAttachmentFetcher({ allowHosts: [] });
  assert.equal(fetcher.enabled, false);
  await assert.rejects(
    fetcher.fetchAttachment({ url: 'https://files.example.test/q.pdf' }),
    (error) => error.code === 'ATTACHMENT_URLS_DISABLED',
  );
});

test('only https on the standard port, no credentials, listed hosts only', async () => {
  let resolved = 0;
  const fetcher = createDraftAttachmentFetcher({
    allowHosts: ['files.example.test'],
    resolveHost: async () => { resolved += 1; return [{ address: '93.184.216.34', family: 4 }]; },
    request: () => { throw new Error('no request should be made'); },
  });
  const cases = [
    ['http://files.example.test/q.pdf', 'ATTACHMENT_URL_BLOCKED'],
    ['https://user:pw@files.example.test/q.pdf', 'ATTACHMENT_URL_BLOCKED'],
    ['https://files.example.test:8443/q.pdf', 'ATTACHMENT_URL_BLOCKED'],
    ['https://other.example.test/q.pdf', 'ATTACHMENT_HOST_NOT_ALLOWED'],
    ['https://127.0.0.1/q.pdf', 'ATTACHMENT_HOST_NOT_ALLOWED'],
    ['https://[::1]/q.pdf', 'ATTACHMENT_HOST_NOT_ALLOWED'],
    ['file:///etc/passwd', 'ATTACHMENT_URL_BLOCKED'],
    ['not a url', 'ATTACHMENT_URL_INVALID'],
  ];
  for (const [url, code] of cases) {
    await assert.rejects(fetcher.fetchAttachment({ url }), (error) => error.code === code, url);
  }
  assert.equal(resolved, 0, 'rejected before any DNS lookup');
});

test('a listed host that resolves to a private address is never contacted', async () => {
  let requested = false;
  const fetcher = createDraftAttachmentFetcher({
    allowHosts: ['files.example.test'],
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
    request: () => { requested = true; throw new Error('should not connect'); },
  });
  await assert.rejects(
    fetcher.fetchAttachment({ url: 'https://files.example.test/q.pdf' }),
    (error) => error.code === 'ATTACHMENT_URL_PRIVATE_ADDRESS',
  );
  assert.equal(requested, false);
});

test('a PDF is downloaded with its served name, and auth goes only to its own host', async (t) => {
  const { port, seen } = await localHost(t, (_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="Quote 1042.pdf"',
    });
    response.end(PDF);
  });
  const { fetcher } = fetcherFor(port, {
    authHeaders: { 'files.example.test': { authorization: 'Bearer server-side-token' } },
  });
  const file = await fetcher.fetchAttachment({ url: 'https://files.example.test/quotes/1042/pdf?format=proposal&sig=abc' });
  assert.deepEqual(
    { filename: file.filename, contentType: file.contentType, bytes: Buffer.from(file.content, 'base64').equals(PDF) },
    { filename: 'Quote 1042.pdf', contentType: 'application/pdf', bytes: true },
  );
  assert.equal(seen[0].url, '/quotes/1042/pdf?format=proposal&sig=abc');
  assert.equal(seen[0].headers.authorization, 'Bearer server-side-token');
  assert.match(seen[0].host, /^files\.example\.test/);
});

test('the caller can name the file and its type', async (t) => {
  const { port } = await localHost(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(PDF);
  });
  const { fetcher } = fetcherFor(port);
  const file = await fetcher.fetchAttachment({ url: 'https://files.example.test/blob/9', filename: 'Red Hen quote.pdf' });
  assert.equal(file.filename, 'Red Hen quote.pdf');
  assert.equal(file.contentType, 'application/pdf', 'type follows the .pdf name when the server says octet-stream');
});

test('redirects are re-checked: off-list hosts are refused, auth never follows to another host', async (t) => {
  const { port, seen } = await localHost(t, (request, response) => {
    if (request.url === '/to-evil') {
      response.writeHead(302, { location: 'https://evil.example.test/steal' });
      response.end();
    } else if (request.url === '/to-cdn') {
      response.writeHead(302, { location: 'https://a.cdn.example.test/file.pdf' });
      response.end();
    } else if (request.url === '/to-internal') {
      response.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data' });
      response.end();
    } else if (request.url === '/loop') {
      response.writeHead(302, { location: '/loop' });
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end(PDF);
    }
  });
  const { fetcher, lookups } = fetcherFor(port, {
    authHeaders: { 'files.example.test': { authorization: 'Bearer only-for-files' } },
  });
  await assert.rejects(
    fetcher.fetchAttachment({ url: 'https://files.example.test/to-evil' }),
    (error) => error.code === 'ATTACHMENT_HOST_NOT_ALLOWED',
  );
  await assert.rejects(
    fetcher.fetchAttachment({ url: 'https://files.example.test/to-internal' }),
    (error) => error.code === 'ATTACHMENT_HOST_NOT_ALLOWED',
  );
  await assert.rejects(
    fetcher.fetchAttachment({ url: 'https://files.example.test/loop' }),
    (error) => error.code === 'ATTACHMENT_URL_TOO_MANY_REDIRECTS',
  );

  seen.length = 0;
  lookups.length = 0;
  const file = await fetcher.fetchAttachment({ url: 'https://files.example.test/to-cdn' });
  assert.equal(file.filename, 'file.pdf');
  assert.deepEqual(lookups, ['files.example.test', 'a.cdn.example.test'], 'each hop is resolved and checked');
  assert.equal(seen[0].headers.authorization, 'Bearer only-for-files');
  assert.equal(seen[1].headers.authorization, undefined, 'the token is not sent to the redirect target');
});

test('web pages, fake PDFs, empty bodies, errors and oversized files are refused', async (t) => {
  const { port } = await localHost(t, (request, response) => {
    if (request.url === '/login') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html>Sign in</html>');
    } else if (request.url === '/fake.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end('not really a pdf');
    } else if (request.url === '/empty') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end();
    } else if (request.url === '/missing') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('secret upstream detail');
    } else if (request.url === '/declared-big') {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(64) });
      response.end(Buffer.alloc(64));
    } else {
      // No content-length: the cap is enforced while streaming.
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.write(Buffer.alloc(40));
      response.end(Buffer.alloc(40));
    }
  });
  const { fetcher } = fetcherFor(port, { maxBytes: 50 });
  const expect = async (path, code) => assert.rejects(
    fetcher.fetchAttachment({ url: `https://files.example.test${path}` }),
    (error) => {
      assert.equal(error.code, code, path);
      assert.doesNotMatch(error.message, /secret upstream detail/);
      return true;
    },
  );
  await expect('/login', 'ATTACHMENT_URL_NOT_A_FILE');
  await expect('/fake.pdf', 'ATTACHMENT_URL_TYPE_MISMATCH');
  await expect('/empty', 'ATTACHMENT_URL_EMPTY');
  await expect('/missing', 'ATTACHMENT_URL_HTTP_ERROR');
  await expect('/declared-big', 'ATTACHMENT_TOO_LARGE');
  await expect('/streamed-big', 'ATTACHMENT_TOO_LARGE');
});

test('a server that never finishes is cut off at the timeout', async (t) => {
  const { port } = await localHost(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/pdf' });
    response.write('%PDF-');
    // never ends
  });
  const { fetcher } = fetcherFor(port, { timeoutMs: 200 });
  await assert.rejects(
    fetcher.fetchAttachment({ url: 'https://files.example.test/slow.pdf' }),
    (error) => error.code === 'ATTACHMENT_URL_TIMEOUT',
  );
});

test('resolveAttachmentReferences downloads url items and passes others through', async () => {
  const calls = [];
  const fetcher = {
    async fetchAttachment(reference) {
      calls.push(reference);
      return { filename: reference.filename || 'q.pdf', contentType: 'application/pdf', content: PDF.toString('base64') };
    },
  };
  const input = {
    subject: 'Quote',
    attachments: [{ filename: 'kept.txt' }],
    addAttachments: [{ url: 'https://files.example.test/q.pdf', filename: 'Quote.pdf' }],
  };
  const resolved = await resolveAttachmentReferences(input, fetcher);
  assert.deepEqual(resolved.attachments, [{ filename: 'kept.txt' }]);
  assert.equal(resolved.addAttachments[0].filename, 'Quote.pdf');
  assert.equal(resolved.addAttachments[0].url, undefined);
  assert.equal(calls.length, 1);
  assert.equal(input.addAttachments[0].url, 'https://files.example.test/q.pdf', 'the caller\'s input is not mutated');

  assert.equal(await resolveAttachmentReferences({ subject: 'x' }, null).then((value) => value.subject), 'x');
  await assert.rejects(
    resolveAttachmentReferences({ attachments: [{ url: 'https://files.example.test/q.pdf', content: 'QUJD' }] }, fetcher),
    (error) => error.status === 400,
  );
});
