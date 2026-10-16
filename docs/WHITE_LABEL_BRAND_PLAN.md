# White-label branded rollout plan

**Status:** draft, ready for brand-specific inputs. The Acme values in `config/templates/white-label.example.json` are demonstration data and are not a selected customer or product identity. This plan produces a separately owned branded fork; it does not rebrand the checked-in Community product.

## 1. Lock the brand and product identity

Collect and approve these inputs before generating the fork:

- Public product name and lowercase product ID.
- CLI command, npm package name, Debian package name, and OCI image name.
- Verified support name, email address, and URL.
- Three hex colors, CSS-safe font family, approved logo, and optional local TTF/OTF font.
- Supported customer language(s), intended users, and product owner for policy and release decisions.

Keep `product.json.name` and `guides/assets/brand.json.brandName` identical. Ensure the command, package, Debian, and image identities are unique to the fork. Do not include customer records, credentials, or marks without authorization in public assets.

**Gate:** the product owner approves the identity and support routes; all required values pass the white-label config and product schema validation.

## 2. Generate an isolated branded starter

1. Fork the repository and retain its MIT attribution and third-party notices.
2. Create a versioned config based on `config/templates/white-label.example.json` with the approved identity, theme, starter language, profile name, and either the `simple` or `reference-five` policy template.
3. Run the scaffold into a separate review directory:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   pnpm whitelabel:scaffold -- --config ./brand/product.json --output-dir ./brand/review
   ```

4. Review the generated `product.json`, brand theme, policy, project template, and empty inventory. Keep generated review output separate until it is approved for the fork.

**Gate:** generated objects validate, product and guide names match, the inventory is empty, and the Community product files remain untouched.

## 3. Own the policy and customer promise

The scaffold policy is structural starter content, not a security baseline. Before using it with a real fleet, the named policy owner must decide and review:

- Exact supported device and OS releases.
- Trusted app package names, versions, and signer identities.
- Requested permissions, device settings, and network requirements.
- Backup and recovery scope, data handling, retention, support boundaries, and manual acceptance checks.
- Which claims are supported by offline evidence and which require emulator or physical-device qualification.

Keep each deployment project fresh: initialize a new project and enroll its observed device. Do not reuse project databases, approvals, credentials, device IDs, or primary-phone backups as fleet seeds.

**Gate:** a policy owner signs off on the exact policy and customer-facing claims; unresolved support or recovery claims are documented before onboarding.

## 4. Apply the brand to guides and product materials

Update approved public artwork and any brand-specific guide language. Keep generic guide source in `guides/source/markdown`; use the brand descriptor for colors, font, and logo. Rebuild all eight English/Polish HTML editions and sixteen office/print PDFs after changing their sources or assets. Review every rendered page and the QA manifest before distribution.

**Gate:** names, colors, fonts, logo usage, support details, links, accessibility, and print output have been reviewed in the rendered editions.

## 5. Qualify and release the fork

Use the pinned toolchain from `docs/WHITE_LABEL.md`, then run the full source quality gate and create a local preview:

```sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build:native
PXV_REQUIRE_CRYPTO=1 pnpm quality
pnpm build:preview --formats portable,deb,npm,oci
```

Review the fresh `.quality` reports, candidate hashes, provenance, SBOM, notices, package identities, and signatures. Exercise the preview with a disposable project/canary before any production rollout. Keep emulator and physical acceptance, recovery evidence, and release approvals with the exact candidate. Publishing or registry promotion remains a separate explicit release action.

**Gate:** quality and artifact checks pass for the exact fork sources; the candidate has reviewed policy, guide, canary, recovery, and release evidence; the product owner approves distribution.

## Inputs needed to turn this draft into a branded fork

Provide the product name and ID, command/package/image identities, support contacts, approved colors and logo/font, target language(s), intended device/OS scope, and the named policy owner. The brand owner should also choose the starter policy shape; the security and recovery details must then be reviewed before deployment.
