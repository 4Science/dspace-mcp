/**
 * Item management tools for DSpace MCP server.
 * Covers admin item creation and metadata patching.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { DSpaceClient } from '../services/dspace-client.js';
import type { MetadataMap, PatchOperation } from '../types/dspace.js';

/** Minimal extension → MIME type map for common upload formats. */
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Guess a MIME type from a filename extension. */
function guessMimeType(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] || 'application/octet-stream';
}

/** Parse a simplified metadata input into the DSpace metadata map format. */
function parseMetadataInput(input: Record<string, string | string[]>): MetadataMap {
  const metadata: MetadataMap = {};
  for (const [key, val] of Object.entries(input)) {
    const values = Array.isArray(val) ? val : [val];
    metadata[key] = values.map((v, i) => ({
      value: v,
      language: null,
      authority: null,
      confidence: -1,
      place: i,
    }));
  }
  return metadata;
}

export function registerItemTools(server: McpServer, client: DSpaceClient): void {
  server.tool(
    'dspace_create_item',
    'Create an archived item directly in DSpace (admin only, bypasses submission workflow). The item is immediately visible in the repository.',
    {
      owningCollectionUuid: z.string().describe('UUID of the collection to create the item in'),
      metadata: z.record(z.union([z.string(), z.array(z.string())])).describe(
        'Item metadata as key-value pairs. Keys are Dublin Core fields (e.g. "dc.title", "dc.contributor.author"). Values can be a string or array of strings for multi-valued fields.',
      ),
      discoverable: z.boolean().optional().describe('Whether the item is discoverable via search (default: true)'),
    },
    async ({ owningCollectionUuid, metadata, discoverable }) => {
      try {
        const metadataMap = parseMetadataInput(metadata);
        const result = await client.createItemAdmin(owningCollectionUuid, metadataMap, { discoverable }) as Record<string, unknown>;
        return {
          content: [{
            type: 'text' as const,
            text: `Item created successfully.\nUUID: ${result.uuid}\nHandle: ${result.handle || 'pending'}\nName: ${result.name}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Create item failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'dspace_update_item_metadata',
    'Update metadata on an existing DSpace item using JSON Patch (RFC 6902). Supports add, remove, replace, and move operations on metadata fields.',
    {
      uuid: z.string().describe('UUID of the item to update'),
      operations: z.array(
        z.object({
          op: z.enum(['add', 'remove', 'replace', 'move']).describe('Patch operation'),
          path: z.string().describe('JSON Pointer path, e.g. "/metadata/dc.title/0" or "/metadata/dc.description"'),
          value: z.unknown().optional().describe('New value (required for add/replace). For metadata: { "value": "...", "language": "en" }'),
          from: z.string().optional().describe('Source path (required for move operations)'),
        }),
      ).describe('Array of JSON Patch operations'),
    },
    async ({ uuid, operations }) => {
      try {
        const patchOps: PatchOperation[] = operations.map(op => {
          if (op.op === 'move') {
            return { op: 'move', from: op.from!, path: op.path };
          }
          if (op.op === 'remove') {
            return { op: 'remove', path: op.path };
          }
          return { op: op.op as 'add' | 'replace', path: op.path, value: op.value };
        });

        const result = await client.patchItem(uuid, patchOps) as Record<string, unknown>;
        return {
          content: [{
            type: 'text' as const,
            text: `Item updated successfully.\nUUID: ${result.uuid}\nName: ${result.name}\nApplied ${operations.length} patch operation(s).`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Update item failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'dspace_delete_item',
    'Permanently delete an item from DSpace by UUID (admin only). This is irreversible: the item and its bundles/bitstreams are removed from the repository.',
    {
      uuid: z.string().describe('UUID of the item to delete'),
    },
    async ({ uuid }) => {
      try {
        await client.deleteItem(uuid);
        return {
          content: [{
            type: 'text' as const,
            text: `Item deleted successfully.\nUUID: ${uuid}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Delete item failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'dspace_upload_bitstream',
    'Upload a local file as a bitstream (attachment) to a DSpace item (admin only). The file is added to the item\'s bundle (default "ORIGINAL", where DSpace stores primary files); the bundle is created automatically if it does not exist.',
    {
      itemUuid: z.string().describe('UUID of the item to attach the file to'),
      filePath: z.string().describe('Absolute path to the local file to upload'),
      bundleName: z.string().optional().describe('Target bundle name (default: "ORIGINAL"). Use "LICENSE" or "THUMBNAIL" for special bundles.'),
      name: z.string().optional().describe('Bitstream name shown in DSpace (defaults to the file name)'),
      description: z.string().optional().describe('Optional description stored as dc.description on the bitstream'),
      mimeType: z.string().optional().describe('MIME type of the file (auto-detected from the extension if omitted)'),
    },
    async ({ itemUuid, filePath, bundleName, name, description, mimeType }) => {
      try {
        const buffer = await readFile(filePath);
        const filename = basename(filePath);
        const bitstream = await client.uploadFileToItem(
          itemUuid,
          {
            data: new Uint8Array(buffer),
            filename,
            mimeType: mimeType || guessMimeType(filename),
          },
          { bundleName, name, description },
        );

        const sizeBytes = typeof bitstream.sizeBytes === 'number' ? bitstream.sizeBytes : undefined;
        return {
          content: [{
            type: 'text' as const,
            text: [
              'Bitstream uploaded successfully.',
              `UUID: ${bitstream.uuid}`,
              `Name: ${bitstream.name}`,
              `Bundle: ${bundleName || 'ORIGINAL'}`,
              sizeBytes !== undefined ? `Size: ${sizeBytes} bytes` : undefined,
              `Item: ${itemUuid}`,
            ].filter(Boolean).join('\n'),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Upload bitstream failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
