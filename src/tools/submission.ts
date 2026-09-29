/**
 * Submission (workspace item) tools for DSpace MCP server.
 * Handles the standard DSpace deposit workflow.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DSpaceClient } from '../services/dspace-client.js';
import type { PatchOperation } from '../types/dspace.js';

export function registerSubmissionTools(server: McpServer, client: DSpaceClient): void {
  server.tool(
    'dspace_create_workspace_item',
    'Create a new workspace item (submission) in DSpace. This starts the standard deposit workflow. After creation, use dspace_update_workspace_item to add metadata, then submit for review.',
    {
      owningCollectionUuid: z.string().optional().describe('UUID of the target collection (defaults to first submittable collection)'),
      metadata: z.record(z.union([z.string(), z.array(z.string())])).optional().describe(
        'Initial metadata as key-value pairs (e.g. {"dc.title": "My Paper", "dc.contributor.author": ["Author 1", "Author 2"]})',
      ),
    },
    async ({ owningCollectionUuid, metadata }) => {
      try {
        const wsItem = await client.createWorkspaceItem(owningCollectionUuid) as Record<string, unknown>;
        const wsId = wsItem.id as number;

        // If metadata provided, patch it in
        if (metadata && Object.keys(metadata).length > 0) {
          const operations: PatchOperation[] = [];
          for (const [key, val] of Object.entries(metadata)) {
            const values = Array.isArray(val) ? val : [val];
            const metadataValues = values.map(v => ({
              value: v,
              language: null,
              authority: null,
              confidence: -1,
            }));
            operations.push({
              op: 'add' as const,
              path: `/sections/traditionalpageone/${key}`,
              value: metadataValues,
            });
          }
          await client.patchWorkspaceItem(wsId, operations);
        }

        const result = await client.getWorkspaceItem(wsId) as Record<string, unknown>;
        return {
          content: [{
            type: 'text' as const,
            text: `Workspace item created.\nID: ${result.id}\nStatus: Draft (workspace)\nUse dspace_update_workspace_item to add more metadata or files.`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Create workspace item failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'dspace_update_workspace_item',
    'Update metadata on a workspace item (submission in progress) using JSON Patch.',
    {
      id: z.number().int().describe('Workspace item ID'),
      operations: z.array(
        z.object({
          op: z.enum(['add', 'remove', 'replace', 'move']).describe('Patch operation'),
          path: z.string().describe('JSON Pointer path, e.g. "/sections/traditionalpageone/dc.title"'),
          value: z.unknown().optional().describe('New value (required for add/replace)'),
          from: z.string().optional().describe('Source path (required for move)'),
        }),
      ).describe('JSON Patch operations'),
    },
    async ({ id, operations }) => {
      try {
        const patchOps: PatchOperation[] = operations.map(op => {
          if (op.op === 'move') return { op: 'move' as const, from: op.from!, path: op.path };
          if (op.op === 'remove') return { op: 'remove' as const, path: op.path };
          return { op: op.op as 'add' | 'replace', path: op.path, value: op.value };
        });

        await client.patchWorkspaceItem(id, patchOps);
        return {
          content: [{
            type: 'text' as const,
            text: `Workspace item ${id} updated. Applied ${operations.length} patch operation(s).`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Update workspace item failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'dspace_list_workspace_items',
    'List workspace items (submissions in progress) for the current user.',
    {
      page: z.number().int().min(0).optional().describe('Page number (0-based)'),
      size: z.number().int().min(1).max(100).optional().describe('Results per page'),
    },
    async (params) => {
      try {
        const data = await client.listWorkspaceItems(params) as Record<string, unknown>;
        const embedded = data._embedded as Record<string, unknown[]> | undefined;
        const items = (embedded?.workspaceitems || []) as Array<Record<string, unknown>>;
        const page = data.page as { totalElements?: number } | undefined;

        if (items.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No workspace items found.' }] };
        }

        const lines: string[] = [
          `Workspace items (${page?.totalElements ?? items.length} total):`,
          '',
        ];

        for (const item of items) {
          const sections = item.sections as Record<string, unknown> | undefined;
          const pageOne = sections?.traditionalpageone as Record<string, Array<{ value: string }>> | undefined;
          const title = pageOne?.['dc.title']?.[0]?.value || 'Untitled';
          lines.push(`• ID: ${item.id} — ${title}`);
          lines.push(`  Last Modified: ${item.lastModified}`);
          lines.push('');
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `List workspace items failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
