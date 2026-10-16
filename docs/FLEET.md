# Small-fleet workflows

A fleet is a local collection of enrolled physical assets. Every device has its own canonical identity, transport choices, group membership, run, evidence and recovery obligations. This release does not provide unattended remote MDM, multi-tenant hosting or cross-workstation locking.

Use an exact asset for a single phone. Use explicit fleet/group selectors for batches:

~~~sh
pxv fleet provision --project-root "$P" --group pilot --jobs 2 --dry-run
pxv fleet provision --project-root "$P" --group pilot --jobs 2 --operator 'Operator'
pxv fleet provision --project-root "$P" --all --jobs 2 --operator 'Operator'
~~~

Review every target's plan before execution, including cross-user APK effects. Concurrency is bounded from 1 to 8. Start with a disposable canary, then a small pilot, then the remaining authorized devices. A failed member remains fenced independently; one phone's success does not certify the whole group.

Canonical-device and transport kernel locks are shared across projects, preview builds, forks and Docker workers under the operator control root. They prevent overlapping pxv ownership on that host. They do not stop a separate workstation or an unrelated raw ADB/fastboot client; organize custody and workstations accordingly.

Maintain a current support and recovery contact for each product fork. Maintenance and policy changes invalidate prior handoff evidence and require fresh checks. Loss records do not remotely erase a phone. Retirement needs separately confirmed erasure/custody. Backup and identity-provider revocation happen through their own approved processes.

Headwind or another management system may be integrated through a reviewed extension after enrollment and Android multi-user compatibility testing. Evaluate device-owner/enrollment prerequisites before creating secondary users or accounts; enrollment timing can make later integration impossible without reinitialization. No remote-management feature is implied merely by including a local fleet inventory.
