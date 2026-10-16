# Network policies and evidence

Network configuration belongs to a specific profile and application UID. The policy can declare a VPN package, always-on state, lockdown and a signed helper probe. Profile isolation is not proof that every app follows a particular route.

The adapter observes configured VPN state and package/user identity. A network probe installs a content/signer-pinned helper, binds its Android user serial, tests reviewed HTTPS endpoints and expected egress CIDRs, performs requested failure checks and removes only its owned helper/resources. The evidence scope is `probe-app-uid-https-only`.

Configure expected routes and endpoint responses from the deployment's actual service, not a copied sample. A passing helper probe cannot establish the routing of every browser, system component, DNS resolver, tethered client or background app. Test representative actual apps and failure/reconnection behavior, then record the policy's named human checks.

When a probe succeeds or fails, its child cleanup scope must not release provisioning's parent resources, such as keep-awake. An interrupted probe leaves recoverable helper obligations. Never uninstall a package from a recreated user solely because its numeric Android user ID/name match an old record.

VPN/account credentials are entered privately by the recipient or approved owner. Keep them out of manifests, recipe text, source control, notes and screenshots. A file staged for a specific recipe must be declared and digest-bound; staged data is private project material and must be removed through owned cleanup.

After OS, app, VPN or policy changes, repeat live checks. A stale attestation or a diagram of the intended route is not measured evidence. Unsupported UI flows remain manual. The operator owns deciding whether the specific pack's app and failure coverage is sufficient for its promised behavior.
