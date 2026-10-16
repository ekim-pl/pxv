# Automation and MCP

`pxv mcp serve` exposes the current local project's supported operations over stdio. It defaults to observation-oriented behavior; device-changing tools additionally require `--allow-mutations` and the same exact reviewed-plan authorization used by CLI. No model approval, free-text note or extension command bypasses core target/lease/recovery checks.

```sh
pxv mcp serve --project-root "$P"
pxv mcp serve --project-root "$P" --allow-mutations
```

Keep stdout exclusively for the MCP protocol. Configure diagnostics on stderr and give the process an explicit project/resource root. The server identifies itself using the product command and installed build version, so a branded fork remains identifiable. Discover exact tools through the server's tool listing rather than maintaining an independent unchecked schema.

Keep a Docker-hosted MCP server container running for the lifetime of its detached tasks. Stopping the container interrupts those processes even when project state is mounted persistently. Before resubmission, inspect the phone and shared recovery reservations; a durable run record is not evidence that execution survived a stopped container. Short-lived CLI Docker workers instead run `agent execute` in the foreground until a terminal result or manual checkpoint.

An automation should inspect inventory and target, prepare a plan, present the exact review summary to its operator, submit it unchanged, then poll run status using cursors. Stop on pending/manual or inspection-required status. Perform user credentials, accounts, MFA, restores and physical confirmations through the appropriate human workflow.

Extensions are installed explicitly at exact versions from a configured registry or local tarball. Their typed device actions enter the normal planning pipeline. Extension code is trusted code; isolation protects the host process from faults, not from a malicious extension author.

Automation must not log registry credentials or recipient secrets, broaden a selector when an exact asset is unavailable, silently update a policy/extension or delete a fence to retry. Run a single operator control domain for phones reachable from the same host. See [agent jobs](AGENT.md) and [architecture](ARCHITECTURE.md).

The mutation-enabled server also exposes explicit attestation, finalization, custody, inspected recovery, lifecycle and extension management/contribution tools. Each request reloads the project policy and lock through a fresh application context and closes its storage worker afterward. Failed context construction also releases an opened store. Use the tool schemas and exact review text; confirmations such as inspected/debugging-off remain real human statements rather than model guesses.

Core approval/execution, refresh, signoff, finalization, custody and lifecycle services recheck source revisions and executable identity under project ownership before acquiring a device lease. This protects a context that became stale while waiting for an operator or ownership. A stale-context error requires reload and renewed review; it does not authorize replay. Configuration changes likewise reject stale expected file revisions.

State transitions and their audit events commit together. Native receipt events preserve their first-observation time across repeated polling, resume and recovery, while altered receipt payloads still fail validation. Neither an audit event nor a completed worker process replaces fresh device measurements or physical recipient confirmation.

## Tool routes

| Availability                                   | Tools                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Default/read                                   | inspect_host, list_devices, inspect_device, prepare_operation, get_run, list_runs, extension_list, extension_inspect, extension_guide. |
| Explicit mutation-enabled server               | execute_plan, cancel_run, refresh_review, attest_device, finalize_device, confirm_custody, recover_device, record_lifecycle.           |
| Explicit mutation-enabled extension management | extension_install, extension_update, extension_remove, extension_policy, extension_adapter, extension_command.                         |

prepare_operation supports create-users, deploy-apps, provision and install-os; preparing does not authorize execution. execute_plan requires the exact returned reviewSummary plus operator identity. Extension adapter/command tools prepare core actions for review, then execute_plan performs the authorized work. Install/update/remove/policy require reviewed:true. recover_device requires inspected:true and confirm_custody requires debuggingOff:true, each reflecting an actual physical check. The operator and recipient Markdown guides are MCP resources.
