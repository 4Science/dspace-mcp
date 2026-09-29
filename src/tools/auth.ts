/**
 * Authentication tools for DSpace MCP server.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DSpaceClient } from '../services/dspace-client.js';

export function registerAuthTools(server: McpServer, client: DSpaceClient): void {
  server.tool(
    'dspace_login',
    'Authenticate with a DSpace instance. Provide EITHER a JWT token directly, OR username + password for password-based login. The session persists for subsequent tool calls.',
    {
      token: z.string().optional().describe('Pre-existing JWT token to use directly'),
      email: z.string().optional().describe('Email/username for password login'),
      password: z.string().optional().describe('Password for password login'),
    },
    async ({ token, email, password }) => {
      try {
        if (token) {
          client.setToken(token);
          const status = await client.authStatus();
          if (!status.authenticated) {
            return {
              content: [{ type: 'text' as const, text: 'Token set but authentication check failed. The token may be expired or invalid.' }],
              isError: true,
            };
          }
          const eperson = status._embedded?.eperson;
          return {
            content: [{
              type: 'text' as const,
              text: `Authenticated successfully via JWT token.\nUser: ${eperson?.email || 'unknown'}\nName: ${eperson?.name || 'unknown'}`,
            }],
          };
        }

        if (email && password) {
          const jwt = await client.login(email, password);
          const status = await client.authStatus();
          const eperson = status._embedded?.eperson;
          return {
            content: [{
              type: 'text' as const,
              text: `Login successful.\nUser: ${eperson?.email || email}\nName: ${eperson?.name || 'unknown'}\nJWT Token (save for reuse): ${jwt}`,
            }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: 'Please provide either a JWT token, or both email and password.' }],
          isError: true,
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Login failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

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
          content: [{ type: 'text' as const, text: 'Not authenticated. Use dspace_login to authenticate.' }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Auth status check failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'dspace_logout',
    'Logout from the DSpace instance, invalidating the current JWT token.',
    {},
    async () => {
      try {
        await client.logout();
        return {
          content: [{ type: 'text' as const, text: 'Logged out successfully.' }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Logout failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
