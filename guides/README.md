# Operator and device user guides

The eight Markdown sources under [source/markdown](source/markdown) are authoritative. The operator guides explain preparing and flashing a Pixel or fleet, applying predefined profiles, and keeping local records. The user guides explain receiving and using a phone with one Owner or multiple profiles. The separate A5 quick start covers first use, configuration, privacy and security; the private insert is a blank template for device credentials and recovery arrangements. A policy build adapts the A5 editions to the configured GrapheneOS profiles without changing these shared sources. English and Polish editions cover the same workflows.

| Reader      | English                                          | Polski                                                 |
| ----------- | ------------------------------------------------ | ------------------------------------------------------ |
| Operator    | [Operator guide](source/markdown/operator-en.md) | [Instrukcja operatora](source/markdown/operator-pl.md) |
| Device user | [User guide](source/markdown/user-en.md)         | [Instrukcja użytkownika](source/markdown/user-pl.md)   |
| A5 guide for every phone | [Quick start](source/markdown/quickstart-en.md) | [Szybki start](source/markdown/quickstart-pl.md) |
| Private A5 insert template | [Credential insert](source/markdown/credentials-en.md) | [Wkładka z danymi dostępu](source/markdown/credentials-pl.md) |

Use a phone's accepted handoff report for its actual policy, software and verification results. General guides do not certify a device. Never add credentials, customer information or device-specific records to guide sources or branding assets.

## Pack every device

Supply the recipient's chosen language with every phone:

1. Build the A5 editions with the installation's validated policy, then print the quick start and include the phone's accepted handoff report. The quick start adds an appendix page for each configured profile and adapts the profile instructions for a single Owner or multiple profiles. Its profile details describe the intended installation; they do not verify a device. Attach dated written notes with the actual profile purposes, installed apps, VPN/routing requirements, checks performed and unresolved limitations. The exported report contains policy/profile identity and generic instructions; it does not enumerate these checks.
2. Print the blank A5 credential insert. A policy build includes a pair of ordinary credential and account/recovery sheets per configured profile, with its name and role already identified; secrets remain blank. Complete it privately by hand, outside source/release assets, and copy account/recovery sheets as needed. Each sheet must carry the matching asset label. Compare every configured profile with the actual phone and accepted report. A build without a policy produces the generic eight-page quick start and four-page insert; copy that insert's profile page for each actual profile.
3. Fill real support contacts, the route available without this phone, the private credential-update method, backup coverage and any agreed retention. Mark unused fields “not configured”; identify supplied values as initial or privately verified with a date. Confirm ordinary unlocks privately. Registry `current` means last operator-confirmed, not continuously measured.
4. Keep optional destructive credentials on the erasure page, detached and sealed separately from ordinary unlock information. Mark the page “not configured” unless the feature was actually configured and agreed. Include destructive values only through the agreed supervised process. Never activate duress or send an Oblivion key as a test.
5. Check the phone, report and insert have the same asset label. Seal the completed insert for the recipient and attach the packet to the device packaging. Record actual custody through the existing handoff workflow. Advise the recipient to store the private insert securely away from the phone after receipt.

The insert is a manual template; rebuilding guides never reads the encrypted registry or creates populated credential documents. If a separate authorized private retrieval is needed to prepare it, use the [registry workflow](../docs/PHONE_REGISTRY.md#private-retrieval-and-key-rotation), protect the plaintext file and clean it up afterward. Use a trusted local printer and account for printer queues, copies and discarded sheets. Do not edit the public HTML/Markdown to personalize a packet.

Use `quickstart-LOCALE-office.pdf` and `credentials-LOCALE-office.pdf` for normal printing (`LOCALE` is `en` or `pl`). Print at **100% / actual size on A5**. Policy builds have variable page counts; use the generated QA manifest to check the count before packing. The quick start can be duplex with long-edge binding for loose A5 pages. For a folded quickstart booklet on A4, use the PDF reader's booklet mode and duplex instructions; files are in reading order, not imposed spreads. Let the reader add blank pages if needed for folded sheets. **Print credential inserts single-sided**, with the erasure page on its own sheet for separate sealing. Copy profile/account sheets as needed. The `-print.pdf` variants have bleed for a printer's trimming workflow.

## Build HTML and PDF

Rebuild from the matching source checkout with the pinned developer dependencies installed:

```sh
pxv guides rebuild --chromium /usr/bin/google-chrome
```

For a workspace invocation, use `pnpm pxv guides rebuild`. The command runs `pnpm build`, then the [optional publishing tool](../tools/optional/publishing/rebuild.mjs). It requires no initialized project or device. Installed releases include the guide sources, but rebuilding requires the source checkout.

```sh
pxv guides rebuild [--policy FILE] [--output-dir DIR] [--chromium PATH] [--html-only] [--no-render]
```

`--output-dir` selects the destination; the default is `guides/`. `PXV_CHROMIUM` can replace `--chromium`. `--html-only` creates HTML without Chromium or Poppler. `--no-render` creates and checks PDFs but skips page images. A full build creates one HTML file, one office PDF and one print PDF for each edition. Use `--output-dir output/pdf` to keep a separate local print build.

For an installation with five configured Android user profiles, use its policy directly:

```sh
pxv guides rebuild --policy policy-packs/reference-five/policy.v2.json --output-dir output/pdf/reference-five --chromium /usr/bin/google-chrome
```

`--policy` accepts only version 2 authoring policies and validates them through the same policy contracts used for installation. Use the installation's own policy path in place of this structural starter. Choose a separate `--output-dir` for every policy build; the builder refuses to replace authoritative guide sources. Relative policy and destination paths are resolved from the directory where you run the command. A policy build does not require project initialization, connect to the phone or alter the accepted handoff snapshot.

The A5 quick start gains a profile appendix with the policy's profile names, roles, language and declared configuration. The credential insert repeats its ordinary profile and account/recovery sheets automatically. For `N` configured profiles, the quick start has `8 + N` pages and the insert has `2N + 2` pages: an introduction, two sheets per profile, and a separate optional erasure sheet. A single Owner produces a nine-page guide and four-page insert; the five-profile example produces a thirteen-page guide and twelve-page insert. The generated files are installation instructions, not proof that those profiles or settings are present. The accepted handoff report and dated checks remain the record of the actual device.

Only selected configuration fields enter the editions. The builder does not read the encrypted registry, populate secrets or copy the input policy into the output. Complete credentials privately after printing. Generated Markdown under the destination's `source/markdown/` records the content actually rendered; do not replace shared source files with a personalized build.

The rebuild uses an explicitly selected local Chromium and never downloads a browser. PDF QA requires Poppler: `pdfinfo`, `pdftotext`, `pdffonts` and `pdftoppm`. It does not install dependencies, run the full source quality gate, contact phones or publish files. Follow [the contributor workflow](../CONTRIBUTING.md) when changing the renderer.

The [build configuration](source/build-manifest.json) contains the single edition list. The generated `index.html` links the files actually produced. Links between editions resolve to their HTML outputs; local navigation is retained only for copied public files, emitted pages and existing heading fragments. Unavailable repository references and unsafe targets lose their links. Rebuild QA checks navigation throughout the index and every HTML edition. PDF generation retains its separate local-link safety restrictions. The `qa/manifest.json` records hashes of the rendered sources and outputs, page counts, extracted text, embedded fonts, Polish glyph checks, page boxes and one PNG per rendered page. For a policy build, retain its source provenance with the reviewed output so the intended installation can be identified. Review every page before distributing a build; automated checks cannot approve its layout.

Operator/user office PDFs use A4 pages; their color print PDFs use 216 × 303 mm media with an A4 `TrimBox` inset by 3 mm. Quickstart/credentials office PDFs use **148 × 210 mm A5** pages; their print PDFs use **154 × 216 mm** media with an A5 `TrimBox` inset by 3 mm. The A5 layout uses black headings, low-ink writing fields and page numbers. Print PDFs are not PDF/X files and contain no commercial printer color profile. See [BUILD.txt](source/BUILD.txt) for the pipeline details.

Generated HTML, PDFs and `qa/` are ignored build outputs. Keep reviewed copies with their matching release. Rebuilding overwrites current edition outputs; an alternate output directory keeps a separate build.

## Fork branding

[assets/brand.json](assets/brand.json) supplies the brand name, three colors, font family and optional local logo/font paths. Keep `brandName` equal to `product.json.name`. The optional [branding scaffold](../tools/optional/branding/scaffold.mjs) creates this theme together with a product identity and an empty starter project:

```sh
pnpm whitelabel:scaffold -- --config ./config/templates/white-label.example.json
```

See [the branding instructions](../docs/WHITE_LABEL.md). The two editorial cover images, `assets/photos/cover-operator.png` and `assets/photos/cover-user.png`, can be replaced with public images using those names. They are illustrations, not evidence of tested phones or captured product UI. The bundled font retains its license under `assets/fonts/`. Use a local font file for consistent PDF embedding; otherwise Chromium uses an installed font matching `fontFamily`.
