# Guide sources, branding and print files

The Markdown under [source/markdown](source/markdown) is authoritative. Four guide types are available in English and Polish: product, operator, user and business fleet. The renderer creates eight accessible HTML editions and sixteen PDFs. Generic guides are qualification drafts, not device certificates. Only an accepted project record identifies the policy, software, checks and custody outcome for a particular phone.

The generated PDFs and HTML are build outputs, ignored by Git. Keep reviewed copies with the matching release artifacts. Do not commit customer-specific or device-specific evidence here.

## Rebuild from the source checkout

The current source checkout includes the renderer and its developer toolchain; installed builds do not. From the checkout, use:

```sh
pxv guides rebuild --chromium /usr/bin/google-chrome
```

The command runs `pnpm build` automatically, then calls the existing `guides/rebuild.sh` pipeline. For a workspace invocation use `pnpm pxv guides rebuild --chromium /usr/bin/google-chrome` after installing dependencies. The command is handled before project initialization, so it does not require a `pxv.project.json` or device connection.

If Chromium is already configured, set `PXV_CHROMIUM` instead of passing `--chromium`. The rebuild does not download a browser. The source checkout requires the pinned Node/pnpm versions; PDF checks require Poppler (`pdfinfo`, `pdftotext`, `pdffonts`, `pdftoppm`).

```sh
pxv guides rebuild [--output-dir DIR] [--chromium PATH] [--html-only] [--no-render]
```

`--output-dir` selects an alternate output directory. `--html-only` writes HTML without launching Chromium. `--no-render` still inspects the PDFs with Poppler but skips page PNGs. For the full page-by-page evidence, leave it off.

The existing wrapper remains available for release tooling:

```sh
PXV_CHROMIUM=/usr/bin/google-chrome ./guides/rebuild.sh
```

The rebuild does not install project dependencies, install Poppler, run the full source quality gate, contact devices or publish files. For source edits, follow the [contributor quality workflow](../CONTRIBUTING.md) before distributing the output.

## Editions and print modes

Each Markdown edition writes one HTML file and two PDFs:

| Edition | HTML | Office PDF | Print PDF | Markdown |
| --- | --- | --- | --- | --- |
| Product EN | `product-en.html` | `product-en-office.pdf` | `product-en-print.pdf` | [source](source/markdown/product-en.md) |
| Product PL | `product-pl.html` | `product-pl-office.pdf` | `product-pl-print.pdf` | [source](source/markdown/product-pl.md) |
| Operator EN | `operator-en.html` | `operator-en-office.pdf` | `operator-en-print.pdf` | [source](source/markdown/operator-en.md) |
| Operator PL | `operator-pl.html` | `operator-pl-office.pdf` | `operator-pl-print.pdf` | [source](source/markdown/operator-pl.md) |
| User EN | `user-en.html` | `user-en-office.pdf` | `user-en-print.pdf` | [source](source/markdown/user-en.md) |
| User PL | `user-pl.html` | `user-pl-office.pdf` | `user-pl-print.pdf` | [source](source/markdown/user-pl.md) |
| Business fleet EN | `b2b-en.html` | `b2b-en-office.pdf` | `b2b-en-print.pdf` | [source](source/markdown/b2b-en.md) |
| Business fleet PL | `b2b-pl.html` | `b2b-pl-office.pdf` | `b2b-pl-print.pdf` | [source](source/markdown/b2b-pl.md) |

Office PDFs use A4 pages, a low-ink layout, and page numbers. Print PDFs have full-color branded pages, photo covers and selected color section openers. Their physical media is 216 × 303 mm, with an A4 `TrimBox` inset by 3 mm on every edge. The cover and marked section openers extend color into that bleed. The document is not PDF/X, does not specify an ICC profile, and is not a commercial printer proof.

The QA manifest records hashes, language, embedded fonts, Polish glyph presence, page sizes, trim/bleed boxes, text extraction and raster paths for every generated page. Review every page image before distribution; automated checks do not determine whether a layout is visually acceptable. `guides/index.html` provides the static output index.

## Fork branding and the starter policy

The guide theme is [brand.json](assets/brand.json). It supplies a brand name, three colors, a font family, and optional local logo/font paths. Keep its `brandName` equal to `product.json.name`. Cover photos are public editorial assets under [assets/photos](assets/photos) and can be replaced while preserving `cover-product.png`, `cover-operator.png`, `cover-user.png` and `cover-b2b.png` filenames.

Create a product identity, branded guide theme and an empty device starter from a versioned configuration:

```sh
pnpm whitelabel:scaffold -- --config ./brand/acme.json
```

The command validates `product.json`, policy and project objects against the existing schemas. It defaults to the `simple` policy, which contains no app pins, extra permissions, settings or VPN. `reference-five` can be selected explicitly. The Community `product.json` remains on `reference-five` unless the scaffold command is deliberately run in that checkout. See [the white-label guide](../docs/WHITE_LABEL.md) and [the example config](../config/templates/white-label.example.json).

To generate the guides for the resulting brand, rebuild from its source checkout after review. A custom font file must be local for consistent embedding; without it, Chromium uses an installed font matching `fontFamily`. The optional logo and font are copied to public `guides/assets/`. Never add customer data, secrets, device identities, or recovery values to the theme or guide sources.

## Sources and evidence boundaries

The [diagrams](assets/diagrams) are editable SVG concepts, not UI captures. The [CLI capture manifest](assets/cli/manifest.json) binds the help capture to its content hash. The DejaVu fonts retain their upstream license next to the font files. The cover photos are generated editorial imagery, not photographs of tested phones or product UI.

Guide output proves document generation and selected text/font/page-box checks only. It does not establish that a policy is qualified, that a Seedvault dataset is restorable, or that a live phone was accepted. The historical Pixel record applies only to the candidate identified in its original evidence. Rebuilding guides does not extend that acceptance. See [build instructions](source/BUILD.txt), [build manifest](source/build-manifest.json), [release gates](source/release-gates.json), and the [canary and recovery runbook](../docs/CANARY_BACKUP_RECOVERY.md).
