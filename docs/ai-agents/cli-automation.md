# CLI companion operations and structured automation

Use the CLI for tasks outside the [MCP catalogue](operations.md), and for scripts
that need reviewed durable execution. Use the same absolute project/resource roots,
product identity, control directory, and host tool selection as the MCP server.

## Initialize and enroll outside MCP

Follow [host setup](../operators/host-setup.md) and the
[single-device](../operators/single-device.md) or [fleet](../operators/fleet.md) path.
Only `project init` creates project state. Starting ADB, validating/locking policy,
and enrolling the observed physical identity are explicit CLI steps. Do not create
fake inventory identities to satisfy a tool call.

```sh
P='/absolute/private/project'
pxv project init --path "$P" --policy /absolute/private/reviewed-policy.json
pxv policy validate --project-root "$P"
pxv host adb-start --yes
pxv inventory enroll --project-root "$P" --asset phone-01 \
  --serial OBSERVED_SERIAL --model 'OBSERVED_MODEL' --codename OBSERVED_CODENAME
```

Run initialization only for a new project. A policy lock is recorded during
initialization; subsequent policy/metadata/extension changes require renewed
validation, locking, and review.

## Output and exit handling

Structured commands are readable by default. Add `--json` to obtain one JSON
document on stdout on successful structured calls; progress and diagnostics use
stderr. Help, guide, and version remain text. MCP stdout is exclusively protocol.
On nonzero exit, stdout can be empty or contain partial results; inspect the exit
and retained state before treating any preparation/execution as complete.

| Exit outcome | Meaning and response |
| --- | --- |
| 0 | Requested command completed; physical readiness still requires its own checks. |
| 3 | Execution failed or inspection is required; inspect before further mutation. |
| 4 | Pending work or unmet readiness/tool requirement; follow the returned next step. |
| 130 | Cancellation; confirm worker/cleanup state separately. |
| Other nonzero | Invalid input or launcher/runtime error; diagnose without assuming the phone was untouched. |

Do not put an expected pause behind an unconditional success-only retry loop.
`agent resume` can return 4 when it reaches another checkpoint. `--yes` represents
an actual completed review/check; it cannot create a human observation.

## Save an exact review and execute

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

## Resume an intentional manual checkpoint

There is no MCP resume tool. After the named human task and applicable attestation
have actually been completed, continue the exact run through CLI:

```sh
pxv agent resume --project-root "$P" --run RUN_ID --yes
pxv agent status --project-root "$P" --run RUN_ID --after 0 --json
```

`--yes` confirms completed checkpoint work; it is not an instruction to invent an
attestation. At a language gate, complete the phone step and resume; do not invent
a language check. Use [workflow and recovery](workflow-and-recovery.md) for other
pause types and review expiry.

## Complete handoff and printing outside MCP

Use `handoff export` after real acceptance/custody to export that asset’s report.
Use `guide operator|recipient --locale en|pl` for installed localized Markdown or
`guide project` for project requirements. Generate policy-based booklets from a
source checkout and private per-device inserts/labels with the
[operator printing workflow](../operators/guides-and-inserts.md).

Registry commands and collectors remain private host workflows. Never read their
plaintext outputs into an agent context. Passphrases use hidden prompts or approved
private files, not command arguments or environment variables. Ordinary run data,
review files, reports, and MCP results must not contain recipient secrets.

For complete command families and supported options, use the
[operator command reference](../operators/command-reference.md) and command-specific
help. `--dry-run` is supported only for operations that explicitly prepare plans;
attestation, finalization, and inspected recovery reject it.
