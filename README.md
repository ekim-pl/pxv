# pxv Community

A local CLI and MCP toolkit for preparing one Google Pixel or a small fleet with
GrapheneOS, predefined Android user profiles, pinned apps and reviewed configuration.
Linux x86_64 is the initial platform. Community is free under the [MIT license](LICENSE).

A fleet is a local inventory with bounded parallel execution, independent phone
state and inspected recovery. It does not provide remote MDM or cross-workstation
locking. OS installation is a separate destructive phase; private app setup and
physical confirmations remain explicit checkpoints.

## Guides

Preparing and using your own phone? Follow the English
[self-managed phone guide](docs/SELF_MANAGED_PHONE.md) for one person acting as both
operator and end user, with Owner-only or multiple Android profiles.

| Audience | English | Polski |
| --- | --- | --- |
| Operator: single phone and fleet | [Operator guide](guides/source/markdown/operator-en.md) | [Instrukcja operatora](guides/source/markdown/operator-pl.md) |
| Recipient | [User guide](guides/source/markdown/user-en.md) | [Instrukcja użytkownika](guides/source/markdown/user-pl.md) |
| A5 guide supplied with each device | [Quick start](guides/source/markdown/quickstart-en.md) | [Szybki start](guides/source/markdown/quickstart-pl.md) |
| Private A5 insert template | [Credential insert](guides/source/markdown/credentials-en.md) | [Wkładka z danymi dostępu](guides/source/markdown/credentials-pl.md) |

Attach the A5 quick start and accepted handoff report to every device. Complete the
credential insert privately, or use `pxv registry print-insert` for a prefilled private
A5 PDF from the encrypted registry. Match the asset label and seal it for the recipient.
Build with `pxv guides rebuild --policy FILE --output-dir DIRECTORY --chromium PATH`
to adapt the A5 booklet and blank credential/recovery sheets to the installation's
GrapheneOS user profiles. Profile details describe the intended policy; compare
them with the actual phone and accepted report before packing.
See [packing and printing](guides/README.md#pack-every-device) for the handoff process.

Start with the operator guide and a disposable canary. Starter packs describe
profile layouts; they need deployment-specific OS pins, app trust and configuration.
They are not certified hardening policies. The [documentation index](docs/README.md)
links the focused references, recovery procedures and verification boundaries.

## Build and check

Use **Node 24.22.0**, **pnpm 12.11.2** and the pinned Rust toolchain. Android helper
and cryptographic checks need Java 17+, Android platform 35, Build Tools 35.0.0 and
OpenSSH. See [host dependencies](docs/HOST_DEPENDENCIES.md).

```sh
pnpm install --frozen-lockfile
pnpm quality:setup
pnpm build:native
PXV_REQUIRE_CRYPTO=1 pnpm quality
pnpm pxv host doctor
```

Setup downloads checksum-pinned analysis tools explicitly. The strict quality gate
retains evidence for the exact source identity; it does not qualify a physical phone
or production policy. See [testing](docs/TESTING.md) and [verification](docs/VERIFICATION.md).

## Prepare a project

Keep live projects outside the checkout. This example creates private state and an
empty inventory; it does not contact or flash a phone:

```sh
pnpm pxv project init --path /absolute/private/fleet \
  --policy policy-packs/reference-five/policy.json
pnpm pxv policy validate --project-root /absolute/private/fleet
```

Policies define each app once, share app IDs across profiles, separate global
device settings and map exact GrapheneOS releases by Pixel codename. Follow the
[policy reference](docs/POLICY_FORMAT.md) and operator guide to enroll observed
physical identities, pin artifacts, lock the policy, review OS installation and
provision profiles/apps. Plans identify automated and assisted steps, complete app
configuration before VPN lockdown and retain per-phone pause/recovery state.

The [encrypted phone registry](docs/PHONE_REGISTRY.md) records operator-confirmed
phone/profile credentials, Session messenger IDs, Oblivion keys, Proton VPN accounts
and phone numbers. It retains encrypted history, exposes presence/state metadata in
ordinary views and reveals values only to a chosen private file. It does not read
live credentials or configure accounts.

## Automation and distributions

[CLI jobs and MCP](docs/AUTOMATION.md) use the same engine, exact review text,
physical-device ownership and durable recovery checks. Fleet selectors are explicit;
attestation, finalization and recovery require one exact asset. [Docker](docs/DOCKER.md)
supports direct USB and an existing host ADB server; host-ADB mode cannot flash.

CLI commands show readable summaries by default. Use `--json` for structured
automation output; progress and diagnostics go to stderr. Run `pxv COMMAND --help`
for a command's supported flags. Run history is paginated, so follow `nextCursor`
when reading `agent runs --json` or MCP `list_runs` results.

```sh
pnpm build:preview
pnpm build:preview --formats portable,oci
```

Portable is the supported default. OCI is explicit; Debian/npm and experimental SEA
are optional compatibility formats. Formats derive from a frozen candidate with
checksums, provenance and notices. Ordinary builds do not publish or install globally.
See [publication](docs/PUBLICATION_CHECKLIST.md).

Community disables trusted extensions and experimental Seedvault recovery in its
product descriptor. Explicitly enabled products retain those optional workflows;
retained records remain available for inspection and recovery. [Optional source
tooling](tools/optional/README.md) covers branding and guide publishing.

The [architecture](docs/ARCHITECTURE.md), [security boundaries](SECURITY.md) and
[contribution guide](CONTRIBUTING.md) describe the controls that changes must preserve.
