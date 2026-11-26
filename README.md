# DSH MCP Management

Manage HTTP and stdio MCP servers in DeepSeek Harness (DSH), with secret headers and OAuth Device Code authorization.

- Add, edit, import, enable/disable and remove servers.
- Authorize an HTTP URL before saving its configuration.
- Keep configuration and grants isolated by profile, outside the package directory.

Licensed under [MIT](LICENSE). The package currently has `private: true` to prevent accidental npm publication; this does not change its license.

## Requirements

- Node.js **24.5+**.
- DSH services: `configEditor`, `pluginManager`, `credentials` and `connection.fetch.register`.
- OAuth additionally requires DSH's `authorization` service and a provider supporting protected-resource metadata, Device Code and dynamic public-client registration.
- HMR is optional: without it, saved configuration requires restarting DSH.

Host service contracts determine compatibility. A matching Node/MCP-client version alone does not prove support. Authorization-code/PKCE-only providers are not implemented.

## Install a local bundle

From an available source checkout, install the dependency into each profile you use:

```sh
dsh plugin --profile web add "file:/absolute/path/to/dsh-mcp-management"
dsh plugin --profile desktop add "file:/absolute/path/to/dsh-mcp-management"
```

On Windows, use a path such as `file:C:/code/dsh-mcp-management`. `dsh plugin` forwards package-manager arguments to the selected profile.

Select/enable `@shirayner/dsh-mcp-management` in that profile's bundle list, then **fully restart DSH**. Refreshing settings does not reliably reload host JavaScript. Confirm the resolved installation path: a local dependency may be linked or copied, depending on the linker.

Each profile must be configured and authorized separately. Servers supplied by other DSH bundles may also appear in the list; installing this plugin does not reset or take ownership of them.

## Add or import servers

Names must contain **1–32 ASCII letters, digits, underscores or hyphens**. Import accepts an `mcpServers` object.

HTTP with OAuth:

```json
{
  "mcpServers": {
    "search": {
      "url": "https://mcp.example.com/mcp",
      "authMode": "oauth"
    }
  }
}
```

Local stdio:

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["server.mjs", "--label", "hello world"],
      "cwd": "/path/to/tool"
    }
  }
}
```

Argument arrays preserve whitespace and Windows paths. Existing `cwd`, `env` and transport options survive edits. Adding a stdio command authorizes executable code with DSH's privileges; review imports before saving.

### Authentication

| Mode | Behavior |
| --- | --- |
| `none` | No OAuth/stored-header injection; default when headers are omitted |
| `token` | Secret headers from DSH's credential provider; importing headers without an explicit mode selects this |
| `oauth` | The grant for this profile and exact HTTP URL |

In Token mode, enter the header name and value separately, such as `X-API-Key` and `example-token`. Stored values never return to the browser: leave a configured value blank to retain it, enter a replacement to update it, or remove the row to delete that header.

For OAuth:

1. Enter an HTTP URL and select OAuth.
2. Click **Authorize**, inspect the verification link and approve the device code.
3. The plugin commits the grant and restarts the matching MCP connection.
4. Save the configuration. The grant can be created before saving because its key includes the profile and exact URL.

**OAuth · 授权已保存** means the grant is stored, not that the MCP server accepts its token. The list and authorization panel show the same facts: a current-token 401 is **token 被拒绝（401）**, while network errors are connection failures. If reauthorization still returns 401, check the MCP server's token validation rather than assuming that saving failed. Responses from an older authorization cannot overwrite the new connection state.

Tokens refresh on use within sixty seconds of expiry. Rotation is serialized; a rejected token retries at most once for replayable requests. Cancellation and refresh failures are reported. Changing only the saved authentication mode restarts the existing connection when HMR is available; ordinary unchanged saves do not.

Query strings and trailing slashes are part of identity. Changing the URL or moving a profile directory requires separate authorization. Never put secrets in URLs.

## Where data lives

The package's `cordis.patch.yml` registers only this plugin. Runtime operations never write to the package or source directory.

| Location | Contents |
| --- | --- |
| `<profile>/cordis.patch.yml` | User MCP entries; unrelated rows, comments and YAML tags are retained |
| `<profile>/plugin-data/mcp-management/settings.json` | Auth modes, ownership, credential references and certificate preference |
| DSH credential provider | OAuth grants and secret headers, keyed by exact URL and profile identity |

The active profile comes from `configEditor.documentPath`. Package files and other profiles are never used to discover settings or adopt grants. There is no old-format migration or shared-authorization mechanism.

Removing a server does **not** revoke its OAuth grant. Revoke before removing when that is desired. For writable servers inherited from another bundle, removal stores a profile-local hidden/disabled marker; it does not edit or uninstall the bundle. Adding the same name again restores the entry. Read-only servers cannot be toggled or deleted.

Enable/disable and delete operations show pending, failure and completion feedback in both the list and detail views. A saved change that needs a restart or is overridden by higher-priority configuration is reported separately from a live change. Uninstalling the plugin does not silently erase user data.

## Troubleshooting and limits

| Symptom | What to check |
| --- | --- |
| Plugin missing or API returns 404 | Enable the bundle, confirm the required host services, fully restart DSH |
| Saved changes do not appear | HMR must be available; otherwise restart the host |
| HTTP server asks for authorization | Select OAuth and authorize this exact URL in this profile |
| Certificate-chain trust error | If the OS already trusts the certificate, use the displayed **Enable system certificates** action and fully restart DSH before retrying OAuth |
| Certificate expired or hostname mismatched | Ask the server administrator to fix the certificate; enabling system trust does not fix these errors |

System certificates default to off. Enabling them adds the OS store to **all Node TLS requests in that DSH process**; it does not bypass certificate validation.

An active plugin fiber is not connection readiness. HTTP status comes from observed MCP requests, not a guarantee that every tool is healthy. stdio readiness remains unknown without a host health signal.

Management uses DSH Connection's authenticated owner-peer carrier at `/api/mcp-management/*`. A URL-scoped global Fetch hook bridges the current MCP client's static-header interface; explicit Authorization headers win, and credential-bearing redirects are rejected. This is not a sandbox between host plugins.

Writes use DSH's shared `package.json.lock` and Windows-aware atomic replacement. Never delete a live lock. Ordinary failures trigger rollback and incomplete recovery is reported; files and credentials are not one crash-atomic transaction, and power-loss durability depends on the filesystem/provider.

## Development and verification

Run these commands **from a Git checkout**, not an installed runtime package:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm pack --dry-run --ignore-scripts --json
```

The check scans known private-domain/credential patterns in source and all locally present Git objects, and validates release metadata/documents. It is not a complete secret audit. CI is configured for Node 24 on Linux and Windows.

With the DSH CLI and `bash` on PATH, verify an installed web host without mutations or OAuth registration:

```sh
node scripts/probe-dsh.js
```

To additionally test Add/Import, real disable/re-enable and reconnection, Remove and same-name re-add:

```sh
node scripts/probe-dsh.js --mutate --profile-dir /path/to/active/dsh/profiles/web
```

The path must match the active web profile. This mode writes temporary loopback server entries, removes its artifacts, verifies package files remain unchanged and stops only its own DSH instance. It is a developer probe, not part of unit tests or CI, and it does not validate the desktop UI.

For browser verification, add `--ui` to the mutation command. The probe prints a temporary loopback `uiEntry` and test server name; open that entry, disable and re-enable only the named test server, cancel one delete confirmation, then confirm deletion. Open the printed `uiDone` URL to let the probe verify and clean up. It times out after five minutes. The helper keeps the host launch token in memory and must not be used as a persistent/public server.

## Contributing, security and license

- [CONTRIBUTING.md](CONTRIBUTING.md): human development and review workflow.
- [AGENTS.md](AGENTS.md): repository rules for coding agents.
- [SECURITY.md](SECURITY.md): trust boundaries and safe vulnerability reporting.
- [Architecture](docs/design.md) and [OAuth](docs/oauth.md): implementation details.
- [LICENSE](LICENSE): MIT terms, including the notice-retention requirement and warranty disclaimer.

Before publication, confirm your right to release the code and any required organizational approvals. Review Git refs/objects and package contents with a dedicated secret scanner; exclude runtime profiles, credentials, personal logs and generated artifacts. npm publication requires a separately authorized change to `private: true`.
