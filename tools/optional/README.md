# Optional source tooling

The default product focuses on Pixel OS installation and profile/app configuration.
These tools remain available for explicit use from a source checkout:

- [branding/scaffold.mjs](branding/scaffold.mjs): white-label fork scaffolding, run
  with `pnpm whitelabel:scaffold` after building the contracts.
- [publishing/rebuild.mjs](publishing/rebuild.mjs): operator/recipient guides in English and Polish, PDF exports and document QA.
  `pxv guides rebuild` builds the renderer and calls this script directly. No print renderer runs
  during ordinary provisioning, and publishing scripts are not packaged as runtime resources.

Experimental Seedvault orchestration lives in
`packages/engine/src/experimental/seedvault` and is loaded on demand. It is disabled
by the pxv product's `features.seedvault: false`. A reviewed recovery-enabled
product descriptor can opt in; no production UI adapter is qualified by this change.
Historical reports, inspected cleanup, reservations and source records are retained.

Registry-backed extensions and the public authoring SDK remain compatibility
components. `features.extensions: false` disables installing/invoking them in the
core product and rejects mutation of projects that still require extensions. Listing,
inspection and explicit removal remain available. A reviewed product descriptor can
opt into either optional system. Descriptors without `features` preserve legacy behavior.
Changing product features changes reviewed identity; prepare fresh policy locks and
plans. Never remove old records or recovery material to bypass a refusal.

Portable is the default distribution. OCI, Debian, npm and experimental SEA require
an explicit `--formats` selection. CI keeps portable/OCI execution checks on ordinary
changes; manual/tag builds run the broader compatibility matrix. Compatibility formats
are retained to let existing installations migrate without repackaging the execution core.
