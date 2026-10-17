import fs from 'node:fs';

export function emptyRuntimeStatus() {
  return {
    inFlight: false,
    queueDepth: 0,
    oldestStartedAt: null,
    oldestAgeMs: null,
    imapPoolSize: 0,
    connecting: 0,
    coolingDown: 0,
    probesQueued: 0,
  };
}

export function processMemorySnapshot(usage = process.memoryUsage()) {
  return {
    rssBytes: Number(usage.rss) || 0,
    heapUsedBytes: Number(usage.heapUsed) || 0,
  };
}

export function databaseFileStats(dbPath) {
  const sizeOf = (file) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  if (!dbPath) return { bytes: 0, walBytes: 0, shmBytes: 0 };
  return {
    bytes: sizeOf(dbPath),
    walBytes: sizeOf(`${dbPath}-wal`),
    shmBytes: sizeOf(`${dbPath}-shm`),
  };
}

export function readRuntimeStatus(mailService, { locked = false } = {}) {
  if (locked) return emptyRuntimeStatus();
  try {
    if (typeof mailService?.runtimeStatus === 'function') {
      return { ...emptyRuntimeStatus(), ...mailService.runtimeStatus() };
    }
  } catch {
    // Keyslot lazy proxies throw while the harness is locked.
  }
  return emptyRuntimeStatus();
}

export function buildHealthExtras({ config, mailService, locked = false } = {}) {
  return {
    memory: processMemorySnapshot(),
    database: databaseFileStats(config?.dbPath),
    sync: readRuntimeStatus(mailService, { locked }),
  };
}
