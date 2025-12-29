import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Configuration for the HTTP transport.
 */
export interface HttpTransportConfig {
  /** Port to listen on (default: 3000, or MCP_PORT env var) */
  port?: number;

  /** Path for MCP endpoint (default: /mcp) */
  path?: string;

  /** Optional auth middleware (no-op by default, ready for OAuth) */
  authMiddleware?: (req: Request, res: Response, next: () => void) => void;
}

/**
 * Session store for HTTP transport connections.
 */
const transports: Record<string, StreamableHTTPServerTransport> = {};

/**
 * Create and start an HTTP streaming transport server.
 *
 * @param server - The MCP server instance to connect
 * @param config - Transport configuration options
 * @returns The Express app instance
 */
export async function createHttpTransport(
  server: McpServer,
  config: HttpTransportConfig = {}
): Promise<express.Application> {
  const app = express();
  const port = config.port ?? (Number(process.env.MCP_PORT) || 3000);
  const path = config.path ?? '/mcp';

  // Parse JSON bodies
  app.use(express.json());

  // Optional auth middleware (no-op by default)
  if (config.authMiddleware) {
    app.use(path, config.authMiddleware);
  }

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', sessions: Object.keys(transports).length });
  });

  // Handle POST requests (main MCP interactions)
  app.post(path, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing session
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session initialization
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports[id] = transport;
          console.error(`[logpare-mcp] HTTP session initialized: ${id}`);
        },
        onsessionclosed: (id: string) => {
          delete transports[id];
          console.error(`[logpare-mcp] HTTP session closed: ${id}`);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      // Connect server to this transport
      try {
        await server.connect(transport);
      } catch (error) {
        // Clean up transport on connection failure
        transport.onclose = undefined;
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
        transport.close();

        console.error('[logpare-mcp] Failed to connect transport:', error);
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error: failed to initialize session' },
          id: null,
        });
        return;
      }
    } else {
      // Invalid session request
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid session' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // Handle GET requests (SSE for server-to-client notifications)
  app.get(path, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = transports[sessionId];

    if (transport) {
      await transport.handleRequest(req, res);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid session' },
        id: null,
      });
    }
  });

  // Handle DELETE requests (session termination)
  app.delete(path, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = transports[sessionId];

    if (transport) {
      await transport.handleRequest(req, res);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid session' },
        id: null,
      });
    }
  });

  // Start listening
  app.listen(port, () => {
    console.error(`[logpare-mcp] HTTP server listening on port ${port}`);
    console.error(`[logpare-mcp] MCP endpoint: http://localhost:${port}${path}`);
  });

  return app;
}

/**
 * Get the count of active HTTP sessions.
 */
export function getActiveSessionCount(): number {
  return Object.keys(transports).length;
}

/**
 * Close all active HTTP sessions.
 */
export function closeAllSessions(): void {
  for (const sessionId of Object.keys(transports)) {
    const transport = transports[sessionId];
    if (transport) {
      transport.close();
    }
    delete transports[sessionId];
  }
  console.error('[logpare-mcp] All HTTP sessions closed');
}
