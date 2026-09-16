import { createDatabase, createRepositories } from './db.js';
import { createMailService } from './services/mail-service.js';
import { createRemoteContentService } from './services/remote-content.js';
import { createPasskeyService } from './services/passkeys.js';
import { createMeteringService } from './services/metering.js';
import { createKeyslotStore, passkeyStoreFromKeyslots } from './services/keyslots.js';
import { createAuthenticator } from './middleware/auth.js';
import { createVault } from './vault.js';
import { createHandoffServer, requestHandoff } from './handoff.js';
import { createApp } from './app.js';

const BACKLOG_DRAIN_DELAY_MS = 5_000;

/**
 * Wire one aMail process. Both key modes share every service; they differ only
 * in where the key material comes from and when the database opens:
 *
 *   env      keys derive from AMAIL_ENCRYPTION_KEY, the database opens at boot,
 *            AMAIL_ACCESS_TOKEN gates access (a plain self-hosted .env).
 *   keyslot  the process boots locked; the database opens when a keyslot
 *            credential (or an escrow slot / DEK handoff) unwraps the DEK.
 */
export function createHarness({ config, logger }) {
  const metering = createMeteringService({ config, logger });
  let pollTimer = null;
  let drainTimer = null;

  function startPolling(mailService) {
    if (pollTimer || config.syncIntervalMinutes <= 0) return;
    const poll = ({ force = false } = {}) => mailService.syncAll({ maxAgeMs: config.syncMinIntervalMs || 0, force })
      .then((results) => {
        // A pass that ran out of budget with mail still waiting continues
        // shortly instead of leaving the backlog for the next interval.
        const backlog = (results || []).reduce((sum, result) => sum + (Number(result?.remaining) || 0), 0);
        if (backlog > 0 && pollTimer && !drainTimer) {
          drainTimer = setTimeout(() => {
            drainTimer = null;
            poll({ force: true });
          }, BACKLOG_DRAIN_DELAY_MS);
          drainTimer.unref();
        }
      })
      .catch((error) => logger.warn({ err: error }, 'Background mail sync failed'));
    pollTimer = setInterval(poll, config.syncIntervalMinutes * 60_000);
    pollTimer.unref();
    logger.info({ intervalMinutes: config.syncIntervalMinutes }, 'Background IMAP polling enabled');
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (drainTimer) clearTimeout(drainTimer);
    pollTimer = null;
    drainTimer = null;
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
      async close() {
        await mailService.close?.().catch(() => {});
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
        await runtime.close();
      },
    };
  }

  const keyslots = createKeyslotStore({ dataDir: config.dataDir });
  let handoff = null;

  const vault = createVault({
    config,
    keyslots,
    logger,
    buildRuntime: (keys) => buildRuntime({ ...config, ...keys }),
    onUnlock(runtime) {
      startPolling(runtime.mailService);
      handoff?.start().catch((error) => logger.error({ err: error }, 'DEK handoff listener failed to start'));
    },
    onLock() {
      stopPolling();
      handoff?.stop().catch(() => {});
    },
  });

  if (config.handoffSocket) {
    if (config.handoffSecret) {
      handoff = createHandoffServer({
        socketPath: config.handoffSocket,
        secret: config.handoffSecret,
        logger,
        getDek: () => (vault.isUnlocked() ? vault.exportDek() : null),
      });
    } else {
      logger.warn('AMAIL_HANDOFF_SOCKET is set without AMAIL_HANDOFF_SECRET; DEK handoff is disabled');
    }
  }

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
      // Resume without tenant interaction when allowed: a running predecessor
      // hands the DEK over during a deploy, or the tenant opted into escrow.
      if (handoff && !vault.isUnlocked()) {
        const dek = await requestHandoff({ socketPath: config.handoffSocket, secret: config.handoffSecret, logger });
        if (dek) {
          try {
            vault.unlockWithDek(dek, { via: 'handoff' });
          } catch (error) {
            logger.error({ err: error }, 'Handed-off DEK was rejected');
          } finally {
            dek.fill(0);
          }
        }
      }
      if (!vault.isUnlocked() && vault.unlockFromEscrow()) logger.info('Harness unlocked from the escrow keyslot');
      if (!vault.isUnlocked()) {
        logger.info({ initialized: vault.isInitialized() }, vault.isInitialized() ? 'Harness is locked; waiting for a keyslot credential' : 'Harness is not provisioned; waiting for /api/keyslots/init');
      }
    },
    async stop() {
      stopPolling();
      await metering.close().catch(() => {});
      await handoff?.stop().catch(() => {});
      vault.lock({ reason: 'shutdown' });
    },
  };
}
