# Changesets

Releases are automated (`.github/workflows/release.yml`).

1. A PR that ships a change to `ogygia` adds a changeset: `pnpm changeset`, pick `ogygia` and the bump
   (patch / minor / major). It also adds its line under `## [Unreleased]` in
   `packages/ogygia/CHANGELOG.md`, by hand, one line per change. `changelog` is off on purpose: the
   changelog is written, not generated.
2. Merged to `main`, the workflow opens (or updates) the **Version packages** PR: it runs
   `pnpm run version-packages` (`changeset version`, then the changelog's `## [Unreleased]` becomes
   `## [x.y.z] - <date>`).
3. Merging that PR publishes: the workflow builds, runs `verify:package`, publishes `ogygia` to npm,
   and creates the `vx.y.z` tag and its GitHub release from the changelog section.

`pnpm run release` is idempotent: a version already on npm is not published again, and an existing tag
or release is left as it is.
