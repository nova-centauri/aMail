import rateLimit from 'express-rate-limit';
import { AppError, NotFoundError, ValidationError } from '../errors.js';
import { timingSafeMatch } from '../services/crypto.js';

/**
 * Unauthenticated provisioning surface, keyslot mode only.
 *
 * `POST /api/keyslots/init` runs exactly once per harness: it generates the DEK
 * in memory, wraps it for a first bearer token and a recovery code, writes only
 * ciphertext, unlocks, and returns both secrets. Nothing keeps a copy, so the
 * caller (the provisioning step of a hosted control plane, or a self-hoster
 * with curl) must show them to the tenant right away.
 *
 * The call is authorized by AMAIL_PROVISION_SECRET. Without that variable the
 * endpoint is disabled rather than first-come-first-served.
 */
export function registerKeyslotProvisioning(app, { config, vault }) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });

  app.post('/api/keyslots/init', limiter, (request, response) => {
    if (!config.provisionSecret) {
      throw new AppError('Provisioning is disabled: AMAIL_PROVISION_SECRET is not set.', { status: 503, code: 'PROVISIONING_DISABLED', expose: true });
    }
    const presented = (request.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (!timingSafeMatch(presented, config.provisionSecret)) {
      return response.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Provisioning secret required.' } });
    }
    const label = String(request.body?.label || 'Initial token').slice(0, 80);
    const result = vault.init({ label });
    return response.status(201).json({
      token: result.token,
      recoveryCode: result.recoveryCode,
      keyslots: result.keyslots,
      status: vault.status(),
    });
  });
}

/**
 * Authenticated keyslot management. Every route requires an unlocked harness
 * because wrapping needs the DEK; rotation is unwrap-with-old, wrap-with-new,
 * in-container, and nothing here ever returns key material other than the
 * freshly minted credential itself.
 */
export function registerKeyslotManagement(router, { vault, auth }) {
  router.get('/keyslots', (_request, response) => {
    response.json({ keyslots: vault.listSlots(), status: vault.status() });
  });

  router.post('/keyslots/tokens', (request, response) => {
    const label = String(request.body?.label || '').trim();
    if (label.length > 80) throw new ValidationError('Label must be 80 characters or fewer.');
    const { token, slot } = vault.addTokenSlot({ label: label || 'MCP token' });
    response.status(201).json({ token, keyslot: slot });
  });

  router.post('/keyslots/recovery', (_request, response) => {
    const { recoveryCode, slot } = vault.addRecoverySlot();
    response.status(201).json({ recoveryCode, keyslot: slot });
  });

  router.post('/keyslots/passphrase', (request, response) => {
    const passphrase = request.body?.passphrase;
    if (typeof passphrase !== 'string') throw new ValidationError('A passphrase is required.');
    const label = String(request.body?.label || 'Passphrase').slice(0, 80);
    const { slot } = vault.addPassphraseSlot({ passphrase, label });
    response.status(201).json({ keyslot: slot });
  });

  router.post('/keyslots/escrow', (_request, response) => {
    const { slot } = vault.addEscrowSlot();
    response.status(201).json({ keyslot: slot });
  });

  router.post('/keyslots/lock', (request, response) => {
    auth.clearSessions?.();
    auth.endSession(request, response);
    response.json({ status: vault.lock({ reason: 'api' }) });
  });

  router.delete('/keyslots/:id', (request, response) => {
    if (!vault.removeSlot(String(request.params.id))) throw new NotFoundError('Keyslot not found.');
    response.status(204).end();
  });
}
