/**
 * DSpace REST API client.
 * Handles authentication (JWT + CSRF), HAL parsing, and all HTTP interaction.
 */
import { config } from '../config.js';
import type { AuthState, AuthStatus, Bitstream, Bundle, HalPage, MetadataMap, PatchOperation } from '../types/dspace.js';

export class DSpaceClient {
  private baseUrl: string;
  private auth: AuthState = { token: null, csrfToken: null, csrfCookie: null };

  /**
   * @param baseUrl Optional DSpace REST base URL (defaults to config.baseUrl).
   * @param initialToken Optional pre-existing DSpace JWT to seed the session
   *   with. Used by the HTTP/OAuth transport, which builds a fresh client per
   *   request and injects the token resolved from the caller's opaque access
   *   token. The token stays confined to this in-memory instance and is never
   *   returned to the MCP client or the model.
   */
  constructor(baseUrl?: string, initialToken?: string) {
    this.baseUrl = (baseUrl || config.baseUrl).replace(/\/$/, '');
    if (initialToken) {
      this.auth.token = initialToken;
    }
  }

  // ─── CSRF ──────────────────────────────────────────────────

  /** Fetch a fresh CSRF token from the server. */
  async refreshCsrf(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/security/csrf`, {
      method: 'GET',
      headers: this.auth.csrfCookie
        ? { 'Cookie': `DSPACE-XSRF-COOKIE=${this.auth.csrfCookie}` }
        : {},
    });
    const csrfToken = res.headers.get('dspace-xsrf-token');
    if (csrfToken) {
      this.auth.csrfToken = csrfToken;
    }
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/DSPACE-XSRF-COOKIE=([^;]+)/);
      if (match) {
        this.auth.csrfCookie = match[1];
      }
    }
  }

  // ─── Internal HTTP helpers ─────────────────────────────────

  private buildHeaders(method: string, contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (this.auth.token) {
      headers['Authorization'] = `Bearer ${this.auth.token}`;
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
      if (this.auth.csrfToken) {
        headers['X-XSRF-TOKEN'] = this.auth.csrfToken;
      }
      if (this.auth.csrfCookie) {
        headers['Cookie'] = `DSPACE-XSRF-COOKIE=${this.auth.csrfCookie}`;
      }
    }
    if (contentType) {
      headers['Content-Type'] = contentType;
    }
    return headers;
  }

  /** Generic request with auto-CSRF refresh on 403. */
  async request<T = unknown>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      contentType?: string;
      params?: Record<string, string | number | undefined>;
      rawBody?: string;
    } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const doFetch = async (): Promise<Response> => {
      const headers = this.buildHeaders(method, options.contentType);
      const fetchOpts: RequestInit = { method, headers };
      if (options.rawBody !== undefined) {
        fetchOpts.body = options.rawBody;
      } else if (options.body !== undefined) {
        fetchOpts.body = JSON.stringify(options.body);
      }
      return fetch(url.toString(), fetchOpts);
    };

    let res = await doFetch();

    // Auto-refresh CSRF on 403 and retry once
    if (res.status === 403) {
      await this.refreshCsrf();
      res = await doFetch();
    }

    // Extract new CSRF token from any response
    const newCsrf = res.headers.get('dspace-xsrf-token');
    if (newCsrf) this.auth.csrfToken = newCsrf;
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/DSPACE-XSRF-COOKIE=([^;]+)/);
      if (match) this.auth.csrfCookie = match[1];
    }

    let data: T;
    const text = await res.text();
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = text as unknown as T;
    }

    return { status: res.status, data, headers: res.headers };
  }

  /**
   * Multipart/form-data request (used for binary uploads such as bitstreams).
   * The Content-Type (with boundary) is set automatically by fetch from the
   * FormData body, so it must NOT be provided manually. CSRF is auto-refreshed
   * and the request is retried once on 403.
   */
  async requestMultipart<T = unknown>(
    method: string,
    path: string,
    form: FormData,
    options: { params?: Record<string, string | number | undefined> } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const doFetch = async (): Promise<Response> => {
      // buildHeaders() intentionally called WITHOUT a contentType so fetch can
      // set multipart/form-data with the correct boundary itself.
      const headers = this.buildHeaders(method);
      return fetch(url.toString(), { method, headers, body: form });
    };

    let res = await doFetch();

    if (res.status === 403) {
      await this.refreshCsrf();
      res = await doFetch();
    }

    const newCsrf = res.headers.get('dspace-xsrf-token');
    if (newCsrf) this.auth.csrfToken = newCsrf;
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/DSPACE-XSRF-COOKIE=([^;]+)/);
      if (match) this.auth.csrfCookie = match[1];
    }

    let data: T;
    const text = await res.text();
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = text as unknown as T;
    }

    return { status: res.status, data, headers: res.headers };
  }

  // ─── Authentication ────────────────────────────────────────

  setToken(token: string): void {
    this.auth.token = token;
  }

  getToken(): string | null {
    return this.auth.token;
  }

  async login(email: string, password: string): Promise<string> {
    await this.refreshCsrf();

    const body = `user=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
    const res = await this.request<string>('POST', '/api/authn/login', {
      rawBody: body,
      contentType: 'application/x-www-form-urlencoded',
    });

    const authHeader = res.headers.get('authorization');
    if (!authHeader) {
      throw new Error(`Login failed (HTTP ${res.status}): no Authorization header in response`);
    }
    const token = authHeader.replace(/^Bearer\s+/i, '');
    this.auth.token = token;
    return token;
  }

  /**
   * Refresh the current DSpace JWT using DSpace's native refresh mechanism:
   * re-POST the existing token to /api/authn/login with no other parameters,
   * and read the freshly issued token from the response Authorization header.
   *
   * Used to keep a session alive: when the OAuth layer rotates its own opaque
   * refresh token it also renews the backing DSpace JWT here. This only works
   * while the current JWT is still valid, so it must be called before that JWT
   * expires. Note this is rotation, not revocation: DSpace issues a new token
   * but the previous one remains valid until its own expiry.
   *
   * @returns the new JWT.
   * @throws if there is no current token, or DSpace does not return a new one.
   */
  async refreshToken(): Promise<string> {
    if (!this.auth.token) {
      throw new Error('Cannot refresh: no current token');
    }
    await this.refreshCsrf();
    const res = await this.request<string>('POST', '/api/authn/login');
    const authHeader = res.headers.get('authorization');
    if (!authHeader) {
      throw new Error(
        `Token refresh failed (HTTP ${res.status}): no Authorization header in response`,
      );
    }
    const token = authHeader.replace(/^Bearer\s+/i, '');
    this.auth.token = token;
    return token;
  }

  async logout(): Promise<void> {
    if (!this.auth.token) return;
    await this.request('POST', '/api/authn/logout');
    this.auth.token = null;
  }

  async authStatus(): Promise<AuthStatus> {
    // embed=eperson so the authenticated user's email/name are included in the
    // response (DSpace omits the embedded eperson by default).
    const { data } = await this.request<AuthStatus>('GET', '/api/authn/status', {
      params: { embed: 'eperson' },
    });
    return data;
  }

  /**
   * Authenticate this client from environment-provided credentials
   * (config.credentials), used by the stdio transport at startup. Prefers a
   * pre-existing DSpace JWT (DSPACE_TOKEN); otherwise falls back to a
   * username/password login (DSPACE_USER + DSPACE_PASSWORD).
   *
   * Never logs or returns the token. Returns a small, non-sensitive summary of
   * the outcome for a startup message.
   */
  async authenticateFromEnv(): Promise<{
    authenticated: boolean;
    method: 'token' | 'password' | 'none';
    email?: string;
    reason?: string;
  }> {
    const { token, user, password } = config.credentials;

    if (token) {
      this.setToken(token);
      try {
        const status = await this.authStatus();
        if (status.authenticated) {
          return { authenticated: true, method: 'token', email: status._embedded?.eperson?.email };
        }
        this.auth.token = null;
        return { authenticated: false, method: 'token', reason: 'DSPACE_TOKEN is invalid or expired' };
      } catch (e) {
        this.auth.token = null;
        return { authenticated: false, method: 'token', reason: e instanceof Error ? e.message : String(e) };
      }
    }

    if (user && password) {
      try {
        await this.login(user, password);
        const status = await this.authStatus();
        return { authenticated: true, method: 'password', email: status._embedded?.eperson?.email ?? user };
      } catch (e) {
        return { authenticated: false, method: 'password', reason: e instanceof Error ? e.message : String(e) };
      }
    }

    return { authenticated: false, method: 'none', reason: 'no credentials in environment' };
  }

  // ─── Search ────────────────────────────────────────────────

  async search(params: {
    query?: string;
    dsoType?: string;
    scope?: string;
    configuration?: string;
    page?: number;
    size?: number;
    sort?: string;
    filters?: Record<string, string>;
  }): Promise<unknown> {
    const p: Record<string, string | number | undefined> = {
      query: params.query,
      dsoType: params.dsoType,
      scope: params.scope,
      configuration: params.configuration,
      page: params.page,
      size: params.size,
      sort: params.sort,
    };
    if (params.filters) {
      for (const [name, value] of Object.entries(params.filters)) {
        p[`f.${name}`] = value;
      }
    }
    const { data } = await this.request('GET', '/api/discover/search/objects', { params: p });
    return data;
  }

  // ─── Items ─────────────────────────────────────────────────

  async getItem(uuid: string): Promise<unknown> {
    const { data } = await this.request('GET', `/api/core/items/${uuid}`);
    return data;
  }

  async createItemAdmin(owningCollectionUuid: string, metadata: MetadataMap, options?: {
    discoverable?: boolean;
    withdrawn?: boolean;
  }): Promise<unknown> {
    await this.refreshCsrf();
    const body = {
      name: metadata['dc.title']?.[0]?.value || 'Untitled',
      metadata,
      inArchive: true,
      discoverable: options?.discoverable ?? true,
      withdrawn: options?.withdrawn ?? false,
      type: 'item',
    };
    const { data, status } = await this.request('POST', '/api/core/items', {
      body,
      contentType: 'application/json',
      params: { owningCollection: owningCollectionUuid },
    });
    if (status >= 400) {
      throw new Error(`Create item failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  async patchItem(uuid: string, operations: PatchOperation[]): Promise<unknown> {
    await this.refreshCsrf();
    const { data, status } = await this.request('PATCH', `/api/core/items/${uuid}`, {
      body: operations,
      contentType: 'application/json',
    });
    if (status >= 400) {
      throw new Error(`Patch item failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  /**
   * Permanently delete an item from DSpace.
   * Requires admin privileges. On success DSpace returns 204 No Content.
   */
  async deleteItem(uuid: string): Promise<void> {
    await this.refreshCsrf();
    const { data, status } = await this.request('DELETE', `/api/core/items/${uuid}`);
    if (status >= 400) {
      throw new Error(`Delete item failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }
  }

  // ─── Bundles & Bitstreams (file uploads) ───────────────────

  /** List the bundles of an item. */
  async getItemBundles(itemUuid: string): Promise<Bundle[]> {
    const { data, status } = await this.request<HalPage<Bundle>>(
      'GET',
      `/api/core/items/${itemUuid}/bundles`,
      { params: { size: 100 } },
    );
    if (status >= 400) {
      throw new Error(`List bundles failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }
    return data?._embedded?.bundles ?? [];
  }

  /** Create a new bundle (e.g. "ORIGINAL") on an item. */
  async createBundle(itemUuid: string, name: string): Promise<Bundle> {
    await this.refreshCsrf();
    const { data, status } = await this.request<Bundle>('POST', `/api/core/items/${itemUuid}/bundles`, {
      body: { name, metadata: {} },
      contentType: 'application/json',
    });
    if (status >= 400) {
      throw new Error(`Create bundle failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  /**
   * Find the bundle with the given name on an item, creating it if it does not
   * exist. Defaults to the "ORIGINAL" bundle where DSpace stores primary files.
   */
  async ensureBundle(itemUuid: string, name = 'ORIGINAL'): Promise<Bundle> {
    const bundles = await this.getItemBundles(itemUuid);
    const existing = bundles.find(b => b.name === name);
    if (existing) return existing;
    return this.createBundle(itemUuid, name);
  }

  /** Upload a bitstream (file) into a bundle via multipart/form-data. */
  async uploadBitstream(
    bundleUuid: string,
    file: { data: Uint8Array; filename: string; mimeType?: string },
    options?: { name?: string; description?: string },
  ): Promise<Bitstream> {
    await this.refreshCsrf();

    const form = new FormData();
    const blob = new Blob([file.data as BlobPart], {
      type: file.mimeType || 'application/octet-stream',
    });
    form.append('file', blob, file.filename);

    // Optional bitstream metadata sent as a JSON properties part.
    if (options?.name || options?.description) {
      const properties: Record<string, unknown> = {};
      if (options.name) {
        properties.name = options.name;
      }
      if (options.description) {
        properties.metadata = {
          'dc.description': [{ value: options.description }],
        };
      }
      form.append('properties', JSON.stringify(properties));
    }

    const { data, status } = await this.requestMultipart<Bitstream>(
      'POST',
      `/api/core/bundles/${bundleUuid}/bitstreams`,
      form,
    );
    if (status >= 400) {
      throw new Error(`Upload bitstream failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  /**
   * High-level helper: upload a file to an item's target bundle (default
   * "ORIGINAL"), creating the bundle if needed. Returns the created bitstream.
   */
  async uploadFileToItem(
    itemUuid: string,
    file: { data: Uint8Array; filename: string; mimeType?: string },
    options?: { bundleName?: string; name?: string; description?: string },
  ): Promise<Bitstream> {
    const bundle = await this.ensureBundle(itemUuid, options?.bundleName || 'ORIGINAL');
    return this.uploadBitstream(bundle.uuid, file, {
      name: options?.name,
      description: options?.description,
    });
  }

  // ─── Reading bitstream content & extracted text ────────────

  /** List the bitstreams of a bundle (embedding each bitstream's format). */
  async getBundleBitstreams(bundleUuid: string): Promise<Bitstream[]> {
    const { data, status } = await this.request<HalPage<Bitstream>>(
      'GET',
      `/api/core/bundles/${bundleUuid}/bitstreams`,
      { params: { size: 100, embed: 'format' } },
    );
    if (status >= 400) {
      throw new Error(`List bitstreams failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }
    return data?._embedded?.bitstreams ?? [];
  }

  /**
   * List the bitstreams of a named bundle on an item (e.g. "ORIGINAL" or
   * "TEXT"). Returns an empty array if the bundle does not exist.
   */
  async getItemBitstreamsByBundle(itemUuid: string, bundleName: string): Promise<Bitstream[]> {
    const bundles = await this.getItemBundles(itemUuid);
    const bundle = bundles.find(b => b.name === bundleName);
    if (!bundle) return [];
    return this.getBundleBitstreams(bundle.uuid);
  }

  /**
   * Download the raw content of a bitstream.
   * Returns the bytes plus the content type and length reported by the server.
   */
  async downloadBitstreamContent(bitstreamUuid: string): Promise<{
    data: Uint8Array;
    contentType: string;
    contentLength: number;
  }> {
    const url = new URL(`${this.baseUrl}/api/core/bitstreams/${bitstreamUuid}/content`);
    const headers: Record<string, string> = {};
    if (this.auth.token) {
      headers['Authorization'] = `Bearer ${this.auth.token}`;
    }

    // DSpace 307-redirects bitstream content to a storage location; fetch
    // follows redirects by default.
    const res = await fetch(url.toString(), { method: 'GET', headers });
    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      throw new Error(`Download bitstream failed (HTTP ${res.status}): ${text}`);
    }

    const buffer = new Uint8Array(await res.arrayBuffer());
    return {
      data: buffer,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      contentLength: buffer.byteLength,
    };
  }

  /**
   * Resolve the extracted-text bitstream for a given original bitstream.
   *
   * DSpace's media-filter stores extracted plain text in the "TEXT" bundle as a
   * bitstream named after the original file with a ".txt" suffix
   * (e.g. "paper.pdf" → "paper.pdf.txt"). Returns undefined if none is found.
   */
  async findExtractedTextBitstream(
    itemUuid: string,
    originalName: string,
  ): Promise<Bitstream | undefined> {
    const textBitstreams = await this.getItemBitstreamsByBundle(itemUuid, 'TEXT');
    if (textBitstreams.length === 0) return undefined;
    const expected = `${originalName}.txt`;
    return (
      textBitstreams.find(b => b.name === expected) ??
      // Fallbacks: some configurations drop the original extension or vary case.
      textBitstreams.find(b => b.name?.toLowerCase() === expected.toLowerCase()) ??
      textBitstreams.find(b => b.name === `${originalName.replace(/\.[^.]+$/, '')}.txt`)
    );
  }

  // ─── Communities & Collections ─────────────────────────────

  async listCommunities(params?: { page?: number; size?: number }): Promise<unknown> {
    const { data } = await this.request('GET', '/api/core/communities/search/top', {
      params: { page: params?.page, size: params?.size },
    });
    return data;
  }

  async listCollections(params?: {
    communityUuid?: string;
    page?: number;
    size?: number;
  }): Promise<unknown> {
    if (params?.communityUuid) {
      const { data } = await this.request(
        'GET',
        `/api/core/communities/${params.communityUuid}/collections`,
        { params: { page: params.page, size: params.size } },
      );
      return data;
    }
    const { data } = await this.request('GET', '/api/core/collections', {
      params: { page: params?.page, size: params?.size },
    });
    return data;
  }

  // ─── Submission (Workspace Items) ──────────────────────────

  async createWorkspaceItem(owningCollectionUuid?: string): Promise<unknown> {
    await this.refreshCsrf();
    const params: Record<string, string | number | undefined> = {};
    if (owningCollectionUuid) {
      params.owningCollection = owningCollectionUuid;
    }
    const { data, status } = await this.request('POST', '/api/submission/workspaceitems', {
      contentType: 'text/uri-list',
      params,
    });
    if (status >= 400) {
      throw new Error(`Create workspace item failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  async patchWorkspaceItem(id: number, operations: PatchOperation[]): Promise<unknown> {
    await this.refreshCsrf();
    const { data, status } = await this.request('PATCH', `/api/submission/workspaceitems/${id}`, {
      body: operations,
      contentType: 'application/json',
    });
    if (status >= 400) {
      throw new Error(`Patch workspace item failed (HTTP ${status}): ${JSON.stringify(data)}`);
    }
    return data;
  }

  async listWorkspaceItems(params?: { page?: number; size?: number }): Promise<unknown> {
    const { data } = await this.request('GET', '/api/submission/workspaceitems', {
      params: { page: params?.page, size: params?.size },
    });
    return data;
  }

  async getWorkspaceItem(id: number): Promise<unknown> {
    const { data } = await this.request('GET', `/api/submission/workspaceitems/${id}`);
    return data;
  }
}
