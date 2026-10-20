# Network policies and evidence

Network configuration belongs to a specific profile and application UID. The policy can declare a VPN package, always-on state, lockdown and a signed helper probe. Profile isolation is not proof that every app follows a particular route.

The adapter reads saved VPN configuration and package/user identity. Saved secure settings do not prove live always-on or lockdown enforcement. A network probe installs a content/signer-pinned helper, binds its Android user serial, tests reviewed HTTPS endpoints and expected egress CIDRs, performs requested failure checks and removes only its owned helper/resources. The evidence scope is `probe-app-uid-https-only`.

Provisioning installs apps and completes their reviewed configuration before a
`vpn_settings` checkpoint for **every profile**, including already-matching and
disabled VPN configurations. A changed VPN without a matching app recipe may first
pause at `app_setup` for private account setup and Android consent.

At `vpn_settings`, open Android's VPN Settings in the exact profile named by the
pause. Configure or witness the selected package, Always-on VPN and Block connections
without VPN toggles. Record `device attest --check vpn_settings --asset ASSET
--operator OPERATOR`, then resume the run. Each profile needs its own confirmation;
a receipt for another profile or an old plan cannot substitute. Only the active
profile's reviewed VPN transition is permitted during this checkpoint.

PXV verifies saved configuration without writing the secure VPN settings. The proof
is labeled `operator-witnessed-settings`, not an automated live-enforcement
measurement. Finalization requires the profile's bound witness proof as well as
policy-required network probes and human checks. A new provisioning run requires
new confirmations; missing proofs in retained state require newly reviewed
provisioning. Review refresh preserves validated completed proofs and requires a
fresh confirmation for unfinished work.

The ordinary `settings` list rejects secure keys `always_on_vpn_app` and
`always_on_vpn_lockdown`. Remove those declarations and express the requested state
in `vpn`; matching duplicate declarations are also rejected. Historical observations
remain readable, but affected retained execution plans require a fresh review.

A proof checksum alone is insufficient. Readiness, finalization and review refresh
validate the retained source plan, completed VPN action, derived run identity,
consumed receipt and exact attestation audit snapshot. Carried proofs must follow
the committed refresh chain. Missing or changed provenance blocks acceptance and
remains available for inspection; it is never repaired by rewriting evidence.
Expired source execution approval does not invalidate a completed proof. Execution
approval expiry and the 15-minute acceptance-measurement window remain separate.

Configure expected routes and endpoint responses from the deployment's actual service, not a copied sample. A passing helper probe cannot establish the routing of every browser, system component, DNS resolver, tethered client or background app. Test representative actual apps and failure/reconnection behavior, then record the policy's named human checks.

When a probe succeeds or fails, its child cleanup scope must not release provisioning's parent resources, such as keep-awake. An interrupted probe leaves recoverable helper obligations. Never uninstall a package from a recreated user solely because its numeric Android user ID/name match an old record.

VPN/account credentials are entered privately by the recipient or approved owner.
Authorized retention uses the separate [encrypted registry](PHONE_REGISTRY.md);
registry values do not automatically configure the VPN. Keep secrets out of policy
manifests, recipe text, source control, notes and screenshots. A file staged for a
specific recipe must be declared and digest-bound; staged data is private project
material and must be removed through owned cleanup.

After OS, app, VPN or policy changes, repeat live checks. A stale attestation or a diagram of the intended route is not measured evidence. Unsupported UI flows remain manual. The operator owns deciding whether the specific pack's app and failure coverage is sufficient for its promised behavior.

## Configuration validation

A VPN package selects Android’s always-on VPN: `alwaysOn` must be true exactly when
`packageId` is non-null. To disable always-on VPN, set `packageId` to null and both
booleans to false. Lockdown requires always-on VPN. Invalid combinations fail policy
validation before provisioning changes the phone.

Probe endpoints are exact reviewed HTTPS URLs. Query strings are supported and
passed unchanged to the helper; credentials, fragments and redirects are refused.
Do not place private credentials in query parameters. Expected egress ranges must
be valid IPv4/IPv6 CIDRs with bounded prefixes and no host bits or IPv6 zone scopes.
Malformed ranges fail policy validation before artifact acquisition or phone changes.
