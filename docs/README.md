# pxv documentation

This documentation describes the TypeScript 0.1.0 Community engine. Linux x86_64 is the initial target. The free MIT-licensed toolkit supports local projects, reviewed provisioning, recovery, CLI/MCP automation, maintenance and white-label forks. Commercial capabilities arrive as explicitly installed extensions from private repositories and registries.

Start with [operator quickstart](OPERATOR_QUICKSTART.md), [host dependencies](HOST_DEPENDENCIES.md) and [command reference](COMMAND_REFERENCE.md). Recipients should use [user quickstart](USER_QUICKSTART.md), [user guide](USER_GUIDE.md) and [FAQ](USER_FAQ.md). The eight EN/PL editions across product, operator, user and business fleet in [guides](../guides/README.md) are generated from Markdown. Maintainers creating a branded fork should start with [white-label setup](WHITE_LABEL.md).

For operators: [complete workflow](OPERATOR_GUIDE.md), [fleet work](FLEET.md), [network policies](NETWORK_POLICIES.md), [Docker](DOCKER.md), [direct USB](DOCKER_OPERATOR_QUICKSTART.md), [host ADB](DOCKER_HOST_ADB_QUICKSTART.md), [agent](AGENT.md) and [MCP automation](AUTOMATION.md).

Before testing a phone or rehearsing recovery, use [canary testing, backups and device recovery](CANARY_BACKUP_RECOVERY.md). It covers disposable test devices, protected reference/master phones, primary/master phones with real data, phone-data restoration and private operator-state backups.

For personal multi-profile recovery, use the [example scripts](../scripts/examples/README.md) and [supervised Seedvault automation](SEEDVAULT_AUTOMATION.md). Exact-build live adapter qualification remains a prerequisite.

For maintainers: [architecture](ARCHITECTURE.md), [development testing](TESTING.md), [live acceptance](E2E_TESTING.md), [verification](VERIFICATION.md), [publication gates](PUBLICATION_CHECKLIST.md), [release notes](RELEASE_NOTES.md) and [privacy](SECURITY_PRIVACY_GUIDE.md).

The strict component gate is `pnpm quality` after the explicit `pnpm quality:setup` and native build. Its generated `.quality/` reports bind tests, complexity, complete worker/release coverage and dependency findings to the checked source. Read [testing](TESTING.md) for setup and [verification](VERIFICATION.md) for the boundary between current offline results and historical physical fixture evidence.

Development, CI and guide-rebuild instructions require the matching product's source checkout. Source-code links refer to that checkout; installed distributions carry the public operator/recipient documentation, guide sources/assets and guide build records without a development toolchain.

pxv 0.1.0 is undergoing release qualification. Automated tests, artifact verification and container checks do not certify a policy pack, UI recipe, recipient workflow or physical phone. Verified GrapheneOS emulator evidence, exact-build EN/PL walkthroughs and a physical Pixel 8a acceptance record must be retained before making a deployment claim. A stock Google APIs emulator is useful for compatibility tests and cannot supply GrapheneOS provenance.

Commands below use the Community executable `pxv`. A fork uses its product descriptor's command. Source checkouts can replace that prefix with `pnpm pxv` after building. Preview archives expose a unique preview command and choose a separate project by default. Always pass an explicit project root for real devices.

Product maintainers should also read [white-label forks](WHITE_LABEL.md) and [extension authoring](EXTENSIONS.md).
