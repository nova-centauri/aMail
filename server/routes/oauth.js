import express from 'express';
import rateLimit from 'express-rate-limit';
import { OAuthProtocolError } from '../services/oauth-provider.js';

const formBody = express.urlencoded({ extended: false, limit: '32kb', inflate: false });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function connectorHost(transaction) {
  try {
    return new URL(transaction.redirectUri).host;
  } catch {
    return 'Claude';
  }
}

function consentPage(transaction, { authenticated = false, authMode = 'env', error = '' } = {}) {
  const clientName = escapeHtml(transaction.clientName || 'Claude');
  const clientHost = escapeHtml(connectorHost(transaction));
  const credentialLabel = authMode === 'keyslot'
    ? 'aMail owner token, passphrase, or recovery code'
    : 'aMail access token';
  const credential = authenticated ? '' : `
    <label for="credential">${credentialLabel}</label>
    <input id="credential" name="credential" type="password" autocomplete="off" required autofocus>
    <p class="hint">This credential is checked by your aMail server and is never sent to Claude.</p>`;
  const errorBlock = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${clientName} — aMail</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #0d1017; color: #eef2ff; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    main { width: min(520px, 100%); background: #171b25; border: 1px solid #30384a; border-radius: 18px; padding: 28px; box-shadow: 0 24px 80px #0008; }
    .mark { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 12px; background: #6d5dfc; font-weight: 800; font-size: 20px; }
    h1 { margin: 18px 0 8px; font-size: 24px; }
    p { color: #b8c0d4; line-height: 1.55; }
    .access { margin: 20px 0; padding: 16px; border-radius: 12px; background: #10141d; }
    .access strong { display: block; color: #f5f7ff; margin-bottom: 6px; }
    label { display: block; font-weight: 650; margin: 18px 0 8px; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #46506a; border-radius: 10px; padding: 12px; background: #0c1018; color: #fff; font: inherit; }
    .hint { margin: 7px 0 0; font-size: 13px; }
    .error { color: #ffb5b5; background: #3b1c25; padding: 10px 12px; border-radius: 9px; }
    .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 24px; }
    button { border: 0; border-radius: 10px; padding: 11px 16px; font: inherit; font-weight: 700; cursor: pointer; }
    .deny { background: #2a3040; color: #e3e8f5; }
    .allow { background: #6d5dfc; color: white; }
    footer { margin-top: 18px; color: #7f899f; font-size: 12px; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">aM</div>
    <h1>Connect ${clientName} to aMail?</h1>
    <p><strong>${clientHost}</strong> is asking for access to the MCP tools on this aMail server.</p>
    <div class="access">
      <strong>Full mailbox access</strong>
      <span>Claude will be able to read and search mail, change message state, send messages, and manage connected accounts. Individual tool calls remain subject to Claude's tool-approval settings.</span>
    </div>
    ${errorBlock}
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="transaction" value="${escapeHtml(transaction.id)}">
      ${credential}
      <div class="actions">
        <button class="deny" type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
        <button class="allow" type="submit" name="decision" value="allow">Authorize</button>
      </div>
    </form>
    <footer>Redirect after approval: ${escapeHtml(transaction.redirectUri)}</footer>
  </main>
</body>
</html>`;
}

function oauthError(response, error) {
  const protocol = error instanceof OAuthProtocolError
    ? error
    : new OAuthProtocolError('server_error', 'The OAuth request could not be completed.', { status: 500 });
  if (protocol.status >= 500) response.req?.log?.error?.({ err: error }, 'OAuth request failed');
  return response.status(protocol.status).json({
    error: protocol.code,
    error_description: protocol.message,
  });
}

function metadataResponse(response, body) {
  response.set('Access-Control-Allow-Origin', '*');
  response.set('Cache-Control', 'public, max-age=300');
  return response.json(body);
}

/** Register aMail's OAuth 2.1 authorization server and MCP discovery routes. */
export function registerOAuth(app, { auth, oauth }) {
  if (!oauth?.enabled) return;

  const authorizeLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  const credentialLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
  const tokenLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  const registrationLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  const protectedMetadata = (request, response) => {
    try {
      return metadataResponse(response, oauth.protectedResourceMetadata(request));
    } catch (error) {
      return oauthError(response, error);
    }
  };
  app.get('/.well-known/oauth-protected-resource', protectedMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedMetadata);
  app.get('/.well-known/oauth-authorization-server', (request, response) => {
    try {
      return metadataResponse(response, oauth.authorizationServerMetadata(request));
    } catch (error) {
      return oauthError(response, error);
    }
  });

  app.post('/oauth/register', registrationLimiter, (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      return response.status(201).json(oauth.registerClient(request.body));
    } catch (error) {
      return oauthError(response, error);
    }
  });

  app.get('/oauth/authorize', authorizeLimiter, (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const transaction = oauth.beginAuthorization(request.query, request);
      const authenticated = auth.requestHasAccess(request);
      return response.type('html').send(consentPage(transaction, { authenticated, authMode: auth.mode }));
    } catch (error) {
      const status = error instanceof OAuthProtocolError ? error.status : 500;
      const message = error instanceof OAuthProtocolError ? error.message : 'The authorization request could not be started.';
      return response.status(status).type('text').send(message);
    }
  });

  app.post('/oauth/authorize', credentialLimiter, formBody, (request, response) => {
    response.set('Cache-Control', 'no-store');
    const transaction = oauth.getAuthorization(request.body?.transaction);
    if (!transaction) return response.status(400).type('text').send('This authorization request expired. Start the connector setup again.');
    try {
      if (request.body?.decision === 'deny') {
        return response.redirect(303, oauth.finishAuthorization(transaction.id, { approved: false }));
      }
      if (request.body?.decision !== 'allow') {
        return response.status(400).type('text').send('Choose Authorize or Cancel to continue.');
      }
      let authenticated = auth.requestHasAccess(request);
      if (!authenticated) {
        const login = auth.credentialLogin(String(request.body?.credential || ''));
        auth.beginSession(response, { slotId: login.slot?.id || null });
        authenticated = true;
      }
      if (!authenticated) throw new Error('Authentication failed.');
      return response.redirect(303, oauth.finishAuthorization(transaction.id, { approved: true }));
    } catch (error) {
      if (error instanceof OAuthProtocolError) return oauthError(response, error);
      return response.status(401).type('html').send(consentPage(transaction, {
        authenticated: false,
        authMode: auth.mode,
        error: 'That aMail owner credential was not accepted.',
      }));
    }
  });

  app.post('/oauth/token', tokenLimiter, formBody, (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
    try {
      return response.json(oauth.exchangeToken(request.body));
    } catch (error) {
      return oauthError(response, error);
    }
  });

  app.post('/oauth/revoke', tokenLimiter, formBody, (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      oauth.revoke(request.body?.token);
      return response.status(200).send('');
    } catch (error) {
      return oauthError(response, error);
    }
  });
}
