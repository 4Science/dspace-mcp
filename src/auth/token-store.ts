/**
 * Token store for the OAuth2-like layer of the HTTP transport.
 *
 * The MCP server mints its own opaque access tokens (and refresh tokens) and
 * keeps the real DSpace JWT server-side, mapped to the opaque token. The opaque
 * token is the only credential ever handed back to the MCP client; the DSpace
 * JWT never leaves the server process, so it cannot end up in the model's
 * context.
 *
 * The default implementation is in-memory and therefore per-process. That is
 * fine for the long-lived stdio/local HTTP server, but the stateless HTTP
 * transport on AWS Lambda creates a fresh process per invocation, so a
 * persistent implementation (DynamoDB, Redis, ...) must be plugged in there.
 * Everything is written against the TokenStore interface to make that swap
 * possible without touching the provider.
 */

/** A DSpace-backed session referenced by an opaque access token. */
export interface DSpaceSession {
  /** The live DSpace JWT for this user. Never exposed outside the server. */
  dspaceToken: string;
  /** EPerson UUID, when known (from /api/authn/status). */
  epersonId?: string;
  /** EPerson email, for display in auth-status responses. */
  email?: string;
  /** EPerson display name, for display in auth-status responses. */
  name?: string;
  /** Opaque access-token expiry, epoch seconds. */
  accessTokenExpiresAt: number;
  /** OAuth client this session was issued to (dynamic client id). */
  clientId?: string;
  /** Granted scopes. */
  scopes: string[];
}

/**
 * A pending authorization request, created when the client hits /authorize and
 * held (under an opaque request id) across the interactive login step until the
 * user submits their DSpace credentials on the login page.
 */
export interface AuthorizationRequestRecord {
  requestId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  /** Request expiry, epoch seconds (short-lived). */
  expiresAt: number;
}

/** A pending authorization code (Authorization Code flow, PKCE). */
export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** DSpace JWT obtained during the /authorize login step. */
  dspaceToken: string;
  epersonId?: string;
  email?: string;
  name?: string;
  scopes: string[];
  /** Code expiry, epoch seconds (short-lived). */
  expiresAt: number;
}

/** A refresh token mapped to its backing DSpace session material. */
export interface RefreshTokenRecord {
  refreshToken: string;
  clientId: string;
  dspaceToken: string;
  epersonId?: string;
  email?: string;
  name?: string;
  scopes: string[];
  /** Refresh-token expiry, epoch seconds. */
  expiresAt: number;
}

export interface TokenStore {
  // ─── Pending authorization requests ─────────────────────────
  saveAuthorizationRequest(record: AuthorizationRequestRecord): Promise<void>;
  /** Fetch and DELETE (single-use) a pending authorization request. */
  consumeAuthorizationRequest(requestId: string): Promise<AuthorizationRequestRecord | undefined>;

  // ─── Authorization codes ────────────────────────────────────
  saveAuthorizationCode(record: AuthorizationCodeRecord): Promise<void>;
  /** Fetch and DELETE (single-use) an authorization code. */
  consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined>;

  // ─── Access tokens ──────────────────────────────────────────
  saveAccessToken(token: string, session: DSpaceSession): Promise<void>;
  getAccessToken(token: string): Promise<DSpaceSession | undefined>;
  deleteAccessToken(token: string): Promise<void>;

  // ─── Refresh tokens ─────────────────────────────────────────
  saveRefreshToken(record: RefreshTokenRecord): Promise<void>;
  getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined>;
  deleteRefreshToken(token: string): Promise<void>;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * In-memory TokenStore. Suitable for the local/long-lived server. Entries are
 * lazily expired on read; a periodic sweep also runs to bound memory.
 */
export class InMemoryTokenStore implements TokenStore {
  private requests = new Map<string, AuthorizationRequestRecord>();
  private codes = new Map<string, AuthorizationCodeRecord>();
  private accessTokens = new Map<string, DSpaceSession>();
  private refreshTokens = new Map<string, RefreshTokenRecord>();

  constructor(sweepIntervalMs = 60_000) {
    // Do not keep the event loop alive just for the sweep.
    const timer = setInterval(() => this.sweep(), sweepIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  private sweep(): void {
    const t = nowSeconds();
    for (const [k, v] of this.requests) if (v.expiresAt <= t) this.requests.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt <= t) this.codes.delete(k);
    for (const [k, v] of this.accessTokens) if (v.accessTokenExpiresAt <= t) this.accessTokens.delete(k);
    for (const [k, v] of this.refreshTokens) if (v.expiresAt <= t) this.refreshTokens.delete(k);
  }

  async saveAuthorizationRequest(record: AuthorizationRequestRecord): Promise<void> {
    this.requests.set(record.requestId, record);
  }

  async consumeAuthorizationRequest(requestId: string): Promise<AuthorizationRequestRecord | undefined> {
    const rec = this.requests.get(requestId);
    this.requests.delete(requestId);
    if (!rec) return undefined;
    if (rec.expiresAt <= nowSeconds()) return undefined;
    return rec;
  }

  async saveAuthorizationCode(record: AuthorizationCodeRecord): Promise<void> {
    this.codes.set(record.code, record);
  }

  async consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const rec = this.codes.get(code);
    this.codes.delete(code);
    if (!rec) return undefined;
    if (rec.expiresAt <= nowSeconds()) return undefined;
    return rec;
  }

  async saveAccessToken(token: string, session: DSpaceSession): Promise<void> {
    this.accessTokens.set(token, session);
  }

  async getAccessToken(token: string): Promise<DSpaceSession | undefined> {
    const s = this.accessTokens.get(token);
    if (!s) return undefined;
    if (s.accessTokenExpiresAt <= nowSeconds()) {
      this.accessTokens.delete(token);
      return undefined;
    }
    return s;
  }

  async deleteAccessToken(token: string): Promise<void> {
    this.accessTokens.delete(token);
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(record.refreshToken, record);
  }

  async getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const r = this.refreshTokens.get(token);
    if (!r) return undefined;
    if (r.expiresAt <= nowSeconds()) {
      this.refreshTokens.delete(token);
      return undefined;
    }
    return r;
  }

  async deleteRefreshToken(token: string): Promise<void> {
    this.refreshTokens.delete(token);
  }
}
