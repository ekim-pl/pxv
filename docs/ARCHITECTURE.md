# Architecture

The workspace separates contracts/policy, runtime/storage, Android/artifact adapters, workflow services, extension management/SDK, guides, CLI, MCP and release tooling. User interfaces call application services; services consume injected ports and shared contracts. Domain contracts cannot depend on subprocesses, SQLite or device implementations. `tools/check-boundaries.mjs` checks workspace edges and cycles.

## Core data flow

1. Resolve a versioned policy, product descriptor, project marker, inventory, engine identity and extension locks.
2. Read a live target observation and authenticated artifact metadata.
3. Freeze artifact bytes and an exact reviewed plan; bind global APK effects and manual checkpoints.
4. Persist submission and the run atomically with an idempotency key.
5. Acquire shared physical-device and transport leases, persist intent, then open the native execution gate.
6. Ingest redacted native completion receipts idempotently; retain cleanup obligations independently of worker life.
7. Remeasure before attestation/finalization, then record recipient custody separately.

## Storage and identity

A dedicated Node worker owns synchronous built-in SQLite calls. Transactions are short; event reads use bounded cursors. Unknown/malformed records are retained and block the affected workflow. Read-only access to a missing database refuses to initialize it. Atomic private files use replacement, file fsync and directory fsync.

Physical serial, transport selector, asset ID and Android user identity are distinct. Android user recovery binds userId, name and serialNo, because user IDs can be reused. The shared per-operator host control directory is independent of product/fork/project and also mounted into containers. Simultaneous ownership from several workstations is unsupported.

## Native ownership

The Rust Linux supervisor owns nonblocking kernel locks, child-subreaper adoption, pidfd-based process termination, a private IPC authorization gate and durable receipts. Command arguments/environment/stdin cross private IPC and are never persisted in command specifications. A command's durable record contains redacted ownership/effect status. Owner death, failed mutation and uncertain cleanup preserve recovery reservations; interrupted mutations are never automatically replayed.

Recovery acquires inherited fences under the same kernel locks, verifies prior process cleanup or a changed host boot, and performs typed cleanup against stable user identity. A failed cleanup retains the fence, including when it failed before starting another command. Native receipts and application recovery obligations solve different parts of the problem and neither can substitute for the other.

## Product and extension boundaries

Community ships the local workflow without runtime activation. White-label products are forks with one product descriptor, specific assets, packs, templates and documentation. Commercial repositories provide compiled extensions from an authenticated private registry. Extension bundles are trusted executable code; worker isolation is fault isolation, not a sandbox. Device-changing contributions become typed core actions and use the normal review, lease and recovery path.

Public contracts and the extension SDK use API version 1. Schema/engine changes require translated regressions and new acceptance evidence. Portable, Debian, npm and OCI outputs derive from one frozen candidate; previews have isolated identities and projects. Release tooling cannot publish through an ordinary build.
