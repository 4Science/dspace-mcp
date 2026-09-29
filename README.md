# DSpace MCP Server

An MCP (Model Context Protocol) server for [DSpace 7+](https://dspace.org) digital repository platform.

Provides AI assistants with tools to search, authenticate, create and update items in DSpace repositories via the REST API.

## Features

- **Search** — Full-text search with filters, facets, and pagination
- **Authentication** — Login via JWT token or username/password, CSRF-aware
- **Item Management (Admin)** — Create archived items directly (bypasses workflow) and delete items
- **Item Updates** — Patch metadata using JSON Patch (RFC 6902)
- **File Uploads (Admin)** — Attach files (bitstreams) to items, auto-creating the target bundle
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

# Configure in Claude Desktop / Cursor:
# {
#   "mcpServers": {
#     "dspace": {
#       "command": "node",
#       "args": ["dist/transports/stdio.js"],
#       "env": { "DSPACE_BASE_URL": "https://sandbox.dspace.org/server" }
#     }
#   }
# }
```

### Local HTTP (dev)

```bash
DSPACE_BASE_URL=https://sandbox.dspace.org/server npm run dev:http
# MCP endpoint: POST http://localhost:8080/mcp
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

## Tools

| Tool | Description |
|---|---|
| `dspace_login` | Authenticate with JWT token or username/password |
| `dspace_auth_status` | Check current authentication status |
| `dspace_logout` | End the current session |
| `dspace_search` | Search items, communities, collections |
| `dspace_get_item` | Get item by UUID with full metadata |
| `dspace_list_communities` | List top-level communities |
| `dspace_list_collections` | List collections (optionally filtered by community) |
| `dspace_create_item` | Create an archived item (admin, bypasses workflow) |
| `dspace_update_item_metadata` | Patch item metadata (JSON Patch) |
| `dspace_delete_item` | Permanently delete an item by UUID (admin) |
| `dspace_upload_bitstream` | Upload a local file as a bitstream (attachment) to an item (admin) |
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
