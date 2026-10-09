# adapter e2e suite

Proves an all-`csr = false` islands app works end to end on **every** SvelteKit adapter.

When every route is `csr = false`, SvelteKit skips its client build, so ogygia's runtime would 404 and
islands would silently break. ogygia fixes this by injecting a URL-less keepalive route during the
build and removing it at process exit (see `packages/ogygia/src/vite/index.ts`). This suite guards
that fix — permanently.

## What it does

For each adapter it:

1. Builds ogygia, packs it to a tarball, and installs that tarball into a copy of `fixture/` — the
   **real published shape**, not the workspace source.
2. Builds the fixture with that adapter.
3. Asserts the injected keepalive route was cleaned up and the ogygia runtime chunk was emitted.
4. Boots the real output on the closest **offline** emulator and drives a real browser (island
   hydrates and is interactive, the runtime script serves `200`, no console/hydration errors).

| adapter    | emulator                                              |
| ---------- | ----------------------------------------------------- |
| node       | real Node server (`node build/index.js`)              |
| bun        | node output run under the **Bun** runtime             |
| static     | static file server over `build/`                      |
| cloudflare | real **Workers runtime (workerd)** via `wrangler dev` |
| netlify    | the deployed artifact (`build/`)                      |
| vercel     | the deployed artifact (`.vercel/output/static`)       |
| auto       | build-verify only (no server without a platform)      |

No vendor accounts required. `bun` skips if Bun isn't installed; `cloudflare` skips unless `wrangler`
is on PATH or `OGYGIA_E2E_WRANGLER=1` is set (CI sets it).

## Run

```bash
node verify/adapters/run.ts                 # all adapters
node verify/adapters/run.ts --only=node,bun # a subset
node verify/adapters/run.ts --reuse         # skip the ogygia rebuild/install (fast iteration)
```

Or through the single entrypoint that runs every e2e suite:

```bash
pnpm run e2e
```

CI runs it on Node 22 + Bun + wrangler — see `.github/workflows/e2e.yml`.
