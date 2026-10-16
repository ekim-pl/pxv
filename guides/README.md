# Current EN/PL guides

Six A4 guides describe the TypeScript 0.1.0 application: product, operator and recipient in English and Polish. The Markdown sources in [source/markdown](source/markdown) are authoritative. Generated PDFs are ignored build outputs and are not stored in Git; build them locally from the current sources and product assets. PDFs are general qualification drafts, not device certificates. Device-specific handoff packets come from the accepted project snapshot.

> **Branding note:** Generate your product's PDFs from its white-label fork after updating the descriptor, EN/PL guide sources and guide assets. Changing the descriptor's logo alone does not brand the guides. Follow [Generate PDFs with your branding](#generate-pdfs-with-your-branding) below; keep the generated PDFs out of Git.

## Rebuild

Rebuilding requires the matching product's source checkout. Installed distributions include the public guide sources, assets, navigation and build records; the development renderer, test suite and toolchain belong to the source checkout. Source-code links below refer to that checkout.

Prepare the pinned workspace and pass the source quality gate before revising and rebuilding the guides:

```sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build:native
pnpm build
pnpm quality
PXV_CHROMIUM=/usr/bin/google-chrome ./guides/rebuild.sh
```

Dependency installation and `quality:setup` are explicit setup steps. The latter installs pinned analysis tools; the subsequent quality gate runs offline. Its source identity, tool versions and evidence are recorded in `.quality/report.json` and `.quality/report.md`. See the operator editions for the developer quality requirements and [host dependencies](../docs/HOST_DEPENDENCIES.md) for the Java, Android SDK and native build prerequisites.

The wrapper works from any directory. It uses the Node Markdown/HTML pipeline and explicit Chromium for PDF, then Poppler for page metadata, UTF-8 text extraction and every-page raster QA. It does not install dependencies or download browsers. Use `--output-dir DIRECTORY` for an isolated rebuild, `--html-only` to omit PDF, or `--no-render` to omit page PNGs. A Node 24.22.0 runtime, pinned workspace packages and the selected Chromium executable are required; Poppler is needed for PDF QA.

Outputs are product-en.pdf, product-pl.pdf, operator-en.pdf, operator-pl.pdf, user-en.pdf and user-pl.pdf. HTML remains alongside them for accessible reading and review. Raster QA and hashes live under `qa/` in the selected output directory. The default `guides/qa/` directory is entirely ignored by Git, including page images, extracted text, manifests and review records. Retain reviewed QA evidence with its matching release artifacts rather than committing it. No PDF/X, printer ICC, commercial print-proof or physical-device qualification is claimed.

## Generate PDFs with your branding

Work in the product's fork, following [white-label setup](../docs/WHITE_LABEL.md), and complete the prerequisites above. Branding is read from the fork's files at build time; there is no `--brand` option or runtime theme download.

1. Edit [product.json](../product.json) for the product's name, command/package identities, support details and public assets. The general guide renderer automatically uses `name` in the HTML title and edition header and `upstreamVersion` in the edition header. Preserve the upstream engine version/API markers. Other descriptor fields do not automatically replace guide text or insert a logo.
2. Customize all six [Markdown editions](source/markdown): headings, product references, command examples, support details and EN/PL wording. Keep the six EN/PL editions; the wrapper requires exactly six outputs, and the examples below use the existing filenames. Update the editable diagrams in [guide assets](assets/diagrams) as needed, and refresh CLI captures and their provenance/hashes using the fork's built CLI. Keep MIT attribution, third-party notices and asset/font licenses.
3. Put the approved public logo under `guides/assets/`, for example `guides/assets/brand-logo.svg`, and reference it in each applicable Markdown edition as `![Your product](../../assets/brand-logo.svg)`. The generator copies `guides/assets/` into the output and rewrites those image paths. A logo referenced only by `product.json` under the repository's top-level `assets/` is not automatically included in general guide PDFs.
4. For a fully customized visual layout, review the inline styles and `footerTemplate` in [the general guide renderer](../packages/release/src/docs.ts). Its current PDF footer contains fixed Community text; update that template in the fork if it needs the product name. Retain the qualification status and engine identity. Font changes also require updating the rebuild script's font verification and checking Polish glyphs; the current QA expects DejaVuSans.

After saving the branding changes, run from the fork root:

```sh
pnpm build
PXV_REQUIRE_CRYPTO=1 pnpm quality
PXV_CHROMIUM=/usr/bin/google-chrome ./guides/rebuild.sh \
  --output-dir "$PWD/.pxv-preview/branded-guides"
```

Use the reviewed local Chromium executable's actual path. This generates the six PDF/HTML editions, copied guide assets and `qa/manifest.json` with page renders under `.pxv-preview/branded-guides/`. Edition filenames stay `product-en.pdf`, `product-pl.pdf`, `operator-en.pdf`, `operator-pl.pdf`, `user-en.pdf` and `user-pl.pdf`; branding changes their content, not those filenames. Choose another output directory if needed.

Inspect every rendered page, especially the logo, product name, footer, translated support details, command examples and page breaks. Confirm both languages use the intended branding and that no private values appear. Retain reviewed PDFs with the corresponding release artifacts; commit the source, asset and template changes only. `.pxv-preview/` and generated `*.pdf` files are ignored. The rebuild wrapper itself does not run the source quality gate or certify device acceptance.

Device-specific handoff documents use the product and policy snapshot accepted for that project. Editing the current fork's branding does not rewrite an already accepted handoff snapshot; see [operator signoff and custody](../docs/OPERATOR_GUIDE.md#signoff-and-custody).

## Sources and assets

Diagrams are editable SVG concepts, not UI captures. The [CLI capture manifest](assets/cli/manifest.json) binds the current [`pxv --help` capture](assets/cli/overview.txt) to its content hash. The three DejaVu fonts retain their upstream license beside the font files. No real recipient screenshots, serial numbers, credentials or recovery values belong in this directory.

The static [index](index.html) links the six editions' tracked Markdown sources and locally generated PDF/HTML outputs. PDF/HTML links become available after rebuilding into this directory; a fresh checkout contains no PDFs. Use `--output-dir` for customized outputs elsewhere and retain reviewed PDFs with the applicable release artifacts rather than committing them. [Build instructions](source/BUILD.txt), [build manifest](source/build-manifest.json) and [release gates](source/release-gates.json) distinguish document QA from live acceptance. The current source refactor has offline verification only; historical Pixel evidence applies to the candidate named in its original record. Rebuilding these guides does not extend that evidence to a newer build. Keep actual emulator/Pixel acceptance evidence in the private project and controlled release records.

Historical verification records may name paths under `guides/qa/`. Those references describe evidence for the recorded candidate, not files supplied by a fresh checkout. Preserve the corresponding retained artifacts and original records; a new local render does not replace that historical evidence.
