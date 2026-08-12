# ogygia talk

Slidev deck: inventory + pitch for [ogygia](https://ogygia.puruvj.dev), with a Remote Functions chapter.

Standalone nested project (own `node_modules` / lockfile) so it does not join the monorepo workspace.

```bash
pnpm -C talks/ogygia install   # or: npm install
pnpm -C talks/ogygia dev
```

Presenter notes are on **every** slide. Press `p` or open `/presenter/` (notes + next slide).

Do **not** pass `--remote false` — Slidev treats that as password `false`. Omit `--remote` for local presenting.

```bash
pnpm -C talks/ogygia build   # static export to dist/
```
