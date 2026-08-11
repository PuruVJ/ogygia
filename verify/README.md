# Verification

## Run everything (one command)

```bash
pnpm test:e2e          # build lib + playground, serve, run ALL checks, summary
pnpm test:e2e:fast     # skip the build, reuse the existing playground build
node verify/run.mjs --only=lakes,router-race,prefetch   # a subset
PORT=3060 node verify/run.mjs
```

`verify/run.mjs` builds the library and playground, serves the production build (with `ORIGIN`
set for remote `command` / form CSRF), runs every check below in turn, and prints a green/red
summary. Exit code is non-zero if anything fails, so it drops straight into CI or a pre-release
gate. Run it every time — it is the regression net for every island/lake/partial/router surface.

## Manual / individual runs

```bash
# 1. Build the library, then the playground
pnpm --filter ogygia build
pnpm --filter playground build

# 2. Serve the production build.
# Playground uses @sveltejs/adapter-vercel. For local checks either:
#   - `ORIGIN=http://localhost:3051 pnpm --filter playground preview -- --port 3051`
#   - or temporarily switch to adapter-node and `ORIGIN=… PORT=3051 node playground/build/index.js`
# ORIGIN is required for remote `command` (POST) + form CSRF.

# 3. Run the checks (from repo root; Node 26 runs .ts directly)
node verify/fetch-checks.ts    http://localhost:3051   # SSR: island HTML, no Kit bootstrap
node verify/browser.ts         http://localhost:3051   # hydration, strategies, devalue, SPA
node verify/dashboard.ts       http://localhost:3051   # page shim, island goto, client table, chart
node verify/page-state.ts      http://localhost:3051   # page.url.* + params/route/status/data/form/error/state inside islands
node verify/console.ts         http://localhost:3051   # zero hydration_mismatch (includes /lakes)
node verify/remote.ts          http://localhost:3051   # client query+args+refresh, command, live
node verify/live-partial.ts   http://localhost:3051   # query.live partials: swap no-fetch, keep-alive, static morph
node verify/mixed.ts           http://localhost:3051   # csr=true coexistence + opt-in router
node verify/server-islands.ts  http://localhost:3051   # defer:'true' fallback/endpoint/HMAC/cookie/CSS
node verify/nested.ts          http://localhost:3051   # island-in-island single hydration + dev warn
node verify/presets.ts                                 # transform-level: region syntax + presets + errors
node verify/forms.ts           http://localhost:3051   # classic form actions (no-JS + JS)
node verify/prerender.ts       http://localhost:3051   # prerendered page + server-island hole
node verify/flicker.ts         http://localhost:3051   # SSR-resolved query seeding: zero-flash hydration
node verify/lakes.ts           http://localhost:3051   # lakes: frozen region, no client JS, island-in-lake, restore
node verify/mutation-guards.ts http://localhost:3051   # captured-var mutation: build errors + DEV proxy warns / prod-silence
node verify/defer-timing.ts    http://localhost:3051   # server-island fetch timing: load/idle/visible/media + preload-only-for-load
node verify/defer-hydrate.ts   http://localhost:3051   # defer+hydrate: coalesce, mismatch visible, counter click, props/modulepreload
node verify/prefetch.ts        http://localhost:3051   # router data-sveltekit-preload-* : hover fetch + click-from-cache, eager/viewport/tap/off
node verify/region-rate.ts     http://localhost:3051   # forged MAC flood: all 403, budget intact for valid request
node verify/router-race.ts     http://localhost:3051   # overlapping SPA navigations / stale swap guards
node verify/dedup.ts                                   # same-component-two-strategies -> ONE client chunk (kit-driven + standalone)
node verify/portable-bindings.ts http://localhost:3051 # portable bindings: static/dynamic/list + shared entry dedupe
```


### Route weaving (navigation OOO batch)

On a SPA navigation the router pulls all of the incoming page's `defer: 'load'` holes down **one**
batch POST to `/🏝️`, and each hole's HTML streams back as a `<template data-ogygia-slot>` parcel the
moment it settles (out of order). This is covered end-to-end by `frame-weave.ts` (no per-hole
waterfall), `frame-ooo.ts` (fast-first flush order), `frame-batch.ts` (one response, a frame per
call, forged calls dropped), and `frame-single-flight.ts` (a command returns its region). The pure
parcel builder is covered by unit tests (`packages/ogygia/test/stream-regions.test.ts`).

Trust-boundary notes for region HMAC / SPA / seeds live in [`INVARIANTS.md`](../INVARIANTS.md).

`dedup.ts` is a build-output inspector (no server): it checks the already-built playground client
output (Kit-driven) and runs a minimal standalone build of `playground/dedup-fixture` to prove both
modes emit a duplicated-import component's code in exactly one chunk.

`mutation-guards.ts` runs its build-time checks (transform errors for writing to a captured var)
with no server; pass a base URL to ALSO check the runtime DEV proxy. It is mode-aware: against a
PROD build it asserts prod-silence (no warnings); against `vite dev` it asserts the once-per-path
warnings for an object property, a Map mutator, and a Set mutator.

`flicker.ts` is mode-aware: against a PROD build it asserts the full zero-visible-change contract
(no re-fetch for SSR-resolved queries, live still connects, `.refresh()` still re-fetches); against
`vite dev` it asserts the graceful fallback (no seed → islands re-fetch, content stays correct).
See the dev caveat below.

All server-backed suites also pass against the dev server (`pnpm --filter playground dev`), e.g.
`node verify/server-islands.ts http://localhost:5173`. Dev needs no `ORIGIN` (Kit skips CSRF in dev).
`presets.ts` runs the built transform directly (no server needed).

### Dev caveat — remote-query seeding is production-only

The flicker fix reads Kit's INTERNAL per-request store (`@sveltejs/kit/internal/server`) to capture
SSR-resolved query responses. That store is a module singleton. In a production bundle everything is
one module graph, so our `ogygiaHandle` sees the live store and seeds the client (zero flash). Under
`vite dev`, Kit's server runtime resolves that module to a DIFFERENT instance than the externalized
library does (Vite SSR + pnpm boundary) — reachable only via `$app/server`, which does not expose the
store — so `try_get_request_store()` reads an empty store. We degrade gracefully: no seed is emitted,
islands re-fetch on hydration exactly as before (correct content, a brief re-render). No Kit patch can
be applied here, so dev keeps the pre-fix behavior. `verify/flicker.ts` asserts each mode accordingly.

Playwright chromium is required for the browser suites (`pnpm exec playwright install chromium`).

### Dev HMR under `csr=false` (docs)

With the docs app running (`pnpm --filter docs dev --port 5174`), probe route-shell full-reload,
island-entry reload, shared-module soft HMR, and CSS soft HMR:

```bash
node verify/dev-hmr-venues.ts http://127.0.0.1:5174
```

The script mutates markers and restores the files; it needs a writable docs tree.
