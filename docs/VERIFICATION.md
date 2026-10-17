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
`.quality/distribution.json` record so evidence does not become an input to its own
candidate digest.

The current documentation/registry/workflow changes have no new physical-device
canary or exact-build GrapheneOS emulator acceptance record. No physical device was
available for this documentation review. The registry's synthetic encryption and
CLI tests establish local storage behavior, not that retained credentials still
match a phone. New deployment claims need fresh live evidence.

Before qualifying a deployment, retain the candidate/product/policy identities,
artifact hashes, OS fingerprint, app versions/signers, host/transport, stable Android
user identities and a result for every promised capability. Include reboot
persistence, isolation, required settings/permissions, actual-app network and
failure behavior, supported restore scope, localized manual steps, helper cleanup,
debugging shutdown and separate recipient custody where applicable. Keep missing
items pending. Use the [canary and recovery runbook](CANARY_BACKUP_RECOVERY.md).

## Historical evidence

These sanitized records are preserved unchanged for their named October 2026
candidates:

- [Initial 0.1.0 verification record](verification-0.1.0.json).
- [Final 0.1.0 fixture verification record](verification-0.1.0-final.json).

They contain candidate-bound offline, distribution and physical Pixel fixture
results, along with their limitations. Later source, policy, tooling or documentation
changes do not inherit that acceptance. Historical fixture custody does not qualify
an untested production app/VPN policy, restore method or extension. Preserve private
raw evidence separately; publish no hardware serial, account identifier, credential,
recovery value or wipe key.

Follow the [publication checklist](PUBLICATION_CHECKLIST.md) before promoting any
artifact. Ordinary builds do not publish or establish live acceptance.
