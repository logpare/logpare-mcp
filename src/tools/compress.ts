import { z } from 'zod';
import { compressText, type CompressionResult, type Template, type ProgressEvent } from 'logpare';
import { taskStore, type TaskResult, type TaskProgress } from '../stores/task-store.js';
import {
  formatSmart,
  isExpectedFailure,
  hydratePattern,
  extractNumericRange,
  isPerformanceViolation,
} from '../formats/smart.js';

// Size threshold for async processing (1MB)
const ASYNC_THRESHOLD = 1024 * 1024;

export const compressLogsSchema = z.object({
  logs: z.string().describe('Raw log content as a multi-line string'),
  format: z
    .enum(['smart', 'summary', 'detailed', 'json'])
    .optional()
    .describe(
      "Output format: 'smart' (default, LLM-optimized with severity grouping), 'summary' (compact), 'detailed' (full templates), 'json' (machine-readable)"
    ),
  max_templates: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Maximum number of templates to include in output (default: 50)'),
  depth: z
    .number()
    .int()
    .min(2)
    .max(6)
    .optional()
    .describe(
      'Drain algorithm parse tree depth. Higher = more specific templates (default: 4)'
    ),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Similarity threshold for grouping logs. Lower = more aggressive grouping (default: 0.4)'
    ),
  use_task: z
    .boolean()
    .optional()
    .describe('Force async task-based processing for large files'),
});

export type CompressLogsArgs = z.infer<typeof compressLogsSchema>;

export const compressLogsDescription = `Compress repetitive logs for LLM context windows. Uses the Drain algorithm to extract log templates, achieving 60-90% token reduction while preserving all diagnostic information. Best for large log dumps with repetitive patterns.

For files >1MB, automatically uses async task-based processing (poll for results).`;

/** Tool result type compatible with MCP SDK */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Enrich a template with additional diagnostic fields.
 */
function enrichTemplate(t: Template) {
  const firstSample = t.sampleVariables[0] || [];
  const numericRange = extractNumericRange(t.sampleVariables);

  return {
    id: t.id,
    pattern: t.pattern,
    occurrences: t.occurrences,
    severity: t.severity,
    isStackFrame: t.isStackFrame,
    // New enriched fields
    hydratedExample: hydratePattern(t.pattern, firstSample),
    isExpectedFailure: isExpectedFailure(t),
    isPerformanceViolation: isPerformanceViolation(t),
    // URL samples
    urlSamples: t.urlSamples,
    fullUrlSamples: t.fullUrlSamples || [],
    // New extraction fields
    statusCodeSamples: t.statusCodeSamples || [],
    correlationIdSamples: t.correlationIdSamples || [],
    durationSamples: t.durationSamples || [],
    // Numeric range if applicable
    numericRange: numericRange
      ? {
          min: numericRange.min,
          max: numericRange.max,
          avg: numericRange.avg,
          unit: numericRange.unit,
        }
      : null,
    // Sample variables
    sampleVariables: t.sampleVariables,
    // Temporal info
    firstSeen: t.firstSeen,
    lastSeen: t.lastSeen,
  };
}

/**
 * Generate summary counts for structured content.
 */
function generateSummary(templates: Template[]) {
  const allErrors = templates.filter((t) => t.severity === 'error' && !t.isStackFrame);
  const warnings = templates.filter((t) => t.severity === 'warning' && !t.isStackFrame);

  return {
    userImpactingErrors: allErrors.filter((t) => !isExpectedFailure(t)).length,
    expectedFailures: allErrors.filter((t) => isExpectedFailure(t)).length,
    performanceViolations: warnings.filter((t) => isPerformanceViolation(t)).length,
    otherWarnings: warnings.filter((t) => !isPerformanceViolation(t)).length,
    infoPatterns: templates.filter((t) => t.severity === 'info' && !t.isStackFrame).length,
    stackTracePatterns: templates.filter((t) => t.isStackFrame).length,
  };
}

/**
 * Synchronous compression handler.
 */
function compressSync(args: CompressLogsArgs): ToolResult {
  const {
    logs,
    format = 'smart',
    max_templates = 50,
    depth,
    threshold,
  } = args;

  try {
    // 'smart' format is MCP-specific; internally use 'detailed' from logpare
    // and post-process with formatSmart() for LLM-optimized output
    const internalFormat = format === 'smart' ? 'detailed' : format;

    const result = compressText(logs, {
      format: internalFormat,
      maxTemplates: max_templates,
      drain: {
        ...(depth !== undefined && { depth }),
        ...(threshold !== undefined && { simThreshold: threshold }),
      },
    });

    // Apply smart formatting if requested
    const outputText =
      format === 'smart'
        ? formatSmart(result.templates, result.stats)
        : result.formatted;

    const limitedTemplates = result.templates.slice(0, max_templates);

    return {
      content: [{ type: 'text', text: outputText }],
      structuredContent: {
        compressionRatio: result.stats.compressionRatio,
        inputLines: result.stats.inputLines,
        uniqueTemplates: result.stats.uniqueTemplates,
        estimatedTokenReduction: result.stats.estimatedTokenReduction,
        summary: generateSummary(result.templates),
        templates: limitedTemplates.map(enrichTemplate),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{ type: 'text', text: `Error compressing logs: ${message}` }],
      isError: true,
    };
  }
}

/**
 * Map logpare ProgressEvent to TaskProgress.
 */
function mapProgress(event: ProgressEvent): TaskProgress {
  // Map logpare phases to task phases
  const phaseMap: Record<ProgressEvent['currentPhase'], TaskProgress['currentPhase']> = {
    parsing: 'parsing',
    clustering: 'clustering',
    finalizing: 'finalizing',
  };

  const totalLines = event.totalLines ?? 0;
  const processedLines = event.processedLines;
  const percent = event.percentComplete ?? (totalLines > 0 ? Math.round((processedLines / totalLines) * 100) : 0);

  return {
    percent,
    statusMessage: `Processing ${processedLines.toLocaleString()}${totalLines ? ` / ${totalLines.toLocaleString()}` : ''} lines`,
    currentPhase: phaseMap[event.currentPhase],
    processedLines,
    totalLines: totalLines || undefined,
  };
}

/**
 * Start async compression task.
 */
function startAsyncCompression(args: CompressLogsArgs): ToolResult {
  const task = taskStore.create();
  const taskId = task.taskId;

  // Run compression in background with error boundary
  setImmediate(() => {
    (async () => {
      // Check for cancellation before starting
      if (taskStore.isCancelled(taskId)) {
        return;
      }

      const startTime = performance.now();
      const {
        logs,
        format = 'smart',
        max_templates = 50,
        depth,
        threshold,
      } = args;

      try {
        // 'smart' format is MCP-specific; internally use 'detailed' from logpare
        // and post-process with formatSmart() for LLM-optimized output
        const internalFormat = format === 'smart' ? 'detailed' : format;

        const result = compressText(logs, {
          format: internalFormat,
          maxTemplates: max_templates,
          drain: {
            ...(depth !== undefined && { depth }),
            ...(threshold !== undefined && { simThreshold: threshold }),
            // Wire progress callback to task store
            onProgress: (event: ProgressEvent) => {
              // Check for cancellation during processing
              if (taskStore.isCancelled(taskId)) {
                // Note: We can't actually stop the Drain algorithm mid-processing,
                // but we can stop updating progress and skip completion
                return;
              }
              taskStore.updateProgress(taskId, mapProgress(event));
            },
          },
        });

        // Apply smart formatting if requested
        const outputText =
          format === 'smart'
            ? formatSmart(result.templates, result.stats)
            : result.formatted;

        const processingTimeMs = Math.round(performance.now() - startTime);
        const limitedTemplates = result.templates.slice(0, max_templates);

        // Check for cancellation before completing
        if (taskStore.isCancelled(taskId)) {
          return;
        }

        const taskResult: TaskResult = {
          content: [{ type: 'text', text: outputText }],
          structuredContent: {
            compressionRatio: result.stats.compressionRatio,
            inputLines: result.stats.inputLines,
            uniqueTemplates: result.stats.uniqueTemplates,
            estimatedTokenReduction: result.stats.estimatedTokenReduction,
            summary: generateSummary(result.templates),
            templates: limitedTemplates.map(enrichTemplate),
            processingTimeMs,
          },
        };

        taskStore.complete(taskId, taskResult);
      } catch (error) {
        // Don't report errors for cancelled tasks
        if (taskStore.isCancelled(taskId)) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Unknown error';

        // Determine specific error code based on error type
        let code = 'COMPRESSION_FAILED';
        if (message.includes('empty') || message.includes('invalid')) {
          code = 'INVALID_INPUT';
        } else if (message.includes('memory') || message.includes('heap')) {
          code = 'INPUT_TOO_LARGE';
        }

        taskStore.fail(taskId, { code, message });
      }
    })().catch((error) => {
      // Ultimate fallback - should never reach here
      console.error('[logpare-mcp] Unexpected error in async compression:', error);
    });
  });

  return {
    content: [
      {
        type: 'text',
        text: `Compression task started. Task ID: ${task.taskId}\n\nPoll for status using the task ID. Estimated completion: a few seconds.`,
      },
    ],
    structuredContent: {
      taskId: task.taskId,
      status: 'working',
      createdAt: task.createdAt,
      pollInterval: task.pollInterval,
    },
  };
}

/**
 * Main handler for compress_logs tool.
 */
export function handleCompressLogs(args: CompressLogsArgs): ToolResult {
  // Route to async if explicitly requested or input is large
  const useAsync = args.use_task === true || args.logs.length > ASYNC_THRESHOLD;

  if (useAsync) {
    return startAsyncCompression(args);
  }

  return compressSync(args);
}
