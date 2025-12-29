import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Register all MCP prompts with the server.
 *
 * Prompts provide reusable templates for LLM interactions,
 * guiding systematic analysis of compressed log output.
 */
export function registerPrompts(server: McpServer): void {
  // Prompt: diagnose_errors
  // Systematic error analysis of compressed logs
  server.prompt(
    'diagnose_errors',
    {
      title: 'Error Diagnosis',
      description: 'Systematic analysis of error patterns in compressed logs',
    },
    {
      compressed_output: z.string().describe('Output from compress_logs tool'),
      focus_area: z.string().optional().describe('Specific error type to focus on (optional)'),
    },
    ({ compressed_output, focus_area }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Analyze these compressed logs for errors:\n\n${compressed_output}\n\n` +
              (focus_area ? `Focus specifically on: ${focus_area}\n\n` : '') +
              `Provide a structured analysis:\n` +
              `1. Error severity ranking (which errors are most critical)\n` +
              `2. Root cause hypotheses (what might be causing these errors)\n` +
              `3. Correlation patterns (are errors related to each other)\n` +
              `4. Recommended investigation steps`,
          },
        },
      ],
    })
  );

  // Prompt: find_root_cause
  // Correlate error templates with stack traces
  server.prompt(
    'find_root_cause',
    {
      title: 'Root Cause Analysis',
      description: 'Correlate error templates with stack traces to identify root causes',
    },
    {
      templates: z.string().describe('Error templates from compression'),
      stack_traces: z.string().describe('Related stack trace patterns'),
    },
    ({ templates, stack_traces }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Correlate these error templates with stack traces to find root causes:\n\n` +
              `## Error Templates\n${templates}\n\n` +
              `## Stack Trace Patterns\n${stack_traces}\n\n` +
              `Provide:\n` +
              `1. Template-to-trace mapping (which templates correspond to which stack traces)\n` +
              `2. Root cause identification (the underlying issues)\n` +
              `3. Fix recommendations (how to resolve each root cause)\n` +
              `4. Priority order (which fixes should be addressed first)`,
          },
        },
      ],
    })
  );

  // Prompt: performance_analysis
  // Analyze performance violation patterns
  server.prompt(
    'performance_analysis',
    {
      title: 'Performance Analysis',
      description: 'Analyze performance violation patterns from compressed logs',
    },
    {
      performance_patterns: z.string().describe('Performance-related templates from compression'),
    },
    ({ performance_patterns }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Analyze these performance patterns from compressed logs:\n\n${performance_patterns}\n\n` +
              `Provide:\n` +
              `1. Slowest operations (identify the biggest performance bottlenecks)\n` +
              `2. Pattern trends (are there timing patterns or degradation over time)\n` +
              `3. Resource correlations (what resources might be constrained)\n` +
              `4. Optimization recommendations (specific improvements to make)`,
          },
        },
      ],
    })
  );

  // Prompt: summarize_logs
  // General log summary and insights
  server.prompt(
    'summarize_logs',
    {
      title: 'Log Summary',
      description: 'Generate a comprehensive summary and insights from compressed logs',
    },
    {
      compressed_output: z.string().describe('Output from compress_logs tool'),
    },
    ({ compressed_output }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Summarize these compressed logs and provide insights:\n\n${compressed_output}\n\n` +
              `Provide:\n` +
              `1. Executive summary (2-3 sentences on overall system health)\n` +
              `2. Key findings (most important patterns discovered)\n` +
              `3. Anomalies (anything unusual or unexpected)\n` +
              `4. Recommended actions (what should be done based on these logs)`,
          },
        },
      ],
    })
  );
}
