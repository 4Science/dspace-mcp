# DSpace MCP Server

An MCP (Model Context Protocol) server for [DSpace 7+](https://dspace.org) digital repository platform.

Provides AI assistants with tools to search, authenticate, create and update items in DSpace repositories via the REST API.

## Features

- **Search** — Full-text search with filters, facets, and pagination
- **Authentication** — OAuth 2.1 per-user auth on the HTTP transport (each caller acts as their own DSpace user, credentials never reach the model), or JWT/username-password from the environment for local stdio; CSRF-aware
- **Item Management (Admin)** — Create archived items directly (bypasses workflow) and delete items
- **Item Updates** — Patch metadata using JSON Patch (RFC 6902)
- **File Uploads (Admin)** — Attach files (bitstreams) to items, auto-creating the target bundle
- **Content Retrieval** — Read a document's extracted full text (TEXT bundle) or download the original file
- **Submissions** — Create workspace items through the standard submission flow
- **Browse** — List communities and collections

## Dual Runtime

Runs as:
- **Local Node.js** — stdio transport for Claude Desktop, Cursor, etc.
- **AWS Lambda** — HTTP transport via Lambda Web Adapter + API Gateway

## Quick Start

### Local (stdio)

```bash
npm install
npm run build

# Configure in Claude Desktop / Cursor (stdio auth comes from env):
# {
#   "mcpServers": {
#     "dspace": {
#       "command": "node",
#       "args": ["dist/transports/stdio.js"],
#       "env": {
#         "DSPACE_BASE_URL": "https://sandbox.dspace.org/server",
#         "DSPACE_USER": "you@example.org",
#         "DSPACE_PASSWORD": "secret"
#         // or, instead of user/password: "DSPACE_TOKEN": "<dspace-jwt>"
#       }
#     }
#   }
# }
```

### Local HTTP (dev)

The HTTP transport always runs with OAuth 2.1 enabled (see [Authentication](#authentication)).

```bash
DSPACE_BASE_URL=https://sandbox.dspace.org/server \
DSPACE_MCP_PUBLIC_URL=http://127.0.0.1:8080 \
npm run dev:http
# MCP endpoint: POST http://localhost:8080/mcp (requires a bearer token)
```

### AWS Lambda

```bash
npm run build
docker build -t dspace-mcp .
# Push to ECR, deploy with API Gateway HTTP API v2
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DSPACE_BASE_URL` | `https://sandbox.dspace.org/server` | DSpace REST API base URL |
| `PORT` | `8080` | HTTP server port (Lambda/dev) |
| `DSPACE_TOKEN` | _(none)_ | **stdio auth**: a pre-existing DSpace JWT to authenticate the session at startup. Takes precedence over user/password |
| `DSPACE_USER` | _(none)_ | **stdio auth**: DSpace username/email (used with `DSPACE_PASSWORD`) |
| `DSPACE_PASSWORD` | _(none)_ | **stdio auth**: DSpace password (used with `DSPACE_USER`) |
| `DSPACE_MCP_PUBLIC_URL` | `http://127.0.0.1:8080` | **HTTP transport**: externally reachable base URL of this MCP server. Used as OAuth issuer, resource identifier, and to build the metadata/authorize/token URLs. Must be the public URL (behind Lambda/ALB), not `127.0.0.1`, in production |
| `DSPACE_MCP_HEADLESS_FALLBACK` | `false` | Also enable the non-browser `password` token grant. Off by default |
| `DSPACE_MCP_ACCESS_TOKEN_TTL` | `600` | Opaque access-token lifetime, seconds (10 min) |
| `DSPACE_MCP_REFRESH_TOKEN_TTL` | `1200` | Refresh-token lifetime, seconds (20 min) |
| `DSPACE_MCP_AUTH_CODE_TTL` | `300` | Authorization-code lifetime, seconds (5 min) |

> **Token lifetimes.** These form a hierarchy: access token (10 min) < refresh
> token (20 min) < DSpace JWT (DSpace default ~30 min). A refresh renews the
> underlying DSpace JWT via DSpace's native mechanism, which only works while
> that JWT is still valid — so the refresh token is kept shorter than the DSpace
> JWT. If your DSpace uses a different JWT lifetime, adjust these accordingly
> (keep both below the DSpace JWT).

> The OAuth variables affect the **HTTP transport only**. The stdio transport ignores them and authenticates from `DSPACE_TOKEN` (or `DSPACE_USER`/`DSPACE_PASSWORD`) at startup, as the MCP spec recommends for stdio.

## Authentication

There are two authentication models, one per transport.

### stdio (local)

The local process holds a single DSpace session, authenticated **from the
environment at startup** (the model the MCP spec recommends for stdio:
credentials come from the local environment, not over the network and not
through tool calls). Set either:

- `DSPACE_TOKEN` — a pre-existing DSpace JWT (takes precedence), or
- `DSPACE_USER` + `DSPACE_PASSWORD` — a DSpace username/email and password.

```jsonc
// Claude Desktop / Cursor
{
  "mcpServers": {
    "dspace": {
      "command": "node",
      "args": ["dist/transports/stdio.js"],
      "env": {
        "DSPACE_BASE_URL": "https://sandbox.dspace.org/server",
        "DSPACE_USER": "dspacedemo+admin@gmail.com",
        "DSPACE_PASSWORD": "dspace"
        // or, instead of user/password:
        // "DSPACE_TOKEN": "<dspace-jwt>"
      }
    }
  }
}
```

The session established at startup persists for the process lifetime and is
reused for every tool call. If no credentials are set, the server starts
unauthenticated and only public/anonymous DSpace operations work. There is no
login/logout tool: credentials never pass through the model, and for security
the JWT is never returned in any tool response (error messages are scrubbed of
anything resembling a token). Use `dspace_auth_status` to check the session.

### HTTP — OAuth 2.1, per user (recommended for remote/shared deployments)

The HTTP transport **always** runs with OAuth 2.1: the server acts as **both an
OAuth 2.1 authorization server and a resource server**, using **DSpace itself as
the identity backend** — no external OIDC/IdP is required. Each caller
authenticates with **their own DSpace credentials**, so every DSpace call runs
as that user rather than as a shared service account.

Key property: the DSpace JWT stays **server-side**. The MCP server mints its own
**opaque access/refresh tokens** and hands only those to the client; the client
sends them as `Authorization: Bearer …` at the transport layer. The DSpace JWT
therefore never enters a tool argument, a tool result, or the model's context.

Standards implemented (per the MCP authorization spec):
- **RFC 9728** Protected Resource Metadata — `GET /.well-known/oauth-protected-resource/mcp`
- **RFC 8414** Authorization Server Metadata — `GET /.well-known/oauth-authorization-server`
- **RFC 7591** Dynamic Client Registration — `POST /register`
- `POST /mcp` requires a valid bearer; a missing/invalid token returns `401` with
  a `WWW-Authenticate` header pointing at the resource metadata, which is what
  triggers the OAuth flow in MCP clients. Once authenticated, every DSpace call
  runs as that user, using their DSpace JWT.

#### Authorization Code + PKCE (interactive, default)

1. The MCP client discovers the metadata, registers, and opens `/authorize`.
2. The server serves a small **login page**; the user types their DSpace
   credentials **in the browser**. They go straight to DSpace and are never seen
   by the MCP client or the model.
3. On success the server logs in to DSpace, issues a single-use authorization
   code, and redirects back to the client.
4. The client exchanges the code (with its PKCE `code_verifier`) at `/token` for
   an opaque access token + refresh token.
5. Refreshing rotates the tokens and also refreshes the backing DSpace JWT, so
   long sessions stay alive transparently.

#### Headless fallback (optional, non-browser clients)

Enable with `DSPACE_MCP_HEADLESS_FALLBACK=true`. The `/token` endpoint then also
accepts the OAuth 2.1 `password` grant (discouraged by the spec — use only when
a browser is unavailable). It has two modes:

- **Login** — `username` + `password` are DSpace credentials. The server logs in
  to DSpace and stores the freshly minted JWT. That token is created inside the
  server from the credentials and is never returned to the client or the model.

  ```bash
  curl -X POST http://127.0.0.1:8080/token \
    -d grant_type=password \
    -d client_id=headless \
    -d username='dspacedemo+admin@gmail.com' \
    -d password='dspace'
  ```

- **JWT passthrough** — set `username=jwt-token` and put an existing DSpace JWT in
  the `password` field. The server verifies the token against DSpace
  (`/api/authn/status`) and, if valid, stores it **as-is**.

  ```bash
  curl -X POST http://127.0.0.1:8080/token \
    -d grant_type=password \
    -d client_id=headless \
    -d username=jwt-token \
    -d password='<existing-dspace-jwt>'
  ```

Both return a standard OAuth response with an opaque `access_token` (and
`refresh_token`); use the opaque token as the bearer on `/mcp`.

> **Security note.** A JWT supplied via passthrough has, by definition, already
> been handled by the client (and possibly the model context). The server does
> **not** attempt to invalidate it: DSpace's refresh only *rotates* the token
> and leaves the previous one valid until its own expiry, so refreshing cannot
> revoke a leaked token. The only true revocation is a DSpace logout, which
> destroys the whole session (new token included) and is therefore not done
> here. A passed-in JWT stays valid until its natural expiry; supply it
> knowingly. The `password`-login mode does not have this exposure, since the
> token is born server-side — prefer it, and prefer the Authorization Code flow
> over both whenever a browser is available.

Because this grant routes credentials/tokens through the MCP client, it is
**off by default**.

#### Note for AWS Lambda

The token store is **in-memory** by default, which is per-process. That is fine
for a long-lived local/HTTP server, but the Lambda HTTP transport is stateless
(a fresh process per invocation), so opaque tokens minted in one invocation will
not be found in the next. For Lambda, provide a persistent `TokenStore`
implementation (e.g. DynamoDB or Redis) — the code is written against the
`TokenStore` interface in `src/auth/token-store.ts` specifically to make that
swap without touching the provider.

## Tools

> There is no `dspace_login` / `dspace_logout` tool. Authentication is handled by
> the transport — OAuth on HTTP, environment credentials on stdio — never through
> the model. On the HTTP transport every `/mcp` request requires a valid bearer.
> Use `dspace_auth_status` to check the current session.

| Tool | Description |
|---|---|
| `dspace_auth_status` | Check current authentication status |
| `dspace_search` | Search items, communities, collections |
| `dspace_get_item` | Get item by UUID with full metadata |
| `dspace_list_communities` | List top-level communities |
| `dspace_list_collections` | List collections (optionally filtered by community) |
| `dspace_create_item` | Create an archived item (admin, bypasses workflow) |
| `dspace_update_item_metadata` | Patch item metadata (JSON Patch) |
| `dspace_delete_item` | Permanently delete an item by UUID (admin) |
| `dspace_upload_bitstream` | Upload a local file as a bitstream (attachment) to an item (admin) |
| `dspace_get_item_fulltext` | Get an item's file text — extracted text (TEXT bundle) or a textual original |
| `dspace_get_bitstream_content` | Download a bitstream by UUID — save to a local file (`outputPath`), or return inline text / base64 blob |
| `dspace_create_workspace_item` | Create a submission workspace item |
| `dspace_update_workspace_item` | Update workspace item metadata |
| `dspace_list_workspace_items` | List current user's workspace items |

## License

Copyright © 2026 4Science Spa

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.

See the [LICENSE](./LICENSE) file for the full license text.

### No impact on the connected DSpace instance

dspace-mcp is independent software that communicates with a DSpace instance only
through its public REST API, over the network. It is not a derivative work of
DSpace, does not link against DSpace code, and does not embed or redistribute
any part of DSpace.

For this reason, using dspace-mcp has **no licensing impact** on the DSpace
instance it connects to. The AGPL-3.0 covers dspace-mcp itself only, and running
or integrating it does **not** require you to release the connected DSpace
instance — or its customizations, configuration, or infrastructure — under the
AGPL-3.0 or any other license. Interacting with DSpace through its REST API is
ordinary client/server communication and does not combine the two into a single
program.

### Commercial licensing

4Science Spa, as the copyright owner, also offers dspace-mcp under separate
commercial terms for organizations that cannot comply with the AGPL-3.0
(for example, those integrating it into closed-source or SaaS products without
releasing their source). Contact 4Science for commercial licensing options.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md).

All contributions are subject to a Contributor License Agreement, which allows
4Science to distribute the project under the AGPL-3.0 and under commercial
licenses (dual licensing):

- Individuals: [CLA.md](./CLA.md)
- Companies / organizations: [CLA-ENTITY.md](./CLA-ENTITY.md)
