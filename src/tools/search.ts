/**
 * Search and discovery tools for DSpace MCP server.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DSpaceClient } from '../services/dspace-client.js';
import type { SearchResultEntry } from '../types/dspace.js';

/** Extract a compact summary from search results. */
function formatSearchResults(data: unknown): string {
  const d = data as Record<string, unknown>;
  const embedded = d._embedded as Record<string, unknown> | undefined;
  const searchResult = embedded?.searchResult as Record<string, unknown> | undefined;
  const innerEmbedded = searchResult?._embedded as Record<string, unknown> | undefined;
  const objects = (innerEmbedded?.objects || []) as SearchResultEntry[];
  const page = searchResult?.page as { totalElements?: number; number?: number; totalPages?: number } | undefined;

  if (objects.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [
    `Found ${page?.totalElements ?? objects.length} results (page ${(page?.number ?? 0) + 1} of ${page?.totalPages ?? 1}):`,
    '',
  ];

  for (const entry of objects) {
    const obj = entry._embedded?.indexableObject;
    if (!obj) continue;
    const title = obj.metadata?.['dc.title']?.[0]?.value || obj.name || 'Untitled';
    const authors = (obj.metadata?.['dc.contributor.author'] || [])
      .map(a => a.value)
      .join(', ');
    const date = obj.metadata?.['dc.date.issued']?.[0]?.value || '';
    lines.push(`• [${obj.type}] ${title}`);
    lines.push(`  UUID: ${obj.uuid}`);
    if (authors) lines.push(`  Authors: ${authors}`);
    if (date) lines.push(`  Date: ${date}`);
    if (obj.handle) lines.push(`  Handle: ${obj.handle}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function registerSearchTools(server: McpServer, client: DSpaceClient): void {
  server.tool(
    'dspace_search',
    'Search DSpace for items, communities, or collections. Supports full-text queries, type filtering, scoping to a container, and advanced filters.',
    {
      query: z.string().optional().describe('Search query string (Solr/Lucene syntax)'),
      dsoType: z.enum(['item', 'community', 'collection']).optional().describe('Filter by object type'),
      scope: z.string().optional().describe('UUID of a community/collection to scope the search'),
      page: z.number().int().min(0).optional().describe('Page number (0-based)'),
      size: z.number().int().min(1).max(100).optional().describe('Results per page (default 20)'),
      sort: z.string().optional().describe('Sort field and direction, e.g. "dc.date.issued,desc"'),
      filters: z.record(z.string()).optional().describe('Advanced filters as key-value pairs, e.g. {"author": "Smith,equals"}'),
    },
    async (params) => {
      try {
        const data = await client.search(params);
        return {
          content: [{ type: 'text' as const, text: formatSearchResults(data) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Search failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'dspace_get_item',
    'Get a DSpace item by UUID, including all metadata.',
    {
      uuid: z.string().describe('Item UUID'),
    },
    async ({ uuid }) => {
      try {
        const data = await client.getItem(uuid) as Record<string, unknown>;
        const metadata = data.metadata as Record<string, Array<{ value: string }>> | undefined;
        const lines: string[] = [];

        lines.push(`Item: ${data.name || 'Untitled'}`);
        lines.push(`UUID: ${data.uuid}`);
        lines.push(`Handle: ${data.handle || 'none'}`);
        lines.push(`In Archive: ${data.inArchive}`);
        lines.push(`Discoverable: ${data.discoverable}`);
        lines.push(`Withdrawn: ${data.withdrawn}`);
        lines.push(`Last Modified: ${data.lastModified}`);
        lines.push('');
        lines.push('Metadata:');

        if (metadata) {
          for (const [key, values] of Object.entries(metadata)) {
            for (const v of values) {
              lines.push(`  ${key}: ${v.value}`);
            }
          }
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Get item failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'dspace_list_communities',
    'List top-level communities in the DSpace repository.',
    {
      page: z.number().int().min(0).optional().describe('Page number (0-based)'),
      size: z.number().int().min(1).max(100).optional().describe('Results per page'),
    },
    async (params) => {
      try {
        const data = await client.listCommunities(params) as Record<string, unknown>;
        const embedded = data._embedded as Record<string, unknown[]> | undefined;
        const communities = (embedded?.communities || []) as Array<Record<string, unknown>>;

        if (communities.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No communities found.' }] };
        }

        const lines = communities.map(c => {
          const md = c.metadata as Record<string, Array<{ value: string }>> | undefined;
          const title = md?.['dc.title']?.[0]?.value || c.name || 'Untitled';
          return `• ${title}\n  UUID: ${c.uuid}\n  Handle: ${c.handle || 'none'}`;
        });

        return {
          content: [{ type: 'text' as const, text: `Communities:\n\n${lines.join('\n\n')}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `List communities failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'dspace_list_collections',
    'List collections, optionally filtered to a specific community.',
    {
      communityUuid: z.string().optional().describe('UUID of parent community (omit for all collections)'),
      page: z.number().int().min(0).optional().describe('Page number (0-based)'),
      size: z.number().int().min(1).max(100).optional().describe('Results per page'),
    },
    async (params) => {
      try {
        const data = await client.listCollections(params) as Record<string, unknown>;
        const embedded = data._embedded as Record<string, unknown[]> | undefined;
        const collections = (embedded?.collections || []) as Array<Record<string, unknown>>;

        if (collections.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No collections found.' }] };
        }

        const lines = collections.map(c => {
          const md = c.metadata as Record<string, Array<{ value: string }>> | undefined;
          const title = md?.['dc.title']?.[0]?.value || c.name || 'Untitled';
          return `• ${title}\n  UUID: ${c.uuid}\n  Handle: ${c.handle || 'none'}`;
        });

        return {
          content: [{ type: 'text' as const, text: `Collections:\n\n${lines.join('\n\n')}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `List collections failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
