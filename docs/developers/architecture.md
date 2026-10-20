# Architecture and extension points

Start with [building pxv](build.md) or [creating an extension](creating-extensions.md). This reference explains the boundaries a core change or integration must preserve.

The workspace separates contracts/policy, runtime/storage, Android/artifact adapters, workflow services, extension management/SDK, guides, CLI, MCP and release tooling. User interfaces call application services; services consume injected ports and shared contracts. Domain contracts cannot depend on subprocesses, SQLite or device implementations. `tools/check-boundaries.mjs` checks workspace edges and cycles.

`WorkflowEngine` preserves the public constructor and method façade. Its composition root creates separate observation, plan repository, preparation, review, execution, evidence/readiness, attestation, handoff and recovery services. Those services consume explicit interfaces for observations, plans, evidence, ownership and the run journal; none receives the façade or its bound private methods. Shared ownership services enforce lock ordering and freshness, while the journal owns atomic run checkpoints and native receipt reconciliation.

The façade's retained public port, plan, run/state and emulator-evidence type exports are marked `@public`. They remain supported application API even when Community does not itself consume every export. The public contracts and extension SDK entry points remain available to external authors.

## Core data flow

The engine expands the authored policy's shared app catalog, owner-scoped device
settings and per-codename OS pins into an execution model consumed by the action
contracts. See [policy format](../operators/policy-reference.md).

`PolicyDocument` names authored input, while `ExecutionPolicy` names the expanded
engine model. `validatePolicyDocument` validates authored input, `validatePolicy`
expands it, `validateExecutionPolicy` validates engine data, and `toPolicyDocument`
serializes engine data back to authored input. Policies carry no version fields;
resolved locks bind their normalized content by digest.

Project-local `state/artifacts` stores verified content by digest. Per-plan immutable
paths retain shared bytes and repository evidence. Concurrent publication is atomic;
same-process acquisition coalesces requests sharing the same cancellation signal.
Independent cancellation contexts and separate processes can transiently download
the same identity before deduplicating publication. Cache corruption refuses
reuse, and no automatic garbage collection removes historical references. Execution
still makes and authenticates private staging copies. APK observations deduplicate
only within one measurement; user membership and permission checks remain separate.

1. Resolve a validated policy, product descriptor, project marker, inventory, engine identity and extension locks.
2. Read a live target observation and authenticated artifact metadata.
3. Freeze artifact bytes and an exact reviewed plan; bind global APK effects and manual checkpoints.
4. Acquire project ownership, check source/build freshness, and persist submission and the run atomically with an idempotency key.
5. Acquire shared physical-device and transport leases, persist intent, then open the native execution gate.
6. Ingest redacted native completion receipts idempotently; retain cleanup obligations independently of worker life.
7. Remeasure before attestation/finalization, then record recipient custody separately.

## Storage and identity

A dedicated Node worker owns synchronous built-in SQLite calls behind the injected `Store` interface. Expected-state transitions commit related records and audit events in one short transaction. Run/manual checkpoints, attestations, handoff/custody and lifecycle archival cannot leave a successful record with a missing companion write. A changed expected generation rejects the transition. Unknown/malformed records remain available for inspection. Event reads use bounded cursors; read-only access refuses to initialize a missing database. Atomic private files use replacement, file fsync and directory fsync.

Shared engine queries provide run status, pause reasons and history to CLI and MCP.
Run history uses bounded keyset pages with opaque continuation cursors rather than
a silently capped collection read. Superseded-plan replacements are resolved in
one history traversal per requested page. Latest-run queries enrich only the
selected record. Event cursors remain separate sequence numbers.
The CLI command registry owns usage, supported flags, required arguments and
feature gates, and validates requests before project state is opened. Presentation
converts structured results to readable summaries or explicit `--json` output.

Application composition owns storage lifetime; services borrow it. Failed application construction closes the opened worker, and each MCP request closes its own context. Storage startup has a bounded readiness wait, rejects premature exits including exit 0, and retries only idempotent database initialization on lock contention. Worker loss rejects pending requests; reopening does not replay them. Closing storage awaits worker exit, and a failed database close still closes the worker message port so shutdown can settle with the original error.

Readiness and review refresh share an asynchronous VPN proof verifier injected
with the plan reader and store. It validates source action/run completion, consumed
receipts, paginated attestation audit snapshots and committed refresh ancestry.
Plan/run/audit caches last for one verification operation. Retained source plans
allow expired approval while keeping integrity, policy, target and lifecycle checks.
The contracts layer supplies per-profile VPN witness requirements to readiness and
English/Polish guide generation. Generic setting actions cannot write the reserved
VPN secure keys; observation parsing remains separate from authoring validation.

Docker workers use an attached streaming runner with an explicit container identity
and independently bounded control operations. Ownership labels isolate worker
cleanup from ADB sidecars. Failed or uncertain cleanup retains native reservations
and evidence; see [Docker shutdown behavior](../operators/host-setup.md#command-and-container-lifetime).

Project ownership serializes cooperating configuration writes and operations. Submission, execution, review refresh, attestation, finalization, custody and lifecycle changes recheck the loaded configuration, policy and inventory byte revisions plus executable identity after acquiring it. Stale contexts require reload and review. Configuration/lock writes also compare their expected source revisions. Project ownership precedes physical-device ownership.

The shared policy-lock verifier authenticates the retained resolved snapshot and
compares its digest with current normalized policy/configuration, product,
extensions and executable identity. Preparation checks it before observation and
again with source freshness before storing a plan. Reviewed transitions recheck it
under project ownership. Loading a project does not require approval, preserving
inspection, policy editing/locking, cancellation, typed recovery, lifecycle,
registry/export and custody operations. Lock renewal is explicit, including after
an executable upgrade; it never approves a device plan.

Readiness and finalization share the same bounded measurement-age predicate.
Reports add `measurement-freshness` and `policy-lock` blockers while continuing to
identify their evidence as stored. Custody commits its matching workflow run's
completion, workflow state, handoff and both audit events in one expected-state
transition. Query-scoped compatibility projection also recognizes exact completed
custody from current or lifecycle-archived records, verifying the handoff snapshot,
plan, observation and run identity. It does not rewrite historical records or
promote ambiguous evidence. Archive traversal is paginated and lookups are shared
within a query. Completed custody remains historical evidence after policy changes
or measurement expiry and supplies no acceptance/resume instructions.


Physical serial, transport selector, asset ID and Android user identity are distinct. Android user recovery binds userId, name and serialNo, because user IDs can be reused. The shared per-operator host control directory is independent of product/fork/project and also mounted into containers. Simultaneous ownership from several workstations is unsupported.

## Provisioned-phone registry

The [local registry](../operators/registry.md) joins inventory by asset ID, canonical
hardware serial and codename with a separate encrypted JSON database at
`secrets/phone-registry.pxv`. Device fields hold duress credentials/phone number;
profile fields hold normal credentials, the Oblivion notification wipe key,
Session messenger ID, Proton VPN credentials and phone number. Android user IDs and
serials remain distinct from service-account identifiers. Several profiles may use
the same service account.

The runtime uses authenticated AES-256-GCM, a fixed bounded scrypt configuration,
fresh salts/nonces and project-bound authenticated headers. It writes ciphertext
atomically with file/directory synchronization. Command-scoped unlock has no
persistent unlocked cache. Metadata-only CLI views use explicit projections;
private values/history never enter ordinary SQLite rows, reviews, audit events,
MCP responses or handoff exports. Explicit reveal writes a new private plaintext
file.

The optional Oblivion, Session and SIM collectors share a host-only CLI contract,
value-free outcomes and atomic private field merging. App collectors verify enrolled
profile identities, app signers and foreground recovery; SIM numbers are stored once
at device level in the existing multiline phone-number field. Missing/unsupported
values permit hidden private entry or skipping. Both private insert entry points
share read-only registry loading, effective binding checks and PDF rendering. Guide
publishing receives public policy options; the separate private export receives
registry values only within the parent process.

Native project ownership serializes registry writes with provisioning. Ciphertext
revision checks and a final identity/generation guard reject stale updates. A public
SQLite anchor transitions to pending before ciphertext publication and ready after
durable publication; pending or mismatched copies fail closed. Explicit restore
reconciliation preserves encrypted history and appends stale snapshots.

Fields distinguish initial, current, unknown and stale values. Current means an
explicit last-confirmed operator claim, not a live phone measurement. Flash,
profile creation and credential-default attempts rotate affected public generation
tokens before mutation; lifecycle records also invalidate device bindings. Stable
user identities from sufficiently fresh workflow observations reject known profile
mismatches. Profile-specific observation floors preserve unrelated profile evidence.
Private changes on the phone still require a private operator update.

History is append-only within bounded storage; historical retrieval never promotes
values to current. Registry data does not supply initialization defaults, configure
accounts, send notifications or activate erasure. The Oblivion trigger remains a
user-described integration requiring exact-app qualification before automation.
The operator retains the passphrase and encrypted backups; there is no escrow or
reset service.

## Native ownership

The TypeScript Linux supervisor owns nonblocking kernel locks, child-subreaper adoption, pidfd-based process termination, a private IPC authorization gate and durable receipts. Command arguments/environment/stdin cross private IPC and are never persisted in command specifications. A command's durable record contains redacted ownership/effect status. Owner death, failed mutation and uncertain cleanup preserve recovery reservations; interrupted mutations are never automatically replayed.

Recovery acquires inherited fences under the same kernel locks, verifies prior process cleanup or a changed host boot, and performs typed cleanup against stable user identity. A failed cleanup retains the fence, including when it failed before starting another command. Native receipts and application recovery obligations solve different parts of the problem and neither can substitute for the other.

Adapters receive an owner-bound obligation capability. A child can record and resolve only its own resources within the root operation; it cannot release a parent or sibling resource. Explicit recovery can retry pending or blocked obligations after checking identity. Missing users, unmatched recovery lineage and resources left pending prevent a recovery-success claim.

Native completion events retain their first-observation timestamp, including timestamps from previously ingested history. Reconciliation across restarts or later recovery does not create another event or change that timestamp. The complete receipt payload remains bound to its identity; changed bytes are rejected. This timestamp records observation, not a measured command-completion wall time.

## Product and extension boundaries

Community ships the local workflow without runtime activation. Its descriptor
explicitly disables extensions and experimental Seedvault recovery. Descriptors
without the optional `features` object preserve legacy behavior. A separately reviewed
product can explicitly enable either optional feature. Unsupported extension-dependent projects refuse execution,
while historical reporting, cancellation and inspected recovery retain their records.
Changing product features requires a new reviewed identity.

Experimental Seedvault orchestration lives under `experimental/seedvault` and is
composed on demand. Ordinary submissions inspect the retained plan kind without
constructing recovery services. Backup reports remain independent of provisioning
acceptance. Trusted extensions and authoring APIs are compatibility components;
device-changing contributions still use typed actions, review, leases and recovery.
Extension worker isolation is fault isolation, not a sandbox.

Brand scaffolding and guide publishing are [optional source tooling](../../tools/optional/README.md),
with compatibility entry points. They do not run during device provisioning.

Public action contracts and the extension SDK use API version 1. Schema/engine
changes require translated regressions and new acceptance evidence. Portable is the
default output; optional formats derive from the same frozen candidate. Previews
have isolated identities and projects. Release tooling cannot publish through an
ordinary build.

Release candidates and release provenance use schema 2. They record Node, supervisor JavaScript, Koffi version/platform/Node-API version, loader/addon hashes and artifact hashes. Schema 1 candidates must be regenerated. Portable, Debian, npm, OCI and experimental SEA formats include the supervisor bundle, Koffi loader and selected glibc x64 prebuild with reviewed notices. Existing ownership records, IPC protocol and receipts remain schema/protocol 1; policies are unversioned. Never clear host control state to regenerate a candidate. Engine integrity binds source/build bytes and the selected supervisor, addon and loader.

Build tooling that imports a workspace `dist/*.js` entrypoint is checked against
its corresponding `src/*.ts` exports by the repository graph. This keeps compiled
integration entrypoints explicit without hiding unused source exports. Public SDK
entries and documented test-only exports remain separately configured.

## Finding the right extension point

| Change | Entry point |
| --- | --- |
| Policy or action contract | `packages/contracts/src/types.ts` and policy validators |
| Workflow orchestration | Engine services and `packages/engine/src/composition.ts` |
| Android execution | Injected engine ports and Android adapters |
| CLI or MCP operation | CLI command registry, backend, and MCP registration |
| Persistence | Runtime Store and atomic storage transitions |
| External contribution | Public extension SDK and contracts |

Keep subprocess and storage implementation details out of contracts. Expose new behavior through application services so CLI and MCP retain the same review and recovery rules.
