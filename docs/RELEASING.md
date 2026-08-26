# Releasing Cribble Agent

Cribble Agent uses npm trusted publishing from GitHub Actions. The release job
does not use a long-lived npm write token.

## Current npm security posture

As of `1.3.0`, the `cribble-agent` package's trusted publisher is configured
with these exact values:

- provider: GitHub Actions
- organization or user: `Birdabo404`
- repository: `cribble-agent`
- workflow filename: `release.yml`
- allowed action: `npm publish`

The package requires 2FA for direct publishing and disallows traditional
publish tokens. Keep that restriction enabled and keep account recovery codes
outside the repo.

## Release a version

1. Update `package.json` and `package-lock.json` to the same new version.
2. Update tests and release notes, then run:

   ```sh
   npm ci --ignore-scripts
   npm test
   npm audit --omit=dev
   npm audit signatures
   npm pack --dry-run
   ```

3. Commit and push a clean tree. Never include local usage data, Agent keys, or
   generated credentials in the package.
4. Create and push an annotated version tag (for example, `v1.4.0-beta.1`) that
   exactly matches the package version.
5. Manually run the `Publish npm package` GitHub workflow and select that tag.
6. Verify the selected npm lane, integrity, installation, and `cribble
   --version` directly from the public npm registry. Stable versions publish
   to `latest`; prerelease versions publish to `beta`.

The workflow refuses branches and mismatched tags, uses a GitHub-hosted Node 24
runner, reruns tests and audits, and publishes through short-lived OIDC. GitHub
trusted publishing adds npm provenance automatically for this public package.
The explicit dist-tag selection keeps a prerelease from replacing `latest`.

Homebrew distribution is intentionally deferred until the Phase 7 personal
token dashboard is complete.
