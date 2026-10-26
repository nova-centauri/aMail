import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../deploy/typesense-mode.sh', import.meta.url));
const execFileAsync = promisify(execFile);

async function mode(lines) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-typesense-mode-'));
  const envFile = path.join(directory, '.env');
  try {
    fs.writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
    const { stdout } = await execFileAsync('sh', [script, envFile], { encoding: 'utf8' });
    return stdout.trim();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('encrypted auto-search deployments omit the plaintext Typesense service', async () => {
  assert.equal(await mode(['AMAIL_ENCRYPT_DATABASE=true', 'AMAIL_SEARCH_ENGINE=auto']), 'disabled');
  assert.equal(await mode(['GIGAMAIL_ENCRYPT_DATABASE=1']), 'disabled');
  assert.equal(await mode(['AMAIL_KEY_MODE=keyslot', 'AMAIL_SEARCH_ENGINE=AUTO']), 'disabled');
  assert.equal(await mode(['AMAIL_ENCRYPT_DATABASE="yes"', 'AMAIL_SEARCH_ENGINE="auto"']), 'disabled');
  assert.equal(await mode(['AMAIL_ENCRYPT_DATABASE=false', 'AMAIL_ENCRYPT_DATABASE=true']), 'disabled');
  assert.equal(await mode(['AMAIL_ENCRYPT_DATABASE=', 'GIGAMAIL_ENCRYPT_DATABASE=on']), 'disabled');
});

test('explicit FTS always omits Typesense', async () => {
  assert.equal(await mode(['AMAIL_ENCRYPT_DATABASE=false', 'AMAIL_SEARCH_ENGINE=fts']), 'disabled');
  assert.equal(await mode(['AMAIL_SEARCH_ENGINE=off', 'AMAIL_TYPESENSE_URL=http://search.example.test']), 'disabled');
});

test('plaintext auto-search preserves the bundled Typesense performance path', async () => {
  assert.equal(await mode(['AMAIL_ENCRYPT_DATABASE=false', 'AMAIL_SEARCH_ENGINE=auto']), 'local');
  assert.equal(await mode([]), 'local');
  assert.equal(await mode(['AMAIL_ENCRYPT_DATABASE=false', 'GIGAMAIL_ENCRYPT_DATABASE=true']), 'local');
});

test('forcing Typesense opts an encrypted install into the local plaintext index', async () => {
  assert.equal(await mode(['AMAIL_ENCRYPT_DATABASE=true', 'AMAIL_SEARCH_ENGINE=typesense']), 'local');
});

test('an operator-provided URL selects external Typesense without a local service', async () => {
  assert.equal(await mode([
    'AMAIL_ENCRYPT_DATABASE=false',
    'AMAIL_SEARCH_ENGINE=auto',
    'AMAIL_TYPESENSE_URL=https://search.example.test',
  ]), 'external');
  assert.equal(await mode([
    'GIGAMAIL_ENCRYPT_DATABASE=true',
    'GIGAMAIL_SEARCH_ENGINE=typesense',
    'GIGAMAIL_TYPESENSE_URL=http://typesense.internal:8108',
  ]), 'external');
});
