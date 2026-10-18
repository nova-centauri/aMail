import assert from 'node:assert/strict';
import test from 'node:test';
import { clipMcpMessage, MCP_MAX_BODY_CHARS, MCP_MAX_THREAD_MESSAGES } from './bounds.js';

test('MCP message bodies are clipped so a huge thread cannot pin the event loop', () => {
  const huge = 'x'.repeat(MCP_MAX_BODY_CHARS + 50);
  const clipped = clipMcpMessage({ id: 'm1', htmlBody: huge, textBody: huge });
  assert.equal(clipped.htmlBody.length, MCP_MAX_BODY_CHARS);
  assert.equal(clipped.textBody.length, MCP_MAX_BODY_CHARS);
  assert.equal(clipped.bodyTruncated, true);
  assert.equal(MCP_MAX_THREAD_MESSAGES, 40);
});
