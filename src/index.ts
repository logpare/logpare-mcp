import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  compressLogsSchema,
  compressLogsDescription,
  handleCompressLogs,
  type CompressLogsArgs,
} from './tools/compress.js';
import {
  analyzeLogPatternsSchema,
  analyzeLogPatternsDescription,
  handleAnalyzeLogPatterns,
  type AnalyzeLogPatternsArgs,
} from './tools/analyze.js';
import {
  estimateCompressionSchema,
  estimateCompressionDescription,
  handleEstimateCompression,
  type EstimateCompressionArgs,
} from './tools/estimate.js';
import { taskStore } from './stores/task-store.js';
import { createHttpTransport, closeAllSessions } from './transports/http.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { noopAuthMiddleware } from './middleware/auth.js';

/**
 * Transport mode: 'stdio' (default) or 'http'
 * Set via MCP_TRANSPORT environment variable.
 */
const TRANSPORT_MODE = process.env.MCP_TRANSPORT ?? 'stdio';

// Create MCP server instance with full capabilities
const server = new McpServer(
  {
    name: 'logpare',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    },
  }
);

// Register compress_logs tool
server.tool(
  'compress_logs',
  compressLogsDescription,
  {
    logs: z.string().describe('Raw log content as a multi-line string'),
    format: z
      .enum(['smart', 'summary', 'detailed', 'json'])
      .optional()
      .describe("Output format: 'smart' (default, LLM-optimized with severity grouping), 'summary', 'detailed', or 'json'"),
    max_templates: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Maximum templates to include (default: 50)'),
    depth: z
      .number()
      .int()
      .min(2)
      .max(6)
      .optional()
      .describe('Drain tree depth (default: 4)'),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Similarity threshold 0-1 (default: 0.4)'),
    use_task: z
      .boolean()
      .optional()
      .describe('Force async task-based processing'),
  },
  async (args) => {
    const result = handleCompressLogs(args as CompressLogsArgs);
    return {
      content: result.content,
      isError: result.isError,
    };
  }
);

// Register analyze_log_patterns tool
server.tool(
  'analyze_log_patterns',
  analyzeLogPatternsDescription,
  {
    logs: z.string().describe('Raw log content to analyze'),
    max_templates: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum templates to return (default: 20)'),
  },
  async (args) => {
    const result = handleAnalyzeLogPatterns(args as AnalyzeLogPatternsArgs);
    return {
      content: result.content,
      isError: result.isError,
    };
  }
);

// Register estimate_compression tool
server.tool(
  'estimate_compression',
  estimateCompressionDescription,
  {
    logs: z.string().describe('Raw log content to estimate compression for'),
  },
  async (args) => {
    const result = handleEstimateCompression(args as EstimateCompressionArgs);
    return {
      content: result.content,
      isError: result.isError,
    };
  }
);

// Register MCP resources (dual-response pattern for large results)
registerResources(server);

// Register MCP prompts (diagnostic templates for LLM interactions)
registerPrompts(server);

// Cleanup on exit
process.on('SIGINT', () => {
  taskStore.destroy();
  if (TRANSPORT_MODE === 'http') {
    closeAllSessions();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  taskStore.destroy();
  if (TRANSPORT_MODE === 'http') {
    closeAllSessions();
  }
  process.exit(0);
});

// Start the server with selected transport
// CRITICAL: Never log to stdout in stdio mode (corrupts JSON-RPC)
if (TRANSPORT_MODE === 'http') {
  // HTTP streaming transport for remote/async use cases
  await createHttpTransport(server, {
    authMiddleware: noopAuthMiddleware,
  });
  console.error('[logpare-mcp] Server started with HTTP transport');
} else {
  // stdio transport for local use (Claude Desktop, Cursor)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[logpare-mcp] Server started with stdio transport');
}
