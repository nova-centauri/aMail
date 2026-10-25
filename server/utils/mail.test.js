import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountConnection,
  buildAuth,
  discoverAccountProvider,
  mailProviderCatalog,
  normalizeMailHost,
  recipientList,
  recipientsToHeader,
} from './mail.js';

test('hosted providers are discovered from email domains and use safe presets', () => {
  assert.deepEqual(discoverAccountProvider('person@gmail.com'), {
    provider: 'gmail',
    confidence: 'domain',
    reason: 'Known gmail email domain.',
  });
  assert.deepEqual(accountConnection({ email: 'person@gmail.com' }), {
    provider: 'gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  });
  assert.deepEqual(accountConnection({ email: 'person@icloud.com', provider: 'icloud' }), {
    provider: 'icloud',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
  });
});

test('Mail-in-a-Box accepts one TLS hostname for IMAP and submission', () => {
  assert.deepEqual(discoverAccountProvider({ email: 'person@example.test', serverHost: 'box.example.test' }), {
    provider: 'mailinabox',
    confidence: 'server-pattern',
    reason: 'Mail-in-a-Box commonly uses a box.* TLS hostname.',
  });
  assert.deepEqual(accountConnection({
    email: 'person@example.test',
    provider: 'mail-in-a-box',
    serverHost: 'BOX.EXAMPLE.TEST.',
  }), {
    provider: 'mailinabox',
    imap: { host: 'box.example.test', port: 993, secure: true },
    smtp: { host: 'box.example.test', port: 587, secure: false },
  });
});

test('custom settings normalize booleans and reject URL-shaped hosts', () => {
  assert.deepEqual(accountConnection({
    provider: 'custom',
    imap: { host: 'mail.example.test', port: '143', secure: 'false' },
    smtp: { host: 'mail.example.test', port: '587', secure: 'false' },
  }), {
    provider: 'custom',
    imap: { host: 'mail.example.test', port: 143, secure: false },
    smtp: { host: 'mail.example.test', port: 587, secure: false },
  });
  assert.throws(() => normalizeMailHost('https://mail.example.test'), { code: 'VALIDATION_ERROR' });
  assert.throws(() => accountConnection({ provider: 'made-up' }), { code: 'VALIDATION_ERROR' });
});

test('protocol-specific usernames and passwords override shared credentials', () => {
  const credentials = {
    username: 'shared@example.test',
    password: 'shared-password',
    imapUsername: 'incoming-user',
    imapPassword: 'incoming-password',
    smtpUsername: 'outgoing@example.test',
    smtpPassword: 'outgoing-password',
  };
  assert.deepEqual(buildAuth(credentials, 'fallback@example.test', 'imap'), {
    user: 'incoming-user',
    pass: 'incoming-password',
  });
  assert.deepEqual(buildAuth(credentials, 'fallback@example.test', 'smtp'), {
    user: 'outgoing@example.test',
    pass: 'outgoing-password',
  });
  assert.deepEqual(buildAuth({ password: 'mailbox-password' }, 'fallback@example.test', 'imap'), {
    user: 'fallback@example.test',
    pass: 'mailbox-password',
  });
});

test('provider catalog exposes setup metadata but no credentials', () => {
  const catalog = mailProviderCatalog();
  assert.ok(catalog.some((provider) => provider.id === 'gmail'));
  assert.ok(catalog.some((provider) => provider.id === 'icloud'));
  assert.ok(catalog.some((provider) => provider.id === 'mailinabox' && provider.requiresServerHost));
  assert.doesNotMatch(JSON.stringify(catalog), /password\s*[:=]/i);
});

test('recipient headers reject controls and ambiguous addresses', () => {
  assert.throws(() => recipientList([{ name: 'Visible\r\nBcc: hidden@example.test', email: 'visible@example.test' }], 'To'), {
    code: 'VALIDATION_ERROR',
  });
  assert.throws(() => recipientList(['first@example.test; second@example.test'], 'To'), {
    code: 'VALIDATION_ERROR',
  });
  assert.throws(() => recipientList([`${'a'.repeat(310)}@example.test`], 'To'), {
    code: 'VALIDATION_ERROR',
  });
  assert.equal(
    recipientsToHeader([{ name: 'A "quoted" \\ name', email: 'person@example.test' }]),
    '"A \\"quoted\\" \\\\ name" <person@example.test>',
  );
});
