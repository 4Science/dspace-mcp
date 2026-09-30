/**
 * Authentication tools for DSpace MCP server.
 *
 * Only a read-only status tool is exposed. Credentials are never accepted via
 * tool arguments and the DSpace JWT is never returned in a response, so no
 * credential can leak into the MCP client / model context.
 *
 * How authentication is actually established:
 *  - HTTP transport: OAuth 2.1 at the transport layer (bearer tokens), always on.
 *  - stdio transport: from environment credentials at startup (DSPACE_TOKEN, or
 *    DSPACE_USER + DSPACE_PASSWORD) — see src/transports/stdio.ts.
 *
 * There is intentionally no dspace_login / dspace_logout tool: login/logout are
 * handled by the transport, not by the model.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DSpaceClient } from '../services/dspace-client.js';

export function registerAuthTools(
  server: McpServer,
  client: DSpaceClient,
  transport: 'http' | 'stdio',
): void {
  server.tool(
    'dspace_auth_status',
    'Check the current authentication status with the DSpace instance.',
    {},
    async () => {
      try {
        const status = await client.authStatus();
        if (status.authenticated) {
          const ep = status._embedded?.eperson;
          return {
            content: [{
              type: 'text' as const,
              text: `Authenticated: yes\nUser: ${ep?.email || 'unknown'}\nName: ${ep?.name || 'unknown'}\nMethod: ${status.authenticationMethod || 'unknown'}`,
            }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: transport === 'http'
              ? 'Not authenticated. Sign in through your MCP client\u2019s OAuth flow.'
              : 'Not authenticated. Set DSPACE_TOKEN or DSPACE_USER/DSPACE_PASSWORD in the server environment.',
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Auth status check failed: ${errMsg(error)}` }],
          isError: true,
        };
      }
    },
  );
}

/**
 * Format an error message for a tool response, scrubbing anything that looks
 * like a bearer token / JWT so a token can never leak into the model context
 * through an error string.
 */
function errMsg(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    // Bearer <token>
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    // bare JWTs (three base64url segments)
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]');
}
