import { z } from 'zod';
import { compressText } from 'logpare';

export const estimateCompressionSchema = z.object({
  logs: z.string().describe('Raw log content to estimate compression for'),
});

export type EstimateCompressionArgs = z.infer<typeof estimateCompressionSchema>;

export const estimateCompressionDescription = `Quickly estimate compression ratio without returning the full compressed output. Use this to check if a log dump is worth compressing before running full compression.`;

/** Tool result type compatible with MCP SDK */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Handler for estimate_compression tool.
 */
export function handleEstimateCompression(args: EstimateCompressionArgs): ToolResult {
  const { logs } = args;

  try {
    const lines = logs.split(/\r?\n/).filter((line) => line.trim());

    if (lines.length === 0) {
      return {
        content: [{ type: 'text', text: 'No log lines found.' }],
      };
    }

    const result = compressText(logs, { format: 'json' });
    const stats = result.stats;

    // Rough token estimate (chars / 4 is a common approximation)
    const originalTokens = Math.ceil(logs.length / 4);
    const compressedTokens = Math.ceil(result.formatted.length / 4);
    const tokensSaved = originalTokens - compressedTokens;
    const tokenReductionPercent = ((tokensSaved / originalTokens) * 100).toFixed(1);

    // Generate recommendation
    let recommendation: string;
    let recommendationEmoji: string;

    if (stats.estimatedTokenReduction > 0.5) {
      recommendation = 'Good candidate for compression — high repetition detected';
      recommendationEmoji = '✓';
    } else if (stats.estimatedTokenReduction > 0.2) {
      recommendation = 'Moderate compression potential';
      recommendationEmoji = '△';
    } else {
      recommendation = 'Limited compression potential — logs have low repetition';
      recommendationEmoji = '✗';
    }

    const output = [
      '=== Compression Estimate ===',
      '',
      `Input: ${stats.inputLines.toLocaleString()} lines`,
      `Templates: ${stats.uniqueTemplates} unique patterns`,
      `Compression ratio: ${(stats.compressionRatio * 100).toFixed(1)}%`,
      '',
      'Estimated tokens:',
      `  Original: ~${originalTokens.toLocaleString()}`,
      `  Compressed: ~${compressedTokens.toLocaleString()}`,
      `  Savings: ~${tokensSaved.toLocaleString()} tokens (${tokenReductionPercent}%)`,
      '',
      `${recommendationEmoji} ${recommendation}`,
    ].join('\n');

    return {
      content: [{ type: 'text', text: output }],
      structuredContent: {
        inputLines: stats.inputLines,
        uniqueTemplates: stats.uniqueTemplates,
        compressionRatio: stats.compressionRatio,
        estimatedTokenReduction: stats.estimatedTokenReduction,
        originalTokensEstimate: originalTokens,
        compressedTokensEstimate: compressedTokens,
        tokensSavedEstimate: tokensSaved,
        recommendation,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{ type: 'text', text: `Error estimating compression: ${message}` }],
      isError: true,
    };
  }
}
