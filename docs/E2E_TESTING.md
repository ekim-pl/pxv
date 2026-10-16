# Live and physical acceptance

pxv 0.1.0 is undergoing release qualification. Automated tests, artifact verification and container checks do not certify a policy pack, UI recipe, recipient workflow or physical phone. Verified GrapheneOS emulator evidence, exact-build EN/PL walkthroughs and a physical Pixel 8a acceptance record must be retained before making a deployment claim. A stock Google APIs emulator is useful for compatibility tests and cannot supply GrapheneOS provenance.

## Evidence boundaries

Record the engine candidate/version/content hash, product/policy lock, pinned extension bytes, host/tool versions, OS build/fingerprint and relevant app versions/signers. Keep real serials, raw logs and private recipient data out of public reports. Public evidence may reference a private record through a non-sensitive asset alias and digest.

A dedicated stock Android emulator can test transport, JSON parsing and generic adapter behavior. It cannot establish GrapheneOS security features or image provenance. GrapheneOS emulator evidence must bind the actual image path/hash/fingerprint/source and the policy's capabilities; a note is not a substitute. Emulator outcomes remain emulator-only.

## Disposable canary procedure

1. Obtain explicit authorization for this disposable device, including any erasure. Match its observed serial/model/codename to enrollment before selecting it.
2. Freeze and verify the candidate, reviewed OS/app artifacts and policy before mutations. Keep physical unlock/relock/boot checks attended.
3. Run the policy through CLI and the equivalent supported operator/automation paths. Retain pending checkpoints and recovery behavior as actual results.
4. Test reboot persistence and user isolation. Revoke a required permission to confirm finalization refuses drift; restore it through a new reviewed workflow.
5. Exercise expected routes and failure/reconnection in representative apps, plus the scoped helper probe if configured. Check helper removal and parent resource lifetime.
6. Perform representative backup restoration using synthetic data. Never equate an enabled backup setting with a restore pass.
7. Complete EN and PL setup/recipient walkthroughs on exact supported builds. Keep final credentials private; never trigger destructive duress.
8. Finalize, physically confirm debugging shutdown and record recipient/custody acceptance. Record unsupported/manual steps honestly.

## Fault and distribution checks

Test interrupted workers/native ownership with a disposable project/device and inspect retained fences before recovery. Never interrupt a flash solely to satisfy a synthetic failure test unless a separately designed recovery test authorizes that risk. Verify native/Docker ownership against the same common control root and exact phone identity.

Run the portable archive, Debian extraction/installation, offline npm package and Docker image on the declared Linux targets. Retain package hashes, source provenance and signatures. A container check of CLI/tool availability is not a full physical provisioning result.

Release qualification is complete only when the promised pack/workflow has retained acceptance evidence. Pending prerequisites remain visible in [verification](VERIFICATION.md) and the guide release-gate record.
