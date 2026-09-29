/**
 * Tool registry — registers all DSpace tools on an McpServer instance.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DSpaceClient } from '../services/dspace-client.js';
import { registerAuthTools } from './auth.js';
import { registerSearchTools } from './search.js';
import { registerItemTools } from './items.js';
import { registerContentTools } from './content.js';
import { registerSubmissionTools } from './submission.js';

export function registerAllTools(server: McpServer, client: DSpaceClient): void {
  registerAuthTools(server, client);
  registerSearchTools(server, client);
  registerItemTools(server, client);
  registerContentTools(server, client);
  registerSubmissionTools(server, client);
}
