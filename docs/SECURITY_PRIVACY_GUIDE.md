# Security and privacy boundaries

Protect both the operator host and the phone. The toolkit trusts the local operating system, selected toolchain, product fork and installed extension code. It cannot defend its own files against a malicious operator account or replace physical custody controls.

Keep project state, backup material, helper signing keys and device evidence private. New private files use restrictive permissions. Do not commit live inventory, registry tokens, passwords, MFA/recovery material, private signing keys or signed-in screenshots. Build candidates use a public allowlist and reject private paths/symlinks; those checks supplement careful product ownership.

Artifact security combines reviewed identity and exact bytes. APKs need package/version/content/signer pins; repositories need authenticated index signers, age/rollback protection and approved redirects. OS images need their authenticated OpenSSH signing identity. HTTPS alone is not a trusted publisher identity. All installation routes use the same verification service.

Mutations run only under native physical-device/transport locks and a private authorization gate. Durable evidence excludes inherited command environments and arguments. Cancellation/owner loss keeps uncertainty visible. Recovery binds Android user serials to avoid modifying a replacement user. Never make a stuck operation disappear by deleting evidence.

Observations include measurable permissions, settings, packages, VPN/language/backup state and helper presence. Manual receipts cannot override contradictions. Recipe automation is restricted to its declared exact app/OS context; installed extensions remain trusted executable code, not sandboxed add-ons.

Recipients enter final credentials, accounts, MFA and recovery material privately. Normal lock, final language and optional duress setup have an explicit order. Destructive duress activation is never an acceptance test. Handoff exports project only approved public fields and should be reviewed before sharing.

Debugging is temporary provisioning access. Physically verify shutdown and helper removal before custody transfer. After a policy change, maintenance, loss or retirement, invalidate previous handoff evidence and follow the corresponding custody/recovery process. Read [verification](VERIFICATION.md) before making product claims.
