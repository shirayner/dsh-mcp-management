# Changelog

## 0.2.1

- Reconnecting an authorized server no longer leaves the entry reported as disabled: the restart marks the disposal as ordered and restores the entry's own flag afterwards.

## 0.2.0

- Keep the package immutable and persist settings only under the active DSH profile.
- Use independent profile-scoped OAuth grants and secret headers with exact resource identity.
- Support explicit none, Token and OAuth modes, including authorization before saving.
- Register authenticated management routes through DSH Connection with methods grouped by exact path.
- Preserve unrelated YAML and reuse DSH's shared writer lock and Windows-aware atomic replacement.
- Stage credential changes, roll back ordinary write failures and report incomplete recovery.
- Validate MCP-client naming/retry constraints and support re-adding removed names.
- Distinguish plugin activation, connection readiness and authorization state.
- Keep saved grants separate from current-token rejection, share fresh facts between the editor and list, ignore stale request observations, and reconnect metadata-only authentication changes.
- Make process-wide system-certificate trust an explicit opt-in preference, with actionable certificate-chain errors and a restart-required control in the authorization panel.
- Handle structured host enablement outcomes, show action progress/errors in every view, prevent duplicate mutations and support profile-local removal/re-add of inherited servers.
- Include storage/API/OAuth and action tests, real-host toggle/reconnection and browser probes, and source/package/Git-object release checks.
- Add the MIT license, contributor and agent guidance, and linked user documentation with release validation.
