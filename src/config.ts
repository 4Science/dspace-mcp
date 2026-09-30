/**
 * DSpace MCP Server configuration.
 * All settings are read from environment variables with sensible defaults.
 */

const bool = (v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined) return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
};

const int = (v: string | undefined, dflt: number): number => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
};

export const config = {
  /** DSpace REST API base URL (no trailing slash) */
  baseUrl: (process.env.DSPACE_BASE_URL || 'https://sandbox.dspace.org/server').replace(/\/$/, ''),

  /** HTTP server port for the HTTP transport */
  port: parseInt(process.env.PORT || '8080', 10),

  /** Server identity */
  name: 'dspace-mcp',
  version: '1.0.0',

  /**
   * Credentials for the stdio transport, taken from the environment as the MCP
   * spec recommends for stdio. Used to authenticate the single long-lived
   * DSpace session at startup. Ignored by the HTTP transport, which uses OAuth.
   *
   * Provide EITHER a pre-existing DSpace JWT (`DSPACE_TOKEN`) OR a
   * username/password pair (`DSPACE_USER` + `DSPACE_PASSWORD`). If both are
   * present, the token wins. If none are set, the stdio server starts
   * unauthenticated (only public/anonymous DSpace operations will work).
   */
  credentials: {
    token: process.env.DSPACE_TOKEN || undefined,
    user: process.env.DSPACE_USER || undefined,
    password: process.env.DSPACE_PASSWORD || undefined,
  },

  /**
   * OAuth 2.1 authorization for the HTTP transport. It is ALWAYS enabled on the
   * HTTP transport: the MCP server acts as both authorization server and
   * resource server, using DSpace as the identity backend (no external OIDC IdP
   * required). Does NOT apply to the stdio transport, which — per the MCP spec —
   * takes credentials from the environment instead.
   */
  oauth: {
    /**
     * Public base URL of THIS MCP server (scheme + host [+ port], no trailing
     * slash). Used as the OAuth issuer, the resource identifier, and to build
     * the metadata/authorize/token URLs the client discovers. Must be the
     * externally reachable URL (e.g. behind the Lambda/ALB), not 127.0.0.1.
     */
    publicUrl: (process.env.DSPACE_MCP_PUBLIC_URL || 'http://127.0.0.1:8080').replace(/\/$/, ''),

    /**
     * Opaque access-token lifetime, seconds (default 10 min).
     *
     * Must stay below both the refresh-token TTL and the underlying DSpace JWT
     * lifetime (DSpace default ~30 min). The token lifetimes form a hierarchy:
     * accessToken < refreshToken < DSpace JWT. A refresh renews the DSpace JWT
     * via DSpace's native mechanism, which only works while that JWT is still
     * valid; keeping the refresh token shorter than the DSpace JWT guarantees a
     * refresh presented in time can still renew the session.
     */
    accessTokenTtl: int(process.env.DSPACE_MCP_ACCESS_TOKEN_TTL, 10 * 60),

    /**
     * Refresh-token lifetime, seconds (default 20 min).
     *
     * Kept below the DSpace JWT lifetime (~30 min) so a refresh is always
     * presented while the underlying JWT can still be refreshed. If you raise
     * DSpace's JWT lifetime, you can raise this proportionally.
     */
    refreshTokenTtl: int(process.env.DSPACE_MCP_REFRESH_TOKEN_TTL, 20 * 60),

    /** Authorization-code lifetime, seconds (default 5 min). */
    authCodeTtl: int(process.env.DSPACE_MCP_AUTH_CODE_TTL, 5 * 60),

    /**
     * Enable the headless fallback on the token endpoint: the OAuth 2.1
     * `password` grant against DSpace, for non-browser clients. A normal login
     * uses DSpace username/password; a token minted this way is born in the
     * server and is never exposed. As a documented convenience, username
     * "jwt-token" switches to JWT-passthrough mode, where the password field is
     * an existing DSpace JWT that is verified and stored as-is (it then remains
     * valid until its own expiry — DSpace refresh only rotates, it does not
     * revoke). OFF by default because the password grant is discouraged by
     * OAuth 2.1 and routes credentials through the MCP client.
     */
    headlessFallback: bool(process.env.DSPACE_MCP_HEADLESS_FALLBACK, false),
  },
} as const;

/** Convenience: the resource/issuer URL as a URL object. */
export const publicUrl = (): URL => new URL(config.oauth.publicUrl);
