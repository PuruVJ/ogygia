# Changesets

Releases are automated (`.github/workflows/release.yml`, the Changesets GitHub Action).

1. A PR that ships a change to `ogygia` adds a changeset: `pnpm changeset`, pick `ogygia` and the bump
   (patch / minor / major), and write one line that says what changed for users. That line is the
   changelog entry; `@changesets/changelog-github` adds the PR link and its author.
2. Merged to `main`: the **Version packages** PR opens (or updates) with the new version and changelog.
3. Merging that PR publishes `ogygia` to npm and creates its tag and GitHub release.

## Two lines: `main` and `next`

- `main` is the current line (0.8.x): its releases go out under npm's `latest` tag.
- `next` is the next minor, in pre mode (`.changeset/pre.json`, `changeset pre enter next`): the same
  flow publishes `x.y.z-next.n` under npm's `next` tag (`pnpm add ogygia@next`). A PR for the next
  line targets `next`; fixes land on `main` first and `main` is merged into `next`.
- To release the next line for real: on `next`, `pnpm changeset pre exit`, merge the Version packages
  PR, then merge `next` into `main`.
