/**
 * DSpace MCP Server — shared core.
 * Creates the McpServer instance, the DSpaceClient, and registers all tools.
 * Transport-agnostic: both stdio.ts and http.ts import this.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DSpaceClient } from './services/dspace-client.js';
import { registerAllTools } from './tools/index.js';
import { config } from './config.js';

export type TransportKind = 'http' | 'stdio';

/**
 * @param options.transport Which transport is hosting this server. Selects how
 *   authentication is described to the model (OAuth on http, environment on
 *   stdio). Defaults to 'stdio'.
 * @param options.dspaceToken Optional DSpace JWT to seed the per-request client
 *   with. The HTTP/OAuth transport resolves this from the caller's opaque
 *   access token and injects it here so every DSpace call runs as that user.
 *   The token never leaves the server; it is not exposed to tools or the model.
 */
export function createServer(options?: { transport?: TransportKind; dspaceToken?: string }): {
  server: McpServer;
  client: DSpaceClient;
} {
  const server = new McpServer({
    name: config.name,
    version: config.version,
  });

  const client = new DSpaceClient(undefined, options?.dspaceToken);
  registerAllTools(server, client, { transport: options?.transport ?? 'stdio' });

  return { server, client };
}
