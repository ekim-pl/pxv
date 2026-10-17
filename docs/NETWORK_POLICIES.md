# Network policies and evidence

Network configuration belongs to a specific profile and application UID. The policy can declare a VPN package, always-on state, lockdown and a signed helper probe. Profile isolation is not proof that every app follows a particular route.

The adapter observes configured VPN state and package/user identity. A network probe installs a content/signer-pinned helper, binds its Android user serial, tests reviewed HTTPS endpoints and expected egress CIDRs, performs requested failure checks and removes only its owned helper/resources. The evidence scope is `probe-app-uid-https-only`.

Provisioning installs apps and performs their reviewed configuration before applying
VPN lockdown, then runs required network checks. If always-on/lockdown must change
and no configuration recipe targets the VPN package, the plan inserts a named manual
account/configuration/consent checkpoint for that profile before the VPN action.
An already compliant VPN adds no new checkpoint. Each checkpoint needs its own
action-scoped confirmation; a completed setup step in another profile is insufficient.

Configure expected routes and endpoint responses from the deployment's actual service, not a copied sample. A passing helper probe cannot establish the routing of every browser, system component, DNS resolver, tethered client or background app. Test representative actual apps and failure/reconnection behavior, then record the policy's named human checks.

When a probe succeeds or fails, its child cleanup scope must not release provisioning's parent resources, such as keep-awake. An interrupted probe leaves recoverable helper obligations. Never uninstall a package from a recreated user solely because its numeric Android user ID/name match an old record.

VPN/account credentials are entered privately by the recipient or approved owner.
Authorized retention uses the separate [encrypted registry](PHONE_REGISTRY.md);
registry values do not automatically configure the VPN. Keep secrets out of policy
manifests, recipe text, source control, notes and screenshots. A file staged for a
specific recipe must be declared and digest-bound; staged data is private project
material and must be removed through owned cleanup.

After OS, app, VPN or policy changes, repeat live checks. A stale attestation or a diagram of the intended route is not measured evidence. Unsupported UI flows remain manual. The operator owns deciding whether the specific pack's app and failure coverage is sufficient for its promised behavior.
