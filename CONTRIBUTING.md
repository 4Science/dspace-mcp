# Contributing to dspace-mcp

Thanks for taking the time to contribute! This document explains how to submit
changes and, importantly, the licensing terms that apply to contributions.

## Licensing & Contributor License Agreement

dspace-mcp is distributed under the **GNU Affero General Public License v3.0
(AGPL-3.0)**. In addition, the project owner, **4Science Spa**, may offer the
software under separate commercial or alternative licenses (dual licensing).

To make that possible, every contribution must be covered by a Contributor
License Agreement (CLA) that lets 4Science re-license the contributed code:

- **Individuals** — read and agree to [CLA.md](./CLA.md).
- **Companies / organizations** — have an authorized signatory execute
  [CLA-ENTITY.md](./CLA-ENTITY.md).

You keep the copyright to your contributions; the CLA grants 4Science the rights
it needs to distribute and re-license them. You do **not** transfer ownership.

### How to agree

We use a sign-off model based on the
[Developer Certificate of Origin](https://developercertificate.org/). Add a
`Signed-off-by` line to each commit to certify the DCO and agree to the CLA:

```bash
git commit -s -m "feat: add my change"
```

This appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

Make sure the name and email match your real identity. For corporate
contributions, ensure your organization has executed the Entity CLA first.

### Relationship with DSpace and its license

dspace-mcp is an **independent** piece of software that talks to a DSpace
instance only through its public REST API, over the network. It is not a
derivative work of DSpace, it does not link against DSpace code, and it does not
embed or redistribute any part of DSpace.

Because of this separation, using dspace-mcp against a DSpace installation does
**not** affect the licensing of that DSpace instance in any way. In particular:

- The AGPL-3.0 license of dspace-mcp applies only to dspace-mcp itself (and its
  contributions), **not** to the connected DSpace instance.
- Running, deploying, or integrating dspace-mcp does **not** create any
  obligation to release the connected DSpace instance's source code — or any
  customizations, configuration, or surrounding infrastructure — under the
  AGPL-3.0 or any other license.
- DSpace keeps its own license and terms; interacting with it through its REST
  API is ordinary client/server communication and does not make the two works a
  single combined program.

In short: adopting this software has no licensing impact on the DSpace instance
it connects to.

### Contributing dspace-mcp code upstream to DSpace

The upstream DSpace project ([DSpace/DSpace](https://github.com/DSpace/DSpace))
is distributed under the **BSD-3-Clause** license, with project copyright held
by **LYRASIS**, and accepts contributions via pull request (historically under
LYRASIS/DuraSpace Contributor License Agreements).

The CLA you agree to here is designed to keep this path open. Because you grant
4Science a broad, irrevocable license **with the right to sublicense Your
Contributions under any license terms of its choosing**, 4Science can, if it
ever chooses to, contribute all or part of dspace-mcp upstream to DSpace under
the BSD-3-Clause license (or execute a LYRASIS Corporate CLA / software grant to
that effect) — **without needing to go back to individual contributors** for
additional permission.

Note that this re-licensing right rests with 4Science as the project steward; it
does **not** require you to transfer ownership of your contributions (you keep
your copyright), and it does **not** relicense dspace-mcp itself away from the
AGPL-3.0 for its public distribution.

To keep the codebase upstreamable, please follow the [Dependencies](#dependencies)
guidance below: only add dependencies under permissive licenses (MIT, Apache-2.0,
BSD, ISC) that are compatible with the DSpace BSD-3-Clause license, and never add
GPL/AGPL-licensed dependencies.

## Development workflow

1. Fork the repository and create a feature branch off the default branch.
2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
3. Make your change. Keep the existing code style (TypeScript, ESM, the
   `register*Tools` pattern in `src/tools/`).
4. Build cleanly before opening a PR:
   ```bash
   npm run build
   ```
5. Open a pull request against the default branch with a clear description of
   the change and the motivation.

## Adding a new MCP tool

New tools follow the established pattern:

- Add the DSpace REST call as a method on `DSpaceClient`
  (`src/services/dspace-client.ts`).
- Register the tool in the relevant module under `src/tools/` (e.g. `items.ts`,
  `search.ts`), using `zod` for input validation and returning the standard
  `{ content: [...] }` shape.
- Update the tool table in [README.md](./README.md).

## Dependencies

Keep runtime dependencies permissively licensed (MIT, Apache-2.0, BSD, ISC).
Avoid adding AGPL/GPL-licensed dependencies: they would prevent 4Science from
offering the project under a different license. Flag any new dependency in your
PR description.

## Reporting issues

Use the issue tracker to report bugs or request features. Include reproduction
steps, the DSpace version/endpoint involved, and any relevant logs (redact
credentials and tokens).

---

By contributing, you agree that your contributions are licensed under the
AGPL-3.0 and subject to the applicable CLA above.
