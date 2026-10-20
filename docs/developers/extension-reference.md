# Extension API, bundles, and execution boundaries

For a complete first build, follow [creating extensions](creating-extensions.md). This reference defines API v1 packaging, contribution, installation, and worker constraints.

This is an optional compatibility subsystem. The default Community descriptor sets
`features.extensions: false`: listing, inspection, guide reading and explicit removal
remain available, while installation and invocation are refused. Use an explicitly
extension-enabled product descriptor for the workflow below. Changing product
identity requires fresh locks and reviews; existing extension references are never
silently ignored. See [optional tooling](../../tools/optional/README.md).

Extensions provide commands, declared policy packs, guides and integration adapters. Community does not contact an activation server. A commercial publisher keeps source private and distributes an exact compiled bundle through an authenticated npm-compatible registry. Operators can also install local tarballs for testing. Installation and updates
require native host execution; Docker workers and container-hosted MCP reject those
operations before downloading or opening an archive. Other permitted extension
operations retain their existing review requirements and read-only bundle mounts.

## Operator workflow

```sh
pxv extension install --project-root "$P" --file /private/build/example-extension.tgz --yes
pxv extension list --project-root "$P"
pxv extension inspect --project-root "$P" --extension example-extension
pxv extension invoke --project-root "$P" --extension example-extension \
  --command prepare --asset lab-01 --input-file "$P/input.json"
```

Registry installation uses `--package NAME --version EXACT --registry HTTPS`. The CLI reads authentication from the external `PXV_REGISTRY_TOKEN` environment variable; never write it into a policy, lock, candidate or image. The installer authenticates only to the configured registry, validates package identity/API/content integrity, rejects unsafe archive entries, and runs no lifecycle scripts or dependency resolution. Normal invocation works offline and never implicitly updates an extension.

Installation updates the project's exact extension lock and invalidates prior policy approvals. Write/review a new policy lock before device work. `update --extension ID` is explicit and also needs `--file NEW.tgz` or `--package NAME --version EXACT --registry HTTPS`. npm artifact promotion uses external npm authentication/configuration, not this extension-install token. `remove --extension ID` removes the project reference; shared installed bytes may remain for other projects. Missing, changed or incompatible bundles fail closed.

`invoke` and integration adapters produce validated typed core actions, then prepare an ordinary reviewed plan. Device changes do not execute as an unreviewed shortcut. Declared policy/guide contributions are accessed by their contained metadata paths; selecting a policy requires explicit confirmation and a renewed lock/review.

## Bundle format

The published tarball contains ESM JavaScript, `package.json`, `pxv-extension.json` and its declared public contribution files. Package identity/version/main must match extension metadata. The installed package must have no scripts or runtime/dev/optional/peer/bundled dependencies. Bundle the SDK and any dependencies during the publisher's build; source devDependencies belong outside the published installation manifest.

```json
{
  "name": "example-extension",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js"
}
```

```json
{
  "schemaVersion": 1,
  "id": "example-extension",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "dist/index.js",
  "contributions": {
    "commands": ["prepare"],
    "policyPacks": [],
    "guides": [],
    "adapters": []
  }
}
```

Author against the versioned public `@pxv/extension-sdk` and `@pxv/contracts` packages. A minimal entry is:

```ts
import { defineExtension } from '@pxv/extension-sdk';
export default defineExtension({
  apiVersion: 1,
  commands: { prepare: () => [] },
});
```

An empty action list is an authoring smoke example, not a provisioning policy. For real actions, use the public contracts and let the engine validate them against the selected policy. Integration adapters must also return typed planned actions. Do not place recipient credentials in returned actions or extension inputs.

SDK definitions and host validation share the API v1 contracts and command-name rules. Existing v1 names such as `prepare.v1` remain valid. A command must be both declared in metadata and an own function in the extension definition; inherited properties are not handlers. The SDK helpers freeze their returned definitions. Public JavaScript and type-declaration entry points are retained for external consumers.

Publish SDK/contracts locally with the pinned workspace pack commands before registry promotion:

```sh
pnpm build
pnpm --filter @pxv/contracts pack --pack-destination /tmp/pxv-sdk
pnpm --filter @pxv/extension-sdk pack --pack-destination /tmp/pxv-sdk
```

The external-consumer test packs these public packages, typechecks an author outside the workspace, bundles the SDK into an extension, then removes author dependencies and invokes the installed bundle offline. Follow that same separation between authoring dependencies and the dependency-free installed manifest.

Worker separation limits crashes and resource usage; it is not a hostile-code sandbox. Review authors and code as part of choosing an extension. Registry integrity proves the selected package bytes, not the safety of their behavior.

Worker inputs and results each have a 1 MiB JSON budget and a nesting limit of 64. Values must be finite plain JSON without cycles, symbol keys or sparse/decorated arrays. Results contain at most 10,000 validated core actions; preparing an extension plan further limits contributions to 1,000 actions. Invocation defaults to 30 seconds and accepts a maximum of 300 seconds. Workers have a 128 MB V8 old-generation limit, a minimal environment, and suppressed stdout/stderr; arbitrary extension failures receive a generic error. These limits do not bound all host resources or remove trusted code's filesystem access.

Default installation limits are 25 MiB compressed, 100 MiB expanded and 10,000 archive entries. Rejected archives stop streaming. Registry authentication is sent only to the configured HTTPS origin and is not forwarded to another origin on redirect.

## Declared contribution commands

```sh
pxv extension guide --project-root "$P" --extension example-extension --contribution guides/intro.md
pxv extension policy --project-root "$P" --extension example-extension --contribution policies/example.json --yes
pxv policy lock --project-root "$P" --yes
pxv extension adapter --project-root "$P" --extension example-extension \
  --contribution adapters/example.js --asset lab-01 --input-file "$P/input.json"
```

Paths must be declared in the installed metadata and remain contained in the verified bundle. Policy selection writes the project policy and requires a renewed lock. An adapter returns a reviewed plan; save its exact reviewSummary and use agent execute after review. Author an adapter module with the bundled SDK:

```ts
import { defineIntegrationAdapter } from '@pxv/extension-sdk';
export default defineIntegrationAdapter((_input) => []);
```

The empty action list is only an SDK shape example. Real adapters return typed core actions and cannot bypass policy validation or the review gate.
