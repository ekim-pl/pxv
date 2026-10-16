# Publication and promotion checklist

1. Freeze the source/product descriptor, assets, manifests, configuration templates and exact toolchain. Community remains MIT and local workflows remain available without activation.
2. Run strict build/lint/boundary checks, automated and native fault suites, real cryptographic cases and the required application coverage targets. Retain the output.
3. Complete the advertised policy/UI/restore/EN-PL/physical acceptance matrix. Keep pending checks visible; never replace missing live evidence with a generic emulator.
4. Build one frozen engine candidate. Inspect its public allowlist, secret-sentinel checks, dependency notices, SPDX SBOM, source digest and tool hashes.
5. Derive portable, Debian, npm and OCI formats from that candidate. Check external projects, arbitrary working directories, read-only installation roots, preview coexistence and offline extension use. Review the actual local Docker image's caller-UID behavior.
6. Create stable artifacts only with an explicitly supplied release signing key. Keep signing material outside the source/candidate. Verify signed checksums before promotion.
7. Rebuild the six EN/PL guides through Node/Chromium, inspect every rendered page and update the guide build/QA records. Remove stale proofs and CLI transcripts.
8. Review the final names/URLs/support contact for the product fork. Commercial extension distribution credentials stay in external registry configuration, not images or project locks.
9. Promote only the verified artifacts through an explicit publication action. Ordinary build/preview commands never push, publish, globally install or replace stable launchers.

~~~sh
pnpm build:preview --formats portable,deb,npm,oci
node packages/release/dist/cli.js --release --signing-key /private/release-key \
  --formats portable,deb,npm,oci
node packages/release/dist/cli.js promote --artifacts ARTIFACT_DIRECTORY \
  --package PACKAGE.tgz --registry https://YOUR_REGISTRY \
  --allowed-signers /private/release-signers --signer RELEASE_ID --dry-run
~~~

Remove `--dry-run` only for an authorized publication to the configured registry. The built-in promotion path verifies real OpenSSH signatures/checksums before npm publication. Repository/OCI/package-repository publishing outside that path requires an equally explicit reviewed release process.

The SEA target is experimental and requires an explicit postject executable plus matching external resources. The portable archive is the supported binary-like distribution baseline. Do not describe the experimental launcher as a self-contained supported phone-management binary.
