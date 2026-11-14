# Security and privacy

pxv is a local provisioning toolkit. It trusts the operator's operating system,
selected toolchain, product fork and explicitly installed extension code. It cannot
protect its files from a malicious local account or replace physical custody.
Concurrent control of a phone from multiple workstations is unsupported.

## Device changes and recovery

Enrolled physical identity, stable Android user serials, authenticated artifacts,
exact reviews, kernel-owned leases, durable obligations and fresh observations form
the core boundary. APKs bind package/version/content/signer; OS images bind their
reviewed OpenSSH signing identity. HTTPS alone is not a publisher identity.
Repository inputs also require authenticated, fresh index evidence and rollback
checks.

Managed installed APKs are verified from one pulled standalone APK: SHA-256,
package, version and signer describe the same stable bytes. Split installations
require explicit maintenance; PXV never uninstalls them automatically. Content
differences require reviewed reinstalls even at the same version, including effects
on other Android users. Older retained handoffs can authenticate original custody;
missing historical hashes do not establish newly verified content.

Mutating subprocess inputs cross private IPC; command specifications do not persist
secret argv/environment/stdin. Cancellation or process loss does not prove reversal
or cleanup. Native reservations and application obligations remain until inspected,
owner-scoped recovery proves the relevant cleanup. A recreated user is a different
identity even when its numeric ID/name match. A child cannot release parent or
sibling obligations. Never delete evidence or change control roots to bypass a fence.

Use the same per-operator control directory across native installations, previews,
forks and containers. Project ownership rechecks source revisions and executable
identity before state changes. Expected-state SQLite transitions commit related
records and audit events together; mismatches preserve newer evidence. Manual
receipts cannot override contradictory measurements.

ADB authorization and USB access remain operator responsibilities. Debugging is
provisioning access: physically verify both debugging toggles are off and helpers
are removed before separate recipient custody confirmation. Lifecycle changes
invalidate prior readiness; a retirement record does not erase a phone.

An incomplete debugging-shutdown intent blocks new device-changing work even after
policy or executable changes. Inspection, typed recovery, disconnect and offline
records remain available. Explicit maintenance archives the intent and invalidates
old plans before new provisioning. Backup-only automation, including dry runs,
requires an authentic current policy lock before connecting or pairing; renewal
requires operator validation and explicit approval, including after upgrades.

Recipe/probe acceptance requires complete results, exact retained execution lineage
and observation checkpoints; assisted recipe completion also needs its consumed
audit-backed witness receipt. Malformed evidence blocks current readiness without
rewriting history. Original-baseline historical custody remains available. Every
new Seedvault connection rechecks approval under ownership after prompts; disconnect
and inspected cleanup remain accessible. Worker error handling cannot replace a
competing run or remove another launch attempt's claim.

## Private information

Keep projects, backups, helper signing keys, private inputs and raw device evidence
outside source/release assets. Do not put real credentials, account IDs, recovery
words, wipe keys, MFA seeds, private signing keys, inventories or signed-in screenshots
in public issues, notes or attestation text. Candidate allowlists and secret-sentinel
checks supplement careful review; they do not replace it.

Final credentials, accounts, MFA and recovery material normally use private phone
entry. Optional initialization defaults are a separate explicit input mechanism:
policies hold references; `secrets/credentials/<assetId>.json` holds values in a
current-user-owned regular `0600` file with no symlink file/secret directories.
Reviews contain references and action types, without values, hashes or secret
snapshots. Values are read only during execution and can change privately before
resume. Defaults remain initial-only and require recipient verification/replacement.

Authorized support retention uses the separate [encrypted phone registry](docs/operators/registry.md).
Its current states describe the last operator confirmation. Values and
history stay encrypted at rest; ordinary outputs project only presence/state
metadata, and explicit retrieval writes a new private file. Secrets never enter
normal SQLite records, plans, audit events, MCP outputs or handoff artifacts.
Provisioning invalidates affected registry bindings before credential-changing
attempts; private on-phone changes still require an operator update. Retain encrypted
backups and unlock material separately. The trusted local OS and JavaScript memory
remain outside guaranteed erasure.

The optional `device collect-oblivion`, `device collect-sessionid` and
`device collect-simcards` commands share project/device ownership, interactive
retention confirmation even with `--yes`, and atomic encrypted registry merging.
App collection checks trusted signing identities and enrolled profile identities;
SIM collection stores numbers once at device level. Unreadable values permit hidden
manual entry or skipping. No screenshots, raw UI hierarchies or plaintext collection
files are retained. Foreground recovery obligations survive interrupted app
collection, including existing Oblivion obligations. Values remain last-confirmed
operator claims; collection never sends keys or establishes erasure capability.
Both private insert entry points use the same protected registry export. Guide
publishing receives no registry values or passphrase; its shared artifacts remain
blank and the populated PDF must use a separate private destination.

Private staged configuration is declared and digest-bound to its recipe. Without an
accepted file-picker capability, the workflow requests complete manual import before
launch/staging, so recipients are not directed to files already removed by cleanup.
Keep ordinary lock setup, language and optional duress in the reviewed order. Never
activate destructive duress or send a real Oblivion wipe key to test setup.

## Optional code and qualification

Extensions execute trusted code. Worker/archive/input/IPC bounds contain accidental
faults; they are not a security sandbox. Install only exact approved bundles and keep
registry authentication external. Optional Seedvault automation needs exact-build
qualification and demonstrated restore scope. Neither feature is enabled by default
in pxv.

Offline tests, a successful command and copied backup bytes do not establish
production acceptance. Retain exact-build GrapheneOS provenance, authorized physical
and localized workflow evidence, representative network/failure checks and witnessed
restores for advertised capabilities. See [verification](docs/operators/acceptance.md) and
[recovery](docs/operators/recovery-and-maintenance.md).

## Report a vulnerability

Use the repository host's private reporting mechanism when available. Include the
affected version, a minimal disposable fixture, impact and redacted evidence.
Never attach real recipient secrets or private fleet inventories to a public issue.
Fork maintainers must replace example support identities before distribution.

## Supervisor and native dependencies

The ownership gateway is a separate TypeScript process launched with the selected Node executable, a minimal environment and private IPC on fd 3. Its private Linux interface uses the reviewed Koffi 3.3.3 glibc x64 Node-API 8 prebuild for kernel locks, subreaper setup, pidfds, descriptor flags and nonblocking adopted-child reaping. It validates kernel capabilities before acquiring ownership. Node/libuv retains responsibility for directly spawned children; command processes do not inherit IPC or lock descriptors.

Koffi executes with the supervisor's operating-system privileges. It is not a sandbox. The frozen dependency policy disables its installer, and distributions omit installer scripts and unused platform addons. Missing or incompatible prebuilds fail closed with reinstall instructions. Engine integrity includes the selected supervisor JavaScript, addon and loader bytes, so changing them invalidates reviewed execution.

IPC protocol 1 and ownership/receipt schema 1 remain compatible with Rust-produced records. Recovery verifies locks, process identity, host boot identity and cleanup evidence, and retains reservations whenever completion or cleanup is uncertain. Candidate and release-provenance schema 2 require regeneration of old candidates; policies remain unversioned. Never clear host control state to rebuild a distribution.

The official Node 24.22.0 binary is the explicit upstream Rust exception. Its embedded Rust-derived TypeScript parser remains part of that official distribution; tests transpile through esbuild and synchronous module hooks. Project-managed Rust payloads, including transitive development executables, addons and WASM, are rejected by dependency and artifact checks.
