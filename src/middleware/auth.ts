import type { Request, Response, NextFunction } from 'express';

/**
 * Scope definitions for logpare MCP operations.
 * Used for OAuth 2.1 authorization when implemented.
 */
export const SCOPES = {
  /** List available operations and metadata */
  DISCOVER: 'logs:discover',

  /** Run log compression operations */
  COMPRESS: 'logs:compress',

  /** Access full compression results via resources */
  EXPORT: 'logs:export',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/**
 * Authentication context passed through requests.
 * Currently no-op, ready for OAuth 2.1 implementation.
 */
export interface AuthContext {
  /** Whether the request is authenticated */
  authenticated: boolean;

  /** Granted scopes for this request */
  scopes: Scope[];

  /** User/client identifier (when authenticated) */
  subject?: string;

  /** Token expiration time (when authenticated) */
  expiresAt?: Date;
}

/**
 * Default auth context (no-op, all access granted).
 * Replace with actual OAuth validation in production.
 */
const DEFAULT_AUTH_CONTEXT: AuthContext = {
  authenticated: true,
  scopes: [SCOPES.DISCOVER, SCOPES.COMPRESS, SCOPES.EXPORT],
};

/**
 * No-op authentication middleware.
 *
 * This middleware is structured for future OAuth 2.1 implementation:
 * 1. Validates bearer token from Authorization header
 * 2. Extracts scopes from token claims
 * 3. Attaches auth context to request
 *
 * Currently passes all requests with full access.
 *
 * @example Future OAuth implementation:
 * ```typescript
 * export function createAuthMiddleware(config: OAuthConfig) {
 *   return async (req: Request, res: Response, next: NextFunction) => {
 *     const authHeader = req.headers.authorization;
 *     if (!authHeader?.startsWith('Bearer ')) {
 *       res.status(401).json({ error: 'Missing bearer token' });
 *       return;
 *     }
 *
 *     const token = authHeader.slice(7);
 *     const claims = await validateToken(token, config);
 *
 *     req.authContext = {
 *       authenticated: true,
 *       scopes: claims.scope.split(' ') as Scope[],
 *       subject: claims.sub,
 *       expiresAt: new Date(claims.exp * 1000),
 *     };
 *
 *     next();
 *   };
 * }
 * ```
 */
export function noopAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  // Attach default auth context to request
  (req as Request & { authContext: AuthContext }).authContext = DEFAULT_AUTH_CONTEXT;

  // Pass through all requests (no-op)
  next();
}

/**
 * Scope checking middleware factory.
 * Use after authentication to verify required scopes.
 *
 * @param requiredScopes - Scopes required for the operation
 * @returns Middleware that checks for required scopes
 *
 * @example
 * ```typescript
 * app.post('/mcp', noopAuthMiddleware, requireScopes([SCOPES.COMPRESS]), handler);
 * ```
 */
export function requireScopes(requiredScopes: Scope[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authContext = (req as Request & { authContext?: AuthContext }).authContext;

    if (!authContext?.authenticated) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authentication required' },
        id: null,
      });
      return;
    }

    const hasAllScopes = requiredScopes.every((scope) =>
      authContext.scopes.includes(scope)
    );

    if (!hasAllScopes) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: {
          code: -32002,
          message: `Insufficient scope. Required: ${requiredScopes.join(', ')}`,
        },
        id: null,
      });
      return;
    }

    next();
  };
}

/**
 * Get auth context from request.
 * Returns undefined if no auth context is attached.
 */
export function getAuthContext(req: Request): AuthContext | undefined {
  return (req as Request & { authContext?: AuthContext }).authContext;
}
