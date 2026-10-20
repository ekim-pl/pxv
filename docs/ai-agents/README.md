# Integrate an AI agent with pxv

pxv exposes a local stdio MCP server over the same engine used by the CLI. Start
with [running the server](running-mcp.md), use the [operation catalogue](operations.md),
and follow [reviewed execution and recovery](workflow-and-recovery.md).

## Prepare the environment

The operator first installs/builds the reviewed product, configures host tools,
initializes a private project, validates/locks its policy, and enrolls each physical
target. Follow [single-device](../operators/single-device.md) or
[fleet preparation](../operators/fleet.md). Device inspection needs the explicitly
started ADB service, required permissions, and an authorized connected phone.

MCP does not initialize projects, enroll inventory, start ADB, print device packets,
or expose registry secrets. Use the documented [CLI companion operations](cli-automation.md).
Keep product resources and the operator’s shared control directory consistent
between MCP, CLI, native workers, and containers.

## Connect and inspect first

1. Configure the client to launch the reviewed executable with absolute project and
   resource paths. Begin with the default observation/preparation mode.
2. Discover tools and resources from the running server. Read
   `pxv://guides/operator` and `pxv://guides/recipient` as needed.
3. Call `inspect_host` with `{}` and `list_devices` with `{}`. The latter reports
   enrolled inventory; use `inspect_device` for current observation of one asset.
4. Call `prepare_operation` with an exact asset and supported operation. Read its
   plan identity, exact review text, and expiry with the human operator.

Example tool arguments, after selecting the asset from inventory:

```json
{"assetId":"phone-01","operation":"provision"}
```

Preparation stores a plan and may acquire/verify artifacts, but grants no authority
to change the phone. Execution requires a server started with `--allow-mutations`
and the exact human-approved review. That switch does not supply approval or
physical observations for individual operations.

## Integration boundaries

Use one asset per device operation; retain independent plan/run/checkpoint state
for fleet members. Follow run-list pagination and event cursors. Human checks,
private setup, MFA, debugging shutdown, custody, and inspected recovery require
actual observations; an agent must not invent confirmations from successful tool
responses. Keep credentials, wipe keys, and recovery material out of arguments,
review text, logs, and chat.
