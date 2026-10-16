# Command reference

Run `pxv --help` for the installed product's identity and `pxv version` for its build version. Commands use strict flag parsing. Common options are `--project-root DIRECTORY`, `--resource-root DIRECTORY`, `--asset ID`, `--transport usb|wifi|emulator`, `--operator NAME` and `--yes`. Read the exact plan before using non-interactive confirmation.

| Area | Commands and purpose |
| --- | --- |
| Project | `project init --path NEW_DIRECTORY [--policy FILE]` creates distinct project state. |
| Policy | `policy validate` checks structure; `policy lock --yes` writes the canonical lock. |
| Inventory | `inventory list`; `inventory enroll --asset ID --serial SERIAL --model MODEL --codename CODE [--kind pixel|emulator] [--mode adb|fastboot] --yes`; `inventory import --file FILE --yes`. |
| Host | `host doctor`; explicit `host adb-start --yes`; `host bootstrap --file APPROVED_ARCHIVE.json --license ID --path NEW_DIRECTORY --yes`; `host build-helper --type probe|setup|e2e --yes`. |
| Docker host | `host docker-prepare --yes`; `host docker-adb-start --image IMAGE --yes`; `host docker-adb-stop --yes`. |
| Read device | `device inspect --asset ID`; `device report --asset ID`. A report is stored readiness. |
| Plan | `device plan --asset ID`; `device provision --asset ID --dry-run` prepares a reviewed immutable plan. |
| Execute | `device provision`, `device guided`, `device create-users`, `device deploy`, `device install-os`. OS installation is destructive. |
| Fleet | `fleet provision --all|--group GROUP --jobs 1..8`; no implicit wildcard asset. |
| Agent | `agent runs`; `agent status --run ID --after CURSOR`; `agent cancel --run ID`; `agent resume --run ID --yes`; `agent refresh --run ID` prepares a fresh review of remaining work; `agent execute --plan ID --review-file FILE --operator NAME`. |
| Attest | `device attest --asset ID --check NAME --operator NAME [--note TEXT] --yes`. Emulator provenance also requires `--evidence FILE`. |
| Recovery | `device recover --asset ID` inspects reservations; `--run ORIGINAL_RUN_ID --inspected --yes` performs explicit recovery. |
| Handoff | `device finalize --asset ID --operator NAME --locale en|pl`; `handoff accept --asset ID --recipient NAME --debugging-off --yes`; `handoff export --asset ID --locale en|pl --output DIRECTORY`. |
| Lifecycle | `lifecycle maintenance|policy-change|loss|retirement --asset ID --operator NAME --note TEXT [--erased] --yes`. |
| Extensions | `extension install --file FILE.tgz` or `--package NAME --version EXACT --registry HTTPS`; `list`, `inspect --extension ID`, `update --extension ID` with a new explicit package source, `remove --extension ID`, `policy|guide|adapter --extension ID --contribution PATH`, `invoke --extension ID --command NAME [--input-file FILE] --asset ID`. |
| MCP | `mcp serve [--allow-mutations]` starts stdio transport; stdout is protocol-only. |
| Guides | `guide operator|recipient --locale en|pl` prints installed Markdown; `guide project --locale en|pl --kind pixel|emulator` renders current policy requirements. |

Docker execution adds `--execution docker --image EXPLICIT_IMAGE --docker-mode direct|host-adb`. Direct mode requires the independently started ADB sidecar; host-ADB mode uses a previously running host service. Installed extensions are mounted read-only into workers.

An exact asset called `all` uses `--asset all`. `--all` is the fleet selector and cannot be combined with `--asset` or `--group`. First enrollment uses USB or a dedicated emulator; Wi-Fi transport data requires reviewed inventory configuration.

Common exit outcomes: 0 means the requested command completed; 3 indicates a failed/inspection-required execution; 4 indicates pending work or an unmet readiness/tool check; 130 indicates cancellation. Unexpected input/errors return a nonzero launcher result. Inspect the JSON result and retained run status rather than inferring readiness from process exit alone.

Repository maintainer commands are separate from the installed phone CLI: `pnpm check` runs static gates, `pnpm test:coverage` enforces complete per-module coverage, and `pnpm quality` aggregates static/native/coverage/helper checks and reports. Run `pnpm quality:setup` explicitly for pinned analysis tools. See [testing](TESTING.md); ordinary checks/builds never publish or install the product globally.
