#!/usr/bin/env node
/**
 * stdio transport entry point.
 * For local use with Claude Desktop, Cursor, etc.
 *
 * Authentication is taken from the environment (as the MCP spec recommends for
 * stdio): DSPACE_TOKEN, or DSPACE_USER + DSPACE_PASSWORD. The single long-lived
 * DSpace session is established here at startup and reused for all tool calls.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../server.js';

const { server, client } = createServer();

// Authenticate from environment credentials before serving requests.
const auth = await client.authenticateFromEnv();
if (auth.authenticated) {
  console.error(`DSpace MCP: authenticated via ${auth.method}${auth.email ? ` as ${auth.email}` : ''}`);
} else if (auth.method === 'none') {
  console.error('DSpace MCP: no credentials in environment (DSPACE_TOKEN or DSPACE_USER/DSPACE_PASSWORD); starting unauthenticated — only public operations will work.');
} else {
  console.error(`DSpace MCP: authentication via ${auth.method} failed: ${auth.reason ?? 'unknown error'}; starting unauthenticated.`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('DSpace MCP server running on stdio');
