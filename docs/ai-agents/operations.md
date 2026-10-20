# Supported MCP operations

Discover the live tool schemas after connecting. This catalogue follows
[`packages/mcp/src/index.ts`](../../packages/mcp/src/index.ts) and the
[CLI backend](../../packages/cli/src/backend.ts). Default-mode tools are registered
without `--allow-mutations`; all other tools below require that switch.

Each device operation selects one exact `assetId`; MCP has no group/whole-fleet
tool. Nonempty ID strings are required. The tool wrapper returns a text content
block containing JSON on success. Check `isError` before parsing: errors use
`isError: true` and may contain unstructured text. Inventory/path/serial projections
are redacted; registry values are never returned.

## Default-mode inspection and preparation

| Tool | Required inputs; optional inputs | Result and prerequisites |
| --- | --- | --- |
| `inspect_host` | `{}` | Host prerequisites/runtime/tool diagnosis; does not start ADB or a phone workflow. |
| `list_devices` | `{}` | Enrolled inventory projection. This does not establish current live connectivity. |
| `inspect_device` | `assetId` | Live observation of exactly one enrolled asset; needs the authorized configured transport. |
| `prepare_operation` | `assetId`, `operation` | Returns `planId`, exact `reviewSummary`, `expiresAt`, and capabilities when supplied. Prepares/persists work without executing device changes. |
| `get_run` | `runId`; `after` | `{ run, events }`; `run` contains review status and pause/next steps when found. Events are bounded to 100 per call. `after` is a nonnegative integer, default 0. |
| `list_runs` | none; `cursor`, `limit` | `{ items, nextCursor }`; continue until null. Default limit 100, range 1–1000; cursor is opaque, nonempty, up to 1024 characters, without NUL. |

`prepare_operation.operation` is one of `create-users`, `deploy-apps`, `provision`,
or `install-os`. MCP uses `deploy-apps` while the CLI command is `device deploy`.
OS installation is a separate destructive phase requiring the approved physical
target, authenticated image pin, and attended bootloader confirmations.

`execute_plan` returns described run metadata whose identifier is `id`; use that
value as `runId` in later calls. `get_run` events contain `{ sequence, event }`;
pass the last received `sequence` as the next `after`. An unknown run can have no
`run` member after JSON serialization; do not treat that as completed work. Run-list
continuation tokens and event sequence numbers are different cursor types.

## Mutation-mode execution and lifecycle

| Tool | Required inputs; optional inputs | Result and human prerequisites |
| --- | --- | --- |
| `execute_plan` | `planId`, `reviewSummary`, `operator` | Submits the exact approved review and launches/returns durable run metadata. Preserve the prepared string byte-for-byte after JSON decoding; no added newline. |
| `cancel_run` | `runId` | Cancellation-request acknowledgement, not rollback or cleanup proof. Inspect the run afterward. |
| `refresh_review` | `runId` | New prepared plan/review for unfinished intentional manual-checkpoint work; requires renewed human review and `execute_plan`. |
| `attest_device` | `assetId`, `check`, `operator`; `note`, `evidence` | Records a check against fresh measured state. The operator must actually perform the check; notes contain no secrets. |
| `finalize_device` | `assetId`, `operator`, `locale` | Rechecks readiness and requests debugging shutdown; locale must be `en` or `pl`. All required measured/witnessed checks must already be complete. |
| `confirm_custody` | `assetId`, `recipient`, `debuggingOff: true` | Records recipient custody only after actual handover and physical verification that debugging is off. |
| `recover_device` | `assetId`, `runId`, `inspected: true` | Performs typed recovery after inspection against the original operation/asset; never replays an interrupted mutation. |
| `record_lifecycle` | `assetId`, `type`, `operator`, `note`; `confirmedErasure` | Records maintenance, policy change, loss, or retirement and invalidates old handoff evidence. Erasure confirmation must reflect a real completed check. |

For lifecycle, `type` is `maintenance`, `policy-change`, `loss`, or `retirement`.
`confirmedErasure` defaults to false. Lifecycle/attestation operator strings have
a 200-character maximum; notes have a 1000-character maximum, with a nonempty note
required for lifecycle. `recipient` is nonempty and at most 200 characters.

Attestation’s optional strict `evidence` object contains `path`, lowercase 64-hex
`sha256`, `fingerprint`, and `source`; all are required when the object is supplied.
Use it only for the actual evidence type required by the check, such as emulator
provenance. Passing a file is not a substitute for physical acceptance.

See [workflow and recovery](workflow-and-recovery.md) for review expiry, manual
pauses, measured-state freshness, final signoff order, and continuation through CLI.

## Extension operations

Read operations work with verified local bundles; invocation does not fetch updates.
Community disables extension install/update, policy selection, command, and adapter
execution. Explicit removal remains permitted with mutation mode. Runtime feature
gates can reject a registered tool even when it appears in discovery.

| Tool | Mode / feature | Inputs and result |
| --- | --- | --- |
| `extension_list` | Default | `{}`; lists locally installed extension metadata. |
| `extension_inspect` | Default | `id`; verifies and inspects the project-pinned bundle. |
| `extension_guide` | Default | `id`, `contribution`; returns declared contained guide text as a JSON string. |
| `extension_install` | Mutation + extensions enabled + native host | `source`, `reviewed: true`; optional `registry`; installs verified bytes and updates project extension references. |
| `extension_update` | Mutation + extensions enabled + native host | `id`, `source`, `reviewed: true`; optional `registry`; explicitly updates an installed exact version. |
| `extension_remove` | Mutation; permitted in Community | `id`, `reviewed: true`; removes the project reference, retaining shared immutable installed bytes. |
| `extension_policy` | Mutation + extensions enabled | `id`, `contribution`, `reviewed: true`; selects a declared policy and invalidates prior approvals. |
| `extension_command` | Mutation + extensions enabled | `assetId`, `id`, `contribution`; optional `input` (default `{}`); invokes the declared command name and returns a prepared review. |
| `extension_adapter` | Mutation + extensions enabled | `assetId`, `id`, `contribution`; optional `input` (default `{}`); invokes the declared adapter path and returns a prepared review. |

For MCP `extension_command`, the field is **`contribution`**, containing the command
name; the CLI instead uses `--command`. Guide, policy, and adapter contributions
use declared bundle paths. Contributed actions still need separate exact-reviewed
`execute_plan`; install/update/selection also require the renewed CLI policy lock.

`source` is exactly one of these object shapes:

```json
{"tarball":"/absolute/private/extension.tgz","integrity":"OPTIONAL_REVIEWED_INTEGRITY"}
```

```json
{"package":"example-extension","version":"EXACT_VERSION"}
```

Omit `integrity` unless supplying a real reviewed value. `registry`, when supplied,
is an HTTPS URL. Registry authentication uses external `PXV_REGISTRY_TOKEN`, never
tool arguments, policy, or image contents. Native host requirements apply to MCP
inside raw containers as well as Docker-wrapped CLI. See the
[extension reference](../developers/extension-reference.md) for bundle validation,
trust, resource limits, offline behavior, and update rules.

## Guide resources

| URI | Content |
| --- | --- |
| `pxv://guides/operator` | Installed English operator Markdown. |
| `pxv://guides/recipient` | Installed English user Markdown. |

Both are available in default and mutation modes with MIME type `text/markdown`.
They are general resources, not per-device accepted reports, private registry
records, or configurable-locale endpoints. Use the CLI for Polish/project guides.

## Operations supplied through CLI

There is no MCP tool for manual-step resume, project initialization, inventory
enrollment/import, policy validation/locking, ADB start, registry retention/private
collection, handoff export, guide rebuilding, or per-device insert/label printing.
Use [CLI automation](cli-automation.md) and the operator path against the same
project/resources. Optional Seedvault commands are also separate CLI workflows.
