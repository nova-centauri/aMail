#!/usr/bin/env node
/**
 * Online backup of the aMail database.
 *
 *   node server/tools/backup.js [destination]
 *
 * Reads the same environment as the server, so an encrypted database is opened
 * with its configured key and `VACUUM INTO` writes a compact copy that stays
 * encrypted under that same key. Plaintext databases produce plaintext copies.
 * The default destination is `<data dir>/backup-<timestamp>.sqlite`.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db.js';

const config = loadConfig();
const destination = path.resolve(
  process.argv[2] || path.join(config.dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`),
);

if (!fs.existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath}`);
  process.exit(1);
}
if (fs.existsSync(destination)) {
  console.error(`Refusing to overwrite ${destination}`);
  process.exit(1);
}

const db = openDatabase(config.dbPath, { key: config.databaseKey, readonly: true });
try {
  db.prepare('VACUUM INTO ?').run(destination);
} finally {
  db.close();
}
fs.chmodSync(destination, 0o600);
console.log(JSON.stringify({ ok: true, destination, encrypted: Boolean(config.databaseKey) }));
