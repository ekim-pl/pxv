# Agent jobs and reviewed execution

The agent interface uses durable local run records, exact reviewed plans and bounded event cursors. It is a local job system, not a remote fleet-management server. CLI and MCP call the same workflow engine and safety services.

Prepare `device plan --asset ID` or an extension contribution. Preserve the exact returned `reviewSummary` bytes in a private file; do not regenerate that text from an independently edited policy. Submit only after reviewing target identity, immutable artifact bytes, manual checkpoints and cross-user APK effects.

~~~sh
pxv agent execute --project-root "$P" --plan PLAN_ID \
  --review-file "$P/review.txt" --operator 'Operator'
pxv agent runs --project-root "$P"
pxv agent status --project-root "$P" --run RUN_ID --after 0
pxv agent cancel --project-root "$P" --run RUN_ID
~~~

A plan submission and run record are committed atomically. Reusing an idempotency key with different content is rejected. Native completion receipts are reconciled into events idempotently. A worker launch is a separate durable responsibility: an abandoned launch cannot imply the device operation succeeded.

On the native host, `agent execute` starts a detached worker. In a CLI-created direct/host-ADB Docker worker it executes in the foreground until a terminal result or manual checkpoint, so the short-lived container cannot exit ahead of its job. Keep the command running during execution. Detached tasks started by a persistent MCP container remain inside that container and are interrupted if it stops; retained records never imply those tasks survived. Use explicit inspection/recovery after interruption.

Run outcomes include completed, pending, cancelled, failed and needs-inspection. Pending manual work is resumed with `agent resume --run RUN_ID --yes` after the exact checkpoint is complete. An interrupted mutation is not automatically retried. Cancelling prevents further work and requests cleanup; it cannot promise reversal of an already applied change.

Events are paged with an exclusive sequence cursor. Keep the last returned sequence and request later events, rather than treating the first page as the whole run. Malformed evidence remains in storage and blocks affected operations instead of disappearing from the UI.

Plans and observations expire or become invalid when policy, engine, device state or pinned extension bytes change. See [operator guide](OPERATOR_GUIDE.md) for recovery, signoff and custody.

If the remaining work outlives its review, run `agent refresh --run RUN_ID`. It prepares a new plan for unfinished work only and returns `planId`, exact `reviewSummary` and `expiresAt`. Save the decoded reviewSummary string exactly in a private file, inspect the new target/actions, then submit `agent execute --plan NEW_PLAN_ID --review-file FILE --operator NAME`. Refresh does not authorize work or replay completed actions. Interrupted mutations still require inspection/recovery first.
