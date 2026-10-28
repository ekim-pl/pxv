# Reviewed execution, checkpoints, and recovery

CLI and MCP share immutable reviewed plans, bounded run queries, native ownership,
and durable recovery. Use one shared operator control directory for native
installations, forks, and containers that can reach a phone. Ownership across
several workstations is unsupported.

## Worked MCP sequence

The following tool names and JSON objects describe client calls, not shell commands.
Keep each phone’s asset, plan, run, review, and cursors together.

1. Inspect host prerequisites with `inspect_host {}` and enrolled assets with
   `list_devices {}`. Inspect the authorized phone with
   `inspect_device {"assetId":"phone-01"}`.
2. Prepare `prepare_operation {"assetId":"phone-01","operation":"provision"}`.
   Parse the success JSON and retain `planId`, `reviewSummary`, and `expiresAt`.
   Preparation stores a plan; it does not approve device changes.
3. Show the exact review to the operator. Check the physical target, immutable
   artifacts, actions affecting shared APKs, automated/manual scope, and expiry.
   For OS installation, obtain the destructive-phase authorization and attend the
   required bootloader prompts separately.
4. On a mutation-enabled server, call `execute_plan` with the returned `planId`,
   the exact decoded `reviewSummary`, and actual `operator`. Do not add whitespace,
   reformat the summary, or send the surrounding JSON as the approval string.
5. Retain the returned run metadata’s `id` and call
   `get_run {"runId":"RUN_ID","after":0}`. The result is `{ run, events }`;
   follow `run.status`, `run.pauseReason`, review status, and next steps. Later
   reads use the last received event’s `sequence` as `after`.
6. If it pauses at a named profile’s `vpn_settings`, the operator actually opens
   VPN Settings and witnesses the required state. Then call `attest_device` with
   that asset, `check: "vpn_settings"`, and the operator. Use CLI `agent resume`
   for that run; MCP has no resume operation. Repeat for each requested profile.
7. Complete all other private/manual and required acceptance checks. Record actual
   recipient acceptance, then fresh operator signoff with `attest_device` using
   their requested check names. Use `finalize_device` with the exact asset,
   operator, and `locale: "en"` or `"pl"` only when readiness permits it.
8. After physical verification of USB and Wireless debugging shutdown and actual
   handover, call `confirm_custody` with that asset, actual recipient, and
   `debuggingOff: true`. Export and pack the report/guides/inserts through CLI.

Neither a model’s inference nor a successful tool response can supply a physical
check. Keep account passwords, MFA, ordinary/duress credentials, wipe keys, and
recovery material out of arguments, notes, review text, logs, and conversation.

## Pauses, expiry and recovery

Read the run's `pauseReason` and follow its next step:

| Kind | Next step |
| --- | --- |
| `manual-step` | Complete the named checkpoint, record its applicable real check, then resume the run. |
| `reenrollment` | Finish post-flash setup and re-enrollment, then prepare and review a new provisioning plan. |
| `acceptance` | Complete required checks and finalization, followed by recipient custody. |
| `inspection` | Inspect the phone and retained obligations, then use inspected recovery before further mutation. |

Only an intentional `manual-step` checkpoint can resume:

An assisted recipe also requires its complete retained checkpoint and exact
source lineage. Missing, malformed or conflicting evidence blocks resume and
refresh; never retry the UI recipe to reconstruct it. Inspect the phone and
retained records, complete typed recovery where required, then prepare and approve
new work. Refreshed queued runs retain this requirement. Completed historical
evidence remains readable. If request storage disposal also fails, CLI/MCP report
both the original operation message and the disposal message; neither is an
instruction to replay a mutation.

```sh
pxv agent resume --project-root "$P" --run RUN_ID --yes
```

`agent cancel --run RUN_ID` requests a stop and owned cleanup; it cannot reverse applied changes.
Failed or uncertain mutations need inspection and typed recovery. Never broaden a
selector, delete a fence, change the control root or replay a flash to bypass that
state. Attestation, finalization and recovery select one exact asset. See the
[recovery runbook](../operators/recovery-and-maintenance.md).

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

Every provisioning profile pauses at `vpn_settings` after app setup and before
network probes. Follow the returned profile-specific Settings instructions, record
`device attest --check vpn_settings --asset ASSET --operator OPERATOR`, then resume.
This is an operator witness of Android's VPN Settings, not an automated live VPN
manager measurement. Receipts are scoped to the active profile and action; reports
label their evidence `operator-witnessed-settings`. Review refresh retains validated
completed proofs and requires new confirmation for an unfinished VPN action.

Use the policy `vpn` block for the requested configuration. Ordinary secure-setting
declarations for `always_on_vpn_app` or `always_on_vpn_lockdown` fail validation,
including matching duplicates. Generated project guides include each profile's
mandatory VPN witness before probes, with separate attest/resume instructions.
Readiness and refresh require retained plan/run completion and the audited witness
receipt; a proof with a new checksum and unrelated plan identity is insufficient.

Attestation may inspect an expired execution plan, but still requires unchanged live state and provisioning measurements no older than 15 minutes. Submission and resume still require an unexpired review. For stale acceptance measurements, prepare and execute a newly reviewed provisioning run; acceptance-only pauses cannot use `agent refresh`.

A retained `debugging-shutdown` intent without a committed handoff returns `ready: false` and `finalization-inspection`. Do not retry finalization or infer custody from debugging being off. Follow the [incomplete-finalization recovery procedure](../operators/recovery-and-maintenance.md#recover-incomplete-finalization). Successful `shutdown-requested` and completed custody remain distinct states.

The intent also blocks new plans, submission, refresh, execution/resume, attestation,
extension contributions, Seedvault operations and collectors after baseline changes.
Inspection, cancellation, typed recovery, disconnect and offline records remain
available. Explicit lifecycle maintenance must archive it before new reviewed work.

Current managed-package evidence requires hashes from verified standalone APK bytes,
including all-user shared effects. Content mismatch at unchanged version/signature
requires a reviewed reinstall; splits require maintenance, never automatic removal.
Original hashless handoffs remain eligible for authentic historical custody without
claiming newly measured content. Backup-only preflight, including dry runs, requires
a current authentic lock before pairing/connection and never renews approval.

Recipe/probe verification authenticates complete results, their source action/run,
the observed execution checkpoint and committed refresh ancestry. Assisted recipe
completion also requires its consumed audit-backed app-setup receipt. Complete older
records remain usable only when the source can be identified unambiguously; missing
evidence stays blocked. Historical custody remains readable and unchanged.

New Seedvault connections require current approval under project ownership after
prompts. Backup-only automation rechecks its initial baseline after the physical
checkpoint and stops if it changed, even with a newly approved lock. Disconnect
and typed recovery do not require renewal. Worker failure transitions are conditional
and audited; newer run records and foreign launch claims are preserved.

VPN verification treats missing/malformed/mismatched evidence as a blocker, but storage, worker and stored-JSON decoding failures remain errors, including later audit pages. Preserve the original error; retrying provisioning is not a storage repair. Custody recomputes complete prepared-plan integrity using the original handoff snapshot, even when the current baseline changed.

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
Integrations must traverse pages to read the complete history. Status and history share engine queries across CLI and MCP;
their stored evidence does not establish the current physical phone state. A
`current` review status means its stored metadata matches the loaded project,
policy, enrollment and lifecycle generation and has not expired. It does not
replace full plan-integrity validation at execution or supply human approval.

Readiness reports include `measurement-freshness` for invalid, future-dated or
older-than-15-minute measurements, and `policy-lock` for an unapproved baseline.
They remain stored evidence rather than a live inspection. `device report` adds `readinessStatus`: `available` retains `state`; `unavailable` omits it, returns `ready: false` and `readiness-unavailable`, and supplies `readinessUnavailableReason` (`missing-workflow`, `baseline-changed` or `invalid-workflow`). Consume its projected historical run independently. Measurement expiry still uses `measurement-freshness`; it does not invalidate historical custody. Storage failures are not converted to unavailable readiness.

After custody confirmation, the matching provisioning run reports `completed`
without an acceptance pause or acceptance instructions. Older pending runs receive
the same read-only projection only when exact current or lifecycle-archived custody
evidence supports it. Their original records/events are preserved. Historical
completion does not authorize new execution or expire with measurements; do not
restart provisioning to refresh an already completed handover. Successful subset/extension execution can already be `completed` before custody; require the handoff evidence to establish that transfer. Custody checks original retained lineage after executable/policy changes without requiring a new lock. Explicit lifecycle invalidation prevents accepting archived handoffs.

CLI and MCP retained history, offline custody/lifecycle records, cancellation and typed recovery do not require installed extension files. Planning, execution, attestation, finalization and contributed actions retain their installed-extension checks and mutation authorization.

## Handle tool errors and lost connections

A tool response with `isError: true` is an error even if transport delivery
succeeded. Do not parse its text as a successful preparation response or reuse an
unknown plan ID. Inspect the exact run/device and retained obligations after a
lost execution response, worker startup error, cancellation, or uncertain mutation.
Changed configuration needs a fresh review; stale contexts reload on the next
request, but reloading does not approve changed work.

Submission and its run record commit atomically. Reusing an idempotency key with
different content is refused by the engine. The MCP execution schema exposes no
client-supplied idempotency key; do not invent one. Use retained run history and
status before resubmitting uncertain work. Cancelling is not rollback.

For fleet integration, repeat the sequence with one exact asset per operation.
A paused or failed phone keeps its own obligations; do not rerun successful phones
because another member needs inspection. Follow
[operator recovery](../operators/recovery-and-maintenance.md) for typed cleanup,
backup restoration, and lifecycle maintenance. Extension contributions use the
same exact-review execution path and the enabled-product restrictions in the
[operation catalogue](operations.md).
