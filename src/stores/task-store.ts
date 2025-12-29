/**
 * Simple in-memory store for async task tracking.
 * Tasks auto-expire after TTL.
 */

/**
 * Progress information for a running task.
 */
export interface TaskProgress {
  /** Percentage complete (0-100) */
  percent: number;

  /** Human-readable status message */
  statusMessage: string;

  /** Current processing phase */
  currentPhase: 'parsing' | 'clustering' | 'categorizing' | 'formatting' | 'finalizing';

  /** Number of lines processed so far */
  processedLines?: number;

  /** Total lines to process (if known) */
  totalLines?: number;
}

export interface TaskState {
  taskId: string;
  status: 'working' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number;
  pollInterval: number;
  progress?: TaskProgress;
  result?: TaskResult;
  error?: TaskError;
}

export interface TaskResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: {
    compressionRatio: number;
    inputLines: number;
    uniqueTemplates: number;
    estimatedTokenReduction: number;
    summary: {
      userImpactingErrors: number;
      expectedFailures: number;
      performanceViolations: number;
      otherWarnings: number;
      infoPatterns: number;
      stackTracePatterns: number;
    };
    templates: Array<{
      id: string;
      pattern: string;
      occurrences: number;
    }>;
    processingTimeMs: number;
  };
}

export interface TaskError {
  code: string;
  message: string;
}

// Simple UUID-like ID generator (no external deps)
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

export class TaskStore {
  private tasks: Map<string, TaskState> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Cleanup expired tasks every 30 seconds
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 30000);
  }

  /**
   * Create a new task with 'working' status.
   * @param ttl Time-to-live in milliseconds (default: 5 minutes)
   */
  create(ttl: number = 300000): TaskState {
    const taskId = generateId();
    const now = new Date().toISOString();

    const task: TaskState = {
      taskId,
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttl,
      pollInterval: 1000,
    };

    this.tasks.set(taskId, task);
    return task;
  }

  /**
   * Get a task by ID.
   */
  get(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Update a task's fields.
   */
  update(taskId: string, updates: Partial<TaskState>): TaskState | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    const updated: TaskState = {
      ...task,
      ...updates,
      lastUpdatedAt: new Date().toISOString(),
    };

    this.tasks.set(taskId, updated);
    return updated;
  }

  /**
   * Mark a task as completed with result.
   */
  complete(taskId: string, result: TaskResult): TaskState | undefined {
    return this.update(taskId, {
      status: 'completed',
      result,
    });
  }

  /**
   * Mark a task as failed with error.
   */
  fail(taskId: string, error: TaskError): TaskState | undefined {
    return this.update(taskId, {
      status: 'failed',
      error,
    });
  }

  /**
   * Cancel a running task.
   * Returns the updated task or undefined if task doesn't exist or isn't cancellable.
   */
  cancel(taskId: string): TaskState | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'working') {
      return undefined;
    }

    return this.update(taskId, {
      status: 'cancelled',
      error: {
        code: 'CANCELLED',
        message: 'Task was cancelled by user',
      },
    });
  }

  /**
   * Check if a task has been cancelled.
   */
  isCancelled(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return task?.status === 'cancelled';
  }

  /**
   * Update task progress.
   */
  updateProgress(taskId: string, progress: TaskProgress): TaskState | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'working') {
      return undefined;
    }

    return this.update(taskId, { progress });
  }

  /**
   * Delete a task.
   */
  delete(taskId: string): boolean {
    return this.tasks.delete(taskId);
  }

  /**
   * Clean up expired tasks.
   */
  private cleanupExpired(): void {
    const now = Date.now();
    const expired: string[] = [];

    this.tasks.forEach((task, taskId) => {
      const createdMs = new Date(task.createdAt).getTime();
      if (now - createdMs > task.ttl) {
        expired.push(taskId);
      }
    });

    for (const taskId of expired) {
      this.delete(taskId);
    }
  }

  /**
   * Stop cleanup interval and clear all tasks.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.tasks.clear();
  }
}

// Singleton instance for the server
export const taskStore = new TaskStore();
