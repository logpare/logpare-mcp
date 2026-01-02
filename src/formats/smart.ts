import type { Template, CompressionResult } from 'logpare';

/**
 * Patterns and domains that indicate expected failures (ad blockers, analytics, etc.)
 * These are not actionable errors but expected behavior for some users.
 */
const EXPECTED_FAILURE_PATTERNS = [
  /ERR_BLOCKED_BY_CLIENT/i,
  /net::ERR_/i,
  /Failed to fetch/i,
  /NetworkError/i,
  /blocked by client/i,
];

const EXPECTED_FAILURE_DOMAINS = [
  'monorail-edge.shopifysvc.com',
  'api.amplitude.com',
  'connect.facebook.net',
  'kameleoon.io',
  'cdn.attn.tv',
  'ping.fastsimon.com',
  'www.google-analytics.com',
  'stats.g.doubleclick.net',
  'www.googletagmanager.com',
  'analytics',
  'tracking',
  'pixel',
  'beacon',
];

/**
 * Check if a template represents an expected failure (ad blocker, blocked analytics, etc.)
 */
function isExpectedFailure(t: Template): boolean {
  // Check pattern text
  const patternMatch = EXPECTED_FAILURE_PATTERNS.some((p) => p.test(t.pattern));
  if (patternMatch) return true;

  // Check URLs
  const allUrls = [...t.urlSamples, ...(t.fullUrlSamples || [])];
  const domainMatch = allUrls.some((url) =>
    EXPECTED_FAILURE_DOMAINS.some((d) => url.toLowerCase().includes(d.toLowerCase()))
  );
  if (domainMatch) return true;

  return false;
}

/**
 * Hydrate a pattern by replacing <*> placeholders with sample variable values.
 */
function hydratePattern(pattern: string, samples: string[]): string {
  if (!samples || samples.length === 0) return pattern;

  let result = pattern;
  for (const value of samples) {
    result = result.replace('<*>', value);
  }
  return result;
}

/**
 * Extract numeric range from sample variables.
 * Returns min-max range with unit if samples contain numeric values.
 */
function extractNumericRange(
  samples: string[][]
): { min: number; max: number; avg: number; unit: string } | null {
  const numericPattern = /^(\d+(?:\.\d+)?)(ms|s|KB|MB|GB|%|px)?$/;
  const values: number[] = [];
  let unit = '';

  for (const sampleSet of samples) {
    for (const sample of sampleSet) {
      const match = sample.match(numericPattern);
      if (match) {
        values.push(parseFloat(match[1]));
        if (match[2]) unit = match[2];
      }
    }
  }

  if (values.length === 0) return null;

  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
    unit,
  };
}

/**
 * Check if a template is a performance violation.
 */
function isPerformanceViolation(t: Template): boolean {
  return (
    /\[Violation\]/i.test(t.pattern) ||
    /handler took/i.test(t.pattern) ||
    /Forced reflow/i.test(t.pattern) ||
    /Long task/i.test(t.pattern)
  );
}

/**
 * Find stack frames that might be related to an error template.
 * Matches by file references or common patterns between error and stack frames.
 */
function findRelatedStackFrames(
  error: Template,
  allTemplates: Template[],
  maxFrames: number = 5
): Template[] {
  const stackFrames = allTemplates.filter((t) => t.isStackFrame);
  if (stackFrames.length === 0) return [];

  // Extract file references from the error pattern
  const filePattern = /([a-zA-Z0-9_-]+(?:[-.][\w]+)*\.(?:js|ts|jsx|tsx|mjs|cjs))/g;
  const errorFiles = new Set<string>();
  let match;
  while ((match = filePattern.exec(error.pattern)) !== null) {
    errorFiles.add(match[1].toLowerCase());
  }

  // Also check URLs from the error
  const errorUrls = [...error.urlSamples, ...(error.fullUrlSamples || [])];

  // Find stack frames that reference the same files or URLs
  const relatedFrames = stackFrames.filter((frame) => {
    // Check if frame mentions any of the error's files
    const framePattern = frame.pattern.toLowerCase();
    for (const file of errorFiles) {
      if (framePattern.includes(file)) return true;
    }

    // Check if frame mentions any of the error's URLs
    for (const url of errorUrls) {
      if (framePattern.includes(url.toLowerCase())) return true;
    }

    return false;
  });

  // If we found related frames, return them sorted by occurrence
  if (relatedFrames.length > 0) {
    return relatedFrames
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, maxFrames);
  }

  // Fallback: return top stack frames by occurrence (they may still be relevant)
  return stackFrames.sort((a, b) => b.occurrences - a.occurrences).slice(0, maxFrames);
}

/**
 * LLM-optimized smart formatter that groups templates by severity
 * and provides actionable insights with enhanced diagnostic context.
 */
export function formatSmart(
  templates: Template[],
  stats: CompressionResult['stats']
): string {
  const lines: string[] = [];

  // Header
  lines.push('=== Log Analysis ===');
  lines.push(
    `Source: ${stats.inputLines.toLocaleString()} lines → ${stats.uniqueTemplates} unique patterns`
  );
  lines.push('');

  // Categorize templates
  const allErrors = templates.filter((t) => t.severity === 'error' && !t.isStackFrame);
  const userImpactingErrors = allErrors.filter((t) => !isExpectedFailure(t));
  const expectedFailures = allErrors.filter((t) => isExpectedFailure(t));

  const warnings = templates.filter((t) => t.severity === 'warning' && !t.isStackFrame);
  const performanceViolations = warnings.filter((t) => isPerformanceViolation(t));
  const otherWarnings = warnings.filter((t) => !isPerformanceViolation(t));

  const info = templates.filter((t) => t.severity === 'info' && !t.isStackFrame);
  const stackFrames = templates.filter((t) => t.isStackFrame);

  // User-Impacting Errors section
  lines.push('## ERRORS (User-Impacting)');
  if (userImpactingErrors.length > 0) {
    // Show top 3 errors with stack traces
    for (const t of userImpactingErrors.slice(0, 3)) {
      lines.push(formatTemplateEnhanced(t));
      // Add stack traces for the first few errors
      const relatedFrames = findRelatedStackFrames(t, templates, 5);
      if (relatedFrames.length > 0) {
        lines.push('        Stack (first occurrence):');
        for (const frame of relatedFrames) {
          lines.push(`          ${frame.pattern}`);
        }
      }
    }
    // Show remaining errors without stack traces
    for (const t of userImpactingErrors.slice(3, 10)) {
      lines.push(formatTemplateEnhanced(t));
    }
    if (userImpactingErrors.length > 10) {
      lines.push(`   ... and ${userImpactingErrors.length - 10} more errors`);
    }
  } else {
    lines.push('   None detected');
  }
  lines.push('');

  // Expected Failures section (ad blockers, analytics blocks, etc.)
  if (expectedFailures.length > 0) {
    const totalExpectedOccurrences = expectedFailures.reduce((sum, t) => sum + t.occurrences, 0);
    lines.push('## EXPECTED FAILURES (Ad Blocker / Network)');
    lines.push(
      `   [${totalExpectedOccurrences} total across ${expectedFailures.length} patterns]`
    );
    lines.push('');
    // Show first expected failure with stack trace
    const firstExpected = expectedFailures[0];
    lines.push(formatTemplateEnhanced(firstExpected));
    const expectedFrames = findRelatedStackFrames(firstExpected, templates, 3);
    if (expectedFrames.length > 0) {
      lines.push('        Stack (first occurrence):');
      for (const frame of expectedFrames) {
        lines.push(`          ${frame.pattern}`);
      }
    }
    // Show remaining without stack traces
    for (const t of expectedFailures.slice(1, 5)) {
      lines.push(formatTemplateEnhanced(t));
    }
    if (expectedFailures.length > 5) {
      lines.push(`   ... and ${expectedFailures.length - 5} more expected failures`);
    }
    lines.push('');
    lines.push('   Action: Expected behavior for users with ad blockers. No fix needed.');
    lines.push('');
  }

  // Performance Violations section
  if (performanceViolations.length > 0) {
    lines.push('## PERFORMANCE VIOLATIONS');
    for (const t of performanceViolations.slice(0, 10)) {
      lines.push(formatPerformanceTemplate(t));
    }
    if (performanceViolations.length > 10) {
      lines.push(`   ... and ${performanceViolations.length - 10} more violations`);
    }
    lines.push('');
  }

  // Other Warnings section
  if (otherWarnings.length > 0) {
    lines.push('## WARNINGS (Review)');
    for (const t of otherWarnings.slice(0, 10)) {
      lines.push(formatTemplateEnhanced(t));
    }
    if (otherWarnings.length > 10) {
      lines.push(`   ... and ${otherWarnings.length - 10} more warnings`);
    }
    lines.push('');
  }

  // Success signals section - surface key success events from INFO
  const successPatterns = [
    /\b200\b/,
    /\bOK\b/,
    /\bsuccess/i,
    /\bcomplete[d]?\b/i,
    /\bloaded\b/i,
    /\bconnected\b/i,
    /\bready\b/i,
  ];
  const successEvents = info.filter((t) =>
    successPatterns.some((p) => p.test(t.pattern))
  );
  if (successEvents.length > 0) {
    const totalSuccessOccurrences = successEvents.reduce((sum, t) => sum + t.occurrences, 0);
    lines.push('## SUCCESS SIGNALS');
    lines.push(
      `   [${totalSuccessOccurrences.toLocaleString()} occurrences showing system is working]`
    );
    for (const t of successEvents.slice(0, 5)) {
      lines.push(`   [${t.occurrences}x] ${t.pattern}`);
    }
    if (successEvents.length > 5) {
      lines.push(`   ... and ${successEvents.length - 5} more success patterns`);
    }
    lines.push('');
  }

  // Info section (summarized) - excludes success signals already shown
  const remainingInfo = info.filter((t) => !successPatterns.some((p) => p.test(t.pattern)));
  if (remainingInfo.length > 0) {
    const totalInfoOccurrences = remainingInfo.reduce((sum, t) => sum + t.occurrences, 0);
    lines.push('## INFO (Noise)');
    lines.push(
      `   ${remainingInfo.length} patterns, ${totalInfoOccurrences.toLocaleString()} total occurrences`
    );
    lines.push('');
  }

  // Stack frames summary
  if (stackFrames.length > 0) {
    const totalStackOccurrences = stackFrames.reduce((sum, t) => sum + t.occurrences, 0);
    lines.push('## STACK TRACES');
    lines.push(
      `   ${stackFrames.length} frame patterns, ${totalStackOccurrences.toLocaleString()} total occurrences`
    );
    lines.push('');
  }

  // Files by activity
  const fileActivity = extractFileActivity(templates);
  if (fileActivity.length > 0) {
    lines.push('## FILES BY ACTIVITY');
    for (const [file, count] of fileActivity.slice(0, 5)) {
      lines.push(`   ${file}: ${count.toLocaleString()} entries`);
    }
    lines.push('');
  }

  // Status codes summary
  const allStatusCodes = new Map<number, number>();
  templates.forEach((t) => {
    (t.statusCodeSamples || []).forEach((code) => {
      allStatusCodes.set(code, (allStatusCodes.get(code) || 0) + t.occurrences);
    });
  });
  if (allStatusCodes.size > 0) {
    lines.push('## HTTP STATUS CODES');
    const sortedCodes = Array.from(allStatusCodes.entries()).sort((a, b) => b[1] - a[1]);
    for (const [code, count] of sortedCodes.slice(0, 5)) {
      const label = getStatusCodeLabel(code);
      lines.push(`   ${code} ${label}: ${count.toLocaleString()} occurrences`);
    }
    lines.push('');
  }

  // Correlation IDs summary
  const allCorrelationIds = new Set<string>();
  templates.forEach((t) => {
    (t.correlationIdSamples || []).forEach((id) => allCorrelationIds.add(id));
  });
  if (allCorrelationIds.size > 0) {
    lines.push('## CORRELATION IDS');
    const idList = Array.from(allCorrelationIds).slice(0, 5);
    lines.push(`   ${idList.join(', ')}`);
    if (allCorrelationIds.size > 5) {
      lines.push(`   ... and ${allCorrelationIds.size - 5} more`);
    }
    lines.push('');
  }

  // Durations summary
  const allDurations = new Set<string>();
  templates.forEach((t) => {
    (t.durationSamples || []).forEach((d) => allDurations.add(d));
  });
  if (allDurations.size > 0) {
    lines.push('## DURATIONS');
    const durationList = Array.from(allDurations).slice(0, 10);
    lines.push(`   ${durationList.join(', ')}`);
    if (allDurations.size > 10) {
      lines.push(`   ... and ${allDurations.size - 10} more`);
    }
    lines.push('');
  }

  // Stats footer
  lines.push('---');
  lines.push(
    `Compression: ${(stats.compressionRatio * 100).toFixed(1)}% | Token reduction: ~${(stats.estimatedTokenReduction * 100).toFixed(0)}%`
  );

  return lines.join('\n');
}

/**
 * Format a template with enhanced diagnostic information.
 */
function formatTemplateEnhanced(t: Template): string {
  const parts: string[] = [];

  // Gather all sample values for hydration, filtering out any containing <*>
  const allSamples = t.sampleVariables
    .flat()
    .filter((s) => s.length > 0 && !s.includes('<*>'));
  const hydratedPattern = hydratePattern(t.pattern, allSamples);

  // Add correlation ID inline if present (first 8 chars for brevity)
  const correlationIds = t.correlationIdSamples || [];
  const idSuffix = correlationIds.length > 0 ? ` [ID: ${correlationIds[0].slice(0, 8)}]` : '';
  parts.push(`[${t.occurrences}x] ${hydratedPattern}${idSuffix}`);

  // Add full URLs if present (more useful than hostnames)
  const fullUrls = t.fullUrlSamples || [];
  if (fullUrls.length > 0) {
    parts.push(`        URL: ${fullUrls[0]}`);
    if (fullUrls.length > 1) {
      parts.push(`             (and ${fullUrls.length - 1} more URLs)`);
    }
  } else if (t.urlSamples.length > 0) {
    parts.push(`        Domains: ${t.urlSamples.slice(0, 3).join(', ')}`);
  }

  // Add status codes if present
  const statusCodes = t.statusCodeSamples || [];
  if (statusCodes.length > 0) {
    parts.push(`        Status: ${statusCodes.join(', ')}`);
  }

  // Correlation IDs are now shown inline, but show additional IDs if there are more
  if (correlationIds.length > 1) {
    parts.push(`        Additional IDs: ${correlationIds.slice(1, 3).map(id => id.slice(0, 8)).join(', ')}`);
  }

  // Add all sample variables for context, filtering out any containing <*>
  if (t.sampleVariables.length > 0) {
    const samples = t.sampleVariables
      .map((vars) =>
        vars
          .filter((v) => v.length > 0 && v.length < 80 && !v.includes('<*>'))
          .join(', ')
      )
      .filter((s) => s.length > 0);
    if (samples.length > 0) {
      parts.push(`        Samples:`);
      for (const sample of samples.slice(0, 3)) {
        parts.push(`          - ${truncate(sample, 70)}`);
      }
    }
  }

  return parts.join('\n');
}

/**
 * Format a performance violation template with numeric ranges.
 */
function formatPerformanceTemplate(t: Template): string {
  const parts: string[] = [];

  // Use durationSamples if available (preferred), otherwise fall back to sampleVariables
  const durations = t.durationSamples || [];

  if (durations.length > 0) {
    // Parse duration samples to get min/max
    const numericValues = durations
      .map((d: string) => {
        const match = d.match(/^(\d+(?:\.\d+)?)/);
        return match ? parseFloat(match[1]) : 0;
      })
      .filter((v: number) => v > 0);

    if (numericValues.length > 0) {
      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);
      // Extract unit from first duration
      const unitMatch = durations[0].match(/[a-zA-Zµμ]+$/);
      const unit = unitMatch ? unitMatch[0] : 'ms';
      const rangeStr = min === max ? `${min}${unit}` : `${min}-${max}${unit}`;
      const patternWithRange = t.pattern.replace(/took <\*>/, `took ${rangeStr}`);
      parts.push(`[${t.occurrences}x] ${patternWithRange}`);
      parts.push(`        Durations: ${durations.slice(0, 5).join(', ')}`);
      return parts.join('\n');
    }
  }

  // Fall back to extractNumericRange from sampleVariables (legacy behavior)
  const range = extractNumericRange(t.sampleVariables);

  if (range) {
    // Show pattern with numeric range instead of <*>
    const rangeStr = `${range.min}-${range.max}${range.unit}`;
    // Replace the <*> that follows "took " (the duration placeholder)
    const patternWithRange = t.pattern.replace(/took <\*>/, `took ${rangeStr}`);
    parts.push(`[${t.occurrences}x] ${patternWithRange}`);
  } else {
    // No numeric samples - use <N>ms as a clearer placeholder for durations
    const patternWithPlaceholder = t.pattern.replace(/took <\*>/, 'took <N>ms');
    parts.push(`[${t.occurrences}x] ${patternWithPlaceholder}`);
  }

  // Show sample values, filtering out any containing <*>
  if (t.sampleVariables.length > 0) {
    const flatSamples = t.sampleVariables
      .flat()
      .filter((s) => s.length > 0 && !s.includes('<*>'));
    if (flatSamples.length > 0) {
      parts.push(`        Samples: ${flatSamples.slice(0, 5).join(', ')}`);
    }
  }

  return parts.join('\n');
}

/**
 * Extract file activity from patterns (files mentioned in templates).
 */
function extractFileActivity(templates: Template[]): [string, number][] {
  const filePattern = /([a-zA-Z0-9_-]+\.(?:js|ts|jsx|tsx|mjs|cjs))(?::\d+)?/g;
  const fileCounts = new Map<string, number>();

  for (const t of templates) {
    const matches = t.pattern.matchAll(filePattern);
    for (const match of matches) {
      const file = match[1];
      fileCounts.set(file, (fileCounts.get(file) || 0) + t.occurrences);
    }
  }

  return Array.from(fileCounts.entries()).sort((a, b) => b[1] - a[1]);
}

/**
 * Truncate a string with ellipsis.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Get a human-readable label for an HTTP status code.
 */
function getStatusCodeLabel(code: number): string {
  const labels: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return labels[code] || '';
}

/**
 * Export helper functions for use in compress.ts
 */
export { isExpectedFailure, hydratePattern, extractNumericRange, isPerformanceViolation };
