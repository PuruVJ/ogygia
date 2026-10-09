# mfe — fragment federation v2 demo (three teams, one page)

Three independent SvelteKit + ogygia apps, each its own build and server, composing into one
site. Everything here uses the real `packages/ogygia` (`workspace:*`) — no patched copies.

| app       | port | role                                                                                |
| --------- | ---- | ----------------------------------------------------------------------------------- |
| **shell** | 5190 | owns the domain: chrome, session; mounts cms, renders dash widgets; FROZEN pages    |
| **dash**  | 5191 | a widget catalog (`kpis`) — served static (baked) AND deferred (a per-visitor hole) |
| **cms**   | 5192 | a whole app (`federate({ expose })`) mounted under `/cms/*`                         |

Plus: `contracts/` (`@corp/contracts` — the shared `SharedState` cart + the `csr_flag`
experiment), `foreign-hosts/` (a zero-dependency `node:http` host mounting the cms app — the
wire is language-agnostic), `chaos/` (a latency/failure proxy for the reliability drills).

## Run it

```sh
pnpm install                       # at the REPO root (these apps are workspace members)
pnpm --filter ogygia build
node gen-keys.mjs && source keys.env    # in examples/mfe — mints one Ed25519 pair PER app (gitignored)
# (general apps: `npx ogygia keys <name>` prints one pair as env lines — same format)
# three terminals (source keys.env in each — every app gets ALL publics + all origins + its own signing key):
cd dash  && ORIGIN=http://localhost:5191 pnpm dev --port 5191
cd cms   && ORIGIN=http://localhost:5192 pnpm dev --port 5192
cd shell && ORIGIN=http://localhost:5190 pnpm dev --port 5190
```

Open http://localhost:5190 — the static KPI card came from dash at render time (baked into the
shell's frozen page), the deferred card is a per-visitor hole fetched through the shell, and
`/cms/*` is the whole cms app under shell chrome.

## The API surface it demos — all of it is `federate()`

- **`federate({ name, key, peers, visitor?, expose?, widgets? })`** — ONE call per app, its whole
  federation identity, in `*/src/lib/federation.server.ts` (dash, shell) / `peers.server.ts` (cms).
  Returns typed peer handles. NO route files: the handle serves `/og/fragment/*`, `/og/thaw`, and
  the deferred-hole endpoint. The `peers` map is symmetric — each peer's public key verifies its
  inbound calls + thaw notices, the app's own private key signs outbound.
- **`mount(cms)`** — one route-table entry mounts the whole cms app
  (`shell/src/lib/shell-router.ts`): nested layouts, form actions (PRG), redirects, its own 404 —
  all faithfully translated. GET documents cache; POSTs invalidate.
- **`dash.widget('kpis', { org }, dials?)`** — a remote widget as a REGION
  (`shell/src/lib/shell-router.ts` home load): `render: 'static'` bakes it into the shell's SSR
  (freezable); `render: 'deferred'` is a per-visitor hole the browser fetches through the shell.
  Rendered `<Region of={data.kpis} />`.
- **Cross-app thaw** — the shell's home is a FROZEN page that bakes a dash fragment. A publish or
  deploy on dash sends a signed `/og/thaw` notice to the shell, which drops the frozen pages that
  embedded dash. `shell/vite.config.ts` turns freeze on; see the `data-state/freeze` doc.
- **`user(c)`** — verified signature-bound claims inside the cms's exposed loads
  (`cms/src/lib/router.ts` layout load reads `c.visitor`), unforgeable via HTTP.
- **`csr_flag`** — picks the cms `/lab` page's csr=true|false as two bindings of ONE file
  (`cms/src/lib/router.ts`); sticky per visitor; `?og-exp=` override rides the signed claims.
- **`SharedState`** — the cart (`contracts/src/index.js`) reacts across BUILDS on one page;
  devalue snapshot-on-write membrane keeps live references from crossing runtimes.

## Architecture facts worth stealing

- Foreign islands hydrate through the PRODUCER's `__og_hydrate` (closed over its own svelte core) —
  one scheduler per page, N svelte cores per N builds, no split-brain hydration.
- Claims are signature-bound: forging identity means forging Ed25519. They ride a Symbol on the
  forwarded Request in-process, so the MFE's standalone front door can never smuggle identity.
- A deferred remote region's hole URL is a shell-signed capability — the browser chooses nothing,
  so there is no open proxy and no allowlist to maintain.
- W3C `traceparent` continues through every hop; Server-Timing names each team's cost in DevTools.
- Fragment props are plain data; wired classes crossing a BUILD boundary throw loudly.

Full design: `internal/notes/federation.md`.
