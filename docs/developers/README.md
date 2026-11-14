# Developer documentation

Start with either [building pxv](build.md) or [creating an extension](creating-extensions.md).
Core contributors need Linux x86_64, the exact Node/pnpm pins, and the repository’s
frozen dependencies. External extension authors use the packaged public SDK and
contracts, then bundle their authoring dependencies into a standalone installation.

## Read by task

| Task | Documentation |
| --- | --- |
| Compile and run locally | [Build process](build.md) |
| Build a first extension outside the workspace | [Extension tutorial](creating-extensions.md) |
| Check SDK, metadata, limits, or trust boundaries | [Extension reference](extension-reference.md) |
| Change core workflow/storage/device behavior | [Architecture and extension points](architecture.md) |
| Validate a change and retain evidence | [Testing](testing.md) |
| Produce portable/OCI packages or a branded product | [Distribution](distribution.md) |
| Connect an AI client | [MCP integration](../ai-agents/README.md) |

## Package map

| Package | Responsibility |
| --- | --- |
| `contracts` | Public policy, action, identity, validation, and API contracts |
| `engine` | Preparation, review, execution, evidence, handoff, and recovery services |
| `runtime` | Storage worker, private files, command supervision, leases, and receipts |
| `adapters` | Android/tool/artifact implementations behind injected ports |
| `extensions` / `extension-sdk` | Verified bundle management / public authoring API |
| `cli` / `mcp` | Interfaces to the same application behavior |
| `guides` / `release` | Handoff/print rendering and frozen distribution candidates |

Keep live projects, signing keys, credentials, customer records, and populated
inserts outside the checkout. Source checks and physical acceptance are distinct;
see [evidence boundaries](../operators/acceptance.md#evidence-and-qualification).
pxv disables extension installation/invocation; the tutorial explains the
explicit product opt-in needed for extension development.
