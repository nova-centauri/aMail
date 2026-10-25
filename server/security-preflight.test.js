import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../deploy/security-preflight.sh', import.meta.url));

test('security preflight reports secret state without disclosing values', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-preflight-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const encryptionKey = `encryption-${'a'.repeat(48)}`;
  const accessToken = `access-${'b'.repeat(48)}`;
  const typesenseKey = `typesense-${'c'.repeat(48)}`;
  fs.writeFileSync(path.join(fixture, '.env'), [
    `AMAIL_ENCRYPTION_KEY=${encryptionKey}`,
    `AMAIL_ACCESS_TOKEN=${accessToken}`,
    `TYPESENSE_API_KEY=${typesenseKey}`,
    'AMAIL_ENCRYPT_DATABASE=true',
    '',
  ].join('\n'), { mode: 0o600 });

  const result = spawnSync('sh', [script, fixture], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /secret\.encryption-key=present-and-at-least-32-chars/);
  assert.match(result.stdout, /secret\.access-token=present-and-at-least-32-chars/);
  assert.match(result.stdout, /secret\.typesense-api-key=present-and-at-least-32-chars/);
  assert.match(result.stdout, /env\.AMAIL_ENCRYPT_DATABASE=true/);
  assert.equal(result.stdout.includes(encryptionKey), false);
  assert.equal(result.stdout.includes(accessToken), false);
  assert.equal(result.stdout.includes(typesenseKey), false);
});
