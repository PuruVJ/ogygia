---
title: Releases
summary: Each release of ogygia, newest first.
---

All notable changes to **ogygia** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-10-09

The **passage** release: the runtime and the compiler rebuilt on one identity primitive, regions that move instead of reset across navigations, a standalone compiler, a production SSR profiler, a devtools dock, a typed router, frozen pages and fragment federation. Underneath, one load scheduler, one DOM ownership model and one page model replace per-path rules.

### Breaking changes

- Flags and experiments collapse onto one primitive, `flag()`; `experiment`, `layer`, `allowOverrides`, `onExposure`, `batchExposures`, `.bucket`, `.on` and `routes({ experiments })` are removed.
  Declare with a shape (`flag('x')`, `flag('x', 10)`, `flag('x', fn)`, `flag('x', { control: 80, bold: 20 })`), read by calling it (`checkout(c)`), branch with `flag.pick(map)` / `flag.pick(c, map)`, read payloads with `flag.value(c)`, configure once with `decide({ source, overrides, exposure, batch })`, and pre-decide in a route-only shell with `routes({ flags: [...] })`.
- `kitMount` is now `mount.kit`.
- `ogygia/rewrite` is now `ogygia/markup` (no alias; change the import).
- `transformHole` is removed; `ogygia.handle({ transform })` covers region answers and documents alike.
- `regionTtl` is now `regions: { ttl }`.
- `regions.preload` is removed; each island's whole graph preloads at its wake.

### Added

- One load scheduler for every download ogygia starts: island code and background work wait for the page's `fetchpriority="high"` resources (or the first input, or a 2.5 s cap), so islands no longer compete with the hero image.
- Holes and regions a remote `query` / `command` renders see their page's `page.url`, route, params and server-load `page.data` (looked up through Kit, only when read), so a server-rendered header can refresh in place ("A lake that can refresh").
- One DOM ownership model for every ogygia DOM writer — who writes inside an element, its attributes, its children's order and their existence — so a web component's own DOM survives repairs, hole answers and navigations.
- SvelteKit 3 support, on the APIs late Kit 2 and Kit 3 share.
- The SSR profiler, `ogygia({ profiler })`: CPU, network, heap and the browser half of a visit, with a 0–100 page score and on-demand mode (`profiler: { onDemand: true }`).
- Devtools, `ogygia({ devtools })`: an island-graph dock with Page, Hydration, Record, Bytes and Profiler tabs, every vital explained down to the island and line responsible.
- `ogygia/testing`: the devtools and the profiler as test primitives.
- `ogygia/router`: Kit's routing, programmatic and fully typed; `document()` renders a complete page from a handle.
- `ogygia/internal/compiler`: the compiler as a standalone, bundler-agnostic engine.
- Frozen pages, `ogygia({ freeze: true })`: a page renders once on write and is served as stored bytes until a publish thaws it (with edge stitching for per-visitor holes).
- Fragment federation: one `federate()`, a remote fragment is a region, and a publish thaws it everywhere.
- The Ref hub: one identity layer for live classes, stores, functions, snippets and held regions that cross an island boundary.
- Transportable values: everything devalue rejects now crosses through one serialization seam; unbridgeable values fail at discovery, not in production.
- A navigation moves regions instead of resetting them (state-delta reconciler); opt-in server-delta navigation renders only what changed (`router: { serverDelta: true }`).
- `ogygia.handle({ transform })`: server transforms that may reshape Svelte-owned markup, restored in the browser before hydration.
- `ogygia/markup` and `scanRegions(html)`: the region round trip for an app that runs a third-party SSR pass over the page.
- On-demand server islands: `render: 'deferred'` + `wake: 'interaction'` fetch nothing until the visitor shows intent.
- `prefetch` warms a deferred hole's HTML before it swaps.
- `keepFallback()`: a server island's answer that keeps the page's fallback.
- `requestEvent()`: Kit's `RequestEvent` inside a server island.
- `isOgygiaPage()`: tells shared code which world it runs in.
- A lake survives Kit hydration on a `csr = true` page.
- `ogygia({ barrels })`: barrel imports become leaf imports at transform time.
- Zero-config library islands: a dependency declares its island roots in its own `package.json`.
- The app's `hooks.client.ts` `init` runs on `csr = false` pages.
- Server islands ship their component tree's CSS; region CSS obeys Kit's `inlineStyleThreshold`.
- Lazy islands download at background priority, so they never fight the first paint.
- Accessible SPA navigation (focus, announcements) and a reason on every page fetch.
- `when()`: flags gate routes, and `pick` chooses infrastructure; OpenFeature interop (`ogygia/flag/openfeature`).
- The build warns when island code reads a context nothing bridges.
- A recovered or healed island says why, and the discard warning names what Svelte threw.
- The ogygia MCP server grows to eleven tools, and the bundled AI skill is rewritten.

### Changed

- A `<Region of={promise}>` waits where the render can: awaited in the server render under Svelte's async mode, streamed as a late region on the server router, or resolved after hydration otherwise.
- Islands inside a region's HTML always wake on the runtime, `csr = true` pages included.
- The page seed ships only when an island reads it, and only the `page.data` keys the page's islands read.
- The remote seed ships only for remotes an island on the page can call.
- Island props reference the page seed instead of copying it, and ride at the end of the body with the module-preload hints.
- Island hints are `fetchpriority="low"`; island wakes start after the page has painted.
- The boot never loads Svelte and is four files fetched in one round trip; the runtime goes right before the page's own JavaScript.
- Duplicate stylesheet links are dropped.
- HTML is byte-identical across renders (window-aligned capability expiry, per-request slot ids).
- The server request path is one request store, one document pass and one walk, and stops allocating per item.
- A slow or hung page can no longer wedge the profiler or the site, and recordings coordinate across processes.
- The Vite plugin is a compiler, and region rendering is region-granular.
- `rolldown` is no longer a dependency: the compiler parses and bundles through the app's Vite, keeping its 16 MB native binary out of production installs.

### Fixed

- Island entries on pages below the root no longer 404 in builds (Kit's `asset()` form comes from the build's Kit version).
- A region moved by another script keeps its in-flight fetch and its woken island.
- Restored shadow roots keep their sheets across a router navigation.
- A preloaded `load` hole stays out of the batch instead of downloading twice.
- Region URLs are pinned to their page, there is one region per hole across path depths, and a navigated island arrives whole in one swap.
- A registry's plain imports keep their CSS on `csr = false` pages; an island inside an island links its own CSS; held regions keep inline sheets.
- A kept island adopts its server DOM instead of discarding it on every load.
- An island with children has the same fingerprint and bytes on every render.
- An island edited while it slept hydrates from its own server markup instead of re-rendering.
- A hole answer that is not the region's (a redirect, a whole document) is refused.
- A deferred hole survives Kit rebuilding a client-on document, and outlives a CDN-cached document.
- A hole's answer morphs over its fallback on every schedule, keeping a web component's attributes and state, unfocused edited fields, and focus visible to assistive tech.
- Region and hole HTML is parsed aware of declarative shadow DOM.
- A lake with no island host survives Kit giving up on the document, and a lake's island with props hydrates on a `csr = true` page.
- An error page under a `csr = false` page renders as the Kit-hydrated document it is.
- A `csr = true` route that imports a block registry no longer links every block's CSS and chunk, and a `csr = false` page links only the island CSS it renders.
- Island entries and the runtime are content-hashed, so a deploy never runs the last build's island code.
- The runtime's hash module is no longer named `fingerprint.js`, which ad blockers blocked.
- A `visible` island's code waits for the viewport, and a scroll-woken island no longer waits on the scheduler.
- An island of ours on a Kit document waits until Kit has applied its page; `requestEvent()` answers under Kit's own render too.
- `goto()` from an island on a Kit-booted page navigates through Kit, and a script module reached through an app alias gets the island's page.
- The router keeps a destination page's inline `<style>` sheets, follows `data-sveltekit-reload`'s grammar, navigates links inside web components in place, corrects the address bar after a server redirect, and keeps the live `<body>` on a fallback swap.
- An unkeyed wrapper around an island survives a sibling inserted above it, and lakes restore by DOM position.
- A layout's csr world derives from the pages it serves, and a `csr = true` page under a `csr = false` layout keeps the layout's chrome.
- `kit.files.routes`, `kit.outDir`, `appDir` and `paths.base` are honoured everywhere, and route walkers follow symlinks.
- Island chunks are emitted only for islands the server bundle can reach.
- Region fingerprints no longer cost 20 ms per island; the profiler is free when it is not profiling.
- `$app/stores` `$page` works inside every ogygia render root, and a server island's `page.url` is the referring page.
- On a `csr = true` page a server island keeps its server-minted endpoint through Kit's hydration, and server-island HTML is absolutized for nested paths.
- `wake: 'interaction'` replays the waking click on the next frame, into the deepest target.
- A `wake: 'none'` lake in a `+layout.svelte` ships its scoped CSS, a lake's or island's scoped CSS keeps its Svelte hash, and the fouc-css fallback ships valid CSS.
- An island inside a server island's `ogygiaFallback` stays a region, and `keepFallback()` from an inline-rendered server island fails with the reason.
- A relative `with { wake }` import inside a `{#snippet}`, a forwarded snippet opening with `{@const}`, and a raw `<style lang="scss">` no longer break or silently skip a component.
- A portable snippet carries its host's style scope, a branded snippet runs in place, and store auto-subscriptions in crossing snippets hoist as snapshots.
- An island's `<svelte:head>` survives a head other scripts edited, and an island's page seed follows dynamic imports.
- The compiler registers only wired transportable classes, and a byte-order-marked source is edited at the right offsets.
- Freeze: a root prefix clears shared stores, and tag sets keep their longest lifetime.
- Dev: CSS authored in holes, regions, islands and frozen snippets applies on first load.
- Dev: every island is a crawl root for Vite's dep scanner, so nothing is discovered late on a cold server.
- Dev: an installed ogygia runs as one copy in the browser.
- Dev: a dep re-optimization no longer strands the islands on an open tab.
- Dev: server islands keep working after an HMR edit of their host file.
- Dev: toggling a route's `csr` export refreshes the server's route set.
- Dev: the nested-island warning no longer crashes SSR.
- Devtools: the dock is styled in a build and under a CSP that refuses inline styles; a wait for a failing first-screen island is not blamed on ogygia.
- Profiler: a page that leaks never takes the server down.
- Profiler: page profiling survives serverless timeouts, and network capture is reliable.
- Profiler: its renders ask as a page navigation, so streamed pages profile as visitors get them.
- Profiler: login survives a large cookie jar, and the dev server runs one live profiler per process.
- Profiler: beacon visits over 64 KB are sent, one beacon per Kit page.
- Profiler: JSON and `.cpuprofile` links download, a `.ogp` moved between machines imports, and the UI ships TS-free templates.

### Internal

- Full TypeScript `strict` at the library level, with `svelte-check` in the library check and zero explicit `any`.
- oxfmt is the workspace formatter.
- The per-host csr context cascade is one per-document signal (`documentIsCsrTrue()`).
- The on-demand-hole browser tests no longer depend on where the runner's pointer rests, and the weekly upstream watcher gained a baseline leg.

## [0.7.0] - 2026-08-20

### Breaking changes

- Unified cross-island context: `<Context of={ctx} value={v}>` and `ctx.get()` are replaced by Svelte's own `setContext` / `getContext`, bridged across islands.

### Added

- `$page.data` (with `form`, `error`, `status`) works inside islands on `csr = false` pages, streamed load promises included.
- Drop-in `setContext`: adopt cross-island context with an import swap.
- A `.ts` registry `with { wake }` binding is mountable.
- `import.meta.og.asRegion(Comp, options)`: the barrel escape hatch for regions.

### Fixed

- A `csr = false` subtree under a `csr = true` ancestor layout islands correctly, also next to a commented-out `csr` export.
- ogygia's own injected imports resolve to ogygia's own files, and its components compile under SSR when the app externalizes it.
- A plain function passed as an island prop errors as a function, not as a snippet.
- The runtime chunk URL busts on the feature set, not only on source.
- `region()` recognizes a `wake:` attach binding, and `keep` splits the region dedupe key.
- Two lakes of the same component restore to the right boxes.
- A held-region import that is only text (a comment, a template literal) is left alone.

### Internal

- One shared region-option parser, one emitter per region kind, and side-channel emits centralized.

## [0.6.6] - 2026-08-19

### Fixed

- A `{#snippet}` forwarded into an island no longer emits duplicate imports.

## [0.6.5] - 2026-08-19

### Removed

- The profiler dashboard's live-server recording mode.

### Fixed

- `ogygia/profiler` is in the published export map.

## [0.6.4] - 2026-08-19

### Added

- Profiler: `×N` call counts and a per-call column, waiting by function, per-caller network attribution, and a serverless dump / upload.

### Fixed

- Profiler: native runtime frames are named instead of rendering as "—".

## [0.6.3] - 2026-08-19

### Fixed

- A `DocsShell` sidebar no longer drowns its own page cross-fade.

## [0.6.2] - 2026-08-19

### Fixed

- A content body's scoped `<style>` no longer vanishes on a `csr = false` page.
- A static server island no longer 404s a bare region id on navigation.
- A page transition between different shells no longer stutters.

## [0.6.1] - 2026-08-19

### Fixed

- Placed client-island CSS no longer vanishes in a production build.

## [0.6.0] - 2026-08-16

### Breaking changes

- Transportable codecs are declared with the `wire` macro (`static [ogygia.wire] = …`).
- The Vite peer is `^7 || ^8` (5 and 6 dropped).
- Island facades are emitted as `og-region.<hash>.js`.
- `continuity.speculate` is removed; SPA mode never emits speculation rules.

### Added

- The config surface: one grammar per `ogygia()` subsystem.
- The site layer, `site()` in `ogygia/content`, with shells and bricks (`Frame`, `DocsShell`).
- The `import.meta.og.*` compile-macro family.
- Region snippets, `region.snippet()`: a snippet that crosses the island boundary.
- Awaitable regions: `await region(Component, props)` bakes the SSR HTML into the ticket.
- `preference()` / `preference.switch()`: site-wide, no-flash visitor preferences.
- A Markdown authoring dialect with VitePress-compatible containers.
- MPA-mode native speculation rules with `router: false`.
- Dev guards: mutating a captured host snapshot inside an island warns.
- `ogygia/profiler`: a drop-in SSR profiler.

### Changed

- Schema layers merge instead of chaining.
- Preloading is render-gated end to end.
- `svelte/server` and the codec graph no longer reach the client.
- Router prefetch also warms the incoming page's island modules.

### Fixed

- A directly used `<Region>` on a `csr = true` page renders inline in the Kit tree.
- An island reading `$app/stores` / `$app/state` no longer bundles Kit's real client store.
- Dev soft-CSS HMR is scoped to the page's own sub-app.
- `csr = false` apps no longer need a token `csr = true` route.
- `folder()` collections no longer come up empty on the dev server.
- Childless islands no longer serialize a phantom `children` slot.
- Nested islands no longer compile in O(2^depth).
- `import.meta.og.code()` in a `.svelte` host is no longer discarded.
- An interrupted navigation no longer logs an unhandled "Transition was skipped" rejection.
- `ogygia/content/slot` resolves.
- Shell reactivity and accessibility fixes (version switcher, element overrides, tab groups).

### Security

- A dev-server path traversal in the FOUC CSS virtual is closed.
- The region batch endpoint rejects oversized bodies (413) before reading them.
- A full audit of the signed-capability pipeline.

## [0.5.1] - 2026-08-13

### Fixed

- Published `exports` resolve to `dist`, not `src`.
- The browser runtime no longer disappears to tree-shaking.

## [0.5.0] - 2026-08-12

### Breaking changes

- The SPA router is global; the `<Router/>` component is removed.
- Content `render()` and `renderHtml()` are replaced by the entry's `body` (a region) with `get()` + `<Region>`.
- `OgygiaBoundary` is now `Boundary`.
- `ogygiaHandle` is now `handle`, exported from `ogygia/server` (`ogygia/hooks` stays as an alias).
- The default island endpoint is `/🏝️`.
- Presets speak the `render` / `wake` grammar.
- `@ogygia/content` is merged into ogygia.

### Added

- Live regions: LiveView over `query.live`.
- Streaming server islands (opt-in, `ogygia({ stream: true })`).
- Regions: `region(Component, props)`, a server-chosen renderable placed like data, with dual-face regions and `ogygia.transport`.
- `content` is part of ogygia (`ogygia/content`).
- One config surface in `ogygia({ … })`, and a namespace API (`import * as ogygia from 'ogygia'`).
- `npx ogygia init` wires a SvelteKit project in one step.
- Async regions: `<Region of={promise}>` owns the full wait.
- `blocks.resolve(tree, registry)` resolves a data tree to regions.
- Per-hole browser cache, `maxAge`.
- `ogygia.script()`: an inline `<script>` from one plain object.
- The `Fallback<P>` type for a deferred island's fallback slot.
- `ogygia/internal/compiler`: the pure transform engine.
- Zero-file all-`csr = false` apps.

### Changed

- Deferred holes are dynamic by default (`Cache-Control: no-store`).
- `ogygia.preprocess()` is synchronous.
- Content sources are trimmed; the mdsvex source is `markdown()`.
- The island endpoint is matched independently of `paths.base`.

### Fixed

- Router back/forward swaps the page, and prefetched pages are used on click.
- The `$app/state` page snapshot reaches islands, and updates after SPA navigation in dev.
- Lakes survive client hydration.
- Content-page islands build, and a standalone client build keeps SSR island registrations.
- Deferred regions hydrate on `csr = true` pages.
- Phantom modulepreload chunks are dropped.
- Island hydration adopts SSR roots in place (no "hero bounce" reflow).
- No FOUC on the first navigation after a deploy.
- Held-region CSS styles the page, in dev and on serverless adapters.
- A live command refresh with only refresh keys works.
- The morph keeps form state with a keyed diff.

## [0.4.3] - 2026-08-07

### Fixed

- `invalidateAll` is a soft seed refresh, not a body swap and view transition.
- `csr = false` FOUC CSS no longer double-owns island component JS, and client stubs keep the entry import that carries island CSS.

## [0.4.0] - 2026-08-07

### Breaking changes

- Portable island bindings: a marked import rewrites the binding itself to an island wrapper, so `<A />`, dynamic components and `{#each}` lists of components work; host children on island call sites are a build error (except `ogygiaFallback`).

### Changed

- Dedupe is identity-based: the same component and options make one wrapper and one client entry, however many call sites.
- `csr = false` client hosts no longer pull island wrappers into Kit's client graph.
- The plugin uses `build.rolldownOptions` on Vite 8.
- Props are real Svelte props into the wrapper, and `ogygiaFallback` is a normal snippet prop.
- Lakes are portable wrappers too.

### Removed

- The static-tag-only requirement, and the tag-hoist virtual modules.

## [0.3.5] - 2026-08-07

### Fixed

- Nested server and deferred-client islands keep their authored attributes.

## [0.3.4] - 2026-08-07

### Added

- Deferred client islands: `with { defer, hydrate }` fetch signed HTML on one schedule and hydrate it on another (matching schedules coalesce).

### Changed

- `defer` + `hydrate` is no longer a build error; `hydrate: 'none'` + `defer` warns in dev and is treated as defer-only.

## [0.3.3] - 2026-08-07

### Changed

- `hydrate: 'load'` also modulepreloads the island's dependency chunks.

## [0.3.2] - 2026-08-07

### Changed

- One runtime bootstrap per page, and `load` preload hints hoisted to the head.

### Fixed

- Relative island entries on nested routes resolve against the document, not the runtime module.

## [0.3.1] - 2026-08-07

### Fixed

- The client build no longer emits thin island entry facades.

## [0.3.0] - 2026-08-06

### Changed

- A hydrate island's `entry` is an importable module URL in production, and the runtime no longer embeds an app-wide regions map.
- Each hydrate island is emitted at a deterministic `ogygia-island.<id>.js`, and SSR renders the same virtual island module the client hydrates.

### Fixed

- Dev: `asset()` no longer rewrites Vite `/@id/…` URLs, and props stay the region's immediate sibling.
- SSR and the client share one virtual tree, ending hydration mismatches on captured props.
