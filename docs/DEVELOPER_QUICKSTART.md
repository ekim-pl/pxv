# Developer quickstart

## Architecture

The architecture is package based, with the workflow engine split into focused services. `WorkflowEngine` keeps the public API; its composition root wires services for preparation, review, execution, recovery, evidence and handoff. Those services use explicit ports, so device and artifact implementations can be supplied outside the engine. The [architecture guide](ARCHITECTURE.md) describes the design in more detail.

Policy is split into two stages: authored `PolicyDocument` input is validated and expanded into the `ExecutionPolicy` used by planning and execution. Plans bind reviewed actions to measured device state and verified artifact bytes. Device changes then go through ownership leases, durable checkpoints and receipts, with recovery state retained if an operation is interrupted.

Project data is separate from source code. A live project has its own marker, policy, inventory and SQLite state; the [README](../README.md) recommends keeping it outside the checkout.

## Where to extend it

| Change | Start here |
| --- | --- |
| Add policy fields or action types | [Contract types and schemas](../packages/contracts/src/types.ts), [policy validation](../packages/contracts/src/policy.ts), then the engine planner and relevant adapter |
| Add device behavior | Define or extend a port in [engine workflow types](../packages/engine/src/workflow-types.ts); implement it in [CLI port wiring](../packages/cli/src/workflow-port.ts) and the [Android adapter](../packages/adapters/src/android.ts) |
| Change workflow behavior | Find the responsible engine service, wire it in [composition](../packages/engine/src/composition.ts), and expose it through the [WorkflowEngine façade](../packages/engine/src/workflow.ts) |
| Add a CLI or MCP operation | Put CLI metadata and flag validation in the [command registry](../packages/cli/src/command-registry.ts); connect it through the [CLI backend](../packages/cli/src/backend.ts) and [MCP tool schema](../packages/mcp/src/index.ts) as needed |
| Add persistent state | Extend the [Store interface](../packages/runtime/src/store.ts) and [storage handler](../packages/runtime/src/storage-handler.ts); use atomic transitions for related records |
| Add an extension | Use the public [extension SDK](../packages/extension-sdk/src/index.ts). Extensions propose typed actions that the host validates and sends through normal review and execution; see [extension authoring](EXTENSIONS.md) |

A useful rule is to keep schemas and domain types in `contracts`, orchestration in `engine`, and subprocess/device details in `adapters` or `runtime`. The boundary checker enforces package dependency rules and detects cycles.

## Build and development

The workspace uses pnpm and TypeScript project references. The pinned versions are Node 24.22.0 and pnpm 12.11.2.

```sh
pnpm install --frozen-lockfile
pnpm build
```

The supervisor is a separate TypeScript process compiled by `pnpm build` in `@pxv/runtime`. It runs through the selected Node executable with private IPC on fd 3. Koffi 3.3.3 and its exact Linux x64 platform package provide reviewed prebuilt Node-API 8 calls for locks, subreapers and pidfds. The install script is disabled; missing or incompatible prebuilds require reinstalling the frozen dependencies on supported glibc Linux, with no compilation fallback.

The official Node 24.22.0 distribution is an explicit exception to the Rust-payload policy: it includes upstream Rust-derived TypeScript parser bytes. Tests use synchronous module hooks and esbuild 0.28.2 to transpile TypeScript and never use Node's embedded parser. Project-managed executables, addons, WASM and development dependencies must pass `node tools/check-dependencies.mjs`.

`pnpm test` builds compiled integration entrypoints, then runs each TypeScript test file in an isolated Node process. Assertions and mocks use expect/jest-mock 30.5.2, with fake-timers 15.4.0. Module mocks register before dynamic imports. `pnpm test:supervisor` includes the ported unit and receipt-persistence fault tests.
