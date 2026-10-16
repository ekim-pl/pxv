# White-label forks

A white-label product is a separate fork. Keep one build-time `product.json` as the product identity: ID/name, executable command, npm package, Debian package, image repository, upstream engine version/API, public assets, default policy and support contact. The fork owns its manifests, configuration templates and documentation. Keep the upstream engine/API marker and shared safety regressions when merging updates.

## Create the first product

1. Fork the Community repository and retain MIT attribution and third-party notices.
2. Copy the example descriptor in `config/templates` into `product.json` and choose unique IDs/package/image/command names. Replace sample support addresses before release.
3. Add approved public assets under `assets`, policies under `policy-packs` or `manifests`, and configuration templates under `config/templates`. Declare assets/defaultPolicy with contained relative paths.
4. Select exactly one owner and the secondary users your use case needs. Add authenticated OS/APK/repository trust material, permissions/settings/network/backup requirements and human checks. Do not invent pins to make a template look complete.
5. Validate policy, build a uniquely named preview and exercise the complete operator/recipient workflow with an isolated project and a disposable canary.
6. Retain exact-build EN/PL, restore/network and physical acceptance evidence before promising a hardened deployment. Refresh it after relevant updates.

~~~sh
pnpm check
pnpm test
pnpm build:preview --formats portable,deb,npm,oci
~~~

The preview records a dirty-tree content digest, has unique command/package/image identities, and uses a separate project by default. Portable archives/DEBs include Node and the supervisor; npm requires the pinned Node runtime. Ordinary builds do not publish or replace stable launchers.

## Commercial boundary

Community includes the local workflow for free. Keep commercial extension sources in private repositories and distribute compiled exact-version tarballs through an authenticated private registry. Do not fork the core merely to add activation checks. Extensions are trusted code; registry access controls distribution, not runtime activation.

A fork must keep the same per-operator control domain as Community/other forks/previews when reaching the same physical phones. Branding must not create an independent lock namespace that allows two products to mutate one device concurrently.

Product assets and policy examples are public distribution inputs. Never place live inventory, recipient values, registry tokens or helper signing keys in those directories. Review the frozen candidate allowlist, source/toolchain provenance and signed artifacts before promotion. See [extensions](EXTENSIONS.md) and [publication](PUBLICATION_CHECKLIST.md).
