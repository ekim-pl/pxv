# Automation and MCP

CLI jobs and MCP use the same local workflow engine. They retain exact reviewed
plans, bounded event cursors and per-phone recovery state. They do not provide a
remote MDM service or cross-workstation ownership. Use one shared operator control
directory for native installations, forks and containers that can reach a phone.

CLI summaries are human-readable by default. Add `--json` whenever a script parses
stdout; successful structured commands emit one JSON document, with progress and
diagnostics on stderr. On a nonzero exit, stdout may be empty or contain partial
results; check the exit outcome before treating any returned preparation as complete. Help, version and guide output remain textual. This is an
intentional change from the previous default JSON output.

## Prepare, review and execute

Prepare a provisioning plan with `device plan --asset ID` or a supported
`device ... --dry-run` command. Preparation stores a plan; it does not authorize
device changes. Inspect the physical target, immutable artifact identities,
cross-user APK effects and every automated or assisted checkpoint.

Saved-plan automation additionally requires the pinned Node 24.22.0 runtime on
`PATH`. Start with an existing private project outside the source/resource checkout.
Capture one exact asset's preparation response in a new private file, then extract
the decoded `reviewSummary` without adding a newline. The example refuses existing
capture/review files; use new names for another review.

```sh
(
  set -eu
  umask 077
  mkdir -p -m 700 "$P/secrets"
  test ! -L "$P/secrets"
  test "$(stat -c '%u:%a' "$P/secrets")" = "$(id -u):700"
  set -C
  pxv device plan --project-root "$P" --asset PHONE_ID --json > "$P/secrets/plan.json"
  node --input-type=module - "$P/secrets/plan.json" "$P/secrets/review.txt" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (typeof plan.planId !== 'string' || typeof plan.reviewSummary !== 'string')
  throw new Error('Expected one prepared-plan response');
writeFileSync(process.argv[3], plan.reviewSummary, { mode: 0o600, flag: 'wx' });
console.log(plan.planId);
NODE
)
```

Read `plan.json` and `review.txt`, check expiry and every action, then replace
`PLAN_ID` below with the printed identifier. The JSON wrapper is not approval text.
An editor-added newline changes the exact review and is rejected.

```sh
pxv agent execute --project-root "$P" --plan PLAN_ID \
  --review-file "$P/secrets/review.txt" --operator 'Operator'
pxv agent runs --project-root "$P" --limit 100 --json
pxv agent status --project-root "$P" --run RUN_ID --after 0 --json
```

Submission and its run record commit atomically. Reusing an idempotency key with
different content is rejected. Project ownership rechecks policy, inventory,
configuration and executable identity before execution; a stale context requires
reload and a new review. Native ownership and typed cleanup remain required even
when a caller has approved a plan.

Native-host execution launches a detached worker. CLI-created Docker workers run
in the foreground until a terminal result or manual pause; keep the command and
container running. Detached tasks inside a persistent MCP container still stop
when that container stops. Retained state does not prove a worker survived or that
cleanup completed.

## Pauses, expiry and recovery

Read the run's `pauseReason` and follow its next step:

| Kind | Next step |
| --- | --- |
| `manual-step` | Complete the named checkpoint, record its applicable real check, then resume the run. |
| `reenrollment` | Finish post-flash setup and re-enrollment, then prepare and review a new provisioning plan. |
| `acceptance` | Complete required checks and finalization, followed by recipient custody. |
| `inspection` | Inspect the phone and retained obligations, then use inspected recovery before further mutation. |

Only an intentional `manual-step` checkpoint can resume:

```sh
pxv agent resume --project-root "$P" --run RUN_ID --yes
```

`agent cancel --run RUN_ID` requests a stop and owned cleanup; it cannot reverse applied changes.
Failed or uncertain mutations need inspection and typed recovery. Never broaden a
selector, delete a fence, change the control root or replay a flash to bypass that
state. Attestation, finalization and recovery select one exact asset. See the
[recovery runbook](CANARY_BACKUP_RECOVERY.md).

Execution and resume exit with 4 when further work is pending, 3 when failed or
inspection is required, and 130 when cancelled. A pending result is a checkpoint to
inspect, not an execution failure to retry. Read its structured status before
choosing the next command; a successful process exit never supplies a human check.

If a valid pending run at an intentional `manual-step` checkpoint outlives its
review, `agent refresh --run RUN_ID` prepares a new plan for unfinished work.
Inspect its new `reviewSummary`, save it exactly and submit the new plan through
`agent execute`. Refresh grants no approval and does not replay completed work.
It does not apply to the other pause kinds. Changed configuration requires renewed
review; an interrupted mutation still needs recovery first.

Event cursors are exclusive sequence numbers. Retain the last returned sequence
and request later events. A single page is not the whole history. Native completion
events preserve their first-observation timestamp across polling and recovery;
that timestamp is not a measured command-completion time. Malformed evidence and
changed receipt payloads fail closed.

Run history has a separate opaque cursor. `agent runs --json` and MCP `list_runs`
return `{ items, nextCursor }` instead of an array. Read `items`, then pass each
non-null `nextCursor` as CLI `--cursor` or MCP `cursor`, retaining the same page
limit, until it is null. The default limit is 100 and the maximum is 1,000. Pages
follow retained record keys and do not provide a transactional snapshot across
concurrent submissions. Do not reuse event sequence numbers as run-list cursors.
Existing integrations must update their array parsing and traverse pages to read
the complete history. Status and history share engine queries across CLI and MCP;
their stored evidence does not establish the current physical phone state. A
`current` review status means its stored metadata matches the loaded project,
policy, enrollment and lifecycle generation and has not expired. It does not
replace full plan-integrity validation at execution or supply human approval.

## MCP server

```sh
pxv mcp serve --project-root "$P"
pxv mcp serve --project-root "$P" --allow-mutations
```

Stdout is protocol-only. Supply an explicit project/resource root and keep
diagnostics on stderr. The default server exposes observation and preparation;
mutation tools additionally require `--allow-mutations`. Each request reloads
project state and closes its application storage context afterward.

| Mode | Tool families |
| --- | --- |
| Default | Host/device inspection, plan preparation, run reading, extension listing/inspection/guides. |
| Mutation-enabled | Exact-reviewed execution, cancellation, refresh, attestation, finalization, custody, inspected recovery and lifecycle changes. |
| Extension-enabled product plus mutation mode | Explicit extension installation/update/removal, policy selection and reviewed contributions. |

Discover the current schemas through the server's tool listing. `execute_plan`
requires the exact returned review summary and operator identity. `inspected`,
`debuggingOff` and other confirmations represent actual human observations; a model
must not infer them from a successful command. Operator/recipient guides are MCP
resources. Registry credentials are not MCP resources or tool results.

Keep recipient secrets out of tool arguments, notes, logs and review files.
Private account setup, MFA, recovery material and physical prompts use the human
workflow. Optional extensions execute trusted code; their actions still pass
through core planning and recovery. See [extension boundaries](EXTENSIONS.md),
[architecture](ARCHITECTURE.md) and the [command reference](COMMAND_REFERENCE.md).
