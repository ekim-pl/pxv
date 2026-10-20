# Operator and device user guides

The eight Markdown sources under [source/markdown](source/markdown) are authoritative. The operator guides explain preparing and flashing a Pixel or fleet, applying predefined profiles, and keeping local records. The user guides explain receiving and using a phone with one Owner or multiple profiles. The separate phone-sized quick start covers first use, configuration, privacy and security; the private insert is a blank template for device credentials and recovery arrangements. A policy build adapts the phone-sized editions to the configured GrapheneOS profiles without changing these shared sources. English and Polish editions cover the same workflows.

| Reader                              | English                                                | Polski                                                        |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Operator                            | [Operator guide](source/markdown/operator-en.md)       | [Instrukcja operatora](source/markdown/operator-pl.md)        |
| Device user                         | [User guide](source/markdown/user-en.md)               | [Instrukcja użytkownika](source/markdown/user-pl.md)          |
| phone-sized guide for every phone   | [Quick start](source/markdown/quickstart-en.md)        | [Szybki start](source/markdown/quickstart-pl.md)              |
| Private phone-sized insert template | [Credential insert](source/markdown/credentials-en.md) | [Wkładka z danymi dostępu](source/markdown/credentials-pl.md) |

Use a phone's accepted handoff report for its actual policy, software and verification results. General guides do not certify a device. Never add credentials, customer information or device-specific records to guide sources or branding assets.

## Pack every device

Supply the recipient's chosen language with every phone:

1. Build the phone-sized editions with the installation's validated policy, then print the quick start and include the phone's accepted handoff report. The quick start adds an appendix section for each configured profile and adapts the profile instructions for a single Owner or multiple profiles. Its profile details describe the intended installation; they do not verify a device. Attach dated written notes with the actual profile purposes, installed apps, VPN/routing requirements, checks performed and unresolved limitations. The exported report contains policy/profile identity and generic instructions; it does not enumerate these checks.
2. Print the blank phone-sized credential insert. A policy build includes a pair of ordinary credential and account/recovery sheets per configured profile, with its name and role already identified; secrets remain blank. Complete it privately by hand, outside source/release assets, and copy account/recovery sheets as needed. Every credential panel has an asset-label writing area; complete it on each panel before cutting. Policy-specific profile panels repeat the full profile name, ID and role. Generic profile panels provide a blank profile/scope field. Compare every configured profile with the actual phone and accepted report. A build without a policy produces the generic eight-section quick start and four-section insert; copy that insert's profile section for each actual profile.
3. Fill real support contacts, the route available without this phone, the private credential-update method, backup coverage and any agreed retention. Mark unused fields “not configured”; identify supplied values as initial or privately verified with a date. Confirm ordinary unlocks privately. Registry `current` means last operator-confirmed, not continuously measured.
4. Keep optional destructive credentials on the erasure page, detached and sealed separately from ordinary unlock information. Mark the page “not configured” unless the feature was actually configured and agreed. Include destructive values only through the agreed supervised process. Never activate duress or send an Oblivion key as a test.
5. Check the phone, report and insert have the same asset label. Seal the completed insert for the recipient and attach the packet to the device packaging. Record actual custody through the existing handoff workflow. Advise the recipient to store the private insert securely away from the phone after receipt.

The shared insert is a manual template; ordinary guide rebuilding does not read the encrypted registry. An explicit `guides rebuild --private-insert-output PRIVATE.pdf --project-root DIR --asset ID --output-dir DIR --chromium PATH` also exports a separate private registry PDF, with optional `--locale en|pl` and `--passphrase-file FILE`; it uses the project policy and rejects `--policy` and `--html-only`. The private PDF must be outside the shared output directory. To produce a separate private phone-sized PDF with all saved values for one phone, use [`pxv registry print-insert`](../docs/PHONE_REGISTRY.md#prefilled-private-phone-sized-insert). This compact registry export groups ordinary values by profile, omits blank worksheets, and prints the asset identifier once per A4 sheet. The saved phone hardware serial is included in the device details of both ordinary and destructive sections, with an English or Polish label. It targets two sheets, with destructive credentials on a separate sheet and extra sheets when values need more room. Stale or unknown values remain labeled for private verification. If a separate authorized private retrieval is needed to prepare it, use the [registry workflow](../docs/PHONE_REGISTRY.md#private-retrieval-and-key-rotation), protect the plaintext file and clean it up afterward. Use a trusted local printer and account for printer queues, copies and discarded sheets. Do not edit the public HTML/Markdown to personalize a packet.

Use `quickstart-LOCALE-a4-fold.pdf` and `credentials-LOCALE-a4-fold.pdf` (`LOCALE` is `en` or `pl`). Print **landscape A4, single-sided, at 100% / actual size**; disable fit-to-page and booklet mode. Check the marked 50 mm scale before cutting. Each sheet holds four 136 × 100 mm slips. Cut the thin solid lines, fold the dashed center lines with printing inside, and stack slips by their printed numbers. Each folded slip is **68 × 100 mm**. Unused panel positions remain blank. Quickstart, ordinary credentials and destructive credentials start on separate A4 sheets; seal erasure slips separately. Copy entire profile/account sections as needed. Check the QA manifest for the actual panel and sheet counts. A5 packet office/bleed files are obsolete and removed by PDF rebuilds.

## Build HTML and PDF

Rebuild from the matching source checkout with the pinned developer dependencies installed:

```sh
pxv guides rebuild --chromium /usr/bin/google-chrome
```

For a workspace invocation, use `pnpm pxv guides rebuild`. The command runs `pnpm build`, then the [optional publishing tool](../tools/optional/publishing/rebuild.mjs). It requires no initialized project or device. Installed releases include the guide sources, but rebuilding requires the source checkout.

```text
pxv guides rebuild [--policy FILE] [--output-dir DIR] [--chromium PATH] [--html-only] [--no-render]
```

`--output-dir` selects the destination; the default is `guides/`. `PXV_CHROMIUM` can replace `--chromium`. `--html-only` creates HTML without Chromium or Poppler. `--no-render` creates and checks PDFs but skips page images. A full build creates HTML for every edition, office/bleed PDFs for operator and user guides, and one A4 cut-and-fold PDF for each quickstart and credential edition. Use `--output-dir output/pdf` to keep a separate local print build.

For an installation with five configured Android user profiles, use its policy directly:

```sh
pxv guides rebuild --policy policy-packs/fleet-nerd/policy.json --output-dir output/pdf/fleet-nerd --chromium /usr/bin/google-chrome
```

`--policy` accepts authoring policies and validates them through the same policy contracts used for installation. Use the installation's own policy path in place of this structural starter. Choose a separate `--output-dir` for every policy build; the builder refuses to replace authoritative guide sources. Relative policy and destination paths are resolved from the directory where you run the command. A policy build does not require project initialization, connect to the phone or alter the accepted handoff snapshot.

The phone-sized quick start gains a profile appendix with the policy's profile names, roles, language and declared configuration. The credential insert repeats its ordinary profile and account/recovery sections automatically. For `N` configured profiles there are `8 + N` quickstart sections and `2N + 2` credential sections. Sections can span multiple 68 × 100 mm panels; sheet counts depend on content and language and are recorded in the QA manifest. The generated files are installation instructions, not proof that those profiles or settings are present. The accepted handoff report and dated checks remain the record of the actual device.

Only selected configuration fields enter the editions. The shared builder does not receive registry values or copy the input policy into the output. An explicit private-insert export is separate from the shared builder. Complete credentials privately after printing. Generated Markdown under the destination's `source/markdown/` records the content actually rendered; do not replace shared source files with a personalized build.

The rebuild uses an explicitly selected local Chromium and never downloads a browser. Use Chromium with CSS page-margin-box support for repeating panel identities. PDF QA requires Poppler: `pdfinfo`, `pdftotext`, `pdffonts` and `pdftoppm`; real-PDF regression tests also use `pdftohtml`. It does not install dependencies, run the full source quality gate, contact phones or publish files. Follow [the contributor workflow](../CONTRIBUTING.md) when changing the renderer.

The [build configuration](source/build-manifest.json) contains the single edition list. Its `foldLayout` describes the immutable `@pxv/guides` layout; rebuild validates those dimensions against the shared definition and rejects drift. It is layout metadata, not an editable print-size setting. The generated `index.html` links the files actually produced. Links between editions resolve to their HTML outputs; local navigation is retained only for copied public files, emitted pages and existing heading fragments. Unavailable repository references and unsafe targets lose their links. Rebuild QA checks navigation throughout the index and every HTML edition. PDF generation retains its separate local-link safety restrictions. The `qa/manifest.json` records hashes of the rendered sources and outputs, page counts, extracted text, embedded fonts, Polish glyph checks, page boxes and one PNG per rendered page. For a policy build, retain its source provenance with the reviewed output so the intended installation can be identified. Review every page before distributing a build; automated checks cannot approve its layout.

Operator/user office PDFs use A4 pages; their color print PDFs use 216 × 303 mm media with an A4 `TrimBox` inset by 3 mm. Quickstart/credential PDFs use **297 × 210 mm landscape A4** sheets containing actual-size 68 × 100 mm panels. Their low-ink layout uses 10 pt body/value text, metadata of at least 8 pt, repeating identity/continuation headings and numbered slips. Identity and asset writing areas have reserved page-margin space, so long names increase panel counts rather than reduce text size. Blank writing fields reserve at least 8 mm below their labels. Fold PDFs have cutting/folding marks and no bleed. Print PDFs are not PDF/X files and contain no commercial printer color profile. See [BUILD.txt](source/BUILD.txt) for pipeline details.

Generated HTML, PDFs and `qa/` are ignored build outputs. Keep reviewed copies with their matching release. Rebuilding overwrites current edition outputs; an alternate output directory keeps a separate build.

## Fork branding

[assets/brand.json](assets/brand.json) supplies the brand name, three colors, font family and optional local logo/font paths. Keep `brandName` equal to `product.json.name`. The optional [branding scaffold](../tools/optional/branding/scaffold.mjs) creates this theme together with a product identity and an empty starter project:

```sh
pnpm whitelabel:scaffold -- --config ./config/templates/white-label.example.json
```

See [the branding instructions](../docs/WHITE_LABEL.md). The two editorial cover images, `assets/photos/cover-operator.png` and `assets/photos/cover-user.png`, can be replaced with public images using those names. They are illustrations, not evidence of tested phones or captured product UI. The bundled font retains its license under `assets/fonts/`. Use a local font file for consistent PDF embedding; otherwise Chromium uses an installed font matching `fontFamily`.
