# ogygia talk

Slidev deck: inventory + pitch for [ogygia](https://ogygia.puruvj.dev), with a Remote Functions chapter.

Standalone nested project (own `node_modules` / lockfile) so it does not join the monorepo workspace.

```bash
pnpm -C talks/ogygia install   # or: npm install
pnpm -C talks/ogygia dev
```

Presenter notes are on **every** slide. Press `p` in the browser for presenter mode (notes + next slide).

```bash
pnpm -C talks/ogygia build   # static export to dist/
```
