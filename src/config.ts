/**
 * DSpace MCP Server configuration.
 * All settings are read from environment variables with sensible defaults.
 */
export const config = {
  /** DSpace REST API base URL (no trailing slash) */
  baseUrl: (process.env.DSPACE_BASE_URL || 'https://sandbox.dspace.org/server').replace(/\/$/, ''),

  /** HTTP server port for the HTTP transport */
  port: parseInt(process.env.PORT || '8080', 10),

  /** Server identity */
  name: 'dspace-mcp',
  version: '1.0.0',
} as const;
