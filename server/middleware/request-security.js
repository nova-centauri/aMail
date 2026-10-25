const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizedOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function requestOrigin(request) {
  const host = String(request.get('host') || '').trim();
  if (!host) return null;
  return normalizedOrigin(`${request.protocol || 'http'}://${host}`);
}

/**
 * Reject state-changing browser requests from a different origin. SameSite
 * cookies alone do not stop a sibling subdomain (which is still "same-site")
 * from submitting a form, while non-browser clients normally send no Origin.
 * A caller that explicitly supplies a bearer token does not rely on ambient
 * cookie authority and remains compatible with MCP/REST integrations.
 */
export function browserOriginGuard(config = {}) {
  return (request, response, next) => {
    if (SAFE_METHODS.has(request.method) || /^Bearer\s+\S+/i.test(request.get('authorization') || '')) return next();

    const fetchSite = String(request.get('sec-fetch-site') || '').toLowerCase();
    const supplied = request.get('origin');
    if (!supplied && fetchSite !== 'cross-site') return next();

    const origin = normalizedOrigin(supplied);
    const allowed = new Set([
      requestOrigin(request),
      ...(Array.isArray(config.webauthnOrigins) ? config.webauthnOrigins.map(normalizedOrigin) : []),
    ].filter(Boolean));
    if (fetchSite !== 'cross-site' && origin && allowed.has(origin)) return next();

    return response.status(403).json({
      error: { code: 'ORIGIN_FORBIDDEN', message: 'This browser request came from an untrusted origin.' },
    });
  };
}

const LARGE_JSON_ROUTES = [
  /^\/api\/messages\/?$/,
  /^\/api\/drafts(?:\/[^/]+)?\/?$/,
  /^\/api\/accounts(?:\/test|\/[^/]+(?:\/avatar)?)?\/?$/,
  /^\/mcp\/?$/,
];

export function needsLargeJsonBody(request) {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return false;
  return LARGE_JSON_ROUTES.some((pattern) => pattern.test(request.path));
}
