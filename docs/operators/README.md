# Operator documentation

Use these instructions when you prepare, maintain, or hand over phones. You need an
authorized physical target, a reviewed policy, a supported Linux host, and a private
project. Device operations use the installed `pxv` command; source-checkout users
use `pnpm pxv` after [building](../developers/build.md).

## Choose a project path

| Path | Use it for | Result |
| --- | --- | --- |
| [Single device](single-device.md) | One phone, with Owner-only or multiple profiles; includes preparing your own phone | One accepted phone and its complete guide/report/private-insert packet. |
| [Fleet](fleet.md) | Several individually enrolled phones using one reviewed project policy | Independent per-phone outcomes and a complete packet for every delivered asset. |

Read [host setup](host-setup.md), choose a path, and follow it through
[guide generation and packing](guides-and-inserts.md). Neither a successful process
exit nor a batch summary establishes a phone’s readiness.

## References by task

- [Policy reference](policy-reference.md#choose-the-policy-command): resolve app sources into pins, update trusted F-Droid releases, validate and lock policies; also profiles, OS pins, credentials, language, recipes and VPN.
- [Command reference](command-reference.md): command families, selectors, flags, structured output, and exit outcomes.
- [Encrypted registry](registry.md): authorized retention, private collection, record updates, history, and restore reconciliation.
- [Acceptance](acceptance.md): canary checks, per-phone qualification, and the five-profile self-service procedure.
- [Recovery and maintenance](recovery-and-maintenance.md): pending/failed runs, inspected cleanup, backups, restores, lifecycle events, and optional recovery automation.
- [AI integration](../ai-agents/README.md): MCP and CLI automation using the same reviewed workflow.

## Completion standard

For each delivered phone, retain its asset identity, reviewed configuration,
completed run/checks, accepted handoff, recipient custody, and matching packet.
Keep credentials and populated inserts in private storage. Record limitations and
missing checks explicitly; use a disposable canary for destructive installation
and restore qualification. [End-user instructions](../endusers/README.md) explain
the security and privacy information to discuss at handoff.
