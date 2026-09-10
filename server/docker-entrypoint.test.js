import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../deploy/docker-entrypoint.sh');

async function runEntrypoint(env) {
  const { stdout } = await execFileAsync('sh', [script, 'sh', '-c', 'printf %s "$NODE_OPTIONS|$UV_THREADPOOL_SIZE"'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME || '/', ...env },
    encoding: 'utf8',
  });
  return stdout;
}

test('keyslot entrypoint applies the hosted heap and threadpool caps', async () => {
  assert.equal(await runEntrypoint({ AMAIL_KEY_MODE: 'keyslot' }), '--max-old-space-size=384|2');
  assert.equal(
    await runEntrypoint({ AMAIL_KEY_MODE: 'keyslot', NODE_OPTIONS: '--enable-source-maps' }),
    '--enable-source-maps --max-old-space-size=384|2',
  );
});

test('keyslot entrypoint leaves an explicit heap cap and threadpool size alone', async () => {
  assert.equal(
    await runEntrypoint({
      AMAIL_KEY_MODE: 'keyslot',
      NODE_OPTIONS: '--max-old-space-size=512',
      UV_THREADPOOL_SIZE: '8',
    }),
    '--max-old-space-size=512|8',
  );
});

test('env-mode entrypoint does not inject hosted runtime flags', async () => {
  assert.equal(await runEntrypoint({ AMAIL_KEY_MODE: 'env' }), '|');
  assert.equal(
    await runEntrypoint({ AMAIL_KEY_MODE: 'env', NODE_OPTIONS: '--enable-source-maps', UV_THREADPOOL_SIZE: '4' }),
    '--enable-source-maps|4',
  );
});
