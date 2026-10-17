# Operator and device user guides

The four Markdown sources under [source/markdown](source/markdown) are authoritative. The operator guides explain preparing and flashing a Pixel or fleet, applying predefined profiles, and keeping local records. The user guides explain receiving and using the prepared phone. English and Polish editions cover the same workflows.

| Reader      | English                                          | Polski                                                 |
| ----------- | ------------------------------------------------ | ------------------------------------------------------ |
| Operator    | [Operator guide](source/markdown/operator-en.md) | [Instrukcja operatora](source/markdown/operator-pl.md) |
| Device user | [User guide](source/markdown/user-en.md)         | [Instrukcja użytkownika](source/markdown/user-pl.md)   |

Use a phone's accepted handoff report for its actual policy, software and verification results. General guides do not certify a device. Never add credentials, customer information or device-specific records to guide sources or branding assets.

## Build HTML and PDF

Rebuild from the matching source checkout with the pinned developer dependencies installed:

```sh
pxv guides rebuild --chromium /usr/bin/google-chrome
```

For a workspace invocation, use `pnpm pxv guides rebuild`. The command runs `pnpm build`, then the [optional publishing tool](../tools/optional/publishing/rebuild.mjs). It requires no initialized project or device. Installed releases include the guide sources, but rebuilding requires the source checkout.

```sh
pxv guides rebuild [--output-dir DIR] [--chromium PATH] [--html-only] [--no-render]
```

`--output-dir` selects the destination; the default is `guides/`. `PXV_CHROMIUM` can replace `--chromium`. `--html-only` creates HTML without Chromium or Poppler. `--no-render` creates and checks PDFs but skips page images. A full build creates one HTML file, one A4 office PDF and one color print PDF for each edition.

The rebuild uses an explicitly selected local Chromium and never downloads a browser. PDF QA requires Poppler: `pdfinfo`, `pdftotext`, `pdffonts` and `pdftoppm`. It does not install dependencies, run the full source quality gate, contact phones or publish files. Follow [the contributor workflow](../CONTRIBUTING.md) when changing the renderer.

The [build configuration](source/build-manifest.json) contains the single edition list. The generated `index.html` links the files actually produced. The `qa/manifest.json` records source/output hashes, page counts, extracted text, embedded fonts, Polish glyph checks, page boxes and one PNG per rendered page. Review every page before distributing a build; automated checks cannot approve its layout.

Office PDFs use A4 pages, a low-ink layout and page numbers. Color print PDFs use 216 × 303 mm media, with an A4 `TrimBox` inset by 3 mm. They are not PDF/X files and contain no commercial printer color profile. See [BUILD.txt](source/BUILD.txt) for the pipeline details.

Generated HTML, PDFs and `qa/` are ignored build outputs. Keep reviewed copies with their matching release. Rebuilding overwrites current edition outputs; an alternate output directory keeps a separate build.

## Fork branding

[assets/brand.json](assets/brand.json) supplies the brand name, three colors, font family and optional local logo/font paths. Keep `brandName` equal to `product.json.name`. The optional [branding scaffold](../tools/optional/branding/scaffold.mjs) creates this theme together with a product identity and an empty starter project:

```sh
pnpm whitelabel:scaffold -- --config ./config/templates/white-label.example.json
```

See [the branding instructions](../docs/WHITE_LABEL.md). The two editorial cover images, `assets/photos/cover-operator.png` and `assets/photos/cover-user.png`, can be replaced with public images using those names. They are illustrations, not evidence of tested phones or captured product UI. The bundled font retains its license under `assets/fonts/`. Use a local font file for consistent PDF embedding; otherwise Chromium uses an installed font matching `fontFamily`.
