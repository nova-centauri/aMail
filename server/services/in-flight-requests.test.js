import assert from 'node:assert/strict';
import test from 'node:test';
import { createInFlightRegistry, mcpCallMeta } from './in-flight-requests.js';

test('mcpCallMeta extracts the tool name without reading arguments', () => {
  assert.deepEqual(mcpCallMeta(null), { mcpMethod: null, mcpTool: null });
  assert.deepEqual(mcpCallMeta({ method: 'initialize' }), { mcpMethod: 'initialize', mcpTool: null });
  assert.deepEqual(mcpCallMeta({
    method: 'tools/call',
    params: { name: 'sync_mail', arguments: { accountId: 'secret-account' } },
  }), { mcpMethod: 'tools/call', mcpTool: 'sync_mail' });
});

test('the in-flight registry lists request ids and tool names', () => {
  let now = 1_000;
  const registry = createInFlightRegistry({ now: () => now });
  const first = registry.begin({ reqId: 'abc', method: 'POST', path: '/mcp', mcpTool: 'get_thread' });
  assert.equal(first.reqId, 'abc');
  now = 1_500;
  assert.deepEqual(registry.list(), [{
    reqId: 'abc',
    method: 'POST',
    path: '/mcp',
    mcpTool: 'get_thread',
    mcpMethod: null,
    ageMs: 500,
  }]);
  registry.end('abc');
  assert.equal(registry.size(), 0);
});
