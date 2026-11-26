# Security

## Reporting

Never include access/refresh tokens, device codes, profile files or unsanitized logs in public issues. Until the owner configures a private reporting channel, contact the owner through an agreed private channel rather than disclosing sensitive exploit details publicly.

## Trust boundaries

- Management handlers use DSH Connection's authenticated `/api` Fetch registry, including HTTP Host/Origin and native desktop owner-peer checks.
- An authenticated user adding a stdio server authorizes executable code with DSH's privileges. Review imported commands and settings before saving.
- APIs return header names and grant presence, not credential values. Debug output contains only counts, version and a profile identifier.
- Secrets use DSH's credential provider; encryption at rest depends on that provider. This plugin does not add its own keychain or encryption.
- Runtime settings belong only to the active DSH profile. They must never be copied into the package, repository or release artifacts.
- OAuth records have exact HTTP(S) resource identity and independent profile keys. Userinfo is rejected; queries and trailing slashes are preserved. Unscoped credentials and other profiles' grants are not adopted.
- OAuth endpoints require HTTPS except loopback. Metadata issuer and resource origin are checked; credential-bearing redirects are rejected.
- A selected server's authorization metadata is a trust decision. Inspect the verification link and never approve an unexpected device-code request.

## Host side effects

The current MCP client lacks an OAuth-provider injection point, so the plugin wraps `globalThis.fetch` for matching resource URLs. It is not a sandbox between plugins in one process; host-accessible plugins can also access DSH services directly.

System certificates are opt-in and affect all Node TLS requests in the process. Trust is added rather than verification disabled. Restart DSH after changing it.

Individual file replacement is atomic, but files and credentials are not a crash-atomic transaction. Ordinary failures trigger rollback; incomplete recovery is reported rather than hidden.

## Release checklist

1. Confirm publication rights and required organizational approvals; retain the MIT license notice.
2. Run `npm ci`, `npm test` and `npm run check`.
3. Inspect `npm pack --dry-run --ignore-scripts --json`.
4. Check the working tree and all Git objects/refs with a dedicated secret scanner as well as built-in checks.
5. Exclude runtime profiles, credential stores, personal logs and generated artifacts.
6. Verify anonymous and cross-origin rejection on every supported host version.

Authorization-code/PKCE login, OS-keychain implementation and native MCP-client OAuth are not claimed features.
