# Changelog

All notable changes to **ogygia** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-08-09

The unification release. Partials become the one renderable, content collapses onto them, the
`@ogygia/content` package dissolves into ogygia, and config + exports get a single surface.

### Added

- **Live partials — LiveView over `query.live`, one word: `await`.** A dual partial (a component
  imported `with { partial: … }`, made into a value with `partial(Component, props)`) is now
  **awaitable**. Awaiting it renders the component to HTML on the server and bakes that HTML into the
  ticket, so the client swaps it in with **no fetch**. In an async generator, JavaScript awaits what
  you `yield`, so it is automatic:

  ```ts
  // stats.remote.ts
  export const dashboard = query.live(v.string(), async function* (id) {
    for await (const stats of feed(id)) {
      yield partial(StatCard, { stats }); // awaited by the language → HTML rides the ticket
    }
  });
  ```

  ```svelte
  <Partial of={dashboard(id).current} />
  ```

  The client swaps the first tick in immediately, then per tick does the right thing with no new API:
  - **static partial** (`partial: 'static'`, ships no client JS) → the runtime **morphs** the new
    HTML in place, so focus, typed-in input values, scroll, and CSS transitions survive the tick;
  - **interactive partial** (`partial: 'load' | 'idle' | 'visible' | media`) → **keep-alive**: the
    mounted island gets the new props pushed in (Svelte reconciles); local island state is not reset
    and it is not re-hydrated. A different component id replaces + re-hydrates.

  A partial you **don't** await still renders inline where it lands (first paint, same SSR pass) —
  delivery is a per-moment decision, not a per-import one. `partial()` returns an `AwaitablePartial`
  (a `Partial` you can render now, and a `PromiseLike<Partial>` you can await). The baked HTML rides
  the existing `ogygia.transport` Partial codec (install it once in your universal hooks). Playground:
  `/live-partial`; suite: `verify/live-partial.ts`.

- **Streaming server islands (opt-in) — `ogygia({ stream: true })`.** On a dynamic csr=false page,
  `handle()` keeps the response open after the shell, renders each immediate `defer: 'load'` hole
  in-process, and appends its HTML as a `<template data-ogygia-slot>` parcel after the document —
  **zero extra requests**, holes fill as they finish, out of order. The browser paints the shell
  first; each parcel is inert (`<template>` — no paint, no scripts, no image loads) until the runtime
  moves it into its region. Fallback is total and automatic: prerender / CDN pages, holes that need
  per-request server context the stream can't provide, and any render error all fall back to the
  per-hole fetch — streaming never changes correctness, only round-trips. `idle` / `visible` / media
  defers keep fetching on their schedule (deferring the SERVER work is their whole point). Default
  `false` while the e2e matrix is validated; drops `Content-Length` (chunked) and sets
  `X-Accel-Buffering: no` so the shell still paints early behind an nginx-style proxy. Live-partial
  `renderHtml` and streaming's render both use `svelte/server` on the SSR leg only — no server render
  code reaches the client bundle.

- **Partials — a server-chosen island you render like data.** `partial(Component, props)` mints a
  descriptor and `<Partial of={f} />` renders it, props type-checked against the component.
  - **Inline** (a plain component import): renders in the current SSR pass — the RSC-shaped path.
  - **Deferred** (`import Card from './Card.svelte' with { partial: 'load' }`): the server mints a
    signed capability in a load / remote function; the client fetches, swaps the HTML in, and
    hydrates. The one `partial` value carries the whole schedule — `'load' | 'idle' | 'visible' | a
    media query` set when the JS wakes, and `'static'` ships HTML only (no client chunk, never
    interactive). Works from `.svelte`, `.svx`, and `.ts` (load / remote) modules.
- **Dual-face partials + `ogygia.transport`.** A `partial()` made from a component imported
  `with { partial: … }` renders **inline** where it's created (server pass → first paint, hydrates)
  and becomes a **signed ticket** only when it actually crosses the wire. The one new mechanism is
  `transport`, a SvelteKit `transport` hook entry that signs on serialize and rebuilds on the
  client. Install it once in your **universal** hooks:

  ```ts
  // src/hooks.ts
  import * as ogygia from 'ogygia';
  export const transport = { ...ogygia.transport };
  ```

  A partial returned from a `load`/render renders inline; one returned from a remote (search, a
  live query) arrives deferred and self-fetches. Same `partial()`, locality automatic.
- **`content` is now part of ogygia.** Import from `ogygia/content`, `ogygia/content/collection`,
  `ogygia/content/formats`. `mdsvex` / `shiki` stay **optional peers** — ogygia never installs them.
- **One config surface.** All config lives in `ogygia({ … })`, including `content: { markdown }`.
  The svelte config only needs value-free calls:

  ```js
  ogygia({ content: { markdown: { themes } } })
  sveltekit({
    extensions: ogygia.extensions(),
    preprocess: [vitePreprocess(), ...(await ogygia.preprocess())],
  })
  ```

  `ogygia.extensions()` includes `.svelte` (adds `.svx`/`.md` when markdown is configured);
  `ogygia.preprocess()` is `[]` and loads no mdsvex when markdown isn't configured. The content dev
  HMR plugin is folded into `ogygia()` — no separate plugin to add.
- **Namespace API.** `import * as ogygia from 'ogygia'` → `<ogygia.Router />`, `ogygia.transport`,
  `<ogygia.Partial />`. `import * as ogygia from 'ogygia/server'` → `ogygia.handle()`.

### Changed

- **Breaking: content `render()` → the entry's `body` (a partial).** `get(id)` (server-only)
  returns `{ id, data, headings, body }`; render the body with `<Partial of={entry.body} />`. It's
  an inline partial — SSR'd in the page's own pass, islands inside hydrate as before.
- **Breaking: `OgygiaRouter` → `Router`, `OgygiaBoundary` → `Boundary`** (namespace-friendly).
  Use `<ogygia.Router />`.
- **Breaking: `ogygiaHandle` → `handle`, exported from `ogygia/server`** (`ogygia/hooks` kept as an
  alias). `ogygiaTransport` is now `ogygia.transport` (from the main `ogygia` entry).
- **Breaking: the default island endpoint is now `/🏝️` (single emoji), not `/🏝️ogygia🏝️`.** The
  single 🏝️ is already clash-safe against real routes; the brackets were redundant. Override with
  `ogygia.handle({ endpoint })`. No change to signing, props, or expiry.

### Removed

- **Breaking: `content.render()` and `renderHtml()`.** Replaced by `get()` + `<Partial>`. Content
  delivered over the wire (feeds, search) maps entries to partials of your own `with { partial }`
  components instead of returning HTML strings.
- **`@ogygia/content` as a separate package.** Its cross-package bridge, the `ogygia/preprocess`
  seam, and the optional-peer dance are gone — all internal now.

### Fixed

- **Router back/forward (popstate) swaps the page.** `navigate()` derived its `from` URL from
  `location.href`, but on a `popstate` the browser has already moved `location` to the target — so
  the same-document guard saw an identical URL and bailed into the hash-only branch, leaving the
  previous page's DOM in place while the address bar changed. The router now tracks the
  currently-displayed URL and uses it as `from`, so back/forward actually swaps the body.
- **Prefetched pages are used on click.** A hover / viewport / eager preload warmed the page-HTML
  cache, but `fetch_page` consulted that cache only when called without an `AbortSignal` — and real
  navigations always pass one — so the click re-fetched, defeating the prefetch. A cache hit is
  instant (nothing to abort), so it is now served regardless; the entry is still deleted one-shot
  after use, keeping the next visit fresh.
- **The `$app/state` page snapshot reaches islands.** The document page seed
  (`application/ogygia-page`, feeding the `$app/state` / `$app/stores` island shims) was built by
  reading `page` from `$app/state` inside the `handle` hook — but that is a rune, component-scoped,
  and throws `lifecycle_outside_component` outside a component, so the seed was always null and
  islands saw only the client `location` fallback (`page.url` worked; `params` / `route` / `status`
  were empty). The seed is now built from the `RequestEvent`.
- **`$app/state` page updates in islands after SPA nav under `vite dev`.** The page snapshot store
  is a module singleton the runtime writes (`set_page`/`reset_page` on navigation) and islands read
  (`page.url` / `params`). In a production build the runtime and island entries share one
  `page-store` chunk, so one instance — but `vite dev` serves the module twice (the runtime imports
  it relatively; islands reach it via the `$app/state` alias, a different URL), so the runtime
  updated one instance while an island read the other, leaving `page.url` stale after an SPA
  navigation (e.g. a sidebar's active link stuck on the previous page in dev). The store is now a
  `globalThis` + `Symbol.for` singleton — one instance no matter how many times the module loads.
- **Lakes survive client hydration.** A `hydrate: 'none'` lake inside a hydrated island vanished
  once the island hydrated. The runtime bundle (which mounts the provider that sets the "inside an
  island" context) and each island-entry bundle (which reads it in the lake wrapper) are separate
  client graphs; `createContext`'s per-module `Symbol()` minted a **different** key in each, so
  `setNested()` and `isNested()` missed each other, the lake rendered no `<ogygia-region
  hydrate="none">` client-side, and the lift/restore dropped it. The nested-island context key is
  now a global `Symbol.for`, identical across every bundle. SSR bundles once, so this only ever
  surfaced after hydration.
- **Content-page islands now build.** Island chunks are emitted in `buildStart`, which scans
  `.svelte` / `.ts` — islands authored inside markdown (`.svx` / `.md`) become Svelte only after a
  preprocessor, so their chunks were never emitted (404 at prerender). ogygia now runs a build-time
  scanner on the island bridge in BOTH build legs; the internal markdown transform fills it. Running
  it in the SSR leg too means `.svx`-authored SERVER islands land in the server manifest — otherwise
  their signed endpoint 403'd at runtime. ogygia stays format-agnostic — it never names `.svx`.
- **Standalone client build no longer strands SSR island registrations.** When every route is
  `csr=false`, ogygia runs a standalone client build that re-invokes the plugin factory, which
  reassigned the shared island-bridge transform. The bridge transform is now saved and restored
  around the standalone build.
- **Deferred regions hydrate on `csr=true` pages.** A server island / `<Partial>` on a `csr=true`
  page fetches its HTML after load, so Kit never hydrated it — but `#hydrate` bailed via its "Kit
  hydrates this" guard and left it inert. The guard now exempts deferred regions.
- **Dropped phantom modulepreload chunks.** Island dependency preloads are now collected in
  `writeBundle` (post-merge) and filtered to emitted chunks, so a rolldown-eliminated shared chunk
  can't leave a `modulepreload` pointing at a file that was never written (404 at prerender).

## [0.4.3] — 2026-08-07

### Fixed

- **`invalidateAll` is a soft seed refresh, not a body swap + view transition.** Kit remote `form()` always calls `invalidateAll` on success; ogygia previously re-fetched the current URL via full SPA navigate (VT + `body.replaceWith`), which remounted islands and could re-paint stale SSR HTML (in-memory remotes / multi-isolate). It now busts the page-HTML cache, re-fetches, merges `<head>`, and refreshes `application/ogygia-page` + `application/ogygia-remote` seeds in place — no VT, no body swap, no island remount, no live query-map clear, no auto-refresh of live queries, and no `beforeNavigate`/`afterNavigate` (Kit soft invalidate is not a navigation). Soft fetch abort/generation is isolated from hard `navigate()` so invalidate cannot cancel an in-flight click nav. Islands that need query updates use `.refresh()`, or `submit().updates(query)` **with** server `requested(query).refreshAll()` (updates alone does not populate response `q`).
- **csr=false FOUC CSS no longer dual-owns island component JS.** Restoring styles by importing the authored `.svelte` beside the client binding stub put the same default-export module in the page graph *and* the `emitFile` island entry, so Rolldown thin-facaded every `ogygia-island.*`. Stub hosts now import `virtual:ogygia/fouc-css/<entry>.js` — a CSS-only graph (scoped `.css` virtuals + transitive plain stylesheets) with no component JS — so Kit still links stylesheets while named island entries own the hydrate module.
- **csr=false client stubs keep a side-effect entry import for island CSS.** Portable bindings rewrote marked imports to `virtual:ogygia/client-binding-stub` and dropped the host `__css` import of the authored `.svelte`. Kit only links stylesheets from the *client* page graph, so layout/page islands painted with scoped class hashes but **no rules**. Stub bindings still omit wrappers/entries; one deduped `import '…entry.svelte'` restores FOUC CSS.

## [0.4.0] — 2026-08-07

### Changed

- **Portable island bindings (breaking).** A marked `import A from '…' with { hydrate|defer|preset }` rewrites **`A` itself** to a virtual Island/ServerIsland/Lake wrapper. The template keeps `<A />`; dynamic `<Comp />` / `{#each}` lists of `{ Comp: A, props }` work.
- **Dedupe is identity-based:** same component path + strategy/options → one wrapper + one client `emitFile` entry across import sites and hosts (not `host::tagIndex`). Multiple instances share the entry URL; each still gets its own region/props at SSR. Scale: 1000× same binding → **1** module, not 1000.
- **csr=false client hosts omit wrapper links** (same spirit as 0.3.1): marked imports bind to `virtual:ogygia/client-binding-stub` so Kit page nodes do not pull N wrappers/entries into the client graph. SSR / csr=true keep real wrappers; hydrate still loads via `import(entry)`. Wrappers are not an extra client network hop.
- **Vite 8 / Rolldown:** plugin `build.rolldownOptions` (not deprecated `rollupOptions`) for `preserveEntrySignatures`.
- **Props** are real Svelte props into the wrapper (devalue for the region/endpoint). Free-var tag-site capture and tag `s.overwrite` replacement are removed.
- **`ogygiaFallback`** is a normal snippet prop on the ServerIsland wrapper (no host peel/re-attach).
- **Host children** on hydrate/defer call sites are a build error (except `ogygiaFallback` on defer). Put UI and lakes inside the island component.
- Lakes are portable wrappers too (`isNested()` → LakeRegion; shell → plain component).

### Removed

- Static-tag-only requirement and “never used as a static component tag” errors.
- Tag-hoist virtual modules that baked call-site markup/children into the island entry.

### Tests

- Transform/audit coverage for portable bindings, dedupe, dynamic components, list/each, defer+fallback, defer+hydrate, lakes, presets.
- Permanent e2e: `verify/portable-bindings.ts` + playground `/portable`.

## [0.3.5] — 2026-08-07

### Fixed

- **Nested server / deferred-client islands keep authored attributes.** `ServerIsland` now passes the virtual island module as `__component` (entry stays `__css` for FOUC), matching `Island` — nested inline degrade no longer drops static props like `salutation="Hey"`.

### Tests

- Thorough coverage for deferred client islands: transform combo/presets/coalesce attrs, runtime phase-2 contracts, playground `/defer-hydrate` + `verify/defer-hydrate.ts` (coalesce, mismatch visible, counter click), nested defer+hydrate degrade.

## [0.3.4] — 2026-08-07

### Added

- **Deferred client islands** — `with { defer: '…', hydrate: '…' }`. Phase 1 fetches signed HTML on the defer schedule; phase 2 `import(entry)` + hydrates that DOM. Matching schedules coalesce to immediate hydrate after swap (no second idle / IO / MQ). `hydrate: 'load'` after any defer is ASAP after swap.
- Emit both the signed defer endpoint (opaque region id) and an importable client module URL on `<ogygia-region entry>` for the combo. Props sibling + `modulepreload` when phase-2 is load (authored or coalesced).

### Changed

- `defer` + `hydrate` is no longer a roadmap build error. `hydrate: 'none'` + `defer` is a **dev warning** (nonsense — use `defer` alone) and is treated as defer-only.

## [0.3.3] — 2026-08-07

### Changed

- **`hydrate: 'load'` also `modulepreload`s dependency chunks.** Client `generateBundle` walks each `ogygia-island.*` facade’s static `imports` graph and writes `.svelte-kit/ogygia-island-deps.json`; SSR reads that handoff when emitting head links (Kit builds SSR before client, so hashes can’t be baked at SSR compile time). Idle / visible / media still preload nothing.

### Notes

- Same handoff shape as the deterministic island/runtime filenames: client writes, SSR consumes — except dep chunk names stay Vite content-hashed, so the map is the bridge.

## [0.3.2] — 2026-08-07

### Changed

- **Single runtime bootstrap.** Only one `<script type="module" data-ogygia-runtime>` is emitted per page (via `<OgygiaRouter>` in `<svelte:head>`, or the first top-level island when there is no router). Islands no longer each inject a duplicate tag.
- **`hydrate: 'load'` `modulepreload` hoisted to `<head>`** (and server-island `rel=preload as=fetch` for `defer: 'load'` likewise). Keeps the props `<script>` the immediate sibling of `<ogygia-region>`.

### Fixed

- Nested routes: relative island entries (`../_app/…` from `asset()`) no longer resolve against the runtime module URL into `/_app/_app/…` 404s. `import(entry)` now resolves relatives against the document URL.

## [0.3.1] — 2026-08-07

### Fixed

- Client build: thin `ogygia-island.*.js` Rolldown entry facades. Root cause was csr=false page nodes statically importing the same virtual island module that `emitFile` registers as a named entry (shared module → facade). csr=false client hosts now omit that import; hydration still uses `import(entry)`. csr=true hosts keep `__component` so Kit can hydrate islands as normal components.

## [0.3.0] — 2026-08-06

### Changed

- **Self-describing hydrate `entry` (Astro-style).** `<ogygia-region entry>` now carries an **importable module URL** in production (`/_app/immutable/ogygia-island.<id>.js`), not an opaque registry id. Dev already used Vite `/@id/…` URLs; prod matches that model.
- The sticky client runtime **no longer embeds an app-wide `regions` map**. Island JS was already code-split; the registry was the part that grew with hydrate count. Runtime loads islands with `import(entry)` only.
- Client build **`emitFile`s** each hydrate island at a deterministic `ogygia-island.<id>.js` filename (same SSR↔client handoff pattern as `ogygia-runtime.<hash>.js`).
- SSR of hydrate islands renders the **virtual island module** (same tree the client hydrates). The entry `.svelte` stays as a side-effect `__css` import so styles still join Kit’s FOUC bag under `csr=false`.

### Fixed

- Dev: `asset()` must not rewrite Vite `/@id/…` URLs to `./@id/…` — that made `import()` resolve against the runtime module path and 404.
- Dev: `modulepreload` between the region and the props `<script>` skipped the devalue payload; props are the immediate sibling again, and the runtime skips intervening `<link>`s.
- Hydration mismatches for demos like `codeHtml={data.heroCode}`: SSR used to spread captures onto the **entry** component (`{ data }` → missing `codeHtml`), while the client hydrated the virtual module. SSR and client now share the virtual tree.

### Notes

- Defer / lake `entry` attributes remain **opaque region ids** (HMAC + server manifest). Only hydrate regions use module URLs.
- `hydrate: 'load'` emits `<link rel="modulepreload">` for the island URL (Vite’s automatic preload graph does not apply to `@vite-ignore` dynamic imports).
