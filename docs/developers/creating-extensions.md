# Create and package an extension

This tutorial builds a trusted API v1 extension outside the workspace. It contributes
a policy-declared screen timeout as a typed action. Invocation prepares a reviewed
plan; only separate exact-reviewed execution changes a phone.

Use [the reference](extension-reference.md) for full limits and contribution rules.
Authoring/build steps need no phone. Host installation needs a private project;
invocation needs an enrolled authorized target and the matching policy.

## Enable extension development explicitly

Community’s `product.json` has `features.extensions: false`: install, update,
policy selection, and invocation are refused. Use a separately reviewed development
product/fork. In its descriptor, preserve the other fields and explicitly set:

```json
{
  "features": { "extensions": true, "seedvault": false }
}
```

The [branding scaffold](distribution.md#scaffold-a-reviewable-fork) can generate
this configuration through `product.features`. Use the fork’s own product/command
identity and resource root. Descriptor changes change reviewed identity; initialize
a distinct development project for a new product, and renew locks and reviews for
existing compatible project configuration changes. Do not reuse Community approvals.

Run all install/update commands on the native host, including when using MCP.
Container-hosted install/update is refused before archive acquisition. Extensions
execute trusted code; worker separation is not a hostile-code sandbox.

## Prepare public packages and an external author directory

From the pxv checkout with the [pinned toolchain](build.md), pack the public packages:

```sh
pnpm build
mkdir -p /tmp/pxv-sdk
pnpm --filter @pxv/contracts pack --out /tmp/pxv-sdk/contracts.tgz
pnpm --filter @pxv/extension-sdk pack --out /tmp/pxv-sdk/extension-sdk.tgz
```

Create a fresh author directory **outside** the checkout, for example
`/absolute/private/extension-author`. Create its `package.json`:

```json
{
  "name": "example-extension-author",
  "private": true,
  "type": "module"
}
```

From that directory, install the exact local packages and build tools:

```sh
pnpm add --save-dev /tmp/pxv-sdk/contracts.tgz /tmp/pxv-sdk/extension-sdk.tgz \
  esbuild@0.28.2 typescript@7.0.2
mkdir -p src package/dist
```

Retain the authoring lockfile. This author manifest and its dependencies are not
the installation manifest shipped to operators. Use the compiler package here;
the workspace’s separate TypeScript 6 API dependency is for linting, not this CLI.

## Start with the SDK shape

A minimal `src/index.ts` can demonstrate the entry point:

```ts
import { defineExtension } from '@pxv/extension-sdk';

export default defineExtension({
  apiVersion: 1,
  commands: { prepare: () => [] },
});
```

This is only a compile/import smoke example. The engine rejects empty contributed
plans. Replace it with the following useful action before invocation.

## Contribute a policy-bound action

Use the public `Action` type and return plain JSON actions:

```ts
import { defineExtension, type Action } from '@pxv/extension-sdk';

export default defineExtension({
  apiVersion: 1,
  commands: {
    'screen-timeout.v1': (): readonly Action[] => [
      {
        kind: 'setting',
        profileId: 'owner',
        setting: {
          namespace: 'system',
          key: 'screen_off_timeout',
          value: '60000',
        },
      },
    ],
  },
});
```

The selected policy must contain an existing profile with ID `owner` and the exact
setting under its `settings` array:

```json
{
  "namespace": "system",
  "key": "screen_off_timeout",
  "value": "60000"
}
```

Merge this setting into the complete policy rather than replacing the profile with
the fragment. Validate and lock the resulting project. An extension cannot introduce
an undeclared setting, arbitrary command, or device target. Avoid secret-bearing
input/actions; private account setup remains a human checkpoint.

For an integration adapter, export a separate module using
`defineIntegrationAdapter((_input) => actions)` and declare its bundle path in
`contributions.adapters`. It proposes actions through the same validation/review path.

## Typecheck and bundle

From the author directory:

```sh
pnpm exec tsc --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext \
  --target ES2023 --noEmit src/index.ts
pnpm exec esbuild src/index.ts --bundle --packages=bundle --platform=node \
  --format=esm --outfile=package/dist/index.js
```

Bundle the SDK and authoring libraries into the JavaScript. Inspect bundler output
for unresolved package imports and keep resources declared and contained. The
installed bundle must work after removing the author’s source/dependencies.

Create `package/package.json` with no scripts or dependency fields:

```json
{
  "name": "example-screen-timeout",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js"
}
```

Create `package/pxv-extension.json`:

```json
{
  "schemaVersion": 1,
  "id": "example-screen-timeout",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "dist/index.js",
  "contributions": {
    "commands": ["screen-timeout.v1"],
    "policyPacks": [],
    "guides": [],
    "adapters": []
  }
}
```

Identity, version, and entry must match the installation manifest. Declare any
policy/guide/adapter files before using them. Commands must be both declared names
and own function properties; a path outside the verified bundle is invalid.

```sh
tar -czf example-screen-timeout-0.1.0.tgz package
```

Package only the staged `package` tree. Exclude author dependencies, private state,
tokens, credentials, and signing material. The installer runs no lifecycle scripts
or dependency resolution.

## Install, inspect, and prepare a plan

Use the extension-enabled product’s executable for `pxv` in these examples, or
supply its explicit resource root consistently. Start with its private project and
separately enrolled canary; see [single-device preparation](../operators/single-device.md).

```sh
P='/absolute/private/extension-project'
pxv extension install --project-root "$P" \
  --file /absolute/private/extension-author/example-screen-timeout-0.1.0.tgz
pxv extension list --project-root "$P"
pxv extension inspect --project-root "$P" --extension example-screen-timeout
pxv policy validate --project-root "$P"
pxv policy lock --project-root "$P"
pxv extension invoke --project-root "$P" --extension example-screen-timeout \
  --command screen-timeout.v1 --asset canary-01 --json
```

Installation updates the exact project extension lock and invalidates old approvals.
Inspection verifies the pinned bundle. Invocation returns a prepared plan with
`planId`, exact `reviewSummary`, and expiry. It does not execute the setting.
If the profile/setting does not match policy, correct and review the policy or
extension instead of bypassing validation.

Capture invocation output into a new private file if automating. Follow
[the exact review-file procedure](../ai-agents/cli-automation.md), using that
invocation result rather than preparing an unrelated provisioning plan. Read the
target/action/expiry, save the decoded summary without adding a newline, then:

```sh
pxv agent execute --project-root "$P" --plan PLAN_ID \
  --review-file /absolute/private/review.txt --operator 'Operator name'
pxv agent status --project-root "$P" --run RUN_ID --after 0 --json
```

Finish any named manual gates and inspect retained failures. A successful extension
run does not by itself complete provisioning or certify handoff readiness.

## Update or distribute explicitly

Bump both manifest versions together, rebuild a new archive, review changed code,
then use `extension update --extension example-screen-timeout --file NEW.tgz`.
Validate/lock the project and review new plans. Nothing implicitly updates an
installed bundle; invocation works offline with verified local bytes.

Registry installation uses exact package/version and an explicit HTTPS registry.
Keep `PXV_REGISTRY_TOKEN` in external host configuration; never include it in the
tarball, policy, lock, or image. See [installation and trust limits](extension-reference.md).
Source forks and public SDK promotion follow [distribution](distribution.md).

Before shipping, run the relevant [extension checks](testing.md), including the
existing external-consumer test that packs declarations, typechecks outside the
workspace, bundles the SDK, removes author dependencies, and invokes offline.
Verify unsupported APIs, undeclared contributions, malformed results, and changed
bundle bytes are rejected. Use an authorized canary for actual device acceptance.
