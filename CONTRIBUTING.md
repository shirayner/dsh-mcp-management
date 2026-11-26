# Contributing

The project is licensed under [MIT](LICENSE). Contribute only material you have the right to release under those terms; retain required third-party notices and do not include proprietary code or user data.

## Development

Use Node.js 24.5+ and a Git checkout:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm pack --dry-run --ignore-scripts --json
```

The runtime package is not a development checkout: tests and check/probe scripts are maintained in the repository. CI runs the test/check commands on Node 24 for Linux and Windows.

See [architecture](docs/design.md) for responsibilities and [AGENTS.md](AGENTS.md) for repository implementation invariants. Prefer the current JavaScript/React patterns and focused changes rather than unrelated refactors or new tooling.

## Tests and runtime verification

- Unit tests use temporary directories and mock OAuth endpoints, never personal profiles, live grants or organizational services.
- Storage changes need preservation, concurrency and rollback tests.
- OAuth changes need cancellation, rotation, exact-URL and profile-isolation tests.
- Route changes must retain authenticated owner-peer dispatch and exact-path/method coverage.

Follow the real-host probe instructions in [README](README.md). Mutating probes belong only on a profile you own and are authorized to change; they are not CI checks. A web probe does not establish desktop UI compatibility.

## Review and delivery

Include the behavior changed, relevant tests and actual results, and any unverified host behavior. Fix incorrect behavior rather than weakening assertions. Update user instructions and protocol/design detail when their contracts change.

Do not include server lists, credentials, `.env` files, personal logs, profile data or generated archives. Release checks cover known patterns and all locally present Git objects, but do not replace a dedicated secret scanner. Follow [SECURITY.md](SECURITY.md) for sensitive reports; never put unsanitized logs or secrets in a public issue.

Publication still requires ownership/organizational approval where applicable. Do not publish all refs or remove the npm publication guard without reviewing the release scope.
