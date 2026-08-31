# mfe — fragment federation demo (three teams, one page)

Three independent SvelteKit + ogygia apps, each its own build and server, composing into one
site. Everything here uses the real `packages/ogygia` (`workspace:*`) — no patched copies.

| app | port | role |
| --- | --- | --- |
| **shell** | 5180 | owns the domain: chrome, session, experiments; mounts cms, stitches dash |
| **dash** | 5181 | a widget catalog (`/og/fragment/kpis`) — SSR-stitched AND lazily client-stitched |
| **cms** | 5182 | a whole app (`expose()`d v2 route table) mounted under `/cms/*`; itself stitches dash |

Plus: `contracts/` (`@corp/contracts` — the shared `SharedState` cart + the `csr_exp`
experiment), `foreign-hosts/` (a zero-dependency `node:http` host and a PHP host mounting the
cms app — the wire is language-agnostic), `chaos/` (a latency/failure proxy for the
reliability drills).

## Run it

```sh
pnpm install                       # at the REPO root (these apps are workspace members)
pnpm --filter ogygia build
node gen-keys.mjs && source keys.env   # in examples/mfe — mints Ed25519 keys (gitignored)
# (general apps: `npx ogygia keys <caller>` prints one pair as env lines — same format)
pnpm --filter mfe-dash build && pnpm --filter mfe-cms build && pnpm --filter mfe-shell build
# three terminals (source keys.env in each):
cd dash  && ORIGIN=http://localhost:5181 pnpm preview
cd cms   && ORIGIN=http://localhost:5182 DASH_ORIGIN=http://localhost:5181 pnpm preview
cd shell && ORIGIN=http://localhost:5180 CMS_ORIGIN=http://localhost:5182 DASH_ORIGIN=http://localhost:5181 pnpm preview
```

Open http://localhost:5180 — the KPI card came from dash at render time; `/cms/*` is the whole
cms app under shell chrome. Kill dash and reload: the shell renders with an inline card.

## The API surface it demos

- **`client(origin, { sign, timeout, cache })`** — ONE transport per MFE
  (`shell/src/lib/clients.server.ts`): Ed25519 signing, bounded latency, SWR document cache,
  request coalescing, generation-safe invalidation. Every consumer below shares it.
- **`mount(cms)`** — one route-table entry mounts the whole cms app
  (`shell/src/lib/shell-router.ts`): nested layouts, form actions (PRG), redirects, its own
  404 — all faithfully translated. GET documents cache; POSTs invalidate.
- **`routes(table, { visitor, experiments })`** — THE identity, resolved once
  (`c.visitor`), signed into every mount hop on-behalf-of; experiment buckets **auto-carry**
  in the claims so every team renders the same visitor in the same world.
- **`expose(router, { base, verify })`** — the cms serves its route tree as a fragment
  endpoint (`cms/src/routes/og/fragment/page/+server.ts`); signature gate BEFORE routing;
  verified claims arrive as `c.visitor` / `user(c)`, unforgeable via HTTP.
- **`client.widget(name, props, { claims, traceparent })`** — a named catalog fragment for
  SSR stitching (`shell/src/lib/stitch.server.ts`, and cms→dash in
  `cms/src/lib/nested-stitch.js` — the three-team chain re-signs with the CMS's own key).
- **`proxy({ dash })`** — the lazy client-stitch endpoint
  (`shell/src/routes/og/frag/[name]/+server.ts`): the browser only ever fetches the SHELL.
- **`experiment()`** — `csr_exp` picks the cms `/lab` page's csr=true|false as two bindings
  of ONE file (`cms/src/lib/router.ts`); sticky per visitor; `?og-exp=` override rides the
  signed claims through every hop.
- **`SharedState`** — the cart (`contracts/src/index.js`) reacts across BUILDS on one page;
  devalue snapshot-on-write membrane keeps live references from crossing runtimes.

## Architecture facts worth stealing

- Foreign islands hydrate through the PRODUCER's `__og_hydrate` (closed over its own svelte
  core) — one scheduler per page, N svelte cores per N builds, no split-brain hydration.
- Claims are signature-bound: forging identity means forging Ed25519. They ride a Symbol on
  the forwarded Request in-process, so the MFE's standalone front door can never smuggle
  identity through a header.
- W3C `traceparent` continues through every hop (shell → cms → dash = one trace-id);
  Server-Timing names each team's cost in DevTools.
- Fragment props are plain data; wired classes crossing a BUILD boundary throw loudly
  (revivers off for foreign entries).

Full design + the 17-round experiment log: `internal/notes/mfe.md`.
