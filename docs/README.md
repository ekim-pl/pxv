# Documentation

The canonical workflows are the English and Polish guides:

| Audience | English | Polski |
| --- | --- | --- |
| Operator: one Pixel or a local fleet | [Operator guide](../guides/source/markdown/operator-en.md) | [Instrukcja operatora](../guides/source/markdown/operator-pl.md) |
| Recipient: setup, acceptance and daily use | [User guide](../guides/source/markdown/user-en.md) | [Instrukcja użytkownika](../guides/source/markdown/user-pl.md) |
| A5 device quick start and configuration | [Quick start](../guides/source/markdown/quickstart-en.md) | [Szybki start](../guides/source/markdown/quickstart-pl.md) |
| Private A5 credential insert template | [Credential insert](../guides/source/markdown/credentials-en.md) | [Wkładka z danymi dostępu](../guides/source/markdown/credentials-pl.md) |

Use `pxv guide operator|recipient --locale en|pl` to read the installed guide.
`pxv guide project` renders requirements from the selected project's policy.
See [guide sources and rebuilding](../guides/README.md) for generated editions.
Use `pxv guides rebuild --policy FILE --output-dir DIRECTORY --chromium PATH`
to generate variable A5 editions for an installation's GrapheneOS user profiles.
They include paired blank ordinary credential and recovery sheets per profile; the accepted
handoff report remains the record of the actual device.

## Operation and configuration

- [Host dependencies](HOST_DEPENDENCIES.md): supported tools, explicit ADB services and native runtime.
- [Command reference](COMMAND_REFERENCE.md): command families and exact selectors.
- [Policy format](POLICY_FORMAT.md): authoring, shared apps and per-model OS pins.
- [Encrypted phone registry](PHONE_REGISTRY.md): private credentials, history, retrieval and restore reconciliation.
- [Network policies](NETWORK_POLICIES.md): VPN ordering and the limits of measured network evidence.
- [Automation and MCP](AUTOMATION.md): exact reviews, durable runs, pauses and local automation.
- [Docker](DOCKER.md): direct USB, host ADB and container/service ownership.
- [Canary, backup and recovery](CANARY_BACKUP_RECOVERY.md): live acceptance, protected phones, restore drills and interrupted operations.
- [Security](../SECURITY.md): trust, privacy and vulnerability reporting.

## Development and distribution

- [Architecture](ARCHITECTURE.md): contracts, services, storage and safety boundaries.
- [Testing](TESTING.md): development loop, strict quality gates and retained evidence.
- [Verification](VERIFICATION.md): evidence boundaries and deployment qualification.
- [Publication checklist](PUBLICATION_CHECKLIST.md): immutable candidates, signatures and explicit promotion.

## Optional systems

The Community descriptor disables extensions and experimental Seedvault recovery.
These pages describe explicitly enabled products; they do not imply those features
are active or qualified in Community:

- [Trusted extensions and SDK](EXTENSIONS.md).
- [Seedvault recovery](SEEDVAULT_AUTOMATION.md) and [personal recovery tooling](SEEDVAULT_AUTOMATION.md#personal-recovery-tool).
- [White-label forks](WHITE_LABEL.md) and [optional source tooling](../tools/optional/README.md).
