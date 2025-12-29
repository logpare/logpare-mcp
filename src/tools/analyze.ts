import { z } from 'zod';
import { createDrain } from 'logpare';

export const analyzeLogPatternsSchema = z.object({
  logs: z.string().describe('Raw log content to analyze'),
  max_templates: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of templates to return (default: 20)'),
});

export type AnalyzeLogPatternsArgs = z.infer<typeof analyzeLogPatternsSchema>;

export const analyzeLogPatternsDescription = `Extract log templates and patterns without full compression. Shows the structure of logs with occurrence counts and sample variable values. Useful for understanding log patterns before deciding on compression settings.`;

/** Tool result type compatible with MCP SDK */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Handler for analyze_log_patterns tool.
 */
export function handleAnalyzeLogPatterns(args: AnalyzeLogPatternsArgs): ToolResult {
  const { logs, max_templates = 20 } = args;

  try {
    const lines = logs.split(/\r?\n/).filter((line) => line.trim());

    if (lines.length === 0) {
      return {
        content: [{ type: 'text', text: 'No log lines found to analyze.' }],
      };
    }

    const drain = createDrain();
    drain.addLogLines(lines);
    const result = drain.getResult('detailed', max_templates);

    // Build formatted output
    const templateList = result.templates
      .slice(0, max_templates)
      .map((t, i) => {
        const samples =
          t.sampleVariables.length > 0
            ? t.sampleVariables
                .slice(0, 3)
                .map((vars) => vars.join(', '))
                .join(' | ')
            : '';
        return `${i + 1}. [${t.occurrences}x] ${t.pattern}${samples ? `\n   Sample values: ${samples}` : ''}`;
      })
      .join('\n\n');

    const output = [
      '=== Log Pattern Analysis ===',
      '',
      `Lines analyzed: ${result.stats.inputLines}`,
      `Unique templates found: ${result.stats.uniqueTemplates}`,
      `Potential token reduction: ${(result.stats.estimatedTokenReduction * 100).toFixed(1)}%`,
      '',
      'Top templates by frequency:',
      '',
      templateList,
      result.templates.length > max_templates
        ? `\n... and ${result.templates.length - max_templates} more templates`
        : '',
    ].join('\n');

    return {
      content: [{ type: 'text', text: output }],
      structuredContent: {
        inputLines: result.stats.inputLines,
        uniqueTemplates: result.stats.uniqueTemplates,
        estimatedTokenReduction: result.stats.estimatedTokenReduction,
        templates: result.templates.slice(0, max_templates).map((t) => ({
          id: t.id,
          pattern: t.pattern,
          occurrences: t.occurrences,
          sampleVariables: t.sampleVariables,
          firstSeen: t.firstSeen,
          lastSeen: t.lastSeen,
        })),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{ type: 'text', text: `Error analyzing logs: ${message}` }],
      isError: true,
    };
  }
}
