# Repository guidance

This file applies to the entire repository. Read the relevant implementation and tests before changing behavior. Use [architecture](docs/design.md) for module boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## Implementation conventions

- Use the existing plain JavaScript ESM host modules and runtime-loaded React client; do not add build tooling or a framework unless the task requires it.
- Keep changes scoped. Preserve unknown transport options, argument arrays, `cwd` and `env` during edits.
- Authentication has exactly three modes: `none`, `token`, `oauth`. Do not add package-file discovery, automatic adoption of unscoped credentials, shared profile grants or old-format migration.

## Runtime and security invariants

- The package is immutable. Derive the active profile from `configEditor.documentPath`, never from a checkout path, package directory or a user's home directory.
- Server entries belong in the profile patch; metadata belongs in its `plugin-data/mcp-management/`. Tokens and secret headers belong only in `ctx.credentials`.
- Credential keys bind both profile identity and the exact resource URL. Preserve query strings and trailing slashes; reject URL userinfo.
- Register management handlers through `connection.fetch.register` at `/api/mcp-management/*`. Register each exact path once with all supported methods. Do not add an unauthenticated WebServer route.
- Never return or log secret values. DTOs may expose header names and authorization facts only.
- Edit YAML through its document AST. Preserve unrelated rows, comments and custom tags; never evaluate a tag here.
- Serialize profile read/merge/write with DSH's shared `package.json.lock` and atomic writer. Stage credential changes and retain failure-path rollback. Do not break a live lock or overwrite a concurrent writer's newer record.
- Authorization, plugin activation and connection readiness are different states. A successful MCP operation establishes HTTP readiness; an active fiber alone does not.
- The Fetch hook and system-CA setting affect the host process. Preserve explicit Authorization headers, reject credential-bearing redirects, restore owned hooks on disposal, and keep system-CA trust opt-in.

## Verification

Run from a Git checkout:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm pack --dry-run --ignore-scripts --json
```

Scale tests with the change: storage changes need concurrency/rollback coverage; OAuth changes need cancellation, rotation, profile isolation and exact-URL coverage; route changes need exact-path/method and rejection coverage. Fix behavior rather than weakening assertions.

Unit tests use temporary directories and mock authorization endpoints. They must not use personal profiles, real grants or organizational services.

`node scripts/probe-dsh.js` starts and stops a real web host. Its `--mutate --profile-dir <active-web-profile>` mode writes temporary loopback server entries and cleans them up. Run that mode only within the task's runtime-mutation authorization. It does not verify the desktop UI or perform real OAuth registration.

## Documentation and delivery

- Keep user steps in README, contributor workflow in CONTRIBUTING, agent constraints here, and protocol/design detail in `docs/`; link instead of duplicating full sections.
- Update documentation when supported modes, storage paths, host requirements or lifecycle behavior change.
- LICENSE is MIT. Do not change licensing or copyright attribution without explicit owner authorization.
- Do not include user data, internal domains, credentials, personal logs or generated archives in the repository. `npm run check` scans the working tree and all locally present Git objects; this is not a complete secret audit.
- Do not commit, publish, deploy, delete user profiles, reset authorization or perform real OAuth registration without explicit task authorization.
- Report actual checks and their limits. Do not claim desktop validation, CI execution or a security guarantee from a web probe or unit tests alone.
