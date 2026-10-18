# Verification and qualification

Verification belongs to an exact source/candidate, policy, artifact set and test
environment. This page defines what evidence means. It does not certify the current
checkout, a starter policy, an application or a phone.

## Separate evidence layers

| Layer | Evidence | What it establishes |
| --- | --- | --- |
| Policy | Validated input, resolved lock, exact OS/app pins and reviewed actions | The declared configuration is structurally accepted and bound to a review. |
| Offline implementation | Fresh source-bound quality report, real cryptographic checks, process faults and synthetic fixtures | The tested code passed those checks for that source identity. |
| Distribution | Exact artifact hashes/signatures and actual extracted/installed/container execution | The tested package and runtime work in the recorded environment. |
| Live deployment | Exact-build device observations, scoped network/restore tests and witnessed recipient checks | Only the tested physical/emulator capabilities and data scope passed. |

A pass in one layer does not imply a pass in another. A stock Android emulator
cannot establish GrapheneOS provenance. A GrapheneOS emulator remains emulator
evidence. A helper's scoped HTTPS probe does not establish every app's routing;
copy integrity does not establish backup restorability.

## Current work

Use the latest complete `.quality/report.json` and `.quality/report.md` whose source
identity matches the checkout. Run [the strict quality workflow](TESTING.md) again
after edits; do not copy earlier test counts or coverage totals into a new claim.
Source-bound reports retain the actual tools, component results, coverage and
function metrics. Distribution verification belongs in the separate
`.quality/packaged-runtime.json` record so evidence does not become an input to its own
candidate digest.

Physical-device and exact-build GrapheneOS emulator acceptance require a recorded
canary for the tested configuration. The registry's synthetic encryption and CLI
tests establish local storage behavior; credential validity requires checks on the
phone. Deployment claims need matching live evidence.

Before qualifying a deployment, retain the candidate/product/policy identities,
artifact hashes, OS fingerprint, app versions/signers, host/transport, stable Android
user identities and a result for every promised capability. Include reboot
persistence, isolation, required settings/permissions, actual-app network and
failure behavior, supported restore scope, localized manual steps, helper cleanup,
debugging shutdown and separate recipient custody where applicable. Keep missing
items pending. Use the [canary and recovery runbook](CANARY_BACKUP_RECOVERY.md).

Follow the [publication checklist](PUBLICATION_CHECKLIST.md) before promoting any
artifact. Ordinary builds do not publish or establish live acceptance.


Release candidates and release provenance use schema 2. They record Node, supervisor JavaScript, Koffi version/platform/Node-API version, loader/addon hashes and artifact hashes. Schema 1 candidates must be regenerated. Portable, Debian, npm, OCI and experimental SEA formats include the supervisor bundle, Koffi loader and selected glibc x64 prebuild with reviewed notices. Existing ownership records, IPC protocol and receipts remain schema/protocol 1; policies are unversioned. Never clear host control state to regenerate a candidate. Engine integrity binds source/build bytes and the selected supervisor, addon and loader.
