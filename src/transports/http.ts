/**
 * HTTP transport entry point.
 * Works both for local development AND on AWS Lambda via Lambda Web Adapter.
 * Stateless: each request creates a fresh server+transport (Lambda-safe).
 *
 * OAuth 2.1 is always enabled on this transport: the server acts as an
 * authorization + resource server backed by DSpace. /mcp requires a valid
 * opaque access token, and the real DSpace JWT is resolved server-side per
 * request. See src/auth/*. The DSpace token is never returned to the client or
 * exposed to the model.
 */
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from
  '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from
  '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createServer } from '../server.js';
import { config, publicUrl } from '../config.js';
import { InMemoryTokenStore } from '../auth/token-store.js';
import { DSpaceOAuthProvider } from '../auth/dspace-oauth-provider.js';

const app = express();

// Health check (always public, before any auth).
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: config.name, version: config.version });
});

// ─── OAuth wiring (always on for the HTTP transport) ─────────

const store = new InMemoryTokenStore();
const provider = new DSpaceOAuthProvider(store);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(`${config.oauth.publicUrl}/mcp`));

// The login page posts here. Parse form bodies for this route only.
app.post('/authorize/login', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const { request_id, user, password } = req.body ?? {};
  if (typeof request_id !== 'string' || typeof user !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  try {
    await provider.handleLoginSubmit(request_id, user, password, res);
  } catch (error) {
    console.error('Login submit error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  }
});

// Headless fallback: intercept the `password` grant BEFORE the SDK's token
// handler (which only understands authorization_code / refresh_token). Only
// active when explicitly enabled. To pass an existing DSpace JWT instead of
// credentials, use username "jwt-token" and put the JWT in the password
// field (see headlessPasswordGrant / README).
if (config.oauth.headlessFallback) {
  app.post('/token', express.urlencoded({ extended: false }), async (req: Request, res: Response, next) => {
    if (req.body?.grant_type !== 'password') {
      next(); // hand off to the SDK's mcpAuthRouter /token handler
      return;
    }
    try {
      const clientId = typeof req.body?.client_id === 'string' && req.body.client_id
        ? req.body.client_id
        : 'headless';
      await provider.ensureClient(clientId);
      const scopes = typeof req.body?.scope === 'string' && req.body.scope
        ? req.body.scope.split(' ')
        : [];

      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        res.status(400).json({ error: 'invalid_request', error_description: 'username and password are required' });
        return;
      }
      const tokens = await provider.headlessPasswordGrant({ clientId, user: username, password, scopes });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(tokens);
    } catch (error) {
      const oauthError = error as { errorCode?: string; message?: string };
      const code = oauthError?.errorCode ?? 'invalid_grant';
      res.status(400).json({ error: code, error_description: oauthError?.message });
    }
  });
}

// Standard MCP authorization-server + protected-resource metadata,
// /authorize, /token, /register, /revoke.
app.use(mcpAuthRouter({
  provider,
  issuerUrl: publicUrl(),
  resourceServerUrl: new URL(`${config.oauth.publicUrl}/mcp`),
  resourceName: config.name,
}));

// Guard for /mcp: require a valid opaque bearer and attach req.auth. A
// missing/invalid token returns 401 with WWW-Authenticate pointing at the
// resource metadata, which is what triggers the OAuth flow in MCP clients.
const mcpGuards: express.RequestHandler[] = [
  requireBearerAuth({ verifier: provider, resourceMetadataUrl }),
];
const resolveDSpaceToken = (req: Request): string | undefined => {
  const extra = req.auth?.extra as { dspaceToken?: string } | undefined;
  return extra?.dspaceToken;
};

// JSON body parsing for the MCP endpoint (registered after the form routes
// above so it does not swallow urlencoded auth bodies).
const jsonParser = express.json();

// ─── MCP endpoint — stateless: fresh server+transport per request ──
app.post('/mcp', ...mcpGuards, jsonParser, async (req: Request, res: Response) => {
  try {
    const dspaceToken = resolveDSpaceToken(req);
    const { server } = createServer({ transport: 'http', dspaceToken });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session tracking
    });

    res.on('close', () => {
      transport.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Handle GET/DELETE for MCP protocol (returns 405 in stateless mode)
app.get('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Method not allowed — this server is stateless' });
});

app.delete('/mcp', (_req, res) => {
  res.status(405).json({ error: 'Method not allowed — this server is stateless' });
});

const host = process.env.AWS_LAMBDA_FUNCTION_NAME ? '0.0.0.0' : '127.0.0.1';
app.listen(config.port, host, () => {
  console.error(`DSpace MCP HTTP server listening on http://${host}:${config.port}/mcp`);
  console.error(`OAuth issuer/resource: ${config.oauth.publicUrl}` +
    (config.oauth.headlessFallback ? ' (headless fallback ON)' : ''));
});
