/**
 * DSpace MCP Server — shared core.
 * Creates the McpServer instance, the DSpaceClient, and registers all tools.
 * Transport-agnostic: both stdio.ts and http.ts import this.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DSpaceClient } from './services/dspace-client.js';
import { registerAllTools } from './tools/index.js';
import { config } from './config.js';

export function createServer(): { server: McpServer; client: DSpaceClient } {
  const server = new McpServer({
    name: config.name,
    version: config.version,
  });

  const client = new DSpaceClient();
  registerAllTools(server, client);

  return { server, client };
}
