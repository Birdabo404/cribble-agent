# Releasing Cribble Agent

Cribble Agent uses npm trusted publishing from GitHub Actions. The release job
does not use a long-lived npm write token.

## One-time npm configuration

Configure the `cribble-agent` package's trusted publisher with these exact
values:

- provider: GitHub Actions
- organization or user: `Birdabo404`
- repository: `cribble-agent`
- workflow filename: `release.yml`
- allowed action: `npm publish`

After a trusted release succeeds, set npm publishing access to require 2FA and
disallow traditional tokens. Keep account recovery codes outside the repo.

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
4. Create and push an annotated `vX.Y.Z` tag that exactly matches the package
   version.
5. Manually run the `Publish npm package` GitHub workflow and select that tag.
6. Verify `latest`, integrity, installation, and `cribble --version` directly
   from the public npm registry.

The workflow refuses branches and mismatched tags, uses a GitHub-hosted Node 24
runner, reruns tests and audits, and publishes through short-lived OIDC. GitHub
trusted publishing adds npm provenance automatically for this public package.

Homebrew distribution is intentionally deferred until the Phase 7 personal
token dashboard is complete.
