# Current EN/PL guides

Six A4 guides describe the TypeScript0.1.0 application: product, operator and recipient in English and Polish. The Markdown sources in [source/markdown](source/markdown) are authoritative. PDFs are general qualification drafts, not device certificates. Device-specific handoff packets come from the accepted project snapshot.

## Rebuild

From a prepared pinned workspace, run:

~~~sh
pnpm install --frozen-lockfile
pnpm build
PXV_CHROMIUM=/usr/bin/google-chrome ./guides/rebuild.sh
~~~

The wrapper works from any directory. It uses the Node Markdown/HTML pipeline and explicit Chromium for PDF, then Poppler for page metadata, UTF-8 text extraction and every-page raster QA. It does not install dependencies or download browsers. Use `--output-dir DIRECTORY` for an isolated rebuild, `--html-only` to omit PDF, or `--no-render` to omit page PNGs. A Node24.22.0 runtime, pinned workspace packages and the selected Chromium executable are required; Poppler is needed for PDF QA.

Outputs are product-en.pdf, product-pl.pdf, operator-en.pdf, operator-pl.pdf, user-en.pdf and user-pl.pdf. HTML remains alongside them for accessible reading and review. Raster QA and hashes live under `qa/` in the selected output directory. No PDF/X, printer ICC, commercial print-proof or physical-device qualification is claimed.

## Sources and assets

Diagrams are editable SVG concepts, not UI captures. The only CLI capture is current `pxv --help`, with a content hash. The unused existing blank-phone cover illustration is decorative AI artwork; its provenance record explicitly excludes it from evidence. Fonts retain their upstream licenses. No real recipient screenshots, serial numbers, credentials or recovery values belong in this directory.

The static [index](index.html) links the six editions. [Build instructions](source/BUILD.txt), [build manifest](source/build-manifest.json) and [release gates](source/release-gates.json) distinguish document QA from live acceptance. Keep actual emulator/Pixel acceptance evidence in the private project and controlled release records.
