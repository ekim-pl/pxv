# Run the MCP server

The server uses **stdio**. The MCP client launches and owns the server process;
there is no HTTP listener, port, or remote management service to configure.
Prepare a private project and enrolled assets using the
[operator instructions](../operators/README.md) before connecting.

## Launch an installed product

Use absolute paths to the reviewed executable, project, and product resources:

```sh
/absolute/path/to/pxv mcp serve \
  --project-root /absolute/private/project \
  --resource-root /absolute/path/to/product-resources
```

Resource roots contain the matching product descriptor and installed resources.
The project must belong to that product. Explicit roots avoid relying on the
client’s working directory or resource discovery. The server reloads project state
for each backend request and closes that request’s application storage afterward.

A generic client configuration uses an executable and separate argument strings:

```json
{
  "mcpServers": {
    "pxv": {
      "command": "/absolute/path/to/pxv",
      "args": [
        "mcp", "serve",
        "--project-root", "/absolute/private/project",
        "--resource-root", "/absolute/path/to/product-resources"
      ]
    }
  }
}
```

Use your client’s equivalent command/args configuration if its surrounding format
differs. Do not combine the arguments into a shell command string. Preserve the
required host tool and control-directory environment when the client launches pxv.
The application does not automatically load `.env` files.

## Launch from a source checkout

Follow the [pinned build process](../developers/build.md), then launch the compiled
entry directly with the pinned Node. This keeps wrapper progress output off stdio:

```sh
/absolute/path/to/node-24.22.0 /absolute/path/to/checkout/packages/cli/dist/main.js \
  mcp serve --project-root /absolute/private/project \
  --resource-root /absolute/path/to/checkout
```

For generic client configuration, use that Node executable as `command` and the
compiled entrypoint as the first `args` element, followed by the same MCP arguments.
Rebuild source changes before restarting the server. Source and installed product
identities must match the selected project’s reviewed configuration.

## Choose operation availability

Default mode exposes observation, preparation, run reading, extension inspection,
and guide resources. It can persist prepared plans; it is not a promise of zero
local writes. It does not expose mutation tools.

To expose reviewed execution, lifecycle, attestation, custody, recovery, cancellation,
refresh, and extension mutation tools, append `--allow-mutations`:

```sh
/absolute/path/to/pxv mcp serve \
  --project-root /absolute/private/project \
  --resource-root /absolute/path/to/product-resources --allow-mutations
```

Restart/reconnect after changing launch options and rediscover tools. A mutation
tool’s presence does not override product feature gates: pxv still refuses
extension installation/invocation, while inspection and explicit removal remain
available as documented. See [the catalogue](operations.md).

## Stdio, shutdown, and worker lifetime

Stdout is MCP protocol-only; diagnostics go to stderr. Do not merge stderr into
stdout, prepend shell banners, or pipe human-readable command output into the
transport. MCP tool successes contain JSON encoded in text content; errors may
contain plain error text and `isError: true`.

Closing stdin or sending SIGINT/SIGTERM closes the server. Native execution launches
a durable detached worker; losing an MCP connection does not establish that a run
stopped. Reconnect and inspect retained status. Cancellation is an explicit request
and does not reverse applied changes or prove cleanup.

Container-hosted workers cannot outlive their container. Keep a persistent MCP
container running while its work is active; retained state is not proof that its
worker survived. CLI-created Docker workers are foreground operations until a
terminal result or manual pause. Use the operator’s
[Docker ownership and mounts](../operators/host-setup.md#docker-operation), including
private project/control/extension paths and the independently owned ADB service.

Direct USB and host-ADB modes have different capabilities: host-ADB cannot flash.
Extension install/update requires native host execution, including through MCP.
Do not change the control root or ADB endpoint to bypass retained reservations.

## Diagnose connection failures

| Symptom | Check |
| --- | --- |
| Client cannot start process | Absolute executable/Node/compiled entry paths, ordinary-user permissions, and inherited environment. |
| Project/resources missing | Existing initialized private project, correct product resources, and matching product identity. |
| Protocol parsing fails | No wrapper banners or stderr merging; use the compiled entry or installed executable directly. |
| Tool absent | Server launch mode and newly discovered tool list; restart after changing `--allow-mutations`. |
| Tool exists but feature refused | Product descriptor and host/container restrictions; use an explicitly enabled reviewed product if required. |
| Device unavailable | Host tools, explicit ADB start, physical identity, private phone unlock, and transport authorization. |
| Connection lost during execution | Reconnect and inspect the exact run before any retry or recovery. |
