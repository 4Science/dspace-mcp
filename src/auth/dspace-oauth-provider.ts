/**
 * OAuth 2.1 authorization/resource-server provider backed by DSpace.
 *
 * The MCP server mints its own opaque access/refresh tokens and keeps the real
 * DSpace JWT server-side (in the TokenStore). DSpace itself is the identity
 * backend: the user authenticates with their DSpace credentials, so every
 * request to DSpace is performed as that user — not as a shared service
 * account — and the DSpace JWT never reaches the MCP client or the model.
 *
 * Flows supported:
 *  - Authorization Code + PKCE (interactive): /authorize serves a login page,
 *    the user's credentials go straight to DSpace, and an opaque code is
 *    exchanged for opaque tokens at /token.
 *  - Headless fallback (optional, config.oauth.headlessFallback): the /token
 *    endpoint also accepts the `password` grant. Normally that is a DSpace
 *    user/password login (the JWT is minted server-side and never exposed); as
 *    a documented convenience, username "jwt-token" carries an existing DSpace
 *    JWT in the password field, which is verified and stored as-is. See
 *    headlessPasswordGrant.
 */
import { randomBytes, createHash } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from
  '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from
  '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidGrantError,
  InvalidRequestError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { config } from '../config.js';
import { DSpaceClient } from '../services/dspace-client.js';
import type { TokenStore } from './token-store.js';
import { renderLoginPage } from './login-page.js';

/**
 * Magic username for the headless `password` grant that switches it into
 * "JWT passthrough" mode: the password field then carries an existing DSpace
 * JWT, which is verified and stored as-is. See headlessPasswordGrant.
 */
export const JWT_TOKEN_USERNAME = 'jwt-token';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const token = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** PKCE S256 verification: base64url(sha256(verifier)) === challenge. */
function verifyPkce(verifier: string, challenge: string): boolean {
  const hash = createHash('sha256').update(verifier).digest('base64url');
  return hash === challenge;
}

/** In-memory dynamic client registry (RFC 7591). */
class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: token(16),
      client_id_issued_at: nowSeconds(),
    };
    this.clients.set(full.client_id, full);
    return full;
  }

  /** Used by the provider to persist a client it created implicitly. */
  put(client: OAuthClientInformationFull): void {
    this.clients.set(client.client_id, client);
  }
}

export class DSpaceOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();

  /**
   * We validate PKCE ourselves inside exchangeAuthorizationCode (where the
   * single-use code is consumed), so we tell the SDK's /token handler to skip
   * its own local PKCE check and hand us the code_verifier instead. This
   * avoids consuming the code twice.
   */
  readonly skipLocalPkceValidation = true;

  constructor(private readonly store: TokenStore) {}

  // ─── Authorization Code flow ───────────────────────────────

  /**
   * Called by the SDK's /authorize handler. Instead of redirecting straight
   * back, we persist the (validated) request and render the DSpace login page.
   * The page posts to the internal login-submit endpoint (see
   * handleLoginSubmit), which completes the redirect once DSpace authenticates
   * the user.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const requestId = token(24);
    await this.store.saveAuthorizationRequest({
      requestId,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      expiresAt: nowSeconds() + config.oauth.authCodeTtl,
    });
    const actionUrl = `${config.oauth.publicUrl}/authorize/login`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(renderLoginPage({ actionUrl, requestId }));
  }

  /**
   * Handles the POST from the login page: authenticate to DSpace with the
   * submitted credentials, mint a single-use authorization code bound to the
   * DSpace JWT, and redirect back to the client's redirect_uri with code+state.
   * Returns an HTML string to re-render the login page on failure.
   *
   * This is mounted by the transport, not part of the OAuthServerProvider
   * interface.
   */
  async handleLoginSubmit(
    requestId: string,
    user: string,
    password: string,
    res: Response,
  ): Promise<void> {
    const request = await this.store.consumeAuthorizationRequest(requestId);
    if (!request) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginPage({
        actionUrl: `${config.oauth.publicUrl}/authorize/login`,
        requestId: '',
        error: 'This login request has expired. Please restart the sign-in from your client.',
      }));
      return;
    }

    const client = new DSpaceClient();
    let identity: { epersonId?: string; email?: string; name?: string };
    try {
      await client.login(user, password);
      identity = await this.resolveIdentity(client);
    } catch {
      // Re-persist the request so the user can retry, and re-show the page.
      await this.store.saveAuthorizationRequest({ ...request, requestId });
      res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginPage({
        actionUrl: `${config.oauth.publicUrl}/authorize/login`,
        requestId,
        error: 'Invalid credentials. Please try again.',
      }));
      return;
    }

    const code = token(24);
    await this.store.saveAuthorizationCode({
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      dspaceToken: client.getToken() as string,
      epersonId: identity.epersonId,
      email: identity.email,
      name: identity.name,
      scopes: request.scopes,
      expiresAt: nowSeconds() + config.oauth.authCodeTtl,
    });

    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('code', code);
    if (request.state) redirect.searchParams.set('state', request.state);
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    _authorizationCode: string,
  ): Promise<string> {
    // Not used: skipLocalPkceValidation=true means the SDK never calls this.
    // PKCE is validated in exchangeAuthorizationCode. Kept to satisfy the
    // OAuthServerProvider interface.
    return '';
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = await this.store.consumeAuthorizationCode(authorizationCode);
    if (!record) {
      throw new InvalidGrantError('Authorization code is invalid or expired');
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri mismatch');
    }
    if (!codeVerifier || !verifyPkce(codeVerifier, record.codeChallenge)) {
      throw new InvalidGrantError('PKCE verification failed');
    }
    return this.issueTokens({
      clientId: client.client_id,
      dspaceToken: record.dspaceToken,
      epersonId: record.epersonId,
      email: record.email,
      name: record.name,
      scopes: record.scopes,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const record = await this.store.getRefreshToken(refreshToken);
    if (!record) {
      throw new InvalidGrantError('Refresh token is invalid or expired');
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was issued to a different client');
    }
    // Rotate: consume this refresh token and mint a new pair. Refresh the
    // DSpace JWT too, so the backing session stays alive.
    await this.store.deleteRefreshToken(refreshToken);
    const dspace = new DSpaceClient(undefined, record.dspaceToken);
    let dspaceToken = record.dspaceToken;
    try {
      dspaceToken = await dspace.refreshToken();
    } catch {
      // If DSpace refuses to refresh (token already expired server-side), the
      // session is effectively dead; force re-authentication.
      throw new InvalidGrantError('DSpace session expired; re-authentication required');
    }
    return this.issueTokens({
      clientId: client.client_id,
      dspaceToken,
      epersonId: record.epersonId,
      email: record.email,
      name: record.name,
      scopes: scopes && scopes.length ? scopes : record.scopes,
    });
  }

  // ─── Resource-server token verification ────────────────────

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const session = await this.store.getAccessToken(accessToken);
    if (!session) {
      throw new InvalidGrantError('Access token is invalid or expired');
    }
    return {
      token: accessToken,
      clientId: session.clientId ?? 'unknown',
      scopes: session.scopes,
      expiresAt: session.accessTokenExpiresAt,
      extra: {
        // The DSpace JWT is carried here for the request handler to build a
        // per-request DSpaceClient. It stays server-side; it is never sent to
        // the client or surfaced to the model.
        dspaceToken: session.dspaceToken,
        epersonId: session.epersonId,
        email: session.email,
        name: session.name,
      },
    };
  }

  // ─── Headless fallback (optional) ──────────────────────────

  /**
   * The single headless grant: OAuth 2.1 `password` against DSpace. Invoked from
   * the transport's custom /token handling when the headless fallback is
   * enabled. Two modes, selected by the username:
   *
   *  - Normal login: `username`+`password` are DSpace credentials. The server
   *    logs in to DSpace and stores the freshly minted JWT. That token is born
   *    inside the server and is never exposed to the model context.
   *
   *  - JWT passthrough (documented trick): when `username === "jwt-token"`, the
   *    `password` field carries an EXISTING DSpace JWT. The server verifies it
   *    (via /api/authn/status; it must report authenticated) and, if valid,
   *    stores it AS-IS. No refresh/rotation is performed here: empirically a
   *    DSpace refresh only rotates the token and leaves the old one valid until
   *    its own expiry, so refreshing would not invalidate a token that already
   *    leaked. The caller supplies this token knowingly; it stays valid until
   *    its natural expiry (only a DSpace logout, which kills the whole session,
   *    would revoke it).
   *
   * Note there is intentionally no grant that accepts a JWT and pretends to
   * invalidate it: that guarantee is not achievable against DSpace without
   * destroying the session, so it is not offered.
   */
  async headlessPasswordGrant(input: {
    clientId: string;
    user: string;
    password: string;
    scopes: string[];
  }): Promise<OAuthTokens> {
    if (!config.oauth.headlessFallback) {
      throw new InvalidRequestError('Headless grants are disabled on this server');
    }

    // JWT passthrough mode.
    if (input.user === JWT_TOKEN_USERNAME) {
      const suppliedToken = input.password;
      const dspace = new DSpaceClient(undefined, suppliedToken);
      let authenticated = false;
      let identity: { epersonId?: string; email?: string; name?: string } = {};
      try {
        const status = await dspace.authStatus();
        authenticated = status.authenticated === true;
        const ep = status._embedded?.eperson;
        identity = { epersonId: ep?.uuid, email: ep?.email, name: ep?.name };
      } catch {
        authenticated = false;
      }
      if (!authenticated) {
        throw new InvalidGrantError('Supplied DSpace token is invalid or expired');
      }
      // Store the caller's token as-is.
      return this.issueTokens({
        clientId: input.clientId,
        dspaceToken: suppliedToken,
        epersonId: identity.epersonId,
        email: identity.email,
        name: identity.name,
        scopes: input.scopes,
      });
    }

    // Normal DSpace username/password login.
    const dspace = new DSpaceClient();
    try {
      await dspace.login(input.user, input.password);
    } catch {
      throw new InvalidGrantError('Invalid DSpace credentials');
    }
    const identity: { epersonId?: string; email?: string; name?: string } =
      await this.resolveIdentity(dspace).catch(() => ({}));
    return this.issueTokens({
      clientId: input.clientId,
      dspaceToken: dspace.getToken() as string,
      epersonId: identity.epersonId,
      email: identity.email,
      name: identity.name,
      scopes: input.scopes,
    });
  }

  /** Ensure a client exists for headless callers that skip registration. */
  async ensureClient(clientId: string): Promise<OAuthClientInformationFull> {
    const existing = await this.clientsStore.getClient(clientId);
    if (existing) return existing;
    const created: OAuthClientInformationFull = {
      client_id: clientId,
      redirect_uris: [],
      grant_types: ['password', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    };
    this.clientsStore.put(created);
    return created;
  }

  // ─── Internals ─────────────────────────────────────────────

  private async issueTokens(input: {
    clientId: string;
    dspaceToken: string;
    epersonId?: string;
    email?: string;
    name?: string;
    scopes: string[];
  }): Promise<OAuthTokens> {
    const accessToken = token(32);
    const refreshToken = token(32);
    const accessExp = nowSeconds() + config.oauth.accessTokenTtl;

    await this.store.saveAccessToken(accessToken, {
      dspaceToken: input.dspaceToken,
      epersonId: input.epersonId,
      email: input.email,
      name: input.name,
      accessTokenExpiresAt: accessExp,
      clientId: input.clientId,
      scopes: input.scopes,
    });
    await this.store.saveRefreshToken({
      refreshToken,
      clientId: input.clientId,
      dspaceToken: input.dspaceToken,
      epersonId: input.epersonId,
      email: input.email,
      name: input.name,
      scopes: input.scopes,
      expiresAt: nowSeconds() + config.oauth.refreshTokenTtl,
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: config.oauth.accessTokenTtl,
      refresh_token: refreshToken,
      scope: input.scopes.join(' ') || undefined,
    };
  }

  private async resolveIdentity(
    client: DSpaceClient,
  ): Promise<{ epersonId?: string; email?: string; name?: string }> {
    const status = await client.authStatus();
    const ep = status._embedded?.eperson;
    return { epersonId: ep?.uuid, email: ep?.email, name: ep?.name };
  }
}
