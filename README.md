# @logpare/mcp

MCP server for [logpare](https://github.com/logpare/logpare) — semantic log compression for AI assistants.

Reduce repetitive logs by 60-90% while preserving diagnostic information. Perfect for fitting large log dumps into LLM context windows.

Requires **Node.js 20** or later.

## Installation

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "logpare": {
      "command": "npx",
      "args": ["-y", "@logpare/mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "logpare": {
      "command": "npx",
      "args": ["-y", "@logpare/mcp"]
    }
  }
}
```

### Claude Code

Add to your settings with `claude mcp add`:

```bash
claude mcp add logpare -- npx -y @logpare/mcp
```

Or add directly to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "logpare": {
      "command": "npx",
      "args": ["-y", "@logpare/mcp"]
    }
  }
}
```

### Local Development

Point to your local build:

```json
{
  "mcpServers": {
    "logpare": {
      "command": "node",
      "args": ["/path/to/logpare-mcp/dist/index.js"]
    }
  }
}
```

## Tools

### compress_logs

Compress repetitive logs using the Drain algorithm. For inputs >1MB, automatically uses async task-based processing.

| Parameter       | Type                                         | Default | Description                                    |
| --------------- | -------------------------------------------- | ------- | ---------------------------------------------- |
| `logs`          | string                                       | —       | Raw log content (required)                     |
| `format`        | "smart" \| "summary" \| "detailed" \| "json" | smart   | Output format (see smart format below)         |
| `max_templates` | number (1-500)                               | 50      | Maximum templates to include                   |
| `depth`         | number (2-6)                                 | 4       | Drain tree depth (higher = more specific)      |
| `threshold`     | number (0-1)                                 | 0.4     | Similarity threshold (lower = more aggressive) |
| `use_task`      | boolean                                      | false   | Force async processing                         |

### analyze_log_patterns

Extract log templates without full compression. Shows patterns with occurrence counts and sample variable values.

| Parameter       | Type           | Default | Description                  |
| --------------- | -------------- | ------- | ---------------------------- |
| `logs`          | string         | —       | Raw log content (required)   |
| `max_templates` | number (1-100) | 20      | Maximum templates to return  |

### estimate_compression

Quick compression ratio estimate without full output. Use to check if a log dump is worth compressing.

| Parameter | Type   | Description                |
| --------- | ------ | -------------------------- |
| `logs`    | string | Raw log content (required) |

### Smart Format

The default "smart" format is optimized for LLM diagnostic workflows:

- **Severity grouping** — Errors, warnings, and info separated into sections
- **Expected failure detection** — Identifies ad blockers, analytics, CORS failures to reduce noise
- **Performance violation highlighting** — Flags `[Violation]`, `Forced reflow`, `Long task` patterns
- **Stack frame correlation** — Associates errors with related stack traces
- **File activity summaries** — Shows most active source files
- **Hydrated examples** — Displays actual values instead of `<*>` placeholders
- **Duration extraction** — Shows timing values (e.g., "80ms", "1.5s") with min/max/avg
- **Status code mapping** — Maps HTTP codes to human-readable labels
- **Correlation ID display** — Shows first 8 chars of trace/request IDs

## Resources

Access compression results via MCP resources (for async task results):

| URI                            | Description                      |
| ------------------------------ | -------------------------------- |
| `logpare://results/{taskId}`   | Full compression result (JSON)   |
| `logpare://templates/{taskId}` | Template list only               |
| `logpare://stats/{taskId}`     | Compression statistics           |

## Prompts

Diagnostic prompt templates for LLM guidance:

| Prompt                 | Description                           |
| ---------------------- | ------------------------------------- |
| `diagnose_errors`      | Systematic error pattern analysis     |
| `find_root_cause`      | Correlate errors with stack traces    |
| `performance_analysis` | Analyze performance violations        |
| `summarize_logs`       | General log summary                   |

## Async Task Processing

For large inputs (>1MB) or when `use_task=true`:

1. Tool returns immediately with a `taskId`
2. Poll for progress via resources
3. Supports cancellation during processing

Task progress includes phase information (`parsing`, `clustering`, `finalizing`) and line counts.

## HTTP Transport (Remote Deployment)

For remote/networked deployments, use HTTP streaming transport:

```bash
MCP_TRANSPORT=http MCP_PORT=3000 node dist/index.js
```

Clients connect via HTTP POST to `/mcp`. The server supports:

- Session management with `mcp-session-id` header
- Server-Sent Events for streaming responses
- OAuth-ready middleware structure

## Example Usage

**"Here are my server logs, can you compress them and identify the main error patterns?"**

> Claude uses `compress_logs` and returns a summary with 90%+ token reduction

**"Before I paste these 50k lines of logs, can you estimate if compression will help?"**

> Claude uses `estimate_compression` to check reduction potential

**"What patterns are in these logs?"**

> Claude uses `analyze_log_patterns` to show template structure

## Tuning Tips

| Symptom                  | Solution                    |
| ------------------------ | --------------------------- |
| Too many templates       | Lower threshold (e.g., 0.3) |
| Templates too generic    | Raise threshold (e.g., 0.5) |
| Similar logs not grouped | Increase depth (e.g., 5-6)  |

## Development

```bash
pnpm install    # Install dependencies
pnpm build      # Build the project
pnpm dev        # Development with watch
pnpm inspect    # Test with MCP Inspector
```

## Related

- [logpare](https://github.com/logpare/logpare) — Core library and CLI
- [MCP Documentation](https://modelcontextprotocol.io)

## License

MIT
