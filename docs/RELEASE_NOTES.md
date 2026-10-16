# pxv 0.1.0 release notes

This 0.1.0 replaces the prior application with a strict modular TypeScript workspace. It is a new project/state format; existing projects and approval receipts are not imported or executed. Retain old evidence and create a fresh isolated project.

Community remains free under MIT and includes local provisioning, recovery, CLI/MCP, policy, maintenance and fork tooling. White-label releases are separate forks with their own descriptor/assets/manifests/configuration/documentation. Commercial extensions are compiled bundles distributed from private repositories through authenticated registries, with no engine activation checks.

Safety changes cover stable Android user serials during cleanup, permission drift at finalization, resource-owner cleanup scopes, private IPC instead of durable inherited environments, exact asset/fleet selection and capability-based emulator provenance. Native Linux ownership uses a Rust supervisor, durable fences and redacted receipts. SQLite operations use a dedicated worker and short transactions.

Policy layouts are no longer fixed to five profiles. One-profile and custom-layout starters accompany the reference layout. CLI, MCP and full provisioning share authenticated artifact/install services, immutable reviews, cross-user APK effect checks and explicit manual checkpoints.

Portable archives, Debian packages, self-contained npm tarballs and OCI images derive from a frozen candidate. Dirty-tree previews have unique versions, output paths, commands and default projects. Docker supports explicit direct-USB service ownership and host-ADB operation. Packaging never publishes by default.

Current limits: Linux x86_64 first; concurrent control from different workstations is unsupported; source-built OS workflows and remote MDM integrations are separate follow-up work. UI/backup/network qualification is specific to the promised pack and exact software versions. pxv 0.1.0 is undergoing release qualification. Automated tests, artifact verification and container checks do not certify a policy pack, UI recipe, recipient workflow or physical phone. Verified GrapheneOS emulator evidence, exact-build EN/PL walkthroughs and a physical Pixel 8a acceptance record must be retained before making a deployment claim. A stock Google APIs emulator is useful for compatibility tests and cannot supply GrapheneOS provenance.
