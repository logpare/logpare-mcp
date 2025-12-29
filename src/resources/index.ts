import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { taskStore } from '../stores/task-store.js';

/**
 * Register all MCP resources with the server.
 *
 * Resources enable the dual-response pattern:
 * - Compression tool returns summary inline (fits in context window)
 * - Full data retrievable via resource URI (out-of-band)
 */
export function registerResources(server: McpServer): void {
  // Resource: logpare://results/{taskId}
  // Returns the full compression result for a completed task
  server.resource(
    'compression-result',
    new ResourceTemplate('logpare://results/{taskId}', { list: undefined }),
    {
      title: 'Compression Result',
      description: 'Full compression output for a completed task',
      mimeType: 'application/json',
    },
    async (uri, { taskId }) => {
      const task = taskStore.get(taskId as string);

      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      if (task.status !== 'completed') {
        throw new Error(`Task ${taskId} is not completed (status: ${task.status})`);
      }

      if (!task.result) {
        throw new Error(`Task ${taskId} has no result`);
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                taskId,
                status: task.status,
                createdAt: task.createdAt,
                completedAt: task.lastUpdatedAt,
                ...task.result.structuredContent,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Resource: logpare://templates/{taskId}
  // Returns just the template list (lighter weight)
  server.resource(
    'templates',
    new ResourceTemplate('logpare://templates/{taskId}', { list: undefined }),
    {
      title: 'Template List',
      description: 'Extracted templates from a completed compression task',
      mimeType: 'application/json',
    },
    async (uri, { taskId }) => {
      const task = taskStore.get(taskId as string);

      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      if (task.status !== 'completed') {
        throw new Error(`Task ${taskId} is not completed (status: ${task.status})`);
      }

      if (!task.result) {
        throw new Error(`Task ${taskId} has no result`);
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                taskId,
                templateCount: task.result.structuredContent.templates.length,
                templates: task.result.structuredContent.templates,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Resource: logpare://stats/{taskId}
  // Returns compression statistics only
  server.resource(
    'stats',
    new ResourceTemplate('logpare://stats/{taskId}', { list: undefined }),
    {
      title: 'Compression Statistics',
      description: 'Statistics from a completed compression task',
      mimeType: 'application/json',
    },
    async (uri, { taskId }) => {
      const task = taskStore.get(taskId as string);

      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      if (task.status !== 'completed') {
        throw new Error(`Task ${taskId} is not completed (status: ${task.status})`);
      }

      if (!task.result) {
        throw new Error(`Task ${taskId} has no result`);
      }

      const { templates, ...stats } = task.result.structuredContent;

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                taskId,
                createdAt: task.createdAt,
                completedAt: task.lastUpdatedAt,
                ...stats,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
