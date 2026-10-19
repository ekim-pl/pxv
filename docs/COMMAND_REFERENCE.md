# Command reference

Run `pxv --help` for the installed product's identity, `pxv COMMAND --help` for command-specific usage and `pxv version` for its build version. Commands reject unsupported flags and extra arguments before loading project state. Common options include `--project-root DIRECTORY`, `--resource-root DIRECTORY`, `--asset ID`, `--transport usb|wifi|emulator`, `--operator NAME` and `--yes`; use only those listed for the selected command. Read the exact plan before using non-interactive confirmation.

Structured commands print readable summaries by default. Add `--json` for one JSON document on stdout on successful structured invocations; progress and diagnostics use stderr. Guide, help and version commands remain textual, and MCP stdout remains protocol-only. Preparation responses retain the exact decoded `reviewSummary`; do not add a newline when saving it for approval.

| Area | Commands and purpose |
| --- | --- |
| Project | `project init --path NEW_DIRECTORY [--policy FILE]` creates distinct project state. |
| Policy | `policy validate` checks a authoring policy; `policy lock --yes` writes the canonical lock. |
| Inventory | `inventory list`; `inventory enroll --asset ID --serial SERIAL --model MODEL --codename CODE [--kind pixel|emulator] [--mode adb|fastboot] --yes`; `inventory import --file FILE --yes`. |
| Phone registry | Local encrypted `registry init`, `list`, `show --asset ID`, `history --asset ID`; `update --asset ID --file PRIVATE.json --record-revision N [--yes]`; `reveal --asset ID --output NEW_PRIVATE_FILE [--record-revision N]`; `rekey`; explicit stale-all restore `reconcile [--yes]`. Hidden local unlock or `--passphrase-file PRIVATE_FILE`; rekey also accepts `--new-passphrase-file`. See [private storage and retention](PHONE_REGISTRY.md). |
| Host | `host doctor`; explicit `host adb-start --yes`; `host bootstrap --file APPROVED_ARCHIVE.json --license ID --path NEW_DIRECTORY --yes`; `host build-helper --type probe|setup|e2e --yes`. |
| Docker host | `host docker-prepare --yes`; `host docker-adb-start --image IMAGE --yes`; `host docker-adb-stop --yes`. |
| Read device | `device inspect --asset ID`; `device report --asset ID`. A report is stored readiness. |
| Plan | `device plan --asset ID`; `device provision --asset ID --dry-run` prepares a reviewed immutable plan. |
| Execute | `device provision`, `device guided`, `device create-users`, `device deploy`, `device install-os`. OS installation is destructive. |
| Fleet | `fleet provision --all|--group GROUP --jobs 1..8`; no implicit wildcard asset. |
| Agent | `agent runs [--cursor CURSOR] [--limit N]`; `agent status --run ID --after CURSOR`; `agent cancel --run ID`; `agent resume --run ID --yes`; `agent refresh --run ID` prepares a fresh review of remaining work; `agent execute --plan ID --review-file FILE --operator NAME`. |
| Attest | `device attest --asset ID --check NAME --operator NAME [--note TEXT] --yes`. Emulator provenance also requires `--evidence FILE`. |
| Recovery | `device recover --asset ID` inspects reservations; `--run ORIGINAL_RUN_ID --inspected --yes` performs explicit recovery. |
| Seedvault | `seedvault inspect --asset ID`; reviewed `backup|restore [--file REQUEST.json] [--seedvault-adapter FILE] [--dry-run]`; `report --run ID`; `connections`; verified TLS `connect --endpoint HOST:PORT [--pair-endpoint HOST:PORT]`; scoped `disconnect --endpoint HOST:PORT [--run CONNECTION_ID --inspected]`. All Seedvault commands except `report` require `--asset ID`; fleet selectors are unsupported. Host execution, one enrolled asset and qualified exact-build UI evidence are required. See [personal Seedvault automation](SEEDVAULT_AUTOMATION.md). |
| Handoff | `device finalize --asset ID --operator NAME --locale en|pl`; `handoff accept --asset ID --recipient NAME --debugging-off --yes`; `handoff export --asset ID --locale en|pl --output DIRECTORY`. |
| Lifecycle | `lifecycle maintenance|policy-change|loss|retirement --asset ID --operator NAME --note TEXT [--erased] --yes`. |
| Extensions | `extension install --file FILE.tgz` or `--package NAME --version EXACT --registry HTTPS`; `list`, `inspect --extension ID`, `update --extension ID` with a new explicit package source, `remove --extension ID`, `policy|guide --extension ID --contribution PATH`, `adapter --extension ID --contribution PATH --asset ID`, `invoke --extension ID --command NAME [--input-file FILE] --asset ID`. |
| MCP | `mcp serve [--allow-mutations]` starts stdio transport; stdout is protocol-only. |
| Guides | `guide operator|recipient --locale en|pl` prints installed Markdown; `guide project --locale en|pl --kind pixel|emulator` renders current policy requirements. |
| Guide rebuild | `guides rebuild [--policy FILE] [--output-dir DIR] [--chromium PATH] [--html-only] [--no-render]` rebuilds guides from a source checkout before project loading; it runs `pnpm build` and uses the existing Chromium/Poppler pipeline. `--policy` validates a installation policy and adapts the phone-sized quick start and blank profile sheets. Policy builds require a separate output directory and describe intended configuration, not verified device status. |

Docker execution adds `--execution docker --image EXPLICIT_IMAGE --docker-mode direct|host-adb`. Direct mode requires the independently started ADB sidecar; host-ADB mode uses a previously running host service. Installed extensions are mounted read-only into workers.

An exact asset called `all` uses `--asset all`. `--all` is the fleet selector and cannot be combined with `--asset` or `--group`. First enrollment uses USB or a dedicated emulator. Seedvault's connection command verifies a TLS wireless endpoint against the enrolled physical identity before saving it alongside USB.

`--dry-run` is available only on commands that explicitly prepare a plan. It is rejected for finalization, attestation, recovery and other commands without preparation-only behavior.

`agent runs --json` and MCP `list_runs` return `{ items, nextCursor }`. Request additional pages with CLI `--cursor` or MCP `cursor` until `nextCursor` is null; `limit` controls the bounded page size. A single page is not the complete history. `agent status` and `device report` show stored checkpoints, review expiry and applicable next commands; stored evidence is distinct from live inspection and cannot establish a human confirmation.

Common exit outcomes: 0 means the requested command completed; 3 indicates a failed/inspection-required execution; 4 indicates pending work or an unmet readiness/tool check; 130 indicates cancellation. `agent resume` uses the resulting run's exit outcome, including 4 when it pauses again. Unexpected input/errors return a nonzero launcher result. Inspect the `--json` result and retained run status rather than inferring readiness from process exit alone.

Repository maintainer commands are separate from the installed phone CLI: `pnpm check` runs static gates, `pnpm test:coverage` enforces complete per-module coverage, and `pnpm quality` aggregates static/native/coverage/helper checks and reports. Run `pnpm quality:setup` explicitly for pinned analysis tools. See [testing](TESTING.md); ordinary checks/builds never publish or install the product globally.
