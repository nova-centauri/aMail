import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { registerApi } from './routes/api.js';
import { registerMcp } from './routes/mcp.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { createAuthenticator } from './middleware/auth.js';
import { logSerializers } from './logging.js';

export function createApp({ config, repos, mailService, remoteContent, logger, passkeys, auth = createAuthenticator({ config }), vault = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(pinoHttp({
    logger,
    autoLogging: config.env !== 'test',
    // Request logging stays at info: under the hosted LOG_LEVEL=error profile
    // no per-request entry exists, and the error handler below is the single
    // place a failure is recorded (route, status, request id, scrubbed error).
    serializers: logSerializers,
  }));
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // The supported SSH-tunnel deployment is intentionally plain HTTP on
        // loopback, so do not rewrite same-origin API requests to HTTPS.
        upgradeInsecureRequests: null,
      },
    },
  }));
  // Compose attachments travel as base64 JSON. 8 MiB of files is ~11 MiB encoded.
  app.use(express.json({ limit: '12mb', type: ['application/json', 'application/*+json'] }));

  registerApi(app, { config, repos, mailService, remoteContent, passkeys, auth, vault });
  registerMcp(app, { config, repos, mailService, remoteContent, auth });
  app.use('/api', notFound);

  if (fs.existsSync(config.staticDir)) {
    app.use(express.static(config.staticDir, { index: false, maxAge: config.env === 'production' ? '1h' : 0 }));
    app.get(/^(?!\/(?:api|mcp)(?:\/|$)).*/, (request, response, next) => {
      if (!request.accepts('html')) return next();
      response.sendFile(path.join(config.staticDir, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}
