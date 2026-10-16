# Third-party notices

pxv Community source is MIT licensed. Each frozen distribution generates `THIRD-PARTY-NOTICES.txt`, `NODE-LICENSE.txt` and `sbom.spdx.json` from its actual bundled inputs. Preserve those files when redistributing a fork or an extracted package.

The portable/Debian/Docker runtime bundles Node.js 24.22.0 with its upstream license and third-party notices. JavaScript runtime inputs include the MCP SDK, Zod, YAML and tar dependencies; their recorded versions, licenses and upstream license text are included in the generated notices. Build tooling includes TypeScript 7, its TypeScript 6 ESLint compatibility API, ESLint, Vitest, esbuild, marked and Playwright. Development dependencies are not runtime package requirements.

The native supervisor uses pinned Rust crates recorded in `native/supervisor/Cargo.lock` (base64, libc, serde and serde_json). Preserve their license notices and the release SBOM. Android helpers and the retained Java repository-signature verifier are repository source, built with operator or image toolchains.

Docker includes checksum-pinned Google Android platform/build tools and a Debian snapshot containing OpenJDK, OpenSSH and system libraries. Their bundled notices and package copyright files remain in the image. Host bootstrap requires explicit acceptance of the reviewed tool archive's license; package installation never downloads toolchains or accepts licenses implicitly.

Guide font licenses are retained beside their files under `guides/assets/fonts/`. Existing artwork provenance remains alongside the assets. Forks are responsible for documenting the origin and terms of replacement logos, artwork, fonts, manifests and private extensions.

Use the candidate's generated SBOM and notices to identify the exact content of an artifact. This source summary does not substitute for those artifact-specific records.

The static supervisor also contains the Rust 1.99.1 standard runtime and musl 1.2.5 supplied by its pinned target. The reviewed runtime catalog records upstream archive hashes, the exact sysroot libc archive digest and notice hashes. Candidate files RUST-RUNTIME-COPYRIGHT.html and MUSL-COPYRIGHT.txt preserve full upstream notices, and their packages appear separately in the SBOM.
