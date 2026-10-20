# pxv documentation

pxv is a local CLI and MCP toolkit for preparing Google Pixels with GrapheneOS,
reviewed apps, Android user profiles, and a recorded handoff. Choose your audience:

| Audience | Start here | Main tasks |
| --- | --- | --- |
| Operators | [Operator documentation](operators/README.md) | Prepare a single device or fleet, generate each device’s guides and inserts, and transfer custody. |
| End users | [End-user documentation](endusers/README.md) | Receive and use the phone, protect privacy, understand ordinary and duress credentials, and recover access. |
| Developers | [Developer documentation](developers/README.md) | Build pxv, create extensions, test changes, and package distributions. |
| AI integrations | [AI agent integration](ai-agents/README.md) | Run the MCP server, discover supported operations, and coordinate reviewed work. |

Preparing and using your own phone? Follow the operator’s
[single-device path](operators/single-device.md), then the
[end-user receiving checklist](endusers/receiving-your-phone.md). Perform both roles’
checks even when you are the same person.

## Printable guides and private packets

The existing [English and Polish guide sources](../guides/README.md) provide the
operator/user editions, phone-sized quick start, and blank credential inserts.
[Generate and pack a packet for every device](operators/guides-and-inserts.md)
using the installation’s policy, accepted report, and separately protected private
inserts. General guides describe intended configuration; the accepted handoff and
dated checks describe the actual device.

## Evidence and support

Start with a disposable canary. Starter policies require deployment-specific trust
and configuration. Passing source checks does not qualify a phone, network route,
or restore method; read [acceptance and evidence](operators/acceptance.md).

Community disables extension installation/invocation and experimental Seedvault
automation. Their references explain explicitly enabled products and retained
inspection/recovery behavior. See [security boundaries](../SECURITY.md) and use the
actual support contact supplied with your phone or product.
