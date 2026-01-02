# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server wrapping the `logpare` library for semantic log compression. Achieves 60-90% token reduction while preserving diagnostic information. Targets Claude Desktop, Cursor, and VS Code MCP extension.

**Package:** `@logpare/mcp`
**Repository:** https://github.com/logpare/logpare-mcp

## Commands

```bash
pnpm install      # Install dependencies
pnpm build        # Build the project
pnpm dev          # Development mode with watch
pnpm inspect      # Test with MCP Inspector
```

## Architecture

### Project Structure
```
src/
├── index.ts              # Entry point, server setup, tool/resource/prompt registration
├── tools/
│   ├── compress.ts       # compress_logs tool (sync + async)
│   ├── analyze.ts        # analyze_log_patterns tool
│   └── estimate.ts       # estimate_compression tool
├── formats/
│   └── smart.ts          # LLM-optimized formatting with severity grouping
├── stores/
│   └── task-store.ts     # In-memory task state for async operations
├── transports/
│   └── http.ts           # HTTP streaming transport (Express-based)
├── resources/
│   └── index.ts          # MCP resources for dual-response pattern
├── prompts/
│   └── index.ts          # MCP prompts for diagnostic workflows
└── middleware/
    └── auth.ts           # Auth middleware stub (ready for OAuth)
```

### Transports

Supports two transport modes via `MCP_TRANSPORT` environment variable:

- **stdio** (default): Local integration for Claude Desktop, Cursor. Appropriate for sensitive logs.
- **http**: Remote/async use cases. Runs Express server on `MCP_PORT` (default: 3000) at `/mcp` endpoint.

### Core Components
- **MCP Server**: `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
- **stdio Transport**: `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
- **HTTP Transport**: `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`
- **Validation**: Zod schemas for tool parameters
- **Compression**: `logpare` library's `compressText` and `createDrain` functions

## Tools

### `compress_logs`
Primary compression tool. Automatically uses async processing for inputs >1MB.

**Smart format** (default): LLM-optimized output designed for AI diagnostic workflows:
- **Severity grouping**: Separates errors, warnings, and info into distinct sections
- **Hydrated examples**: Shows actual values inline instead of just `<*>` placeholders
- **Expected failure detection**: Identifies 23+ patterns for ad blockers, analytics, CORS, and network errors to reduce noise
- **Performance violation highlighting**: Flags `[Violation]`, `Forced reflow`, `Long task`, and `handler took` patterns
- **Stack frame correlation**: Automatically associates error templates with related stack frames
- **File activity summaries**: Shows which JS/TS files appear most frequently
- **Status code mapping**: Maps HTTP codes (200, 404, 500, etc.) to human-readable labels
- **Correlation ID extraction**: Displays first 8 chars of request/trace IDs for tracing
- **Success signal surfacing**: Balances error focus by highlighting success patterns (200, OK, loaded, connected)
- **Numeric range extraction**: Shows min/max/avg with units (ms, KB, %) for numeric values

| Parameter       | Type                                        | Default | Description                                      |
| --------------- | ------------------------------------------- | ------- | ------------------------------------------------ |
| `logs`          | string                                      | —       | Raw log content (required)                       |
| `format`        | "smart" \| "summary" \| "detailed" \| "json" | smart   | Output format                                    |
| `max_templates` | number (1-500)                              | 50      | Maximum templates in output                      |
| `depth`         | number (2-6)                                | 4       | Drain tree depth (higher = more specific)        |
| `threshold`     | number (0-1)                                | 0.4     | Similarity threshold (lower = more aggressive)   |
| `use_task`      | boolean                                     | false   | Force async task-based processing                |

### `analyze_log_patterns`
Extract templates without compression. Shows patterns with occurrence counts and sample values.

| Parameter       | Type           | Default | Description                  |
| --------------- | -------------- | ------- | ---------------------------- |
| `logs`          | string         | —       | Raw log content (required)   |
| `max_templates` | number (1-100) | 20      | Maximum templates to return  |

### `estimate_compression`
Quick compression ratio estimate without full output.

| Parameter | Type   | Description                |
| --------- | ------ | -------------------------- |
| `logs`    | string | Raw log content (required) |

## MCP Resources

Resources enable the dual-response pattern for large results:
- `logpare://results/{taskId}` - Full compression output
- `logpare://templates/{taskId}` - Template list only
- `logpare://stats/{taskId}` - Statistics only

## MCP Prompts

Diagnostic workflow templates:
- `diagnose_errors` - Systematic error analysis
- `find_root_cause` - Correlate errors with stack traces
- `performance_analysis` - Analyze performance violations
- `summarize_logs` - Generate comprehensive summary

## Async Task Processing

For large files (>1MB) or when `use_task=true`, compression runs asynchronously:

1. Tool returns immediately with `taskId` and `status: "working"`
2. Background processing completes via `setImmediate`
3. Task store holds results for 5 minutes (TTL)
4. Results include `processingTimeMs` for performance tracking

Task states: `working` → `completed` | `failed` | `cancelled`

## Key Dependencies
- `@modelcontextprotocol/sdk` ^1.25.1 - MCP TypeScript SDK
- `logpare` (local link) - Drain algorithm log compression
- `zod` ^3.25.0 - Schema validation
- `express` ^4.21.0 - HTTP transport server
- `tsup` ^8.5.0 - Build tool
- `typescript` ^5.9.0 - TypeScript compiler

## Development Notes

### Local Setup
- Requires Node.js >=20
- `logpare` is linked locally via `link:../logpare` - ensure the sibling repo is available
- Run `pnpm install` after cloning both repos

### MCP SDK
- Tool names use snake_case per SEP-986: `compress_logs` not `compressLogs`
- NEVER log to stdout (corrupts JSON-RPC) - use `console.error()` only
- Import paths require `.js` extensions for ESM
- Return errors as results with `isError: true`, don't throw

### Build
- tsup adds shebang via banner config (don't add to source)
- ESM-only output, targets ES2022
- Bundles to single `dist/index.js` file with type declarations (`dist/index.d.ts`)

### Environment Variables
- `MCP_TRANSPORT`: `stdio` (default) or `http`
- `MCP_PORT`: HTTP server port (default: 3000)

### logpare API (v0.0.5)
```typescript
import { compressText, createDrain } from 'logpare';

// Full compression with formatting
const result = compressText(logs, {
  format: 'summary' | 'detailed' | 'json',
  maxTemplates: 50,
  drain: { depth: 4, simThreshold: 0.4 }
});

// Direct Drain access for pattern extraction
const drain = createDrain({ depth: 4, simThreshold: 0.4 });
drain.addLogLines(lines);
const result = drain.getResult('detailed', maxTemplates);
```

Result structure:
```typescript
{
  templates: Template[];
  stats: {
    inputLines: number;
    uniqueTemplates: number;
    compressionRatio: number;
    estimatedTokenReduction: number;
  };
  formatted: string;
}
```

Template structure (v0.0.5):
```typescript
interface Template {
  id: string;
  pattern: string;              // Log template with <*> placeholders
  occurrences: number;
  sampleVariables: string[][];  // Up to 3 sample values per variable
  firstSeen: number;            // Line number
  lastSeen: number;
  severity: 'error' | 'warning' | 'info';
  isStackFrame: boolean;
  urlSamples: string[];         // Extracted hostnames
  fullUrlSamples: string[];     // Complete URLs with paths
  statusCodeSamples: number[];  // HTTP status codes (200, 404, etc.)
  correlationIdSamples: string[]; // Trace/request IDs
  durationSamples: string[];    // Timing values (e.g., "80ms", "1.5s")
}
```
