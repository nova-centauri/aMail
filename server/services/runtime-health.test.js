import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildHealthExtras,
  databaseFileStats,
  emptyRuntimeStatus,
  processMemorySnapshot,
  readRuntimeStatus,
} from './runtime-health.js';

test('databaseFileStats reports sqlite, wal, and shm sizes without throwing on missing files', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amail-health-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, 'amail.sqlite');
  assert.deepEqual(databaseFileStats(undefined), { bytes: 0, walBytes: 0, shmBytes: 0 });
  assert.deepEqual(databaseFileStats(dbPath), { bytes: 0, walBytes: 0, shmBytes: 0 });
  fs.writeFileSync(dbPath, 'abcdefghij');
  fs.writeFileSync(`${dbPath}-wal`, 'w'.repeat(20));
  fs.writeFileSync(`${dbPath}-shm`, 's'.repeat(5));
  assert.deepEqual(databaseFileStats(dbPath), { bytes: 10, walBytes: 20, shmBytes: 5 });
});

test('health extras never include mailbox or account fields', () => {
  const extras = buildHealthExtras({
    config: { dbPath: '/tmp/does-not-exist-amail.sqlite' },
    mailService: {
      runtimeStatus() {
        return {
          inFlight: true,
          queueDepth: 2,
          oldestStartedAt: '2026-10-17T12:00:00.000Z',
          oldestAgeMs: 1500,
          imapPoolSize: 3,
          connecting: 1,
          coolingDown: 2,
          probesQueued: 0,
        };
      },
    },
  });
  assert.equal(extras.sync.inFlight, true);
  assert.equal(extras.sync.queueDepth, 2);
  assert.equal(extras.sync.coolingDown, 2);
  assert.equal(typeof extras.memory.rssBytes, 'number');
  assert.equal(typeof extras.database.bytes, 'number');
  assert.equal(Object.hasOwn(extras, 'accounts'), false);
  assert.equal(Object.hasOwn(extras.sync, 'accounts'), false);
  assert.equal(Object.hasOwn(extras.sync, 'email'), false);
});

test('a locked harness reports an empty sync snapshot even if the mail service would throw', () => {
  const extras = buildHealthExtras({
    config: {},
    locked: true,
    mailService: {
      runtimeStatus() {
        throw new Error('Harness is locked.');
      },
    },
  });
  assert.deepEqual(extras.sync, emptyRuntimeStatus());
});

test('readRuntimeStatus fills defaults when mailService has no snapshot', () => {
  assert.deepEqual(readRuntimeStatus({}), emptyRuntimeStatus());
  const memory = processMemorySnapshot({ rss: 10, heapUsed: 4 });
  assert.deepEqual(memory, { rssBytes: 10, heapUsedBytes: 4 });
});
