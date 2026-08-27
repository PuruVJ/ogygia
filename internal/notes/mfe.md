# Microfrontends on ogygia — design + POC findings

Status: DESIGNED (this doc) + POC PROVEN (`/experiment/mfe-poc`, gitignored). Not implemented in the package.
Origin: 2026-08-27 design session. The POC runs two real SvelteKit+ogygia servers and stitches SSR'd.

## The one-line insight

A deferred server island is already "HTML fetched from a URL, dropped into a hole, CSS hoisted,
islands inside wake." **Fragment stitching = that URL belongs to another team's server.** No new
primitive; an existing one crosses origins. And stitch timing is already in the language: `await`
a fragment region = SSR-baked (server stitch, one paint, SEO); bare value = lazy client hole.
Same await-vs-bare law held regions already have.

## Three corporate shapes (name them apart — they get conflated)

1. **Source npm package** (v1, same deploy unit): sub-app ships ogygia-marked SOURCE + its v2
   route table as a value; host's plugin compiles it; mount = spread/mount the table. One runtime,
   one signing domain, free. Not independent deploy — it's code sharing. Needs: optimizeDeps
   exclusion so the transform sees the package.
2. **Gateway**: edge routes `/billing/*` to the billing server. Zero framework work, full-page
   reloads between apps, no shared chrome. Fine for most corporate asks; not an ogygia feature.
3. **Fragment stitching** (the prize): shell renders chrome; each MFE server renders pieces;
   one seamless SSR'd page from N independently-deployed teams. The rest of this doc.

## Decisions (each argued, some POC-proven)

### D1. The Svelte-instance seam — the hydrate contract (POC-PROVEN)
Compiled components only work with the exact svelte core they were compiled against; two builds =
two instances EVEN AT IDENTICAL VERSIONS (module-level hydration cursor / effect context).
POC failed exactly this way before the fix: `effect_orphan` + `Cannot read 'nodes'` — shell's
`hydrate()` wrote state into shell's svelte while the dash component read dash's.
**Contract: island entries export `__og_hydrate(target, props)` / `__og_unmount(app)` closed over
the PRODUCING build's svelte; the consuming runtime only schedules and delegates when the entry is
foreign-origin.** Cost: each MFE ships one svelte core (~12kB) shared by its islands. The contract
is tiny → version it with one number; response declares it; shell warns on major skew.
"One scheduler, N svelte cores, no version coupling."

### D2. Browser never talks to MFE servers — shell proxies fragment HTML
Direct client fetches = CORS + SameSite cookies + exposed internal hosts. Client-stitch holes hit
`/og/frag/<app>/<name>` ON THE SHELL; shell streams from the MFE server-side. Auth attaches in
exactly one place (shell's outgoing-request hook). Cross-app holes rejoin the router's single-flight
batch (they're shell URLs again). Static JS/CSS chunks do NOT proxy — immutable files from the
MFE's CDN (CORS = one header there). Direct-to-CDN fragment HTML = opt-in for public fragments.

### D3. Fragment response is a DOCUMENT, not an HTML string
`{ body, css[], head, status }` (+ format version). CSS links emitted immediately before the
fragment markup (legal in body; render-blocks only content after it = exactly no-FOUC). `head`
for page fragments (title/meta); `status` passes through (MFE 404 → shell 404); redirects rebased
under the mount. Asset URLs inside body must be ABSOLUTE → MFE builds know their CDN origin (one
env var).

### D4. Trust = named fragment catalog, NOT shared secret
`export const summary = fragment(Component, { props: schema })` mints a stable URL; only declared
fragments are reachable; props schema-validated at the door. The catalog doubles as the typed
contract: build emits a types-only stub package (`@corp/dash/fragments`) the shell imports —
`<Region of={await summary({ org })} />`. Kills secret distribution AND the arbitrary-component
surface. Every MFE serves `/__og/fragments.json` (live catalog + schemas + format version);
shell CI diffs stubs vs deployed catalogs → skew fails a build, not a Friday page.

### D5. Whole-app mounting: `fragment.routes(router)` + method passthrough
The MFE's entire v2 route table (its own layouts/error pages inside) as one path-keyed fragment.
Shell mount is ONE route entry owning ALL methods: `'/cms/[...rest]': mount(cms)` — forwards
method/body/search, translates the response document (routes-as-values payoff; two awkward files
in stock Kit). Link problem: MFE builds with Kit `base: '/cms'`; catalog records the base; shell
errors at boot on mismatch. Remounting = MFE rebuild (accepted; the alternative is HTML rewriting).

### D6. Boundary rules between teams
- Props: plain data, schema-checked. No wired classes, no context, no snippets/children across
  the boundary (code doesn't cross team lines). Fragment = leaf, not wrapper. (ESI-style named
  holes the shell fills = possible v2.)
- Failure: `placeholder` = loading, `failed` snippet = error card. `timeout` on an awaited
  fragment demotes to a client hole (works everywhere because proxy). Dead MFE costs its box.
- Caching: shell proxy, key = fragment id + props hash, honors MFE Cache-Control, request
  coalescing (N concurrent renders → 1 upstream call).
- Trusted federation, NOT sandboxing: any MFE's JS runs in the shell origin. Distrust → iframe.

### D7. Day two
Local dev: origins are config — run only your app, point neighbors at staging (likely the
best-loved feature). Timing stays on the COMPONENT's import (user ruling: no `wake` in `page()`);
a fragment's islands hydrate by the owning team's dials, N layers deep.

## POC (`/experiment/mfe-poc`) — what it proved 2026-08-27

Copied ogygia + `shell` (:5180) + `dash` (:5181), own pnpm workspace. All verified headless-Chromium:
- Shell SSR bakes dash's fragment (`await region(Kpis, props)` in a dash endpoint IS the fragment
  renderer — ~15 lines + URL absolutizing); one paint with dash pixels.
- Dash counter (`wake:'load'`) interactive INSIDE shell page, ticker (`wake:'visible'`) schedules,
  chunks + CSS from :5181, zero console errors; shell's own island coexists (one scheduler).
- Fragment-root scoped CSS travels via the `region:'raw'` mark (a PLAIN import in a server-only
  module has no client leg → its sheet never becomes an asset — real-feature must handle).
- Kill dash → shell renders with inline error card (failure isolation).
- The two package patches live in the POC copy only: emit.ts (entry exports the hydrate contract)
  + core.ts (foreign-origin delegation + foreign unmount). Local islands untouched.

POC shortcuts (v1 does properly): regex absolutizing → render-absolute from config; no proxy/lazy
client path; no catalog/types/cache/timeout/head channel/`fragment.routes`; foreign path skips
NestedProvider/context (BY DESIGN — context doesn't cross) but also lakes/keep/live + nested
islands untested; CSS link dedup at bake.

## Build order when implemented

1. `fragment()` + catalog + document response + render-absolute assets (MFE side).
2. Shell: typed stubs + `await`-bake + proxy + `failed`/`timeout`.
3. Hydrate-contract in the real package (benign for local islands; enables foreign).
4. Cache/coalescing; `/__og/fragments.json` + CI diff.
5. `fragment.routes()` + `mount()` (needs v2 router). Later: named holes (children), live regions
   across the boundary.
