# Publication and promotion checklist

1. Freeze the source/product descriptor, assets, manifests, configuration templates and exact toolchain. Community remains MIT and local workflows remain available without activation.
2. Run `pnpm quality:setup`, run `pnpm build`, then `PXV_REQUIRE_CRYPTO=1 pnpm quality`. Retain the unchanged-source component reports, zero unexplained development/production TypeScript repository findings, native faults, genuine crypto and signed helper checks. Every TypeScript module/package must meet 90% lines/85% branches; all enforced function metrics must pass.
3. Complete the advertised policy/UI/restore/EN-PL/physical acceptance matrix. Keep pending checks visible; never replace missing live evidence with a generic emulator.
4. Build one frozen engine candidate. Inspect its public allowlist, secret-sentinel checks, dependency notices, SPDX SBOM, source digest and tool hashes.
5. Derive the advertised formats from that candidate: portable is the supported default; OCI, Debian and npm are explicit additions. Check external projects, arbitrary working directories, read-only installation roots, preview coexistence and offline extension use. Review the actual local Docker image's caller-UID behavior.
6. Create stable artifacts only with an explicitly supplied release signing key. Keep signing material outside the source/candidate. Verify signed checksums before promotion.
7. Update the canonical operator/user guides and phone-sized quickstart/private insert templates in English and Polish after implementation verification. Run `pxv guides rebuild` from the source checkout with explicit Chromium and Poppler available. Inspect every HTML and office/print PDF page, including A4 guide trim/3 mm bleed boxes and the packet's A4 sheet size, 68 × 100 mm panels and cut/fold placement, and update the guide build/QA records. Keep populated credential inserts outside public resources. Remove stale proofs and CLI transcripts. Freeze those public resources before building the final distributable candidate, and rerun source-bound quality checks after documentation changes.
8. Review the final names/URLs/support contact for the product fork. Commercial extension distribution credentials stay in external registry configuration, not images or project locks.
9. Promote only the verified artifacts through an explicit publication action. Ordinary build/preview commands never push, publish, globally install or replace stable launchers.

~~~sh
pnpm build
node packages/release/dist/cli.js --formats portable,deb,npm,oci > /tmp/pxv-preview-result.json
node tools/check-packaged-runtime.mjs /tmp/pxv-preview-result.json
node packages/release/dist/cli.js --release --signing-key /private/release-key \
  --formats portable,deb,npm,oci
node packages/release/dist/cli.js promote --artifacts ARTIFACT_DIRECTORY \
  --package PACKAGE.tgz --registry https://YOUR_REGISTRY \
  --allowed-signers /private/release-signers --signer RELEASE_ID --dry-run
~~~

Remove `--dry-run` only for an authorized publication to the configured registry. The built-in promotion path verifies real OpenSSH signatures/checksums before npm publication. Repository/OCI/package-repository publishing outside that path requires an equally explicit reviewed release process.

The SEA target is experimental and requires an explicit postject executable plus matching external resources. The portable archive is the supported binary-like distribution baseline. Do not describe the experimental launcher as a self-contained supported phone-management binary.


Candidate and release-provenance schema 2 bind Node 24.22.0, the supervisor JavaScript bundle, Koffi 3.3.3 Linux glibc x64 Node-API 8 prebuild, loader bytes and artifact hashes. Regenerate schema 1 candidates. Every supported distribution contains the supervisor, selected addon and reviewed Koffi notices; qualify installed candidate bytes on Debian 12 and Ubuntu 24.04 without workspace dist mounts. Keep host control reservations and private projects intact.


Before the first public release, replace the reserved `example.org` support email
and URL in `product.json` with maintainer-controlled identities, establish the
repository private vulnerability-reporting route, confirm ownership of the npm
scope and OCI namespace, and distribute the release signer identity through a
trusted channel. This checkout has no configured Git remote; local validation
cannot establish hosted CI or repository protection settings. Keep any uncompleted
live acceptance and rendered guide review pending. Do not describe local synthetic
tests as phone workflow qualification.

Run `pnpm audit --json` with registry access before promotion and retain the report
alongside the source-bound quality evidence. CI retains `.quality/advisories.json`, the complete source test reports, the packaged
runtime matrix and checksum/provenance records, including files under the hidden
`.quality` directory. Java parser dependencies use exact
Lodash overrides for published security fixes; keep those pins reviewed when
upgrading the parser. An unavailable advisory service is not a clean audit.
