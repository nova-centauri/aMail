import assert from 'node:assert/strict';
import test from 'node:test';
import { simpleParser } from 'mailparser';
import {
  authenticationColumns,
  authservIdTrusted,
  domainsAligned,
  organizationalDomain,
  parseAuthenticationResults,
  parseAuthservIdList,
  publicAuthentication,
  resolveTrustedAuthservIds,
  validateAuthservIdList,
} from './auth-results.js';
import { loadConfig } from '../config.js';

// Header shapes copied from what each kind of server stamps, with fictional
// names and documentation addresses.
const GMAIL = [
  'Authentication-Results: mx.google.com;',
  '       dkim=pass header.i=@news.example.com header.s=s1 header.b="AbC/d=";',
  '       spf=pass (google.com: domain of bounce@mail.example.com designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@mail.example.com;',
  '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com',
];
const MICROSOFT = [
  'Authentication-Results: spf=pass (sender IP is 192.0.2.44)',
  ' smtp.mailfrom=example.org; dkim=pass (signature was verified)',
  ' header.d=example.org;dmarc=bestguesspass action=none',
  ' header.from=example.org;compauth=pass reason=109',
];
const MICROSOFT_ARC = [
  'ARC-Authentication-Results: i=1; mx.microsoft.com 1; spf=pass',
  ' smtp.mailfrom=example.org; dmarc=pass action=none header.from=example.org;',
  ' dkim=pass header.d=example.org; arc=none',
];
const FASTMAIL_STYLE = [
  'Authentication-Results: mx4.mail.example.net;',
  '    dkim=pass (2048-bit rsa key sha256) header.d=shop.example.co.uk',
  '      header.i=@shop.example.co.uk header.b=Zz9 header.a=rsa-sha256 header.s=k1 x-bits=2048;',
  '    dmarc=none policy.published-domain-policy=none header.from=example.co.uk;',
  '    iprev=pass smtp.remote-ip=198.51.100.7 (mta.example.co.uk);',
  '    spf=softfail smtp.mailfrom=bounces@other.example smtp.helo=mta.example.co.uk',
];

async function columnsFor(headers, { from = 'Sender <sender@example.com>', trustedIds = [] } = {}) {
  const source = [...headers, `From: ${from}`, 'To: owner@example.test', 'Subject: Sample', '', 'Body.'].join('\r\n');
  const parsed = await simpleParser(source);
  return authenticationColumns({
    headerLines: parsed.headerLines,
    fromEmail: parsed.from?.value?.[0]?.address || '',
    trustedIds,
  });
}

test('Authentication-Results parsing handles comments, quoting, versions, and a missing authserv-id', () => {
  const gmail = parseAuthenticationResults(GMAIL.join('\r\n').replace(/^Authentication-Results:/, ''));
  assert.equal(gmail.authservId, 'mx.google.com');
  assert.deepEqual(gmail.results.map((item) => [item.method, item.result]), [['dkim', 'pass'], ['spf', 'pass'], ['dmarc', 'pass']]);
  assert.equal(gmail.results[0].props['header.b'], 'AbC/d=');
  assert.equal(gmail.results[1].props['smtp.mailfrom'], 'bounce@mail.example.com');

  const versioned = parseAuthenticationResults(' Example.COM. 1; spf=hardfail smtp.mailfrom=a@b.example; dkim/1=policy header.d=b.example');
  assert.equal(versioned.authservId, 'example.com');
  assert.deepEqual(versioned.results.map((item) => item.result), ['fail', 'fail']);

  const noResult = parseAuthenticationResults('mx.example.net; none');
  assert.deepEqual(noResult, { authservId: 'mx.example.net', results: [] });

  // A semicolon or a fake result inside a comment or a quoted string is not a result.
  const tricky = parseAuthenticationResults('mx.example.net; spf=fail (x; dkim=pass header.d=evil.example) smtp.mailfrom="a;dmarc=pass"@b.example');
  assert.deepEqual(tricky.results.map((item) => [item.method, item.result]), [['spf', 'fail']]);

  const microsoft = parseAuthenticationResults(MICROSOFT.join('\r\n').replace(/^Authentication-Results:/, ''));
  assert.equal(microsoft.authservId, '');
  assert.deepEqual(microsoft.results.map((item) => [item.method, item.result]), [
    ['spf', 'pass'], ['dkim', 'pass'], ['dmarc', 'none'], ['compauth', 'pass'],
  ]);

  const arc = parseAuthenticationResults(MICROSOFT_ARC.join('\r\n').replace(/^ARC-Authentication-Results:/, ''), { arc: true });
  assert.equal(arc.instance, 1);
  assert.equal(arc.authservId, 'mx.microsoft.com');
  assert.equal(parseAuthenticationResults('mx.example.net; spf=pass', { arc: true }), null);
  assert.equal(parseAuthenticationResults(''), null);
  assert.equal(parseAuthenticationResults('mx.example.net; spf=weird').results[0].result, 'unknown');
});

test('header samples produce the stored verdicts', async (t) => {
  const table = [
    {
      name: 'Gmail, trusted by its authserv-id',
      headers: ['Return-Path: <bounce@mail.example.com>', ...GMAIL],
      options: { from: 'News <hello@news.example.com>', trustedIds: ['mx.google.com'] },
      expected: {
        spf: 'pass', dkim: 'pass', dmarc: 'pass', authservId: 'mx.google.com', trusted: true,
        fromAligned: true, dkimDomains: ['news.example.com'], returnPath: 'bounce@mail.example.com',
      },
    },
    {
      name: 'Gmail header with no trusted id configured is stored untrusted',
      headers: GMAIL,
      options: { from: 'hello@news.example.com' },
      expected: {
        spf: 'pass', dkim: 'pass', dmarc: 'pass', authservId: 'mx.google.com', trusted: false,
        fromAligned: true, dkimDomains: ['news.example.com'], returnPath: null,
      },
    },
    {
      name: 'Microsoft 365: no authserv-id on Authentication-Results, so it cannot be trusted by name',
      headers: MICROSOFT,
      options: { from: 'pat@example.org', trustedIds: ['mx.microsoft.com'] },
      expected: {
        spf: 'pass', dkim: 'pass', dmarc: 'none', authservId: null, trusted: false,
        fromAligned: true, dkimDomains: ['example.org'], returnPath: null,
      },
    },
    {
      name: 'Microsoft 365: the ARC header carries mx.microsoft.com and is used when that id is trusted',
      headers: [...MICROSOFT_ARC, ...MICROSOFT],
      options: { from: 'pat@example.org', trustedIds: ['mx.microsoft.com'] },
      expected: {
        spf: 'pass', dkim: 'pass', dmarc: 'pass', authservId: 'mx.microsoft.com', trusted: true,
        fromAligned: true, dkimDomains: ['example.org'], returnPath: null,
      },
    },
    {
      name: 'Fastmail-style per-host id matched by wildcard; DKIM aligns under co.uk, SPF does not',
      headers: ['Return-Path: <bounces@other.example>', ...FASTMAIL_STYLE],
      options: { from: 'orders@example.co.uk', trustedIds: ['*.mail.example.net'] },
      expected: {
        spf: 'softfail', dkim: 'pass', dmarc: 'none', authservId: 'mx4.mail.example.net', trusted: true,
        fromAligned: true, dkimDomains: ['shop.example.co.uk'], returnPath: 'bounces@other.example',
      },
    },
    {
      name: 'forged header on top with another authserv-id is skipped for the trusted one below it',
      headers: [
        'Authentication-Results: mx.evil.example; spf=pass smtp.mailfrom=ceo@example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
        'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=ceo@example.com; dkim=none; dmarc=fail (p=REJECT) header.from=example.com',
      ],
      options: { from: 'ceo@example.com', trustedIds: ['mx.google.com'] },
      expected: {
        spf: 'fail', dkim: 'none', dmarc: 'fail', authservId: 'mx.google.com', trusted: true,
        fromAligned: false, dkimDomains: [], returnPath: null,
      },
    },
    {
      name: 'only a forged header: results are kept but marked untrusted',
      headers: ['Authentication-Results: mx.evil.example; spf=pass smtp.mailfrom=ceo@example.com; dmarc=pass header.from=example.com'],
      options: { from: 'ceo@example.com', trustedIds: ['mx.google.com'] },
      expected: {
        spf: 'pass', dkim: 'none', dmarc: 'pass', authservId: 'mx.evil.example', trusted: false,
        fromAligned: true, dkimDomains: [], returnPath: null,
      },
    },
    {
      name: 'multiple trusted headers: only the topmost counts',
      headers: [
        'Authentication-Results: mx.example.net; spf=pass smtp.mailfrom=a@list.example; dkim=fail header.d=example.com',
        'Authentication-Results: mx.example.net; spf=fail smtp.mailfrom=a@example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
      ],
      options: { from: 'a@example.com', trustedIds: ['mx.example.net'] },
      expected: {
        spf: 'pass', dkim: 'fail', dmarc: 'none', authservId: 'mx.example.net', trusted: true,
        fromAligned: false, dkimDomains: [], returnPath: null,
      },
    },
    {
      name: 'several DKIM signatures: pass wins and only passing domains are listed',
      headers: ['Authentication-Results: mx.example.net; dkim=fail header.d=broken.example; dkim=pass header.d=esp.example; dkim=pass header.i=@Example.COM; spf=none'],
      options: { from: 'a@example.com', trustedIds: ['mx.example.net'] },
      expected: {
        spf: 'none', dkim: 'pass', dmarc: 'none', authservId: 'mx.example.net', trusted: true,
        fromAligned: true, dkimDomains: ['esp.example', 'example.com'], returnPath: null,
      },
    },
    {
      name: 'DMARC pass for a different From domain does not align the displayed From',
      headers: ['Authentication-Results: mx.example.net; dmarc=pass header.from=other.example; dkim=pass header.d=other.example'],
      options: { from: 'a@example.com', trustedIds: ['mx.example.net'] },
      expected: {
        spf: 'none', dkim: 'pass', dmarc: 'pass', authservId: 'mx.example.net', trusted: true,
        fromAligned: false, dkimDomains: ['other.example'], returnPath: null,
      },
    },
    {
      name: 'no Authentication-Results header at all; null reverse-path',
      headers: ['Return-Path: <>'],
      options: { from: 'a@example.com', trustedIds: ['mx.example.net'] },
      expected: {
        spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', authservId: null, trusted: false,
        fromAligned: false, dkimDomains: [], returnPath: '',
      },
    },
  ];
  for (const row of table) {
    await t.test(row.name, async () => {
      assert.deepEqual(publicAuthentication(await columnsFor(row.headers, row.options)), row.expected);
    });
  }
});

test('List-Id and List-Unsubscribe presence are recorded', async () => {
  const columns = await columnsFor([
    'List-Id: Example announcements <announce.lists.example.com>',
    'List-Unsubscribe: <https://lists.example.com/u/1>, <mailto:leave@lists.example.com>',
  ]);
  assert.equal(columns.list_id, 'announce.lists.example.com');
  assert.equal(columns.list_unsubscribe, 1);
  const plain = await columnsFor([]);
  assert.equal(plain.list_id, null);
  assert.equal(plain.list_unsubscribe, 0);
});

test('alignment uses a relaxed organisational-domain heuristic', () => {
  assert.equal(organizationalDomain('a.b.example.com'), 'example.com');
  assert.equal(organizationalDomain('mail.shop.example.co.uk'), 'example.co.uk');
  assert.equal(organizationalDomain('example.com.au'), 'example.com.au');
  assert.equal(organizationalDomain('EXAMPLE.com.'), 'example.com');
  assert.equal(organizationalDomain('user@Mail.Example.com'), 'example.com');
  assert.equal(organizationalDomain('not a domain'), '');
  assert.equal(domainsAligned('bounce.mail.example.com', 'example.com'), true);
  assert.equal(domainsAligned('example.co.uk', 'other.co.uk'), false);
  assert.equal(domainsAligned('example.com', 'example.org'), false);
  assert.equal(domainsAligned('', ''), false);
});

test('trusted authserv-ids combine account, environment, and provider defaults', () => {
  assert.deepEqual(parseAuthservIdList(' MX.Example.com. , *.mail.example.net, bad id, , mx.example.com'), ['mx.example.com', '*.mail.example.net']);
  assert.deepEqual(validateAuthservIdList(['mx.example.com']), ['mx.example.com']);
  assert.deepEqual(validateAuthservIdList('mx.example.com, *.example.net'), ['mx.example.com', '*.example.net']);
  assert.deepEqual(validateAuthservIdList([]), []);
  assert.throws(() => validateAuthservIdList(['mx.example.com', 'not valid!']), /server names/);
  assert.throws(() => validateAuthservIdList(42), /list of server names/);

  assert.equal(authservIdTrusted('MX.Google.com', ['mx.google.com']), true);
  assert.equal(authservIdTrusted('mx2.mail.example.net', ['*.mail.example.net']), true);
  assert.equal(authservIdTrusted('mail.example.net', ['*.mail.example.net']), false);
  assert.equal(authservIdTrusted('evilmx.google.com', ['mx.google.com']), false);
  assert.equal(authservIdTrusted('', ['mx.google.com']), false);

  const config = loadConfig({ AMAIL_TRUSTED_AUTHSERV_IDS: 'mx.global.example, junk value' });
  assert.deepEqual(config.trustedAuthservIds, ['mx.global.example']);
  assert.deepEqual(loadConfig({}).trustedAuthservIds, []);
  assert.deepEqual(resolveTrustedAuthservIds({ provider: 'gmail', trusted_authserv_ids: '["mx.own.example"]' }, config),
    ['mx.own.example', 'mx.global.example', 'mx.google.com']);
  assert.deepEqual(resolveTrustedAuthservIds({ provider: 'custom', trusted_authserv_ids: 'not json' }, {}), []);
  assert.deepEqual(resolveTrustedAuthservIds({ provider: 'outlook', trustedAuthservIds: ['mx.microsoft.com'] }, {}), ['mx.microsoft.com']);
});

test('public authentication is null until a message has been evaluated', () => {
  assert.equal(publicAuthentication({ auth_spf: null }), null);
  assert.equal(publicAuthentication({}), null);
  assert.deepEqual(publicAuthentication({
    auth_spf: 'pass', auth_dkim: 'bogus', auth_dmarc: 'fail', auth_authserv_id: 'mx.example.net',
    auth_trusted: 1, auth_dkim_domains: 'not json', auth_from_aligned: 0, return_path: 'a@example.com',
  }), {
    spf: 'pass', dkim: 'unknown', dmarc: 'fail', authservId: 'mx.example.net', trusted: true,
    fromAligned: false, dkimDomains: [], returnPath: 'a@example.com',
  });
});
