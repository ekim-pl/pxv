# Architecture

The workspace separates contracts/policy, runtime/storage, Android/artifact adapters, workflow services, extension management/SDK, guides, CLI, MCP and release tooling. User interfaces call application services; services consume injected ports and shared contracts. Domain contracts cannot depend on subprocesses, SQLite or device implementations. `tools/check-boundaries.mjs` checks workspace edges and cycles.

`WorkflowEngine` preserves the public constructor and method façade. Its composition root creates separate observation, plan repository, preparation, review, execution, evidence/readiness, attestation, handoff and recovery services. Those services consume explicit interfaces for observations, plans, evidence, ownership and the run journal; none receives the façade or its bound private methods. Shared ownership services enforce lock ordering and freshness, while the journal owns atomic run checkpoints and native receipt reconciliation.

The façade's retained public port, plan, run/state and emulator-evidence type exports are marked `@public`. They remain supported application API even when Community does not itself consume every export. The public contracts and extension SDK entry points remain available to external authors.

## Core data flow

1. Resolve a versioned policy, product descriptor, project marker, inventory, engine identity and extension locks.
2. Read a live target observation and authenticated artifact metadata.
3. Freeze artifact bytes and an exact reviewed plan; bind global APK effects and manual checkpoints.
4. Acquire project ownership, check source/build freshness, and persist submission and the run atomically with an idempotency key.
5. Acquire shared physical-device and transport leases, persist intent, then open the native execution gate.
6. Ingest redacted native completion receipts idempotently; retain cleanup obligations independently of worker life.
7. Remeasure before attestation/finalization, then record recipient custody separately.

## Storage and identity

A dedicated Node worker owns synchronous built-in SQLite calls behind the injected `Store` interface. Expected-state transitions commit related records and audit events in one short transaction. Run/manual checkpoints, attestations, handoff/custody and lifecycle archival cannot leave a successful record with a missing companion write. A changed expected generation rejects the transition. Unknown/malformed records remain available for inspection. Event reads use bounded cursors; read-only access refuses to initialize a missing database. Atomic private files use replacement, file fsync and directory fsync.

Application composition owns storage lifetime; services borrow it. Failed application construction closes the opened worker, and each MCP request closes its own context. Storage startup has a bounded readiness wait, rejects premature exits including exit 0, and retries only idempotent database initialization on lock contention. Worker loss rejects pending requests; reopening does not replay them.

Project ownership serializes cooperating configuration writes and operations. Submission, execution, review refresh, attestation, finalization, custody and lifecycle changes recheck the loaded configuration, policy and inventory byte revisions plus executable identity after acquiring it. Stale contexts require reload and review. Configuration/lock writes also compare their expected source revisions. Project ownership precedes physical-device ownership.

Physical serial, transport selector, asset ID and Android user identity are distinct. Android user recovery binds userId, name and serialNo, because user IDs can be reused. The shared per-operator host control directory is independent of product/fork/project and also mounted into containers. Simultaneous ownership from several workstations is unsupported.

## Native ownership

The Rust Linux supervisor owns nonblocking kernel locks, child-subreaper adoption, pidfd-based process termination, a private IPC authorization gate and durable receipts. Command arguments/environment/stdin cross private IPC and are never persisted in command specifications. A command's durable record contains redacted ownership/effect status. Owner death, failed mutation and uncertain cleanup preserve recovery reservations; interrupted mutations are never automatically replayed.

Recovery acquires inherited fences under the same kernel locks, verifies prior process cleanup or a changed host boot, and performs typed cleanup against stable user identity. A failed cleanup retains the fence, including when it failed before starting another command. Native receipts and application recovery obligations solve different parts of the problem and neither can substitute for the other.

Adapters receive an owner-bound obligation capability. A child can record and resolve only its own resources within the root operation; it cannot release a parent or sibling resource. Explicit recovery can retry pending or blocked obligations after checking identity. Missing users, unmatched recovery lineage and resources left pending prevent a recovery-success claim.

Native completion events retain their first-observation timestamp, including timestamps from previously ingested history. Reconciliation across restarts or later recovery does not create another event or change that timestamp. The complete receipt payload remains bound to its identity; changed bytes are rejected. This timestamp records observation, not a measured command-completion wall time.

## Product and extension boundaries

Community ships the local workflow without runtime activation. White-label products are forks with one product descriptor, specific assets, packs, templates and documentation. Commercial repositories provide compiled extensions from an authenticated private registry. Extension bundles are trusted executable code; worker isolation is fault isolation, not a sandbox. Device-changing contributions become typed core actions and use the normal review, lease and recovery path.

Public contracts and the extension SDK use API version 1. Schema/engine changes require translated regressions and new acceptance evidence. Portable, Debian, npm and OCI outputs derive from one frozen candidate; previews have isolated identities and projects. Release tooling cannot publish through an ordinary build.
