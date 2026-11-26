# Runtime architecture

## Boundaries

The package is immutable runtime code. Its bundle patch registers only `mcp-management`; it is not a settings database.

- `index.js`: DSH service integration, authenticated Fetch routes, live inventory and reconnection.
- `profile-store.js`: profile-owned YAML editing, metadata and transactional failure handling.
- `server-config.js`: exact resource/profile identity and input validation.
- `oauth.js`: Device Code, credential rotation and the URL-scoped request hook.
- `client.js`: settings UI with distinct configuration, authorization and connection state.

## Persistence

`configEditor.documentPath` identifies the active profile directory. Server configurations live in that profile patch. Authentication mode, ownership and secret references live in `plugin-data/mcp-management/settings.json`. DSH's credential provider stores tokens and secret headers.

Profiles sharing one package checkout still have independent configuration and credential keys. The package is never scanned for user settings; other profiles' grants are never adopted. This plugin creates no default server entries; system-CA trust starts disabled. Existing servers supplied by other DSH bundles remain owned by those bundles.

The YAML AST preserves unrelated rows, comments and custom tags without evaluating them. Read/merge/write uses the same `package.json.lock` as ConfigEditor. DSH's atomic writer supplies bounded Windows replacement retries. Credential changes are staged before persistence; ordinary failures restore prior files and committed records without overwriting newer changes. Incomplete rollback is reported. This is not crash-atomic across files and the credential provider.

## API and UI

Handlers register once per exact path at `/api/mcp-management/*`, listing all supported HTTP methods. DSH authenticates HTTP and native desktop owner Peers before dispatch. No separate unauthenticated listener exists.

The API validates mutation payloads and never returns raw credentials. Editing a configured secret with an empty value retains it; deleting the row removes it. The UI persists one explicit auth mode: none, Token or OAuth.

A successful MCP operation confirms HTTP readiness. Active plugin fibers do not prove network or authorization success. stdio remains unknown until DSH exposes transport health.

## Compatibility constraints

The URL-scoped global Fetch hook bridges the current MCP client's static-header interface. Exact query and trailing-slash identity is retained; credential-bearing redirects are rejected. This is a host integration mechanism, not a security boundary between mutually untrusted plugins.

OAuth supports Device Code with dynamic public-client registration. Authorization-code/PKCE-only providers are not implemented. System-certificate trust is opt-in and process-wide.
