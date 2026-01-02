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

/** Session timeout: 30 minutes */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Session info with transport and activity tracking.
 */
interface SessionInfo {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

/**
 * Session manager returned by createHttpTransport.
 * Encapsulates session state for testability and multiple instance support.
 */
export interface HttpSessionManager {
  /** Express application instance */
  app: express.Application;

  /** Get the count of active sessions */
  getActiveSessionCount: () => number;

  /** Close all active sessions and cleanup resources */
  closeAllSessions: () => void;
}

/**
 * Create and start an HTTP streaming transport server.
 *
 * @param server - The MCP server instance to connect
 * @param config - Transport configuration options
 * @returns Session manager with app and cleanup methods
 */
export async function createHttpTransport(
  server: McpServer,
  config: HttpTransportConfig = {}
): Promise<HttpSessionManager> {
  const app = express();
  const port = config.port ?? (Number(process.env.MCP_PORT) || 3000);
  const path = config.path ?? '/mcp';

  // Instance-local session state (not global)
  const sessions: Record<string, SessionInfo> = {};
  let sessionCleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Update session activity timestamp.
   */
  function touchSession(sessionId: string): void {
    if (sessions[sessionId]) {
      sessions[sessionId].lastActivity = Date.now();
    }
  }

  /**
   * Get the count of active sessions.
   */
  function getActiveSessionCount(): number {
    return Object.keys(sessions).length;
  }

  /**
   * Close all active sessions and cleanup resources.
   */
  function closeAllSessions(): void {
    if (sessionCleanupInterval) {
      clearInterval(sessionCleanupInterval);
      sessionCleanupInterval = null;
    }

    for (const sessionId of Object.keys(sessions)) {
      const session = sessions[sessionId];
      if (session) {
        session.transport.close();
      }
      delete sessions[sessionId];
    }
    console.error('[logpare-mcp] All HTTP sessions closed');
  }

  // Parse JSON bodies
  app.use(express.json());

  // Optional auth middleware (no-op by default)
  if (config.authMiddleware) {
    app.use(path, config.authMiddleware);
  }

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', sessions: getActiveSessionCount() });
  });

  // Start session cleanup interval
  sessionCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of Object.entries(sessions)) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
        session.transport.close();
        delete sessions[id];
        console.error(`[logpare-mcp] Session ${id} expired due to inactivity`);
      }
    }
  }, 60000); // Check every minute

  // Handle POST requests (main MCP interactions)
  app.post(path, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions[sessionId]) {
      // Reuse existing session
      transport = sessions[sessionId].transport;
      touchSession(sessionId);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session initialization
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions[id] = { transport, lastActivity: Date.now() };
          console.error(`[logpare-mcp] HTTP session initialized: ${id}`);
        },
        onsessionclosed: (id: string) => {
          delete sessions[id];
          console.error(`[logpare-mcp] HTTP session closed: ${id}`);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete sessions[transport.sessionId];
        }
      };

      // Connect server to this transport
      try {
        await server.connect(transport);
      } catch (error) {
        // Clean up transport on connection failure
        transport.onclose = undefined;
        if (transport.sessionId) {
          delete sessions[transport.sessionId];
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
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing session ID' },
        id: null,
      });
      return;
    }

    const session = sessions[sessionId];
    if (session) {
      touchSession(sessionId);
      await session.transport.handleRequest(req, res);
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
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing session ID' },
        id: null,
      });
      return;
    }

    const session = sessions[sessionId];
    if (session) {
      await session.transport.handleRequest(req, res);
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

  return { app, getActiveSessionCount, closeAllSessions };
}
