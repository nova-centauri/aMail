import { createDatabase, createRepositories } from './db.js';
import { createMailService } from './services/mail-service.js';
import { createRemoteContentService } from './services/remote-content.js';
import { createPasskeyService } from './services/passkeys.js';
import { createMeteringService } from './services/metering.js';
import { createKeyslotStore, passkeyStoreFromKeyslots } from './services/keyslots.js';
import { createAuthenticator } from './middleware/auth.js';
import { createVault } from './vault.js';
import { createApp } from './app.js';

/**
 * Wire one aMail process. Both key modes share every service; they differ only
 * in where the key material comes from and when the database opens:
 *
 *   env      keys derive from AMAIL_ENCRYPTION_KEY, the database opens at boot,
 *            AMAIL_ACCESS_TOKEN gates access (a plain self-hosted .env).
 *   keyslot  the process boots locked; the database opens when a keyslot
 *            credential (or an escrow slot) unwraps the DEK.
 */
export function createHarness({ config, logger }) {
  const metering = createMeteringService({ config, logger });
  let pollTimer = null;

  function startPolling(mailService) {
    if (pollTimer || config.syncIntervalMinutes <= 0) return;
    const poll = () => mailService.syncAll().catch((error) => logger.warn({ err: error }, 'Background mail sync failed'));
    pollTimer = setInterval(poll, config.syncIntervalMinutes * 60_000);
    pollTimer.unref();
    logger.info({ intervalMinutes: config.syncIntervalMinutes }, 'Background IMAP polling enabled');
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /** Open the database and build the services that depend on it. */
  function buildRuntime(runtimeConfig) {
    const database = createDatabase(runtimeConfig);
    const repos = createRepositories(database);
    const remoteContent = createRemoteContentService({ config: runtimeConfig, repos, logger });
    const mailService = createMailService({ config: runtimeConfig, repos, logger, metering });
    return {
      config: runtimeConfig,
      repos,
      remoteContent,
      mailService,
      close() {
        remoteContent.close().catch(() => {});
        repos.close();
      },
    };
  }

  if (config.keyMode !== 'keyslot') {
    const runtime = buildRuntime(config);
    const passkeys = createPasskeyService({ config, repos: runtime.repos });
    const auth = createAuthenticator({ config });
    const app = createApp({ ...runtime, config, logger, passkeys, auth });
    return {
      mode: 'env',
      app,
      metering,
      vault: null,
      async start() {
        startPolling(runtime.mailService);
      },
      async stop() {
        stopPolling();
        await metering.close().catch(() => {});
        runtime.close();
      },
    };
  }

  const keyslots = createKeyslotStore({ dataDir: config.dataDir });

  const vault = createVault({
    config,
    keyslots,
    logger,
    buildRuntime: (keys) => buildRuntime({ ...config, ...keys }),
    onUnlock(runtime) {
      startPolling(runtime.mailService);
    },
    onLock() {
      stopPolling();
    },
  });

  const passkeys = createPasskeyService({ config, store: passkeyStoreFromKeyslots(keyslots), requestPrf: true });
  const auth = createAuthenticator({ config, vault });
  const app = createApp({ ...vault.runtime, logger, passkeys, auth, vault });

  return {
    mode: 'keyslot',
    app,
    metering,
    vault,
    keyslots,
    async start() {
      // Resume without tenant interaction only when the tenant opted into escrow.
      if (vault.unlockFromEscrow()) logger.info('Harness unlocked from the escrow keyslot');
      if (!vault.isUnlocked()) {
        logger.info({ initialized: vault.isInitialized() }, vault.isInitialized() ? 'Harness is locked; waiting for a keyslot credential' : 'Harness is not provisioned; waiting for /api/keyslots/init');
      }
    },
    async stop() {
      stopPolling();
      await metering.close().catch(() => {});
      vault.lock({ reason: 'shutdown' });
    },
  };
}
