import 'dotenv/config';
import { loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { createHarness } from './bootstrap.js';
import { configureSmartFilter } from './services/smart-filter.js';

const config = loadConfig();
configureSmartFilter({ opsSources: config.opsSources });
const logger = createLogger(config);

if (config.keyModeConflicts.length) {
  logger.fatal({ variables: config.keyModeConflicts.map((name) => `AMAIL_${name}`) }, 'AMAIL_KEY_MODE=keyslot derives every key from the tenant DEK; remove these variables');
  process.exit(1);
}
if (config.encryptDatabase && !config.databaseKey && config.keyMode === 'env') {
  logger.warn('AMAIL_ENCRYPT_DATABASE is set but AMAIL_ENCRYPTION_KEY is missing; the database stays unencrypted');
}

let harness;
try {
  harness = createHarness({ config, logger });
} catch (error) {
  logger.fatal({ err: error }, 'Failed to initialize the aMail database');
  process.exit(1);
}

const server = harness.app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, dataDir: config.dataDir, keyMode: config.keyMode }, 'aMail is ready');
});
harness.start().catch((error) => logger.error({ err: error }, 'Startup tasks failed'));
if (harness.metering.enabled) logger.info({ tenant: config.tenantId }, 'Analyzed-mark metering enabled');

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down aMail');
  server.close(async () => {
    await harness.stop().catch((error) => logger.error({ err: error }, 'Shutdown tasks failed'));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
