# Core's e2e suite (the palaestra)

The e2e suite is scoped BY PACKAGE: every package's specs live with the package and run against a
small fixture app that lists only that package's plugin (`packages/<name>/e2e/*.spec.ts`, its own
`playwright.config.ts`, its fixture app in `packages/<name>/e2e/app`). This directory is CORE's
suite: the specs that need no plugin, against the palaestra (this app — it lists none). Each package
has a turbo `e2e` task (turbo.json), so turbo's package graph and cache decide what reruns: a change
to one plugin reruns that plugin's suite; a change to core reruns every suite (everything depends on
core); unchanged suites replay from the cache.

## Run

```bash
pnpm test:e2e                                   # every package's suite, through turbo (one at a time)
pnpm test:e2e:fast                              # the same, reusing each fixture app's existing build
pnpm turbo run e2e --filter=palaestra           # this suite only (its libraries built first)
pnpm --filter palaestra e2e split-brain         # one spec (libraries already built)
E2E_NO_BUILD=1 pnpm --filter palaestra e2e      # reuse the existing palaestra build
```

The suite's `webServer` builds the palaestra (`e2e-build.ts`, with the prerender-secret warn-path
probe) and serves that exact build with `vite preview` on port 3051 (with `ORIGIN` set for remote
`command` / form CSRF). Specs that need their own server (a dev server, a fixture app's build, the
adapter emulators) boot it in `beforeAll` (`spawn_server` from `@ogygia/tooling/e2e/servers.ts`).
The shared harness — `check()` (named soft assertions), the regexes, the packed ogygia, the suite
config — is `@ogygia/tooling/e2e`.

The other suites: `packages/devtools/e2e` (the dock, the profiler, an installed ogygia + devtools in
dev — against the devtools lab), `packages/testing/e2e` (`@ogygia/testing` against the devtools
lab's dev server), `packages/federation/e2e` (examples/mfe), `packages/freeze/e2e` (the freeze
fixture behind the edge emulators), `packages/content/e2e`, `packages/router/e2e`, and
`apps/docs/e2e` (dev HMR under `csr=false`, on the docs app).

### single-flight navigation (navigation OOO batch)

On a SPA navigation the router pulls all of the incoming page's `defer: 'load'` holes down **one**
batch POST to `/__ogygia__`, and each hole's HTML streams back as a `<template data-ogygia-slot>` parcel the
moment it settles (out of order). This is covered end-to-end by `frame-nav-batch.spec.ts` (no
per-hole waterfall), `frame-ooo.spec.ts` (fast-first flush order), `frame-batch.spec.ts` (one
response, a frame per call, forged calls dropped), and `frame-single-flight.spec.ts` (a command
returns its region). The pure parcel builder is covered by unit tests
(`packages/core/test/stream-regions.test.ts`).

Trust-boundary notes for region HMAC / SPA / seeds live in [`INVARIANTS.md`](../../../internal/notes/INVARIANTS.md).

`dedup.spec.ts` is a build-output inspector (no server): it checks the already-built palaestra
client output (Kit-driven) and runs a minimal standalone build of `apps/palaestra/dedup-fixture` to
prove both modes emit a duplicated-import component's code in exactly one chunk.

`mutation-guards.spec.ts` runs its build-time checks (transform errors for writing to a captured
var) with no server, and checks the runtime against the served build (prod-silence: no warnings).

`flicker.spec.ts` asserts the full zero-visible-change contract against the PROD build (no re-fetch
for SSR-resolved queries, live still connects, `.refresh()` still re-fetches). See the dev caveat
below.

### Dev caveat — remote-query seeding is production-only

The flicker fix reads Kit's INTERNAL per-request store (`@sveltejs/kit/internal/server`) to capture
SSR-resolved query responses. That store is a module singleton. In a production bundle everything is
one module graph, so our `ogygiaHandle` sees the live store and seeds the client (zero flash). Under
`vite dev`, Kit's server runtime resolves that module to a DIFFERENT instance than the externalized
library does (Vite SSR + pnpm boundary) — reachable only via `$app/server`, which does not expose the
store — so `try_get_request_store()` reads an empty store. We degrade gracefully: no seed is emitted,
islands re-fetch on hydration exactly as before (correct content, a brief re-render). No Kit patch can
be applied here, so dev keeps the pre-fix behavior.

Playwright chromium is required for the browser suites (`pnpm exec playwright install chromium`).
