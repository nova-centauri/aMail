import rateLimit from 'express-rate-limit';

/**
 * REST management of outbound webhooks (docs/webhooks.md). Mounted on the
 * authenticated /api router, so every route needs the normal bearer token or
 * session. The secret is in the response to POST (and to a PATCH that rotates
 * it) and nowhere else.
 */
export function registerWebhookRoutes(router, { webhooks }) {
  // Creating, repointing and testing a webhook make the server resolve and
  // contact a caller-chosen host. Same budget as the account probes.
  const webhookProbeLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });

  const patchInput = (body) => ({
    url: body.url,
    events: body.events,
    description: body.description,
    accountIds: body.accountIds,
    enabled: body.enabled,
    secret: body.secret,
    rotateSecret: body.rotateSecret,
  });

  router.get('/webhooks', (_request, response) => {
    response.json({ webhooks: webhooks.list(), eventTypes: webhooks.eventTypes(), status: webhooks.status() });
  });
  router.post('/webhooks', webhookProbeLimiter, async (request, response) => {
    const body = request.body || {};
    const { webhook, secret } = await webhooks.create({
      url: body.url,
      events: body.events,
      description: body.description,
      accountIds: body.accountIds,
      secret: body.secret,
      enabled: body.enabled,
    });
    response.set('Cache-Control', 'private, no-store');
    response.status(201).json({ webhook, secret });
  });
  router.get('/webhooks/:id', (request, response) => {
    response.json(webhooks.get(request.params.id, { deliveries: request.query.deliveries }));
  });
  router.patch('/webhooks/:id', webhookProbeLimiter, async (request, response) => {
    response.set('Cache-Control', 'private, no-store');
    response.json(await webhooks.update(request.params.id, patchInput(request.body || {})));
  });
  router.delete('/webhooks/:id', (request, response) => {
    webhooks.remove(request.params.id);
    response.status(204).end();
  });
  router.post('/webhooks/:id/test', webhookProbeLimiter, async (request, response) => {
    response.json({ delivery: await webhooks.test(request.params.id) });
  });
}
