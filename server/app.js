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
import { requestTiming } from './middleware/request-timing.js';
import { createDeepSearchService } from './services/deep-search.js';
import { createEventLoopWatchdog } from './services/event-loop-watchdog.js';
import { accessGate } from './middleware/auth.js';
import { browserOriginGuard, needsLargeJsonBody } from './middleware/request-security.js';

export function createApp({ config, repos, mailService, remoteContent, logger, passkeys, auth = createAuthenticator({ config }), vault = null, deepSearch = null, eventLoopWatchdog = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(pinoHttp({
    logger,
    autoLogging: config.env !== 'test' && !['error', 'fatal', 'silent'].includes(config.logLevel),
    // Request logging stays at info: under the hosted LOG_LEVEL=error profile
    // no per-request entry exists (autoLogging is off, and the level would drop
    // it anyway). The error handler below is the single place a failure is
    // recorded (route, status, request id, scrubbed error).
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
  app.use((request, response, next) => {
    response.set('Permissions-Policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()');
    if (request.path.startsWith('/api') || request.path.startsWith('/mcp')) {
      response.set('Cache-Control', 'private, no-store');
    }
    next();
  });
  app.use(browserOriginGuard(config));

  const jsonTypes = ['application/json', 'application/*+json'];
  const standardJson = express.json({ limit: '256kb', inflate: false, type: jsonTypes });
  // Compose attachments travel as base64 JSON. 8 MiB of files is ~11 MiB
  // encoded. Authenticate before accepting that larger allocation; every other
  // endpoint stays on a deliberately small parser and compressed request bodies
  // are rejected to avoid decompression-amplification work.
  const largeJson = express.json({ limit: '12mb', inflate: false, type: jsonTypes });
  const largeBodyGate = accessGate(auth);
  app.use((request, response, next) => {
    if (!needsLargeJsonBody(request)) return standardJson(request, response, next);
    return largeBodyGate(request, response, (error) => {
      if (error) return next(error);
      return largeJson(request, response, next);
    });
  });
  // After JSON parsing so MCP tool names are on the request-start line.
  app.use(requestTiming());

  const searchJobs = deepSearch || createDeepSearchService({ repos, mailService, logger });
  const watchdog = eventLoopWatchdog || createEventLoopWatchdog({
    lagThresholdMs: Number(config.eventLoopLagMs) || 1_500,
    stuckSyncMs: Number(config.syncAccountTimeoutMs) || 0,
    stallLogMs: Number(config.eventLoopStallLogMs) || 3_000,
    logger,
    enable: config.env !== 'test',
  });
  app.locals.eventLoopWatchdog = watchdog;
  registerApi(app, { config, repos, mailService, remoteContent, passkeys, auth, vault, deepSearch: searchJobs, eventLoopWatchdog: watchdog });
  registerMcp(app, { config, repos, mailService, remoteContent, auth, deepSearch: searchJobs });
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
