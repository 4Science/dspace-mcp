/**
 * Content-retrieval tools for the DSpace MCP server.
 *
 * These tools read the actual file content attached to an item:
 *  - the extracted plain text (from the "TEXT" bundle, when the media filter
 *    has produced it), which is the cheapest way to get "just the text"; and
 *  - the original file bytes (from the "ORIGINAL" bundle), returned inline as
 *    text when textual, or as a base64 blob otherwise.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DSpaceClient } from '../services/dspace-client.js';
import type { Bitstream } from '../types/dspace.js';

/** Cap on how much extracted/inline text to return in a single response. */
const MAX_INLINE_TEXT_CHARS = 100_000;

/** MIME types (or prefixes) that are safe to decode and return as UTF-8 text. */
function isTextualMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return (
    m.startsWith('text/') ||
    m === 'application/json' ||
    m === 'application/xml' ||
    m.endsWith('+xml') ||
    m.endsWith('+json') ||
    m === 'application/x-www-form-urlencoded'
  );
}

/** Decode bytes to UTF-8 text, truncating past the inline cap. */
function decodeText(data: Uint8Array): { text: string; truncated: boolean } {
  const full = new TextDecoder('utf-8').decode(data);
  if (full.length > MAX_INLINE_TEXT_CHARS) {
    return { text: full.slice(0, MAX_INLINE_TEXT_CHARS), truncated: true };
  }
  return { text: full, truncated: false };
}

/** Human-readable byte size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pull the declared MIME type off a bitstream's embedded format, if present. */
function bitstreamMime(b: Bitstream): string | undefined {
  const embedded = (b as unknown as { _embedded?: { format?: { mimetype?: string } } })._embedded;
  return embedded?.format?.mimetype;
}

export function registerContentTools(server: McpServer, client: DSpaceClient): void {
  server.tool(
    'dspace_get_item_fulltext',
    'Retrieve the full text of an item\'s file(s). Prefers the extracted plain text (DSpace "TEXT" bundle, produced by the media filter and named "<original>.txt") which is the cheapest way to read a document\'s text; falls back to the original file when it is itself textual. Call with only itemUuid to list the item\'s files, then pass a bitstreamUuid (or fileName) to fetch one, or set all=true to fetch text for every file.',
    {
      itemUuid: z.string().describe('UUID of the item whose file text to retrieve'),
      bitstreamUuid: z.string().optional().describe('UUID of a specific ORIGINAL bitstream to fetch text for (from the listing). Omit to list files, or use fileName/all instead.'),
      fileName: z.string().optional().describe('Name of a specific ORIGINAL file to fetch text for (alternative to bitstreamUuid)'),
      all: z.boolean().optional().describe('Fetch the text of all ORIGINAL files in the item (default: false)'),
    },
    async ({ itemUuid, bitstreamUuid, fileName, all }) => {
      try {
        const originals = await client.getItemBitstreamsByBundle(itemUuid, 'ORIGINAL');

        if (originals.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No files found in the ORIGINAL bundle for item ${itemUuid}. The item has no attached documents.` }],
          };
        }

        // Decide which originals to process.
        let targets: Bitstream[];
        if (bitstreamUuid) {
          const match = originals.find(b => b.uuid === bitstreamUuid);
          if (!match) {
            return {
              content: [{ type: 'text' as const, text: `No ORIGINAL bitstream with UUID ${bitstreamUuid} on item ${itemUuid}.` }],
              isError: true,
            };
          }
          targets = [match];
        } else if (fileName) {
          const match = originals.find(b => b.name === fileName)
            ?? originals.find(b => b.name?.toLowerCase() === fileName.toLowerCase());
          if (!match) {
            return {
              content: [{ type: 'text' as const, text: `No ORIGINAL file named "${fileName}" on item ${itemUuid}.` }],
              isError: true,
            };
          }
          targets = [match];
        } else if (all) {
          targets = originals;
        } else {
          // No selector: list the available files so the caller can choose.
          const lines: string[] = [
            `Item ${itemUuid} has ${originals.length} file(s) in the ORIGINAL bundle:`,
            '',
          ];
          for (const b of originals) {
            const size = typeof b.sizeBytes === 'number' ? ` (${formatBytes(b.sizeBytes)})` : '';
            const mime = bitstreamMime(b);
            lines.push(`• ${b.name}${size}${mime ? ` [${mime}]` : ''}`);
            lines.push(`  bitstreamUuid: ${b.uuid}`);
          }
          lines.push('');
          lines.push('Re-run with a bitstreamUuid or fileName to fetch its text, or all=true for every file.');
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        const sections: string[] = [];
        for (const original of targets) {
          sections.push(await fetchTextForOriginal(client, itemUuid, original));
        }

        return { content: [{ type: 'text' as const, text: sections.join('\n\n' + '─'.repeat(60) + '\n\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Get item fulltext failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'dspace_get_bitstream_content',
    'Download the raw content of a specific bitstream by UUID. Best for binary files (PDF, images, office docs): pass outputPath to save the bytes to a usable local file and get the path back. Without outputPath, textual files (text/*, JSON, XML) are returned inline as UTF-8 text and binary files as a base64-encoded blob. Use dspace_get_item_fulltext to discover an item\'s bitstream UUIDs, or when you only need a document\'s extracted text.',
    {
      bitstreamUuid: z.string().describe('UUID of the bitstream to download'),
      outputPath: z.string().optional().describe('Local file path to save the raw bytes to (parent directories are created). When set, the file is written to disk and its path is returned instead of inline content or a base64 blob — use this for large or binary files such as PDFs.'),
      asText: z.boolean().optional().describe('Force decoding the content as UTF-8 text even if the MIME type is not recognized as textual (default: false). Ignored when outputPath is set.'),
    },
    async ({ bitstreamUuid, outputPath, asText }) => {
      try {
        const { data, contentType, contentLength } = await client.downloadBitstreamContent(bitstreamUuid);

        // Save-to-disk mode: write the exact bytes to a usable local file.
        if (outputPath) {
          const absPath = resolve(outputPath);
          await mkdir(dirname(absPath), { recursive: true });
          await writeFile(absPath, data);
          return {
            content: [{
              type: 'text' as const,
              text: [
                `Bitstream ${bitstreamUuid} saved to disk.`,
                `Path: ${absPath}`,
                `Type: ${contentType}`,
                `Size: ${formatBytes(contentLength)} (${contentLength} bytes)`,
              ].join('\n'),
            }],
          };
        }

        if (asText || isTextualMime(contentType)) {
          const { text, truncated } = decodeText(data);
          const header = `Bitstream ${bitstreamUuid} — ${contentType}, ${formatBytes(contentLength)}${truncated ? ` (truncated to ${MAX_INLINE_TEXT_CHARS} chars)` : ''}:\n`;
          return { content: [{ type: 'text' as const, text: header + '\n' + text }] };
        }

        // Binary: return as a base64 blob resource.
        const base64 = Buffer.from(data).toString('base64');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Bitstream ${bitstreamUuid} is binary (${contentType}, ${formatBytes(contentLength)}). Returned as base64 blob below. Pass outputPath to save it as a usable file, or asText=true to force text decoding.`,
            },
            {
              type: 'resource' as const,
              resource: {
                uri: `dspace:bitstream/${bitstreamUuid}`,
                mimeType: contentType,
                blob: base64,
              },
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Get bitstream content failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

/**
 * Fetch the best available text for a single ORIGINAL bitstream: the extracted
 * TEXT-bundle text if present, otherwise the original bytes when textual.
 * Returns a formatted, self-describing section.
 */
async function fetchTextForOriginal(
  client: DSpaceClient,
  itemUuid: string,
  original: Bitstream,
): Promise<string> {
  const name = original.name || original.uuid;

  // 1) Prefer the extracted plain text from the TEXT bundle.
  const extracted = await client.findExtractedTextBitstream(itemUuid, name);
  if (extracted) {
    const { data, contentLength } = await client.downloadBitstreamContent(extracted.uuid);
    const { text, truncated } = decodeText(data);
    return [
      `File: ${name}`,
      `Source: extracted text (TEXT bundle → ${extracted.name}, ${formatBytes(contentLength)}${truncated ? `, truncated to ${MAX_INLINE_TEXT_CHARS} chars` : ''})`,
      '',
      text.trim() ? text : '(extracted text is empty)',
    ].join('\n');
  }

  // 2) Fall back to the original bytes if the file is itself textual.
  const mime = bitstreamMime(original);
  const { data, contentType, contentLength } = await client.downloadBitstreamContent(original.uuid);
  const effectiveMime = mime || contentType;
  if (isTextualMime(effectiveMime)) {
    const { text, truncated } = decodeText(data);
    return [
      `File: ${name}`,
      `Source: original file (${effectiveMime}, ${formatBytes(contentLength)}${truncated ? `, truncated to ${MAX_INLINE_TEXT_CHARS} chars` : ''})`,
      '',
      text,
    ].join('\n');
  }

  // 3) No extracted text and a binary original — report, don't dump bytes.
  return [
    `File: ${name}`,
    `Source: none available as text. The original is ${effectiveMime} (${formatBytes(contentLength)}) and no extracted text exists in the TEXT bundle.`,
    `Use dspace_get_bitstream_content with bitstreamUuid ${original.uuid} to download the raw file.`,
  ].join('\n');
}
