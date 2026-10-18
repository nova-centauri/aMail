/**
 * Process-wide in-flight HTTP/MCP requests for hang diagnosis.
 * Entries are metadata only (method, path, tool name, id) — never bodies.
 */
export function createInFlightRegistry({ now = () => Date.now() } = {}) {
  const items = new Map();
  let seq = 0;

  return {
    begin(info = {}) {
      seq += 1;
      const id = String(info.reqId || info.id || `req_${seq}`);
      const entry = {
        reqId: id,
        method: info.method || null,
        path: info.path || null,
        mcpTool: info.mcpTool || null,
        mcpMethod: info.mcpMethod || null,
        startedAt: new Date(now()).toISOString(),
        startedAtMs: now(),
      };
      items.set(id, entry);
      return entry;
    },
    update(id, patch = {}) {
      const entry = items.get(String(id || ''));
      if (!entry) return null;
      Object.assign(entry, patch);
      return entry;
    },
    end(id) {
      items.delete(String(id || ''));
    },
    list() {
      return [...items.values()].map((entry) => ({
        reqId: entry.reqId,
        method: entry.method,
        path: entry.path,
        mcpTool: entry.mcpTool,
        mcpMethod: entry.mcpMethod,
        ageMs: Math.max(0, now() - entry.startedAtMs),
      }));
    },
    size() {
      return items.size;
    },
  };
}

export const globalInFlight = createInFlightRegistry();

export function mcpCallMeta(body) {
  if (!body || typeof body !== 'object') return { mcpMethod: null, mcpTool: null };
  const mcpMethod = typeof body.method === 'string' ? body.method.slice(0, 80) : null;
  const name = body.params && typeof body.params.name === 'string' ? body.params.name : null;
  return {
    mcpMethod,
    mcpTool: mcpMethod === 'tools/call' && name ? name.slice(0, 80) : null,
  };
}
