# Verification and qualification

## Current post-freeze result: 16 October 2026

The [final sanitized verification record](verification-0.1.0-final.json) binds candidate 0.1.0-preview.20261016105101.ce4658db, its full source digest and the exact portable, Debian, npm and OCI hashes. All four formats passed signature/checksum and execution checks, including actual native lease/child/cleanup-receipt execution inside the Debian 12 OCI image as UID 1000 with a read-only root. The raw image also refused fastboot in its default host-ADB mode.

In host execution mode on the authorized Pixel 8a, this corrected candidate completed fresh review/signoffs and the validated debugging-shutdown request. Native receipts retain wireless exit 0 and the declared expected USB-disconnect exit 255, both with cleanup proven; no native reservation remained. The user then freshly confirmed both debugging modes off and receipt of the phone. The three-profile acceptance fixture reached completed-custody. EN and PL Markdown/HTML handoff exports from the accepted immutable snapshot passed serial/token-sentinel checks. No PDF handoff export is claimed.

This completes the fixture custody workflow. Production/policy/UI qualification remains incomplete: GrapheneOS emulator provenance, approved application VPN/failure tests, representative restore, broader cross-user isolation, full EN/PL workflows and live Docker direct-USB/host-ADB phone provisioning still need retained evidence. OCI checks covered runtime/tools and a synthetic native lease, without live device access. Earlier statements below and the bundled source-freeze JSON describe their historical checkpoints. This post-freeze record is separate from the immutable artifacts; they were not rebuilt merely to include later evidence.

Verification has four layers: policy/schema validation; offline code/cryptographic/process tests; package/runtime checks; and live exact-build acceptance. Report each layer separately and link its retained evidence. A passing layer does not imply later layers passed.

## Required safety behavior

- Stable Android user serials protect recovery from ID/name reuse.
- Measured policy requirements, including permission grants, are observed again before finalization.
- Cleanup is scoped to the resource owner and preserves parent resources.
- Native command specifications never persist argv/environment/stdin secrets.
- Exact asset selection and explicit fleet selection are separate contracts.
- Emulator provenance is capability-bound and cannot masquerade as physical acceptance.

## Recorded source-freeze snapshot: 16 October 2026

The [sanitized verification record](verification-0.1.0.json) reports 407 passing tests in 34 files, six passing Rust supervisor tests, and a passing strict build, typed lint, boundary/cycle, formatting and 35-document check. Application coverage is 94.65% lines (3882/4101) and 87.43% branches (3272/3742), above the 90%/85% targets. Six EN/PL guide PDFs passed text/font checks and visual review of all 24 A4 pages.

Portable execution outside the checkout, Debian installation on Debian 12, offline npm installation and OCI execution with UID 1000/read-only root were verified for candidate 0.1.0-preview.20261016095137.40c0e4a1. A later final candidate incorporating the Docker lifecycle correction must have its own artifact identities and checks retained after derivation. Retain final-distribution/artifacts.json outside candidate source to avoid a self-referential source digest. This snapshot does not claim an unbuilt candidate has passed. No artifacts were published.

On the authorized physical Pixel 8a, the official GrapheneOS akita-install-2026100600 image passed reviewed SHA-256/OpenSSH verification and installation. Unlock, authenticated flash and relock native receipts returned code 0 with cleanup proven; fastboot subsequently reported unlocked=no. This is the completed installation subset for the recorded immutable candidate. No native recovery reservations remained at the observation checkpoint. Candidate 0.1.0-preview.20261016101337.094df7d0 subsequently measured bootVerified=true and ro.boot.flash.locked=1, completed 13 automated fixture actions across the owner and two secondary profiles, and passed reboot comparison of stable user identities, app version/signer, notification permissions, timeout settings and default VPN state. The recipient privately confirmed normal locks in all three profiles and English/Polish test-profile app launches/languages; normal-credential attestation was recorded. This is fixture evidence, not full application/policy qualification. A final static-candidate review, required fresh attestations and remaining signoffs are still pending.

Approved network/failure behavior, representative restoration, cross-user data isolation beyond the fixture observations, full EN/PL workflows, final helper/debugging checks and recipient custody remain pending. No helper packages were present in the current observation. GrapheneOS emulator provenance is unavailable; the available Google APIs API 36 image cannot supply it. Full production/policy/UI qualification is incomplete. Real serials, raw logs and recipient values remain private.

## Current qualification status

This document is an acceptance protocol, not a certificate. The release's final machine-readable verification record and retained test output should state what actually ran. UI recipes, VPN/app combinations, restore destinations and recipient steps need their own exact-build evidence. A structural starter pack is never promoted to a hardened product merely by renaming it.

pxv 0.1.0 is undergoing release qualification. Automated tests, artifact verification and container checks do not certify a policy pack, UI recipe, recipient workflow or physical phone. Verified GrapheneOS emulator evidence, exact-build EN/PL walkthroughs and a physical Pixel 8a acceptance record must be retained before making a deployment claim. A stock Google APIs emulator is useful for compatibility tests and cannot supply GrapheneOS provenance.

The handoff state machine distinguishes subset, emulator, ready-for-handoff and completed-custody. Stored reports identify readiness evidence; live measurements at signoff/finalization establish freshness. Outstanding native reservations, unresolved cleanup, helper packages, contradictory measurements or stale policy/engine identity prevent readiness.

Publish no real device serial, private registry authentication, final credential or recovery value with verification materials. Preserve redacted summaries plus private raw evidence where custody rules require it. [Publication checklist](PUBLICATION_CHECKLIST.md) describes the final promotion gate.

## Native compatibility correction

A later baseline audit found the original GNU-linked supervisor required GLIBC_2.39 from its Ubuntu build host. Earlier project-init/doctor/package-entrypoint results therefore did not establish Debian 12 native ownership compatibility. Those earlier candidates are superseded for supported distribution. The corrected Rust 1.99.1/musl 1.2.5 build uses the pinned static musl target, rejects shared-loader/library dependencies, and has passed an actual lease, synthetic mutation and cleanup-proven receipt on both the host and Debian 12 OCI under UID 1000/read-only root. Six static-target Rust tests and the final 407-test suite passed. The production-dependency audit reports 144 dependencies and zero vulnerabilities at every reported severity. Final rebuilt artifact identities and checks belong in the separate post-freeze verification record. This correction does not change previously measured phone facts or turn pending live acceptance into completion.

## Final shutdown regression and remaining retest

The earlier physical finalization request disabled USB debugging, disconnected ADB and returned 255. The prior implementation retained a native fence and produced no completed handoff record. The operator inspected the physical settings and performed explicit inspected recovery; USB was re-enabled for the corrected candidate retest. The corrected dedicated shutdown step declares only normal exits 0/255, validates a fresh successful existing-server query and selected-transport disappearance, and still requires physical debugging-off/custody confirmation. Signals, timeouts, unexpected exits, unproven cleanup and failed postconditions retain the fence. A full CLI fixture with the real supervisor now covers expected 255, absence of a residual fence and the separate custody gate. The corrected physical candidate 4 retest is pending at this source freeze; its exact artifacts and resulting device checkpoint belong in the separate post-freeze record.
