import crypto from 'node:crypto';
import path from 'node:path';
import { createOAuthStore, OAuthStoreCapacityError } from './oauth-store.js';

export const AMAIL_OAUTH_SCOPE = 'amail';
export const OAUTH_ACCESS_TTL_SECONDS = 60 * 60;
export const OAUTH_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

const AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;
const CODE_TTL_MS = 5 * 60 * 1_000;
const MAX_TRANSACTIONS = 1_000;
const ALLOWED_SCOPES = new Set([AMAIL_OAUTH_SCOPE, 'offline_access']);
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export class OAuthProtocolError extends Error {
  constructor(code, description, { status = 400 } = {}) {
    super(description);
    this.name = 'OAuthProtocolError';
    this.code = code;
    this.status = status;
  }
}

const one = (value) => (Array.isArray(value) ? value[0] : value);
const isoAfter = (milliseconds) => new Date(Date.now() + milliseconds).toISOString();

function normalizedOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function derivedRequestOrigin(request) {
  const host = String(request?.get?.('host') || '').trim();
  return host ? normalizedOrigin(`${request.protocol || 'http'}://${host}`) : null;
}

function publicOrigin(config, request) {
  const configured = normalizedOrigin(
    config.publicOrigin
    || (Array.isArray(config.webauthnOrigins) ? config.webauthnOrigins[0] : null),
  );
  return configured || derivedRequestOrigin(request);
}

function isLoopback(url) {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function normalizeRedirectUri(value) {
  const raw = String(value || '');
  if (!raw || raw.length > 2_048) throw new OAuthProtocolError('invalid_redirect_uri', 'A valid redirect_uri is required.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthProtocolError('invalid_redirect_uri', 'redirect_uri must be an absolute URL.');
  }
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !isLoopback(url))) {
    throw new OAuthProtocolError('invalid_redirect_uri', 'redirect_uri must use HTTPS, except for a loopback development callback.');
  }
  return url.toString();
}

function redirectMatches(registered, requested) {
  if (registered === requested) return true;
  try {
    const left = new URL(registered);
    const right = new URL(requested);
    if (!isLoopback(left) || !isLoopback(right) || left.hostname !== right.hostname) return false;
    return left.pathname === right.pathname && left.search === right.search;
  } catch {
    return false;
  }
}

function parseScopes(value, { fallback = [AMAIL_OAUTH_SCOPE] } = {}) {
  const requested = String(value || '').trim().split(/\s+/).filter(Boolean);
  const scopes = requested.length ? requested : fallback;
  if (!scopes.includes(AMAIL_OAUTH_SCOPE) || scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new OAuthProtocolError('invalid_scope', `Supported scopes are ${[...ALLOWED_SCOPES].join(' ')}.`);
  }
  return [...new Set(scopes)];
}

function pkceDigest(verifier) {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function oauthSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function redirectWith(uri, parameters) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** OAuth 2.1 provider used by Claude's remote custom-connector flow. */
export function createOAuthProvider({ config, vault = null, store = null } = {}) {
  const state = store || createOAuthStore({
    dataDir: config.dataDir || (config.dbPath ? path.dirname(config.dbPath) : path.resolve('data')),
  });
  const transactions = new Map();
  const enabled = config.keyMode === 'keyslot' || Boolean(config.accessToken);

  function issuer(request) {
    const origin = publicOrigin(config, request);
    if (!origin) throw new OAuthProtocolError('server_error', 'The public aMail origin could not be determined.', { status: 500 });
    return origin;
  }

  function resource(request) {
    return `${issuer(request)}/mcp`;
  }

  function resourceMetadataUrl(request) {
    return `${issuer(request)}/.well-known/oauth-protected-resource/mcp`;
  }

  function protectedResourceMetadata(request) {
    return {
      resource: resource(request),
      authorization_servers: [issuer(request)],
      scopes_supported: [AMAIL_OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'aMail MCP connector',
    };
  }

  function authorizationServerMetadata(request) {
    const base = issuer(request);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      scopes_supported: [AMAIL_OAUTH_SCOPE, 'offline_access'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    };
  }

  function challenge(request, { error = 'invalid_token', description = 'aMail authorization is required.' } = {}) {
    if (!enabled) return null;
    const safeDescription = String(description).replace(/["\\\r\n]/g, ' ').slice(0, 160);
    return `Bearer error="${error}", error_description="${safeDescription}", resource_metadata="${resourceMetadataUrl(request)}", scope="${AMAIL_OAUTH_SCOPE}"`;
  }

  function registerClient(input = {}) {
    const redirectUris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
    if (!redirectUris.length || redirectUris.length > 10) {
      throw new OAuthProtocolError('invalid_client_metadata', 'redirect_uris must contain between one and ten URLs.');
    }
    const normalizedRedirects = [...new Set(redirectUris.map(normalizeRedirectUri))];
    const grantTypes = Array.isArray(input.grant_types) && input.grant_types.length
      ? input.grant_types.map(String)
      : ['authorization_code', 'refresh_token'];
    const responseTypes = Array.isArray(input.response_types) && input.response_types.length
      ? input.response_types.map(String)
      : ['code'];
    const authMethod = String(input.token_endpoint_auth_method || 'none');
    if (
      !grantTypes.includes('authorization_code')
      || grantTypes.some((grant) => !['authorization_code', 'refresh_token'].includes(grant))
      || responseTypes.some((responseType) => responseType !== 'code')
      || authMethod !== 'none'
    ) {
      throw new OAuthProtocolError('invalid_client_metadata', 'aMail supports public authorization-code clients with PKCE and optional refresh tokens.');
    }

    let client;
    try {
      client = state.registerClient({
        redirectUris: normalizedRedirects,
        clientName: String(input.client_name || 'Claude').trim().slice(0, 100) || 'Claude',
        grantTypes: [...new Set(grantTypes)],
        responseTypes: ['code'],
        tokenEndpointAuthMethod: 'none',
      });
    } catch (error) {
      if (error instanceof OAuthStoreCapacityError) {
        throw new OAuthProtocolError('server_error', error.message, { status: 503 });
      }
      throw error;
    }
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1_000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    };
  }

  function pruneTransactions() {
    const timestamp = Date.now();
    for (const [id, transaction] of transactions) {
      if (transaction.expiresAt <= timestamp) transactions.delete(id);
    }
  }

  function beginAuthorization(query, request) {
    pruneTransactions();
    if (transactions.size >= MAX_TRANSACTIONS) {
      throw new OAuthProtocolError('temporarily_unavailable', 'Too many authorization requests are pending.', { status: 503 });
    }
    if (one(query.response_type) !== 'code') throw new OAuthProtocolError('unsupported_response_type', 'response_type must be code.');
    const clientId = String(one(query.client_id) || '');
    const client = state.getClient(clientId);
    if (!client) throw new OAuthProtocolError('invalid_request', 'Unknown OAuth client_id.');
    const redirectUri = normalizeRedirectUri(one(query.redirect_uri));
    if (!client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
      throw new OAuthProtocolError('invalid_request', 'redirect_uri is not registered for this client.');
    }
    const codeChallenge = String(one(query.code_challenge) || '');
    if (one(query.code_challenge_method) !== 'S256' || !PKCE_CHALLENGE.test(codeChallenge)) {
      throw new OAuthProtocolError('invalid_request', 'S256 PKCE is required.');
    }
    const requestedResource = String(one(query.resource) || resource(request));
    if (requestedResource !== resource(request)) throw new OAuthProtocolError('invalid_target', 'The requested resource does not match this aMail MCP endpoint.');
    const scopes = parseScopes(one(query.scope));
    const stateValue = String(one(query.state) || '');
    if (stateValue.length > 2_048) throw new OAuthProtocolError('invalid_request', 'state is too long.');

    const id = oauthSecret('amot');
    const transaction = {
      id,
      clientId,
      clientName: client.clientName,
      redirectUri,
      codeChallenge,
      scopes,
      resource: requestedResource,
      state: stateValue,
      issuer: issuer(request),
      allowRefresh: client.grantTypes.includes('refresh_token'),
      expiresAt: Date.now() + AUTHORIZATION_TTL_MS,
    };
    transactions.set(id, transaction);
    state.touchClient(clientId);
    return structuredClone(transaction);
  }

  function getAuthorization(id) {
    pruneTransactions();
    const transaction = transactions.get(String(id || ''));
    return transaction ? structuredClone(transaction) : null;
  }

  function finishAuthorization(id, { approved }) {
    const transaction = getAuthorization(id);
    if (!transaction) throw new OAuthProtocolError('invalid_request', 'This authorization request expired. Start the connection again.');
    transactions.delete(transaction.id);
    if (!approved) {
      return redirectWith(transaction.redirectUri, {
        error: 'access_denied',
        error_description: 'The aMail owner denied access.',
        state: transaction.state,
        iss: transaction.issuer,
      });
    }
    const code = oauthSecret('amoc');
    state.saveCode(code, {
      clientId: transaction.clientId,
      redirectUri: transaction.redirectUri,
      codeChallenge: transaction.codeChallenge,
      scopes: transaction.scopes,
      resource: transaction.resource,
      allowRefresh: transaction.allowRefresh,
      expiresAt: isoAfter(CODE_TTL_MS),
    });
    return redirectWith(transaction.redirectUri, {
      code,
      state: transaction.state,
      iss: transaction.issuer,
    });
  }

  function removeSlots(slotIds) {
    if (!vault) return;
    for (const slotId of slotIds.filter(Boolean)) {
      try {
        vault.removeSlot(slotId);
      } catch {
        // Expired/revoked OAuth wrappers are cleanup only. A missing slot or a
        // concurrently locked harness must not turn a valid protocol response
        // into a failure.
      }
    }
  }

  function mintCredential(kind, metadata) {
    if (config.keyMode !== 'keyslot') {
      return { token: oauthSecret(kind === 'access' ? 'amo1' : 'amr1'), slotId: null };
    }
    if (!vault?.isUnlocked?.()) {
      throw new OAuthProtocolError('temporarily_unavailable', 'aMail is locked. Authorize the connector again to unlock it.', { status: 503 });
    }
    const { token, slot } = vault.addTokenSlot({
      label: `Claude OAuth ${kind}`,
      hidden: true,
      oauth: { kind, ...metadata },
    });
    return { token, slotId: slot.id };
  }

  function issueTokens({ clientId, scopes, resource: target, allowRefresh = true }) {
    removeSlots(state.prune());
    const accessExpiresAt = isoAfter(OAUTH_ACCESS_TTL_SECONDS * 1_000);
    const access = mintCredential('access', { clientId, scopes, resource: target, expiresAt: accessExpiresAt });
    try {
      state.saveToken(access.token, {
        type: 'access', clientId, scopes, resource: target, expiresAt: accessExpiresAt, slotId: access.slotId,
      });
    } catch (error) {
      removeSlots([access.slotId]);
      throw error;
    }

    let refresh = null;
    // A refresh token is an OAuth authorization-code credential, not an OIDC
    // session. Generic MCP clients (including Claude) need not request the
    // OIDC-specific `offline_access` scope, so issue one whenever the dynamic
    // client registered the refresh_token grant.
    if (allowRefresh) {
      const refreshExpiresAt = isoAfter(OAUTH_REFRESH_TTL_SECONDS * 1_000);
      refresh = mintCredential('refresh', { clientId, scopes, resource: target, expiresAt: refreshExpiresAt });
      try {
        state.saveToken(refresh.token, {
          type: 'refresh', clientId, scopes, resource: target, expiresAt: refreshExpiresAt, slotId: refresh.slotId,
        });
      } catch (error) {
        state.removeToken(access.token, 'access');
        removeSlots([access.slotId, refresh.slotId]);
        throw error;
      }
    }

    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: OAUTH_ACCESS_TTL_SECONDS,
      scope: scopes.join(' '),
      ...(refresh ? { refresh_token: refresh.token } : {}),
    };
  }

  function exchangeAuthorizationCode(form) {
    const code = String(one(form.code) || '');
    const record = code ? state.consumeCode(code) : null;
    if (!record) throw new OAuthProtocolError('invalid_grant', 'The authorization code is invalid or expired.');
    const clientId = String(one(form.client_id) || '');
    const redirectUri = normalizeRedirectUri(one(form.redirect_uri));
    const verifier = String(one(form.code_verifier) || '');
    const requestedResource = String(one(form.resource) || record.resource);
    if (
      clientId !== record.clientId
      || redirectUri !== record.redirectUri
      || !PKCE_VALUE.test(verifier)
      || pkceDigest(verifier) !== record.codeChallenge
      || requestedResource !== record.resource
    ) {
      throw new OAuthProtocolError('invalid_grant', 'The authorization code, redirect URI, resource, or PKCE verifier is invalid.');
    }
    return issueTokens(record);
  }

  function refreshAccessToken(form) {
    const refreshToken = String(one(form.refresh_token) || '');
    const clientId = String(one(form.client_id) || '');
    const record = refreshToken ? state.getToken(refreshToken, 'refresh') : null;
    if (!record || clientId !== record.clientId) throw new OAuthProtocolError('invalid_grant', 'The refresh token is invalid or expired.');
    const requestedResource = String(one(form.resource) || record.resource);
    if (requestedResource !== record.resource) throw new OAuthProtocolError('invalid_target', 'The refresh token was not issued for that resource.');
    if (config.keyMode === 'keyslot' && !vault?.authenticateToken?.(refreshToken, { oauthKind: 'refresh' })) {
      throw new OAuthProtocolError('invalid_grant', 'The refresh credential was revoked.');
    }
    const consumed = state.consumeToken(refreshToken, 'refresh');
    if (!consumed) throw new OAuthProtocolError('invalid_grant', 'The refresh token was already used.');
    const requestedScopes = one(form.scope) == null
      ? consumed.scopes
      : parseScopes(one(form.scope), { fallback: consumed.scopes });
    if (requestedScopes.some((scope) => !consumed.scopes.includes(scope))) {
      removeSlots([consumed.slotId]);
      throw new OAuthProtocolError('invalid_scope', 'A refresh request cannot add scopes.');
    }
    try {
      const result = issueTokens({ clientId, scopes: requestedScopes, resource: consumed.resource, allowRefresh: true });
      removeSlots([consumed.slotId]);
      return result;
    } catch (error) {
      removeSlots([consumed.slotId]);
      throw error;
    }
  }

  function exchangeToken(form = {}) {
    const grantType = String(one(form.grant_type) || '');
    if (grantType === 'authorization_code') return exchangeAuthorizationCode(form);
    if (grantType === 'refresh_token') return refreshAccessToken(form);
    throw new OAuthProtocolError('unsupported_grant_type', 'Supported grant types are authorization_code and refresh_token.');
  }

  function verifyAccessToken(token, request = null) {
    const record = token ? state.getToken(token, 'access') : null;
    if (!record) return false;
    if (request && record.resource !== resource(request)) return false;
    if (config.keyMode !== 'keyslot') return true;
    return Boolean(vault?.authenticateToken?.(token, { oauthKind: 'access' }));
  }

  function revoke(token) {
    const removed = state.revokeToken(String(token || ''));
    removeSlots(removed.map((record) => record.slotId));
  }

  return {
    enabled,
    store: state,
    issuer,
    resource,
    resourceMetadataUrl,
    protectedResourceMetadata,
    authorizationServerMetadata,
    challenge,
    registerClient,
    beginAuthorization,
    getAuthorization,
    finishAuthorization,
    exchangeToken,
    verifyAccessToken,
    revoke,
  };
}
