---
title: Releases
summary: Every release of ogygia, newest first.
---

All notable changes to **ogygia** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.5] — 2026-08-19

Patch: the profiler trades its live-server recording for one "profile a page" flow, and its package
export is fixed so it can actually be imported.

### Removed

- **Live-server recording.** The dashboard's "record the live server for N seconds" mode is gone.
  Profiling is now a single action — enter a path, and the profiler renders that page through your
  real server a few times and profiles just those renders — plus the `x-profile: <secret>` header for
  a single request. One obvious way in instead of three, and no window/detail knobs to reason about.

### Fixed

- **`ogygia/profiler` is now in the published export map.** The subpath was declared for local
  development but missing from `publishConfig.exports`, so `import { profiler } from 'ogygia/profiler'`
  would not resolve when installed from npm, even though the compiled files already shipped in `dist`.
  Fixed and verified — 19 subpaths now resolve and type-check.

## [0.6.4] — 2026-08-19

Patch: the profiler now counts how many times each function ran, shows per-call cost, attributes
waiting to the function that waited, and labels native frames.

### Added

- **`×N` call counts and a `per call` column.** A component's cost is usually repetition, not one
  heavy render — `HeavyRow` at 170 ms is 800 renders of a 0.2 ms row, not a slow component. The
  profiler now takes a second, coverage-only pass (V8 `Profiler.startPreciseCoverage`) to count
  every function's exact call count, and the component and function tables gained a sortable **per
  call** column (`total ÷ runs`). The pass is kept out of the timed CPU sample on purpose — running
  coverage inside it disables inlining and would distort the numbers — so the sample stays honest.
  Counts and `per_call_ms` are in the curated JSON too, so a saved dump reproduces the same result.
- **Waiting by function.** Beyond the network waterfall, an `async_hooks` tracker times non-HTTP I/O
  (timers, `fs`, DNS, raw TCP) and attributes each wait to the nearest frame in _your_ code, so a
  slow `readManifest` or a stray `setTimeout` reads as _which function waited_ rather than a
  featureless "idle." Shown as its own sortable table with wait bars.
- **Per-caller network attribution.** Every outbound call in the waterfall now names the source line
  that made it — structured V8 call-sites, mapped back through server source-maps when they are
  emitted — so two `fetch`es to the same host are told apart by who called them.
- **Serverless dump / upload.** On an edge or serverless adapter where the V8 inspector isn't
  available, a report can be downloaded as a self-contained JSON dump and re-uploaded to the profiler
  route to view anywhere — the whole report renderer is a pure function of that dump.

### Fixed

- **Native runtime frames rendered as a bare "—".** Node/V8 built-ins — `existsSync`, `writev`,
  `flushCompileCache`, the UTF-8 codecs — carry no source file, so they fell through to an `unknown`
  category with an em-dash chip and an empty location. They are now bucketed as **node core** with a
  `native` location.

## [0.6.3] — 2026-08-19

Patch: same-shell page transitions no longer stutter under a large sidebar.

### Fixed

- **A `DocsShell` sidebar drowned its own page cross-fade.** Each nav row carries a per-row
  `view-transition-name` (so the active-highlight chip glides beneath stable labels). But that
  promotes every row to its own transition group, and on a same-shell navigation the browser then
  ran the default group+fade for _all_ of them — dozens of animations per hop (a 30-row sidebar =
  ~150, a large one ~300) — even though the rows are identical and stationary. That flood starves the
  actual content cross-fade, which janks or reads as "no transition." The rows already share a
  `phnav` `view-transition-class`; the framework themes now zero those row animations (`animation:
  none`), so an identical row snaps invisibly while the `og-nav-active` chip keeps its slide and the
  root content fade is no longer drowned. Measured on the docs playground: 295 → 10 running
  animations, slide and fade both intact. Applied across every built-in theme.

## [0.6.2] — 2026-08-19

Patch: content bodies ship their own scoped CSS, a static server island no longer 404s on nav, and a
shell-change page transition no longer stutters.

### Fixed

- **A content body's scoped `<style>` could vanish on a `csr=false` page.** A `.svx`/`.md` body is
  leak-free content — the corpus is server-only, so it never enters the client graph, and its scoped
  CSS compiles into the _server_ bundle and joins no page's static stylesheet. On a production build
  the body rendered browser-default (stacked `.doc-demo-row` cards, unstyled prose) while everything
  the route statically imported stayed styled. This is the same blind spot a placed island had
  (fixed in 0.6.1), one step further: a content body has no client module at all, just data. ogygia
  now extracts each content module's own scoped CSS at build — `svelte`-compiled from the post-mdsvex
  source, so `:global` is resolved and the scoped hash matches the SSR'd HTML — and emits it as a
  content-addressed client asset (`og-content.*.css`), one per doc, keyed in the region-deps handoff.
  `Region.svelte` links a body's own CSS as a hoisted `<link data-ogygia-region-css>` — the same
  channel a held/dual region uses, deduped per-request — so a page ships only the CSS of the docs it
  actually renders (not the whole corpus). Survives SPA nav (the router re-renders the body
  server-side each hop). Covered by `e2e/content-css.ts`: the SSR emits the link and the body's
  scoped `<style>` applies in a real production build.
- **A static server island 404'd a bare region id on navigation.** A `render: 'deferred'` island
  with no `wake` has no client module, but `Region.svelte` still emitted the region id as the DOM
  `entry` attribute. On the next SPA hop the router's module-warmer scans `entry="…"` and `import()`s
  each as a client chunk, so that bare id fetched `/<id>` → 404 (only on nav, never on reload — the
  warmer runs on prefetch). A static server island now carries `entry=""`, so the warmer skips it;
  its hole still fetches through the signed `endpoint` (minted from the id, unchanged). The same
  empty-entry rule now covers a held deferred region. `e2e/defer-timing.ts` reads a hole's id from
  its endpoint, not the (now-empty) `entry`.
- **A page transition between different shells stuttered.** A `view-transition-name` lifts its element
  out of the root cross-fade into a standalone group. Navigating between two pages with different
  chrome — a docs page (a sidebar of ~dozens of named nav rows) and a marketing page (none) — left
  every one of those names without a counterpart, so each ran a solo enter/exit over a holed-out root
  snapshot: a visible stutter, worst in dev where the destination paints late. The router now folds
  orphaned `view-transition-name`s (present on only one of the two pages) back into the page-level
  cross-fade for that navigation, and restores them after, so the shell change animates as one clean
  fade. Names present on BOTH pages (a sidebar's active-highlight slide on same-shell nav) are kept
  untouched.

## [0.6.1] — 2026-08-19

Patch: a placed client island now ships its own CSS.

### Fixed

- **Placed client-island CSS could vanish in a production build.** Kit links a route's _static_
  import graph, but Rollup can chunk-split a `wake`-marked component's CSS — notably its `:global()`
  rules (a Bits UI dropdown trigger/menu, a scoped card rendered by a child component) — into a chunk
  the page never loads, so the island rendered browser-default on Vercel/Netlify while the container
  around it stayed styled. The design assumed a plain island's CSS was already in the page's own
  stylesheet; chunk-splitting violates that. `Region.svelte` now ships each placed island's own CSS
  as a hoisted `<link data-ogygia-region-css>` — the same channel a held/dual region already uses,
  claimed per-request so a page rendering the same island many times links its sheet once, and keyed
  off the raw island entry like the modulepreload path (no per-request HTML scan). Covered by
  `e2e/placed-island-css.ts`: the SSR emits the link and the `:global()` style applies in a real
  production build.

## [0.6.0] — 2026-08-16

The site-layer release. `ogygia/content` grows from collections into a layer that can carry a whole
site: `site()` builds the site model, `DocsShell` / `BlogShell` render it, and the new
`import.meta.og.*` compile macros bake content at build. The plugin config collapses to one grammar:
a top-level key per subsystem, each subsystem `defaults + its own presets`. Underneath: region
snippets become a first-class primitive, markdown compiles to serialized regions, preloading goes
render-gated (and native in MPA mode), the client bundle gets smaller, and the
`csr = false` keepalive bug is fixed (#1, #4).

### Added

- **The config surface: one grammar per subsystem.** Every `ogygia()` subsystem is
  `defaults + its own presets`, and every use site opts in the same way: a literal
  `preset: 'name'`, resolved only in its own subsystem's dictionary. An island preset can never
  hold content config; `router` holds no presets at all.
  - **BREAKING (vs earlier 0.6 pre-cuts): `visible` → `regions.visible`, `presets` →
    `regions.presets`, `continuity: { forms }` → `router: { forms }`.** The old spellings are
    **errors** naming the new one — never silent aliasing, so a stale config can't quietly un-tune
    an app. `router: false` now turns forms off too: form continuity rides SPA navigation, and
    with the router gone there is nothing for a form to survive.
  - **`content.presets` — named markdown variants.** Define once in the plugin
    (`content: { markdown: {…}, presets: { plain: { markdown: { overrides: false } } } }`), opt a
    whole collection in on its loader macro:
    `import.meta.og.loader.folder('../content/blog', { preset: 'plain' })`. The preset's bag
    merges over `content.markdown` per setting key. Mechanically, each opted-in file compiles as
    its own **module variant** (`?og_preset=name` via the emitted glob's query), so the same file
    globbed by two collections under two presets renders independently — different pipelines, zero
    conflict — and presetless collections share the bare module exactly as before. The name must
    be a literal; unknown names are build errors listing the configured names; `preset` is
    consumed at compile and never reaches the runtime builder.
  - Config-time validation for both preset dictionaries: empty presets and unknown keys fail at
    config load with the legal vocabulary named — not on first use. (`regions.presets` also
    accepts `keep`, which the transform always honored; type and validation now agree.)

- **The site layer — `site()` in `ogygia/content`.** Arrange collections into a navigable site:
  `outline()` (spec grammar, `pick()`, single-assignment placement with named build errors),
  `dimensions()` (versions/locales as coordinates, per-axis fallback instead of 404s, a switcher),
  full-text search (server brain or a prerendered index queried in an on-device worker, no-JS
  fallback page included), emissions (`sitemap.xml`, `llms.txt`, RSS, per-page raw markdown,
  `search.json`), content checks (`links()` — the in-prose link audit that fails the build, plus
  custom checks), `remotes()` (the wire layer: `nav` / `meta` / `page` / `search`, prerendered or
  live, bodies crossing as baked region tickets), request-context projections (previews, roles),
  and the `fields` schema family (`fields.page` / `fields.post` / `fields.change` — Standard
  Schema, zero validator dependency).

  ```ts title=src/lib/site.server.ts
  import { site, links } from 'ogygia/content';
  import { guides } from './collections.server';

  export const docs = site({ outline: guides, prevNext: 'graph', checks: [links()] });
  ```

- **Shells & bricks.** `Frame` (the headless composition), `DocsShell` (the VitePress form) and
  `BlogShell` (the blog form) — compositions of public bricks (`Doc`, `Sidebar`, `Pager`,
  `OnThisPage`, `Search`, `Switcher`, `BlogList`, `BlogPost`), every region a conditional snippet
  prop: absent → built-in, a snippet → yours, `null` → gone. `site.meta()` (and the `meta` remote)
  hands a shell `{ nav, switcher, data }` in one prerendered call, so the corpus never enters the
  layout's module graph. Styling is opt-in (`theme.css` + `shell.css`, everything in
  `@layer ogygia` so any unlayered rule of yours wins), with Greek-named alternate themes under
  `ogygia/content/themes/*`. Scaffold a whole site with `npx ogygia site init`.

- **The `import.meta.og.*` compile-macro family.** One namespace of build-time constructs,
  AST-precise (TS-aware oxc parse), failing loudly with `file:line` build errors:
  - `loader.markdown` / `.folder` / `.json` take a bare **directory** and derive their opinionated
    file set under it (globs remain the escape hatch); `loader.git('owner/repo@ref:path')` pulls a
    corpus straight from another repository via cached sparse checkout — no committed copy.
  - `code(source, lang, meta?)` renders a snippet at build through the app's own fence pipeline;
    `md(text)` does the same for markdown — both inline as static regions.
  - `bake(fn)` bundles and runs a function at build, inlines the result, drops the imports.
  - `wire(codec)` declares a transportable-class codec (see Changed).
  - `regions('./*.svelte')` registers raw-region imports by glob.

- **Region snippets: `region.snippet()`.** A snippet is now a region-shaped value that can cross
  an island boundary and become interactive. One primitive, three modes: **live** (the compiler lifts a
  `{#snippet}` handed to an island into its own entry — parameters cross, top-level `await` inside
  the body renders through async SSR), **static** (a parameterless snippet frozen to server HTML,
  adopted byte-for-byte), and **slot** (an island's children render in place and the client adopts
  the DOM range — nested islands inside re-wake on their own). `region.snippet()` is the public
  constructor, mirroring `createRawSnippet`.

- **Awaitable regions.** `await region(Component, props)` bakes the SSR HTML into the ticket — so a
  content body (or any held region) crosses a remote or a load as HTML-only data, no source and no
  second render. Markdown leans on this: a pure-static `.md` now compiles to a **serialized
  region** (one HTML string in the module, the template a single `{@html}` reference), which also
  retires the whole svelte-template escaping hazard class for prose.

- **`preference()` / `preference.switch()`.** Site-wide, no-flash visitor preferences (the JS↔TS
  code toggle, package-manager tabs, theme) as one primitive: `preference({ name, values,
  default })` gives `head()` (a pre-paint inline script), `get`/`set`, and a `data-pref-*`
  attribute contract on `<html>`; `preference.switch()` is one delegated handler for every
  `[data-pref][data-pref-set]` control, surviving SPA body swaps with zero islands.

- **Markdown authoring dialect.** VitePress-compatible containers (`::: tip` … `::: details`);
  markdown-native tab groups (`::: code-group` / `::: tabs`) with synced, persisted selection;
  diff markers in two dialects — line-level `+++ ` / `--- ` prefixes (`diff_markers()`) and inline
  `+++added+++` / `---removed---` (`inline_markers()`, twoslash-safe); `title=` fence meta for a
  filename in the code chrome (falls back to the language — the header is never empty); stable
  code-block ids with permalink + copy actions that re-attach on reveal (tab switches, `<details>`).

- **MPA-mode native speculation.** With `router: false` the server handle injects one static
  Speculation Rules script: Chromium prerenders likely next pages, Firefox prefetches them, others
  ignore the JSON — zero config, zero client JS, per-link opt-out via `data-ogygia-speculate`.
  `preloadData(url)` hints a native prerender and `preloadCode(url)` a native prefetch in that mode.

- **Dev guards.** Mutating a captured host snapshot inside an island warns with the prop path; a
  block-level island rendered inline in a `<p>` (parser-hoisted, hydrates twice) is detected and
  explained.

- **`ogygia/profiler` — a drop-in SSR profiler.** One line in `hooks.server.ts`
  (`sequence(profiler(), …)`) and a report UI at `/__profiler`. It samples the whole Node process
  during a render and attributes server time to your components **by name** — Svelte compiles each
  component to a function named after its file, so there is nothing to instrument by hand — while
  splitting the wall clock into compute versus waiting.
  - **Three ways to record:** the live server for a few seconds, one page rendered N times (with an
    un-profiled warm-up so the median is steady), or a single request via an `x-profile: <secret>`
    header.
  - **The report:** a wall-clock budget bar (compute vs idle/waiting), an interactive zoomable
    treemap of self time, sortable component (self vs total) and function tables, an outbound
    network waterfall that flags sequential awaits, top memory allocators + RSS + precise GC pauses,
    a flame graph, and a raw `.cpuprofile` download for Chrome DevTools or speedscope.
  - **Curated JSON for agents and scripts:** `<base>/report/<id>.json`, or one-shot
    `<base>/page?p=/x&format=json` — the analyzed result (summary + verdict, findings with stable
    codes, per-component self/total, network, memory), not the raw V8 profile.
  - **Production-safe:** the UI is gated behind `PROFILER_SECRET` (timing-safe, 404 without it),
    idle cost is near zero, profiles live in memory only, and `Server-Timing` headers are off by
    default in production. Needs a Node server (the V8 inspector); edge runtimes keep the always-on
    request log only.
  - Docs: [Profiler](/docs/profiler/overview).

### Changed

- **BREAKING: transportable codecs are declared with the `wire` macro.** `static [ogygia.wire] =
  { … }` becomes `static wire = import.meta.og.wire({ … })` — no import, the macro mints the codec
  key at build, and misuse is a build error instead of a silent non-codec. The runtime `wire`
  symbol export is removed (the `TransportCodec` type remains).
- **BREAKING: Vite peer is now `^7 || ^8`** (5 and 6 dropped). New optional peers: `@orama/orama`
  (search) and `bits-ui` (shell dropdowns/palette) — both load only on their feature paths.
- **BREAKING: emitted chunk names.** Island facades are `og-region.<hash>.js` (was
  `ogygia-island.*`), the runtime is `og-runtime.<hash>.js`, the build handoff is
  `.svelte-kit/og-region-deps.json`. The `<ogygia-region>` element and `data-ogygia-runtime`
  attribute are unchanged — nothing locates the runtime by filename.
- **BREAKING: `continuity.speculate` is removed.** SPA mode never emits speculation rules — a
  speculation cache serves real navigations only, which a body-swap router cannot read; the
  router's own prefetch + island-module warming is the working equivalent. MPA mode speculates by
  default (see Added).
- **Schema layers merge instead of chaining.** Every layer in a schema array validates the
  original data and the results merge — a later layer no longer loses fields an earlier layer
  didn't declare (the cause of spurious `fields.post` "a post needs a date" failures).
- **Preloading is render-gated end to end.** Portable-snippet entries are preloaded by the island
  whose props actually carry them (the compiler's static scan — which preloaded never-rendered
  candidates — is gone), joining the island facade + dep-chunk links in one head channel. The three
  island-module warmers (router prefetch, visible-idle, interaction hover) merged into one deduped
  `warm_island_module`. Remote seeds skip values carrying a baked region, so a page never ships a
  body twice.
- **Bundle granularity.** `svelte/server` and the codec graph no longer reach the client; the
  frame store is a feature (`defer`/`live`/`morph`/`lakes` apps only); the wire runtime is
  usage-gated (transportables, portable snippets, or islands with children); conditional shell
  built-ins load as islands only when the built-in actually renders. Reference-app brotli:
  static 8.41 → 6.90 kB (−18%), interactive 9.10 → 7.56, forms 8.92 → 7.39.
- **Router.** Prefetch now also warms the incoming page's island modules (Slow-4G: warm nav 18.7×,
  visible-hydrate 229×); `visible` islands idle-warm their chunk.

### Fixed

- **A directly-used `<Region>` on a `csr = true` page now renders inline in the Kit tree instead of
  its own island.** The `with { wake }` import sugar is stripped to a plain import on a `csr = true`
  route (the page ships zero ogygia), but a hand-written `<Region of={region(C, props)}>` is a
  runtime value the transform never saw — so an interactive one still emitted an `<ogygia-region>` +
  the runtime bootstrap on a page meant to be pure Kit, and in a _pure_ `csr = true` app (no
  `csr = false` route → no runtime chunk built) that bootstrap `<script>` 404'd. Now a `csr = true`
  route host carries a bare `setContext` marker (plain Svelte, no ogygia import, so a region-less
  page still ships nothing), and `Region` renders an interactive region as a normal component there —
  Kit hydrates it, no `<ogygia-region>`, no runtime, no 404. Server-driven regions (deferred / live /
  lake) are untouched: they cross the wire and are orthogonal to a page's csr.
- **An island reading `$app/stores` / `$app/state` could bundle Kit's _real_ client store and
  crash at hydrate** — `TypeError: Cannot read properties of undefined (reading 'pathname')`, the
  island's DOM then torn out of the page. Under `csr = false` Kit's client never boots, so its page
  store stays empty; ogygia therefore swaps `$app/*` for shims inside island code. That swap keyed
  off island-graph membership that _grew during the same resolveId walk that consumed it_ — so a
  component shared between an island and a non-island route, reached first through the non-island
  path (or transformed before the island path marked it), kept Kit's real `$app/*` and read
  `page.url` as `undefined`. **Membership is now settled up front:** the prescan completes
  `island_graph` transitively — from each island component it walks every module those components
  import — before the bundler resolves anything, so the shim decision is deterministic regardless of
  build order. The walk is O(reachable modules) (one shared `seen` set, each file scanned once,
  never re-descended — no depth multiplier), reads only (membership stays out of the module id, so
  Svelte's scoped-CSS emission is untouched), and adds no new surface. Seen in production on a
  deployed 0.5.1 app; covered by `e2e/split-brain.ts` (incl. a shared-transitive-dep race guard) and
  the wire-delivered-CSS check in `e2e/live-partial.ts`.
- **Dev soft-CSS HMR is now scoped to the page's own sub-app.** The dev bridge eagerly imported
  every `/src` stylesheet into the browser on every page — invisible while one app owned one look,
  but a project hosting two style-sovereign sub-apps (route-group layouts with disjoint skins) saw
  each page painted with the other's CSS in dev while prod stayed clean. The bridge now joins
  stylesheets lazily: on a CSS edit the plugin walks the module graph up to the owning route files,
  broadcasts their top-level scopes, and a page joins the module only when its own scope (stamped
  by the handle as `ogygia-dev-scope`) is among the owners. First edit joins + applies; later edits
  ride Vite's normal CSS HMR. Kit's FOUC bag is untouched.
- **`csr = false` apps no longer need a token `csr = true` route (#1, #4).** The keepalive
  predicate read each route node's own `csr` while SvelteKit resolves it through the layout chain —
  a fresh app with `csr = false` only in the root layout skipped the client build and 404'd the
  runtime script. Now chain-resolved, matching Kit exactly; verified against the issue's repro.
- **`folder()` collections came up empty on the dev server** (build green, dev broken): Vite's dev
  glob matcher silently drops `{+doc.svx,+meta.json}` brace groups. Loader globs now emit in array
  form, so dev and build agree.
- **Childless islands serialized a phantom `children` slot descriptor** — and on minimal apps
  (no wire feature) every island then failed to hydrate with `Unknown type OgygiaS`. Childless
  payloads now carry nothing; islands with real children enable the wire revivers automatically.
- **Nested islands compiled in O(2^depth)** — the usage walk double-descended component fragments;
  depth-25 hosts hung the build. Now linear.
- **`import.meta.og.code()` in a `.svelte` host was silently discarded** when the island transform
  also touched the file, exploding at runtime. The transforms now compose.
- **An interrupted navigation no longer logs an unhandled "Transition was skipped" rejection.**
- **`ogygia/content/slot` resolved to a missing file**, breaking any app with markdown
  `overrides: true` at prerender.
- **Shell reactivity + a11y:** the version switcher, element-override slot, and tab groups now
  track their inputs (were stale after a slug or group change); the on-this-page rail's top link
  is a real link; deferred-region fetch hints are dropped on single-flight navigations (no double fetch).

### Security

- **Dev-server path traversal** in the FOUC CSS virtual (a crafted `/@id/` request could read
  files outside the project root through the plugin's own `readFileSync`) — the decoded id is now
  validated against traversal/absolute/UNC forms. Dev-only; production builds never run the plugin.
- **Region batch endpoint** now rejects oversized bodies by `Content-Length` (413) before parsing.
- Full audit: the signed-capability pipeline (HKDF-separated keys, length-prefixed MAC message,
  probe-rate before HMAC, `Sec-Fetch-Site` gating, response caps) reviewed and unchanged.

## [0.5.1] — 2026-08-13

A packaging patch. 0.5.0 installed but didn't run: the published manifest pointed at unshipped
`src/*.ts`, and the browser runtime got tree-shaken away. Both fixed. No API changes.

### Fixed

- **Published `exports` now resolve to `dist`, not `src`.** 0.5.0's tarball shipped `exports` targeting
  `./src/*.ts`, which `files: ["dist"]` never ships, so the package entry and several subpaths
  (`ogygia`, `/runtime`, `/hooks`, `/app`, `/server`, `/internal`, `/internal/server`, `/content`,
  `/content/server`) resolved to missing files. Root cause: **`npm publish` ignores
  `publishConfig.exports`** (a pnpm-only feature), so the dev manifest shipped verbatim. ogygia now
  releases with pnpm (a top-level `pub` script), and `publishConfig.exports` was completed — it had
  been missing `./internal/compiler`, `./content/server`, and `./types`.

- **The browser runtime no longer vanishes to tree-shaking.** `import 'ogygia/runtime'` booted the
  kitchen-sink runtime as a pure side-effect import (`runtime/index` → `import './full.js'`). With
  `sideEffects: false`, bundlers and Vite's dep-prebundler dropped it, so `<ogygia-region>` was never
  registered and no island woke. Boot is now an explicit function the compiler calls: `full.ts`
  exports `bootDev()`, `runtime/index` re-exports it (no side-effect import), and the plugin's dev
  entry injects `import { bootDev } from 'ogygia/runtime'; bootDev()`. The per-app production entry
  already booted explicitly. `sideEffects` is now `["**/*.css"]`.

## [0.5.0] — 2026-08-12

The unification release. **Regions** become the one renderable, whether placed, held, deferred, or
live. Content collapses onto them, the `@ogygia/content` package folds into ogygia, the SPA router
becomes a global opt-out plugin feature, and config and exports get a single surface.

### Added

- **Live regions — LiveView over `query.live`, one word: `await`.** A dual region (a component
  imported `with { region: 'raw' }`, made into a value with `region(Component, props)`) is now
  **awaitable**. Awaiting it renders the component to HTML on the server and bakes that HTML into the
  ticket, so the client swaps it in with **no fetch**. In an async generator, JavaScript awaits what
  you `yield`, so it is automatic:

  ```ts title=stats.remote.ts
  export const dashboard = query.live(v.string(), async function* (id) {
    for await (const stats of feed(id)) {
      yield region(StatCard, { stats }); // awaited by the language → HTML rides the ticket
    }
  });
  ```

  ```svelte
  <Region of={dashboard(id).current} />
  ```

  The client swaps the first tick in immediately, then per tick does the right thing with no new API:
  - **static dual region** (`region: 'raw'`, no `wake`, ships no client JS) → the runtime **morphs**
    the new HTML in place, so focus, typed-in input values, scroll, and CSS transitions survive;
  - **interactive dual region** (`region: 'raw'` + `wake: 'load' | 'idle' | 'visible' | media`) →
    **keep-alive**: the mounted island gets the new props pushed in (Svelte reconciles); local island
    state is not reset and it is not re-hydrated. A different component id replaces + re-hydrates.

  A region you **don't** await still renders inline where it lands (first paint, same SSR pass) —
  delivery is a per-moment decision, not a per-import one. `region()` returns an `AwaitableRegion`
  (a `RegionValue` you can render now, and a `PromiseLike<RegionValue>` you can await). The baked HTML
  rides the existing `ogygia.transport` codec (install it once in your universal hooks). Playground:
  `/live-partial`; suite: `verify/live-partial.ts`.

- **Streaming server islands (opt-in) — `ogygia({ stream: true })`.** On a dynamic csr=false page,
  `handle()` keeps the response open after the shell, renders each immediate load-scheduled deferred
  hole in-process, and appends its HTML as a `<template data-ogygia-slot>` parcel after the document —
  **zero extra requests**, holes fill as they finish, out of order. The browser paints the shell
  first; each parcel is inert (`<template>` — no paint, no scripts, no image loads) until the runtime
  moves it into its region. Fallback is total and automatic: prerender / CDN pages, holes that need
  per-request server context the stream can't provide, and any render error all fall back to the
  per-hole fetch — streaming never changes correctness, only round-trips. `idle` / `visible` / media
  deferrals keep fetching on their schedule (deferring the SERVER work is their whole point). Default
  `false` while the e2e matrix is validated; drops `Content-Length` (chunked) and sets
  `X-Accel-Buffering: no` so the shell still paints early behind an nginx-style proxy. Live-region
  render and streaming's render both use `svelte/server` on the SSR leg only — no server render code
  reaches the client bundle.

- **Regions — a server-chosen renderable you place like data.** `region(Component, props)` mints a
  descriptor and `<Region of={f} />` renders it, props type-checked against the component.
  - **Inline** (a plain component import): renders in the current SSR pass — the RSC-shaped path.
  - **Deferred** (`import Card from './Card.svelte' with { render: 'deferred', wake: 'load' }`): the
    server mints a signed capability in a load / remote function; the client fetches, swaps the HTML
    in, and hydrates. `render: 'deferred'` with no `wake` ships HTML only (no client chunk, never
    interactive); adding `wake` (`'load' | 'idle' | 'visible' | a media query`) sets when the JS
    wakes. Works from `.svelte`, `.svx`, and `.ts` (load / remote) modules.
- **Dual-face regions + `ogygia.transport`.** A `region()` made from a component imported
  `with { region: 'raw' }` renders **inline** where it's created (server pass → first paint, hydrates)
  and becomes a **signed ticket** only when it actually crosses the wire. The one new mechanism is
  `transport`, a SvelteKit `transport` hook entry that signs on serialize and rebuilds on the
  client. Install it once in your **universal** hooks:

  ```ts title=src/hooks.ts
  import * as ogygia from 'ogygia';
  export const transport = { ...ogygia.transport };
  ```

  A region returned from a `load`/render renders inline; one returned from a remote (search, a
  live query) arrives deferred and self-fetches. Same `region()`, locality automatic.
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
- **Namespace API.** `import * as ogygia from 'ogygia'` → `<ogygia.Region />`, `<ogygia.Boundary />`,
  `ogygia.region()`, `ogygia.transport`. `import * as ogygia from 'ogygia/server'` → `ogygia.handle()`.
- **`npx ogygia init`.** A bundled CLI (in core — no separate add-on) wires a SvelteKit project in one
  command: registers the Vite plugin **before** `sveltekit()`, installs the `transport` codec (merging
  into an existing `transport`), adds the server `handle()` (sequencing an existing handle), writes
  `src/ogygia.d.ts` with `/// <reference types="ogygia/types" />` so `svelte-check` resolves the
  `virtual:ogygia/*` modules, updates `.gitignore`, and optionally turns on markdown (`--markdown`).
  The old `@ogygia/add` package is retired. **Type setup**: without the `ogygia/types` reference above,
  `svelte-check` flags the virtual imports as unresolved even though the build works — `ogygia init`
  writes it for you; add it by hand in a manual setup.
- **Async regions — `<Region of={promise}>` owns the whole wait.** Pass a promise (a remote call,
  `of={search(q)}`) and the region renders its `{#snippet placeholder()}` until the value **and its
  stylesheet** arrive, then swaps in. A plain (non-promise) `of` still resolves in the same SSR pass —
  no placeholder ever shows. One model for "the data is loading" and "the styled HTML is arriving",
  so loading UI lives on the region rather than in an ad-hoc boundary.
- **`blocks.resolve(tree, registry)`.** Resolve a data tree (from a content collection, a CMS, or a
  `+page.ts`) into placed regions — the whole tree crosses the wire because its leaves are regions.
  "Blocks without a content collection" is now a documented recipe on this helper; there is no shipped
  `<Blocks>` component to render.
- **Per-hole browser cache — `maxAge`.** Deferred holes are dynamic by default (`Cache-Control:
  no-store`), so a reload re-renders them. Opt a hole into a private browser cache with `maxAge` in a
  preset; the TTL is **signed into the endpoint**, so a harvested URL can't be re-pointed at a longer
  cache. This is what lets a prerendered (PPR) hole cache safely without freezing on reload.
- **`ogygia.script(fn, ...args)`.** Serialize a self-contained function into a blocking inline
  `<script>` string (a no-flash theme, a deferred font loader, …). Trailing `args` are JSON-serialized
  and passed in as parameters; any `</script` in the body is escaped so it can't break out of the tag.
- **`Fallback<P>` type.** Types a deferred island's fallback slot. `svelte-check` type-checks raw
  source, so the fallback must live on the component — this type gives its props a shape.
- **`ogygia/internal/compiler`.** The pure transform engine (the island transform + FOUC-CSS graph +
  free-variable analysis) is carved into its own module, importable outside the Vite plugin.
- **Zero-file all-csr=false apps.** When **every** route is `csr = false`, ogygia injects a URL-less
  keepalive route at build time and removes it at process exit, so island chunks still ship — no
  placeholder `csr=true` page in your project, no Kit internals touched. A `csr = true` app ships zero
  ogygia runtime.

### Changed

- **Breaking: the SPA router is now global — there is no `<Router/>` component.** It is on by default
  and configured in one place, the Vite plugin. `ogygia({ router: false })` opts out entirely (and
  tree-shakes the router out of the runtime); `ogygia({ router: { viewTransitions: false } })` keeps
  SPA navigation without view transitions. A single page opts out of view transitions with
  `<meta name="ogygia-router" content="plain">` in its head. The server `handle()` injects the runtime
  bootstrap and the `ogygia-router` marker, so no component or layout wiring is needed.
- **Breaking: content `render()` → the entry's `body` (a region).** `get(id)` (server-only)
  returns `{ id, data, headings, body }`; render the body with `<Region of={entry.body} />`. It's
  an inline region — SSR'd in the page's own pass, islands inside hydrate as before.
- **Breaking: `OgygiaBoundary` → `Boundary`** (namespace-friendly). Use `<ogygia.Boundary />`.
- **Breaking: `ogygiaHandle` → `handle`, exported from `ogygia/server`** (`ogygia/hooks` kept as an
  alias). `ogygiaTransport` is now `ogygia.transport` (from the main `ogygia` entry).
- **Breaking: the default island endpoint is now `/🏝️` (single emoji), not `/🏝️ogygia🏝️`.** The
  single 🏝️ is already clash-safe against real routes; the brackets were redundant. Override with
  `ogygia.handle({ endpoint })`. No change to signing, props, or expiry.
- **Breaking: presets speak the `render` / `wake` grammar.** The old `hydrate` / `defer` / `remount`
  preset keys are removed — an unknown key now errors — and the vestigial `OgygiaRemount` type is
  dropped. A preset reads like an inline import: `render` (the mode) + `wake` (the schedule), plus the
  tuning options not allowed inline (`margin`, `maxAge`, …).
- **Deferred holes are dynamic by default (`Cache-Control: no-store`).** A reload re-renders a hole
  unless it opts into `maxAge` (see Added) — the signed TTL rides the endpoint MAC.
- **`ogygia.preprocess()` is synchronous.** mdsvex loads lazily on first use (with a clear "install
  mdsvex" hint) instead of being awaited up front, so a markdown-free app pays nothing.
- **Content sources trimmed.** The mdsvex source builder is renamed `markdown()`; the `yaml()` /
  `raw()` / `fromArray()` sources are dropped (a `.yaml` or raw loader is a short recipe). Content
  collections now parse frontmatter with ogygia's own dependency-free parser — the `yaml` dependency
  is gone.
- **The island endpoint is matched base-independently.** A request-path suffix match replaces the
  deprecated `base` import from `$app/paths` (removed in Kit 3), so a `paths.base` app needs no extra
  wiring for the endpoint to resolve.

### Removed

- **Breaking: the `<Router/>` component.** The SPA router is global now (see Changed) — configure it
  on the `ogygia()` plugin instead of rendering a component in a layout.
- **Breaking: `content.render()` and `renderHtml()`.** Replaced by `get()` + `<Region>`. Content
  delivered over the wire (feeds, search) maps entries to regions of your own `with { region: 'raw' }`
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
- **Deferred regions hydrate on `csr=true` pages.** A server island / `<Region>` on a `csr=true`
  page fetches its HTML after load, so Kit never hydrated it — but `#hydrate` bailed via its "Kit
  hydrates this" guard and left it inert. The guard now exempts deferred regions.
- **Dropped phantom modulepreload chunks.** Island dependency preloads are now collected in
  `writeBundle` (post-merge) and filtered to emitted chunks, so a rolldown-eliminated shared chunk
  can't leave a `modulepreload` pointing at a file that was never written (404 at prerender).
- **Island hydration adopts SSR roots in place (the "hero bounce" reflow).** The unified
  `Region.svelte` wraps island SSR in `{#if Component}…{/if}`, but the client `NestedProvider`
  rendered a bare `<Component/>` — the mismatched fragment layers stopped Svelte from adopting the SSR
  nodes, so it discarded and **re-created** each island root. A re-created root is class-less for one
  tick, so a root whose `position: fixed` comes from a `class:` briefly fell to `static`, dropped into
  flow, and shoved downstream layout (the sidebar-above-a-centered-hero bounce). `NestedProvider` now
  mirrors the island SSR shape exactly, so hydration adopts the root in place.
- **First-navigation-after-deploy FOUC.** The router merged the new `<head>` and swapped `<body>` in
  one step, but a freshly-appended `<link rel="stylesheet">` loads asynchronously — on a cold cache
  the new route rendered unstyled until its CSS arrived (warm caches hid it, so it only showed
  post-deploy). The router now appends and **awaits** the destination stylesheets (capped at 2s so a
  stalled sheet can't hang navigation) before the swap, and inserts them at the top of `<head>` so an
  island's `<svelte:head>` reconciliation can't reclaim them.
- **Held-region CSS styles the page — in dev too.** A held / dual region's component is server-picked
  (a registry), so its CSS is on no page stylesheet (Kit links CSS from the route's static import
  graph, never from what actually rendered). The render pass now links it from `<svelte:head>` (claimed
  once per request, so five copies of a block link their sheet once) and the client hoists it to
  `<head>`. Production links the built CSS asset; dev imports the same component's style module — so a
  deferred / held hole is styled under `vite dev` exactly as in a production build.
- **Live command refresh.** A client `submit().updates(...)` that sends only refresh keys now triggers
  `requested(...).refreshAll()` on the server, so a live `Query.current` refreshes in place instead of
  staying stale until a full page reload.
- **`morph` keyed-diff rewrite.** Live / streamed HTML now morphs with a keyed diff that preserves
  form state and input focus across a tick.
- **Server-picked region CSS on serverless adapters (Vercel / Netlify).** A held / dual region that
  crosses the wire carries its component's CSS through the island-deps manifest, which the server read
  from disk at render time. Serverless adapters bundle the function with `@vercel/nft`, which traces
  `import`s but not `fs.readFileSync` targets — so the manifest was dropped from the function and
  `islandCss` returned nothing, leaving every server-picked region **unstyled in production** (it
  worked under adapter-node / `vite preview`, which deploy the whole server directory). The manifest is
  now **inlined into the server bundle** at build time (a slot the client build patches in place), so
  it ships with the function; the on-disk read stays as the fallback. The same fix restores
  `modulepreload` for islands that cross the wire.

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
