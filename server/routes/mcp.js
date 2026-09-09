import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { accessGate } from '../middleware/auth.js';
import { createAmailMcpServer } from '../mcp/server.js';

/**
 * Mount a Cursor-compatible Streamable HTTP MCP endpoint at /mcp.
 * Auth reuses the same Bearer token / session cookie gate as /api.
 */
export function registerMcp(app, { config, repos, mailService, remoteContent, auth = config }) {
  const gate = accessGate(auth);
  const handleMcp = async (request, response) => {
    const server = createAmailMcpServer({ config, repos, mailService, remoteContent });
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      response.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (error) {
      request.log?.error?.({ err: error }, 'MCP request failed');
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  // Stateless Streamable HTTP: each POST is a self-contained MCP request.
  // GET/DELETE are unused without sessions; return protocol-shaped 405s.
  app.post('/mcp', gate, handleMcp);
  app.get('/mcp', gate, (_request, response) => {
    response.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST for Streamable HTTP.' },
      id: null,
    });
  });
  app.delete('/mcp', gate, (_request, response) => {
    response.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Stateless MCP has no sessions to delete.' },
      id: null,
    });
  });
}
