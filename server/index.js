import 'dotenv/config';
import { loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { createDatabase, createRepositories } from './db.js';
import { createMailService } from './services/mail-service.js';
import { createRemoteContentService } from './services/remote-content.js';
import { createPasskeyService } from './services/passkeys.js';
import { createMeteringService } from './services/metering.js';
import { createApp } from './app.js';
import { configureSmartFilter } from './services/smart-filter.js';

const config = loadConfig();
configureSmartFilter({ opsSources: config.opsSources });
const logger = createLogger(config);
if (config.encryptDatabase && !config.databaseKey) {
  logger.warn('AMAIL_ENCRYPT_DATABASE is set but AMAIL_ENCRYPTION_KEY is missing; the database stays unencrypted');
}
let database;
try {
  database = createDatabase(config);
} catch (error) {
  logger.fatal({ err: error }, 'Failed to initialize the aMail database');
  process.exit(1);
}
const repos = createRepositories(database);
const remoteContent = createRemoteContentService({ config, repos, logger });
const metering = createMeteringService({ config, logger });
const mailService = createMailService({ config, repos, logger, metering });
const passkeys = createPasskeyService({ config, repos });
const app = createApp({ config, repos, mailService, remoteContent, logger, passkeys });

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, dataDir: config.dataDir }, 'aMail is ready');
});

let pollTimer;
if (config.syncIntervalMinutes > 0) {
  const poll = () => mailService.syncAll().catch((error) => logger.warn({ err: error }, 'Background mail sync failed'));
  pollTimer = setInterval(poll, config.syncIntervalMinutes * 60_000);
  pollTimer.unref();
  logger.info({ intervalMinutes: config.syncIntervalMinutes }, 'Background IMAP polling enabled');
}
if (metering.enabled) logger.info({ tenant: config.tenantId }, 'Analyzed-mark metering enabled');

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down aMail');
  if (pollTimer) clearInterval(pollTimer);
  server.close(async () => {
    await metering.close().catch(() => {});
    await remoteContent.close().catch(() => {});
    repos.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
