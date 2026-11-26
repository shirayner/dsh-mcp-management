# OAuth implementation

## Ownership and identity

`oauth.js` owns discovery, dynamic public-client registration, Device Code, refresh and request injection. DSH `authorization` owns the interaction/commit lifecycle; `credentials` owns serialized record storage. The plugin does not maintain a second credential database.

Grant keys contain digests of the current profile directory and exact resource URL. Stored grants must match their schema, profile and resource. Only configured URLs load durable grants at startup; no unscoped or cross-profile credential is adopted.

## Flow

1. Read RFC 9728 protected-resource metadata from resource-path or origin-root locations.
2. Discover RFC 8414 authorization-server metadata and verify its issuer.
3. Register a public client through RFC 7591, or reuse this profile's stored registration for that issuer.
4. Request Device Code authorization through RFC 8628 and publish the verification URL/code through DSH.
5. Respect the polling interval and `slow_down`. Cancellation aborts waiting and requests; no grant is committed after cancellation.
6. Commit tokens through the DSH authorization session and restart matching MCP entries.

The form can authorize before saving. Saving persists the explicit auth mode, not the grant payload.

## Requests, refresh and revocation

The Fetch hook injects credentials for exact configured resource URLs. Explicit Authorization headers take precedence. Token mode injects stored headers; none suppresses injection. Other URLs pass through.

On each request, tokens within sixty seconds of expiry refresh through the credential provider's serialized record operation. Concurrent rejections reuse an already-refreshed token. Rotated refresh tokens replace their predecessors.

A 401 retries at most once for replayable empty/string bodies. Credential-bearing redirects are rejected. Failed refreshes throw instead of silently making unauthenticated requests.

Certificate-chain trust failures return the structured `tls/certificate-trust` code and a system-certificate opt-in action. Opt-in persists only the active profile's preference and requires a full host restart. It does not disable TLS validation or change fresh-profile defaults. Expired certificates and hostname mismatches do not use this action.

Revocation cancels pending authorization, calls the provider's revocation endpoint when available, then deletes this profile's grant. A rejected remote revocation retains the local record and reports the error.

## Status and limits

Authorization, plugin activation and MCP readiness are distinct. `authorized` describes a valid stored grant with OAuth enabled; `configured` also exposes a stored grant before the form is saved. Neither implies upstream token acceptance. `rejected` applies only to a Bearer challenge for the current injected token, not to an explicit caller Authorization header or a request without that token. Network/refresh errors preserve the stored-grant fact.

Observations bind to the authentication mode, current token and authorization epoch. Commit, revoke and metadata-only mode changes invalidate earlier observations; late responses cannot replace a newer authorization's state. Attempt status includes the same fresh, non-secret summary used by the list. The client polls serially and ignores responses after unmount; switching the form URL remounts the panel.

HTTP/TLS errors and challenges remain visible; a successful MCP operation establishes readiness. Saving or importing a mode-only change explicitly restarts the matching connection because the host's configuration reconciliation cannot observe plugin metadata. A post-save restart error is a warning about the committed configuration, not a failed save.

Only Device Code with dynamic registration is supported. Scope defaults to `openid profile email`; lifetime follows server responses. A native DSH MCP-client OAuth-provider API should eventually replace the Fetch hook.
