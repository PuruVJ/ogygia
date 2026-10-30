# Changesets

Releases are automated (`.github/workflows/release.yml`, the Changesets GitHub Action).

1. A PR that ships a change to `ogygia` adds a changeset: `pnpm changeset`, pick `ogygia` and the bump
   (patch / minor / major), and write one line that says what changed for users. That line is the
   changelog entry; `@changesets/changelog-github` adds the PR link and its author.
2. Merged to `main`: the **Version packages** PR opens (or updates) with the new version and changelog.
3. Merging that PR publishes `ogygia` to npm and creates its tag and GitHub release.

## Two lines: `main` and `next`

The split is for working on GitHub; on npm both are plain releases.

- `next` is the newer line (0.9): a PR for it targets `next`, and its releases go out under npm's
  `latest` tag as usual.
- `main` keeps the older line (0.8.x) for patches. Once `next` has released, `main` publishes under the
  npm tag `0.8`, so a patch never takes `latest` back (`pnpm add ogygia@0.8`).
- Fixes land on `main` first, and `main` is merged into `next`. When the older line is done, `next` is
  merged into `main`.
