# Packages — one core, plugins on one contract

Status: **PROPOSED** (2026-10-31). Nothing built. Package names, the plugin shape and every moved
import path are public API: each needs a user go before it is built.

## The ask

Split `ogygia` into a core and separately installed packages: devtools, profiler, content,
federation, flags, freeze (user, 2026-10-31). Plus the easy ones: testing, the CLI + MCP server.
A `@ogygia/core` exists either way; whether it or `ogygia` is "the main package" is open (see Q4).
The split needs one performant middle layer every package plugs into.

## What the coupling maps found

Five maps (devtools+testing, profiler+cli, content+federation+flags, freeze, existing seams).
The short version: **the core already has five half-built plug-in mechanisms, none shared.**

| Mechanism today                             | Where                                                                                                                   | Used by                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| ~25 `set_*` setters (module `let` slots)    | freeze/registry, freeze/capture, federation/hole, devtools/server-registry, profiler/span, server/request-stats, flags… | every subsystem, each its own                                                  |
| `Symbol.for('ogygia.…')` globals            | ~25 keys                                                                                                                | claims key defined 3× (flags, router/ctx, federation/wire)                     |
| Runtime `slots` + compiler `FEATURES` table | runtime/slots.ts, compiler/link/runtime-entry.ts                                                                        | core client features only — the one that is right                              |
| `define` tokens                             | vite/index.ts:602-619                                                                                                   | devtools, beacon, forms, delta                                                 |
| Hardcoded steps in `hooks.ts #core`         | :993-1245                                                                                                               | flags prime, federation serve, freeze read/write, profiler wrap, devtools seed |
| Compiler specifier collectors               | driver.ts:57,200,1691; compiler/flags.ts:70                                                                             | federation, router, content, flags                                             |
| Internal `PackageScan` entry                | vite/index.ts:254                                                                                                       | profiler UI only                                                               |

Per-package edges that must be cut (the rest are one-way core → subsystem calls the contract absorbs):

- **devtools ↔ profiler** share one analysis engine (page-insights, hydration-hazards, page-assets,
  cpu, vital_parts) and both read core's beacon. Neither can own it.
- **federation ↔ router** cycle: router/index re-exports federation's `mount`; `mount` imports
  router/define, respond, ctx.
- **federation → freeze**: thaw notifier, source observer, and serve.ts writes a hand-built entry
  straight into the freeze store.
- **content ↔ core**: `Blocks.svelte` (core) imports content's block tree and content imports it
  back; the compiler's macro pipeline statically imports the markdown renderer for `og.code`/`og.md`.
- **freeze → core** in many small places: route `export const freeze` (compiler/kit.ts), the
  `stitch` preset key, the `og.source` macro, router `freeze` fields, region-endpoint's
  `freeze_capture_active()`, the client's `document_is_freeze()` meta, devtools events.

## The middle layer: one plugin, four realms

A plugin is ONE value the app declares ONCE, in the Vite config. It has a facet per realm — the
same realms the code already splits on. Core turns the list into **generated static code** at
build time, so nothing is looked up at run time.

```ts
// vite.config.ts — the only place an app names a plugin
ogygia({ plugins: [freeze({ ttl: 600 }), devtools(), profiler({ trap: { over: 400 } })] })
```

```ts
interface OgygiaPlugin {
	name: string;
	compile?: {                       // build time, in the Vite plugin (node)
		files?: PackageScan;            // folds the profiler's internal PackageScan special case
		specifiers?: string[];          // import collectors: 'ogygia/flag', federation, content
		macros?: MacroDef[];            // og.code / og.md / og.loader (content), og.source (freeze)
		presetKeys?: PresetKeyDef[];    // `stitch` (freeze) — validator + transform hook
		routeExports?: string[];        // `export const freeze` in route files (read + strip)
		virtual?: VirtualDef[];         // freeze-routes, profiler-maps, devtools-meta…
		build?: BuildHooks;             // profiler maps fill, flags manifest
		vite?: VitePlugin[];            // content HMR, server sourcemaps
	};
	server?: string;                  // module id → statically imported into virtual:ogygia/server-plugins
	client?: string;                  // module id → contributes FeatureDefs (boot | hydrate phase)
	listens?: EventDomain[];          // event domains it consumes → turns those emits ON
}
```

**Server realm** — the plugin's server module exports stages at fixed points of `#core`:

| Stage      | When                                       | Today's hardcoded occupant                     |
| ---------- | ------------------------------------------ | ---------------------------------------------- |
| `request`  | before the page/endpoint split; may answer | `prime_flags`, `serve_federation`, freeze read |
| `wrap`     | around the whole of `#core`                | profiler `prof()`                              |
| `document` | on the final HTML                          | freeze capture + ESI stitch, devtools seed     |
| `response` | after the response exists                  | freeze write/self-evict, `flush_exposures`     |

Per-request plugin state lives in ONE `bag` slot per plugin on the existing `RequestBag` (the
request ALS), not in new setters.

**Client realm** — plugins add `FeatureDef`s to the existing `FEATURES` table. Same rules as today
([[svelte-free-boot-phases]]): static phases, compiler-generated entries, no per-feature `import()`
in boot. The devtools launcher is a boot feature; its app stays a lazy import on open.

**Events** — the devtools bus widens into core's one event layer. Core emits typed facts
(`region.hydrate.done`, `server.capability.minted`, `freeze.invalidate`, `flag.read`…). Each
domain has a define that is `true` only when some plugin `listens` to it, so an emit nobody
listens to compiles to nothing. Dispatch is a generated static listener list. This replaces the
cross-subsystem setters:

- `set_server_devtools_recorder`, `set_span_recorder`, `set_batch_hole_listener`,
  `set_request_stats_detail` → devtools/profiler listen to server events
- `set_thaw_notifier` → freeze emits `freeze.invalidate`, federation listens
- `set_source_observer` → core emits `source.read`, federation listens
- `set_flag_observer` → flags emit `flag.read`, freeze listens (disqualifies the capture)

**Shared request facts** — one core key for facts several plugins read (the 3 claims symbols
fold into it; `freeze_capture_active()` becomes a core `response_stored` fact freeze sets and the
region endpoint reads; `document_is_freeze()` becomes a generic "served from store" document fact).

## Plugin API v2 — seven concepts (PROPOSED 2026-10-31, replaces the loose-functions door below)

User: "can the plugin system be extremely well done? like the rollup plugin system… a very powerful
ctx… right now feels all over the place… think harder, future possibilities, more flexible,
extensible yet more elegant."

The whole API is seven concepts. Every ad-hoc mechanism in core folds into one of them.

1. **Plugin** — a manifest: `name`, `options` (validated, JSON, flows to every realm), `entries`
   (one module per realm), `build(b)` (compile hooks). Built in vite.config, read in node, so tools
   (MCP, Observatory, docs) can introspect it without running a build.
2. **Realms** — where code runs. Each entry module default-exports `define<Realm>(…)`:
   `server` (request lifecycle), `client` (browser runtime feature, with its boot/hydrate phase in the
   manifest so the build places it statically), `devtools` (panels + insights). Future realms slot in
   the same way: `cli` (commands), `mcp` (tools), `testing` (matchers). One file per realm, like
   Kit's `+page.server.ts` / `+page.ts`: node code never leaks into a browser bundle.
3. **Hooks** — named moments, each with a KIND (Rollup's taxonomy): _first_ (first answer wins:
   server `page`), _sequential_ (each may replace: `response`), _parallel_ (all run, no answer:
   `done`). Ordering is per plugin (`enforce: 'pre' | 'post'`) and per hook (`{ order, handler }`),
   like Vite. Documented once, the same everywhere.
4. **Context** — every hook gets a ctx scoped to its moment: `b` (build), `app` (server process:
   once, in `setup`), `ctx` (one request). Everything stateful lives there; nothing is a loose import.
5. **Events** — notifications, many listeners, no answers (`store:invalidated`). Typed by
   declaration merging; namespaced by the plugin that owns them.
6. **Services** — capabilities, ONE provider, typed callers: `app.provide('page-store', api)` /
   `app.use('page-store')` → the API or `undefined` (an optional dependency, checked). Federation
   asks for `page-store`, not for "freeze": any store plugin can provide it.
7. **Facts** — per-request shared state, `ctx.facts`, a declaration-mergeable record: core declares
   `storable`, `perVisitor`, `streamed`, `private`, `sources`; a plugin may add its own. App code
   outside a hook (a `flag()` read during render) reaches them through `app.current()`.

Pure helpers (hash, escape, LRU, Standard Schema types) need no context: `ogygia/plugin/utils`.
No `api` version number: the fixed package versions and the peer range already guarantee a match.
Build API from `ogygia/vite` (loads in plain node); runtime API from `ogygia/plugin`.

What folds in and gets deleted: every cross-subsystem `set_*` seam (→ services / events), the
`Symbol.for` cross-module registries (→ services), the client FEATURES table (→ core's own features
become client-realm entries: one mechanism for core and plugins), devtools tabs (→ devtools realm),
the MCP flags tool (→ mcp realm), the ad-hoc request/answer events (`cache.build` → a service call).

### v2 as DECIDED (user, 2026-10-31) — five concepts

User pushback folded in: no `use()`/`provide()` string lookups, no module paths in strings, no
`import.meta` first argument ("name is good, it's standard, do it").

1. **Plugin** — `definePlugin({ name: '@ogygia/freeze', options, enforce?, build?(b) })` from
   `ogygia/vite`. `name` is the package name (validated at config time: it must resolve from the app).
   It RETURNS A VITE PLUGIN carrying the definition under `Symbol.for('ogygia.plugin')` (user's
   pick over a name convention like `ogygia:*`; registered so two ogygia copies agree) (user, 2026-10-31: `/vite` must
   mean a real Vite plugin). The app lists it beside `ogygia()`, before `sveltekit()`
   (`plugins: [ogygia(), freeze(), sveltekit()]`); `ogygia()`'s config hook walks the Vite list and
   finds them (wrong order, or a plugin without `ogygia()`, is a build error). `ogygia({ plugins })`
   and the definition's `vite` field are gone: a factory needing Vite hooks of its own returns
   `[definePlugin({…}), itsVitePlugin]`. Package ROOTS stay the runtime; factories stay on `/vite`
   (the Kit / Tailwind convention, decided over root-exported factories).
2. **Realms** — NAMED by the plugin (user, 2026-10-31: "not happy with the implicitness"):
   `server: import.meta.resolve('./server.ts')`, `client: …('./client.ts')`. Package exports are
   free again (`@ogygia/content/server` got its name back). ONE copy still holds: the factory loads
   from `src` in the workspace (its export points at src; every package root is strip-safe, guarded
   by `erasableSyntaxOnly`) and from `dist` when installed, and the shared tsdown build rewrites
   `import.meta.resolve('./x.ts')` to `./x.js`, so the realm is always the sibling of the copy the
   app runs. (Was: `${name}/server` exports found by name.)
3. **Hooks** — core lifecycle hooks (`request` / `page` first, `response` sequential, `done`
   parallel) AND shared hooks, one mechanism. Plugins implement shared hooks as methods; anyone calls
   them through `app.notify.<hook>(…)` (every plugin) or `app.ask.<hook>(…)` (first non-undefined
   answer, plugin order). Core owns the common names (`invalidate`, `invalidated`, `lastBuild`);
   plugin-only hooks carry the plugin's name. Typed by declaration merging (`interface ServerHooks`).
4. **Context** — `b` (build), `app` (server process, in `setup`), `ctx` (one request: `event`, `path`,
   `state`, `options`, `facts`, `routeOption()`, `renderHole()`, `devtools()`).
5. **Facts** — per-request record keyed by the Request (`app.facts(request)`, `ctx.facts`),
   declaration-mergeable: `storable`, `perVisitor`, `streamed`, `private`, `answerForm`, `sources`,
   `assignments`.

Pure helpers: `ogygia/plugin/utils`. No `api` number. Tree-shaking: client realms' hooks are read
statically by the compiler → one build-time constant per client hook, so an unimplemented hook's call
site compiles away (proved by tests).

## The substrate: what plugins see, and how (v1, superseded by v2 above)

User ruling 2026-10-31: `plugins: [...]` list. Asked next: what does the middle layer look like, how
do plugins reach internals, what is exposed.

**Principle: plugins never get internals. They get ports.** A port is a small typed object core
hands a plugin at one of its hook points. It carries data and verbs, not module access. Core keeps
the freedom to rewrite everything behind a port.

**One door.** Everything a plugin may touch comes from ONE subpath, `@ogygia/core/plugin`. No
plugin imports a core file by path. The existing `ogygia/internal/*` exports fold into it or die.
Enforced two ways: core's `exports` map has no other door, and a test scans every plugin package
for imports of `@ogygia/core/*` other than the public subpaths.

### The ports, by realm (derived from what each subsystem uses today)

```ts
// @ogygia/core/plugin
export function definePlugin(p: OgygiaPlugin): OgygiaPlugin;
export const PLUGIN_API = 1; // plugin declares `api: 1`; core refuses a mismatch at config time
```

**1. Compile port** — handed to `compile.*` hooks (node, build time).

| Member                                                                      | Replaces today                                                           | Who needs it                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| `app` (read-only: root, routes dir, dev/build, kit major, `resolve(alias)`) | reaching into `CompileCtx`                                               | all                                         |
| `virtual(id, (ssr) => source)`                                              | per-subsystem ids in compiler/ids.ts + driver loads                      | freeze routes, profiler maps, devtools meta |
| `files(scan)`                                                               | the profiler's internal `PackageScan` entry                              | profiler UI, content shells                 |
| `macro(name, fn)` with a `MacroCtx` (args, file, ssr, emitImport)           | og.code/og.md/og.loader/og.source hardwired in macros/pipeline.ts        | content, freeze                             |
| `presetKey(name, validate)` and `routeExport(name, read)`                   | `stitch` in REGION_PRESET_KEYS + transform; kit.ts `export const freeze` | freeze                                      |
| `specifier(spec, collect)`                                                  | FEDERATION_SPEC, compiler/flags.ts collector, content check              | flags, federation, content                  |
| `buildCache(name)`, `hash()`                                                | content importing BuildCache + host createHash                           | content                                     |
| `islandDeps` (read the island-deps handoff)                                 | profiler/index reading island-deps virtual; content CSS handoff          | profiler, content                           |
| `after(stage, fn)` (writeBundle / closeBundle legs)                         | profiler maps fill, flags manifest write                                 | profiler, flags                             |

**2. Server port** — one `Req` object per request, passed to the four stages.

```ts
interface Req<Bag> {
	event: RequestEvent;            // Kit's own, untouched
	bag: Bag;                       // THIS plugin's slot; typed by the plugin
	facts: Facts;                   // shared request facts (below)
	answer(res: Response): void;    // request stage only: short-circuit (freeze hit, federation route)
	personal(): void;               // today's mark_personal — "never cache this response"
	sign(data): string; verify(data, sig): boolean;   // the app's signing key, never the key itself
	renderHole(url: URL): Promise<string>;            // in-process hole render (freeze ESI stitch)
}
interface Doc {                   // document stage only
	html: string;                   // final HTML (freeze captures it)
	head(tag: string): void; tail(tag: string): void; // inject (devtools seed, profiler beacon tag)
	regions(): RegionFact[];        // scanRegions result, computed once, shared by every plugin
}
interface Facts {                 // the ONLY cross-plugin request state
	claims: Claims;                 // folds the 3 claims symbols (flags, router, federation)
	stored: boolean;                // folds freeze_capture_active(); region endpoint reads it
	streamed: boolean;              // page holds a streamed promise (freeze disqualifies)
	stats: RequestStats;            // read-only; folds request-stats setters (profiler)
}
```

**3. Client port** — plugins add `FeatureDef`s to the existing table. A feature's `install(rt)`
gets a runtime port, never the slots object:

```ts
interface Rt {
	on: EventsOn;                   // client event stream (below)
	regions(): RegionView[];        // fp, entry, kind, state, props bytes, timings — computed by core
	beacon: BeaconPage;             // the beacon's page record (vitals, cpu, visits)
	cost: CostLedger;               // today's own-cost Symbol ledger
}
```

The hard case is devtools: today it reads DOM attribute names, the props sidecar, the island graph
encoding, the own-cost global. Under this design those readings move INTO core as `regions()` /
`beacon` / `cost`, so devtools receives facts, not DOM conventions. Same move puts the shared
analysis engine (page-insights, hazards, page-assets) in `@ogygia/core/insights`: it interprets
core's own measurements, so core owns it.

**4. Events** — one typed stream, both realms. The existing devtools schema (already versioned,
`DEVTOOLS_SCHEMA_VERSION`) becomes the core event schema. `listens: ['server', 'region', …]` in the
plugin turns those domains' emits on at build; an unheard emit compiles to nothing.

**5. Kernels** — small pure helpers several plugins need, re-exported from the door: `fnv1a`,
`escape`, `SizedLru`, `scanRegions` (already public), region values (`region()`, `htmlRegion()`,
`isRegion()` — wraps today's `og_html_region` / `REGION_BRAND`), router types.

### What stays hidden (never on a port)

Runtime `slots`, compiler `Program` / registry / transform, morph and reconcile, hydrate internals,
the wire codec, the capability MAC format, the secret, the session cookie format. If a plugin needs
something here, the answer is a new fact or port member, designed, not a path import.

### How the ports stay fast

- Stages: the build writes `virtual:ogygia/server-plugins` as direct calls in a fixed order —
  `await freeze.request(req)` — no loop over a registry, no lookup by name.
- `bag`: each plugin gets a fixed field on `RequestBag` chosen at build time; no Map.
- `facts`: plain fields on `RequestBag`, filled once.
- `Doc.regions()`: lazy, computed once per document, shared.
- Client: features ride the existing generated runtime entry; nothing new at boot.
- Events: define-gated per domain, as above.

### Versioning

`PLUGIN_API` is one integer. First-party plugins release in a changesets **fixed** group with core,
so their versions always match. A breaking port change bumps `PLUGIN_API` and the group together.

## Progress log (the finish line: every package split, core renamed last)

Order (user: "do it all"): freeze → federation → router → content → devtools+profiler →
testing + cli → compile port completes (flags collector out) → core move (`packages/core` =
`@ogygia/core`, `packages/ogygia` = shell re-exporting it; plugins switch to `@ogygia/core/plugin`).
Core rename goes LAST: many build paths key off the package name `ogygia`.

- R1 5b1bdd45 substrate + @ogygia/flags + packages/tooling. R2 380d0ac8 turbo, .ts scripts,
  changeset. R3 24fe64be isolated declarations for core.
- R4 FREEZE (in progress). The cut:
  - CORE keeps: `stitch` (a dial on core holes); data sources (`og.source` macro + `__og_source`
    runtime, moved to src/source.ts, injected from `ogygia/internal`; record/observer seams);
    the "served from store" document meta the runtime reads (`STORED_DOCUMENT_META`).
  - NEW door pieces: request FACTS on the RequestBag (`stored` → prerender-grade hole capabilities,
    `per_request` → first reason the render is per-visitor (personal reads, streamed promise),
    `streamed`, `private` (devtools-personal), `answer_form` (app transform + router fetch),
    `sources` (og.source receipts while `stored`)), read via `requestFacts()`; ROUTE OPTIONS
    (`compile.routeOptions: ['freeze']` → compiler strips + cascades `export const <name>` like csr;
    the router registers its programmatic verdicts; `routeOption(name, routeId, pathname)`); a
    SERVER EVENT BUS (`on` / `emit` → listener results): `cache.invalidated` (freeze → federation
    thaw notices), `cache.invalidate` (federation inbound thaw → freeze), `cache.build` (deploy
    thaw marker); plugin `options` (JSON) handed to a server-half factory; stages `page` (page
    requests only, may answer) and `response` (may replace); `req.renderHole(endpoint)`.
  - FREEZE package: registry/stores/edges/flights/stitch/observe/adapters + the capture/serve code
    that lived in hooks.ts; `freeze({ ttl, default })` replaces `ogygia({ freeze })`.
  - BUILT on plugin API v2 (uncommitted at time of writing): core door `ogygia/plugin` (defineServer,
    RequestContext, ServerApp, facts, shared hooks), `ogygia/plugin/utils`, `ogygia/plugin/testing`
    (`startPlugin`), build side `definePlugin` in `ogygia/vite`; flags rebuilt on it; freeze moved to
    packages/freeze. Data sources (`og.source`) stayed core (src/source.ts, injected from
    `ogygia/internal`); route options are core (`plugin/routes.ts`, compiler `page_route_options`).
  - LEFT FOR LATER ROUNDS: docs pages still say `ogygia({ freeze })`, `ogygia/flag`, `ogygia/freeze`
    (one docs pass at the end); client-hook DCE lands with the first client realm (devtools).
  - DEPENDENCIES (user, 2026-10-31): each package owns its own. A core optional peer that only one
    feature used becomes a REGULAR dependency of that plugin package (installing the plugin means
    using it): content → mdsvex, shiki, @orama/orama, bits-ui; devtools → @neodrag/svelte. They leave
    core's package.json with the feature.
  - TODO (user, 2026-10-31): RENAME freeze. "Elegant, punchy, but conveys no meaning." Nobody uses
    it yet, so the rename is free: package, plugin, `export const freeze`, the docs. Not now.
- R5 41908d93 FEDERATION (`@ogygia/federation`), e2e 352/352.
- R6 CONTENT (`@ogygia/content`):
  - CORE gives: `b.macro(name, handler)` (content's `code` / `md` / `loader` / `regions`; core keeps
    wire/$/source/store/bake), `b.markup({ extensions, scan, styles })` → the island transform for
    preprocessed markup (replaces core's island bridge), the plugin's `vite` field. Macro building
    blocks (scanner, parser, host fs/path/hash, build cache, content CSS key) come from
    `ogygia/internal/compiler-browser` — host-seamed, so they run in node AND the Observatory.
    `prebaked_region` joins `ogygia/internal`.
  - CONTENT owns: its bridge (`Symbol.for('ogygia.content-bridge.v1')`: markdown config, presets, the
    transform, scan, style sources), the preset tagging pre-transform, the collection-placement and
    loader-in-component warnings, dev HMR. `content({ markdown, presets, watchDirs, hmrDebounceMs })`
    from `@ogygia/content/vite`, plus the svelte config's `preprocess()` / `extensions()` there.
  - `./server` is a RESERVED realm subpath (a plugin's server half, found by name), so content's
    user-facing remote layer moved: `ogygia/content/server` → `@ogygia/content/remote`.
  - Deps moved: mdsvex, shiki, @orama/orama, bits-ui are content's regular dependencies; gone from core.
  - KNOWN COUPLING (follow-up): core's Kit-transport detector still names `@ogygia/content` (a content
    import can put a held region on Kit's wire). Fold into the plugin API (a plugin declares the
    modules whose imports cross the wire) when the next plugin needs it.
- R6b 9538b8db `.ts` IMPORT EXTENSIONS + verbatimModuleSyntax (one scripted pass, user-approved);
  tsdown-plugin-svelte rewrites shipped components' relative `.ts` imports (and `.svelte.d.ts`) to `.js`.
- R7 DEVTOOLS + PROFILER → `@ogygia/devtools` (in progress). Coupling map (2026-10-31): devtools ~60
  files / 13k LOC, profiler ~100 files / 46k LOC; ~39 core emit sites on the bus; profiler UI is built
  on the server router (`ogygia/router`, plus non-public `AnyComponent` / `is_redirect`).
  - STAYS CORE: the event layer (`src/events/`: bus, schema, sinks, server-registry; `ogygia/events`,
    `ogygia/devtools` kept as an alias until the move); insights (`src/insights/`: page-insights,
    third-party, cpu, hydration-hazards, page-assets, fp-drift, hole-segments, html-diff,
    session-insights, testing-version, switch constants) — the compiler (island-deps hazards) and
    testing read them; measurement producers (beacon, own-cost, tool-fetches, request-stats, document-
    tail detail rows, island-deps analysis), gated by "a plugin asked" instead of `profiler`/`devtools`.
  - STEPS: (1) in-core moves to events/ + insights/ (no behaviour change). (2) server door: a
    `handle(ctx, next)` lifecycle kind (Kit-Handle shaped, nested around `#core`), the profiler wrap as a
    server realm, request-stats on `app` + a `batchHole` shared hook, facts `events` / `serverTiming`,
    devtools switch/lean-testing/document-policy into the devtools server realm; export `AnyComponent` +
    `isRedirect` from `ogygia/router`. (3) build door: `b.events()` / `b.beacon()` drive the defines,
    `b.files(scan)` replaces the internal PackageScan, `b.islandFacts()` replaces the profiler_config
    gates, a core island-names virtual replaces devtools-meta; profiler maps/sourcemaps/module map/
    dev-maps become the plugin's own vite plugins; drop the `devtools`/`profiler` options. (4) the first
    CLIENT REALM: `${name}/client` found by name, statically read (`defineClient`), one define per hook so
    unused hooks DCE, generated imports in runtime-entry + `bootDev`, a core kit-page boot for csr=true
    pages; hooks `boot`, `islandMount`, `islandUnmount`; the beacon measure gate becomes a core flag.
    (5) the mechanical move to packages/devtools (64 tests, 12 app imports, 2 configs; `@neodrag/svelte`
    a dependency). Open: `mcp.ts` imports profiler report/patterns/crypto (→ lazy optional peer, or move
    the CLI/MCP split forward); plugin packages with `.svelte` need `ssr.noExternal` when installed.
  - AS BUILT (the user asked to move first, then cut): the folders moved to packages/devtools, then
    each core reach-in became a door piece —
    - SERVER `handle(ctx, next)` lifecycle hook (`around()` in plugin/server.ts nests them, first plugin
      outermost; `next(opts)` composes resolve options); `@ogygia/devtools/server` mounts the profiler
      lazily there (on-demand gate included); core's request stats switch on via `want_request_stats()`
      (no more profiler config in core: `virtual:ogygia/profiler-config` deleted).
    - BUILD `b.events({ lazy })` (the `__OGYGIA_DEVTOOLS__` gate + its lazy form), `b.measure()`
      (embedded maps, module map, island detail, server sourcemaps, dev maps, BEACON), `b.files({ root,
      dirs, files })` (the profiler UI + its router); plugins' build hooks now run in core's `config`
      hook (before the defines); plugin packages join `ssr.noExternal` + `optimizeDeps.exclude`. The
      measurement producers stayed core (they need compiler internals) — gated by `b.measure()`.
    - CLIENT `ogygia/plugin/client`: `defineClient({ boot({ kitPage }), regionMount(el, { entry, urls }),
      regionUnmount(el, { entry }) })` (user: public names say REGION, never island); found by name
      (`<name>/client`), statically imported into the boot entry / `bootDev([…])` / the Kit-page dev boot;
      one gate `__OGYGIA_CLIENT_PLUGINS__` folds every call when none (per-hook DCE: later).
    - `ogygia mcp` loads `@ogygia/devtools/report` from the app's install at first need (moves to the CLI
      package later). The maps' gzip mark is `PROFILER_MAPS_GZ_PREFIX` in compiler ids.
    - `ogygia({ devtools, profiler })` → `devtools({ dock, profiler })` from `@ogygia/devtools/vite`
      (legacy-key errors name the new spelling).
- NEXT (user, 2026-10-31: "yes love it lets do it"): FLATTEN `regions.*` onto ogygia()'s root —
  `visible`, `presets`, `ttl`, `maxPageAge`; `regions` becomes a legacy key with the new spelling.
- R10 SERVER ROUTER → `@ogygia/router` (AS BUILT). src/router moved to packages/router (`.` = the
  router, `./api` = the typed fetch client, `./vite` = `router()`); the CLIENT router stays core. Six
  router tests moved with it (router-dispatch, -api-client, -match, -schema, -infer.test-d,
  route-options-router); core's router-css.test stays (it tests the compiler link). Door pieces:
  - BUILD `b.pageModules({ importers?, files? })`: modules that render pages outside Kit's routes; every
    component they import gets its whole-tree CSS linked when it renders. Replaces the compiler's
    hardcoded `'ogygia/router'` prescan spec (`ctx.page_importers` / `ctx.page_files`; importers apply to
    every compiled file, `ogygia.files` surfaces included). `router()` passes `importers:
    ['@ogygia/router']`; devtools passes `files: [profiler-router]` (its `b.files` stays for the UI).
  - `ogygia/plugin/css` (own subpath, so `virtual:ogygia/router-css` stays out of every plugin's server
    realm; the virtual is now imported on first call): `componentCssHead(components)` (was router/css-head.ts).
  - `ogygia/plugin`: `registerRouteOptions` (+ types), `openLateScope` / `takeLateRegions` (+ `LateRegion`),
    and the late wire `lateSlot` / `lateChunk` / `LATE_BOOT_SCRIPT` (moved to src/server/late-wire.ts:
    core's protocol, also spoken by PromiseRegion*.svelte and runtime/router-nav.ts).
  - `ogygia/plugin/utils`: `escapeText`; `StandardSchemaV1` (+ `StandardResult`, `StandardIssue`) now
    DEFINED in core (src/plugin/standard-schema.ts), the router re-exports it.
  - `ogygia/plugin/testing`: `routeOption`, `clearRouteOptions`, `setPageRouteOptions`.
  - `document()` comes from `ogygia/server`; RawHtml.svelte has a router-own twin.
  - Module identity: route options live on a `Symbol.for` slot; the late registry, the router-css
    registry and `claim_region_css` are reached through core subpaths that resolve to the same files
    `ogygia/server` / `ogygia/internal/register` load (src in the workspace, dist when published).
  - NOT `./client` for the fetch client: `<name>/client` is a plugin's browser REALM (found by name,
    booted on every page), so listing `router()` would have booted the api module as a client plugin.
  - LEFT: the router still declares the `freeze` route option by name (router.ts `option_of`, define.ts
    `freeze` fields) — generalizing it is the "route `meta` freeze reads" edge cut above. Docs: only the
    server-router + federation pages' import lines changed; the docs pass comes later.
- R11 CORE MOVE (AS BUILT): `packages/core` = `@ogygia/core` (private for now, in the fixed group);
  `packages/ogygia` = the `ogygia` SHELL apps install. Apps keep importing `ogygia/*`; plugins import
  `@ogygia/core/*` (peer + dev dep `@ogygia/core: workspace`).
  - SHELL: every core subpath mirrored (same conditions: `svelte`/`default` → src in the workspace,
    `types` → dist, publishConfig → dist; `./vite`, `./internal/compiler`, `./internal/region-core`,
    `./internal/compiler-browser(-full)` → dist like core's), each a one-line `export * from
    '@ogygia/core/<x>'` (core has no default exports on any subpath). `ogygia/types` is `/// <reference
    types="@ogygia/core/types" />`. The bin (`src/cli.ts`, the front door to `@ogygia/cli`) moved here
    with README/LICENSE/CHANGELOG (`ogygia` is the npm package with that history); core got a short
    README. Built with `library()` + the cli bundle config; core's tsdown lost its cli config. The shell
    repeats core's peers so an install hands core the app's svelte/kit/vite.
  - ONE MODULE COPY: shell src re-exports resolve to core's src in the workspace (dist when published);
    compiler-emitted specifiers stay `ogygia/...` (apps depend on `ogygia`; `ogygia/internal` and
    `ogygia/internal/server` still resolve head-on to core files via `OGYGIA_INJECTED_FILES`).
  - SELF-NAME: `src/own-package.ts` (`OWN_PACKAGE_NAMES` = `ogygia`, `@ogygia/core`; `is_own_specifier`;
    `OWN_SPECIFIER_SOURCE`; `OWN_FILE_RE` = `…/ogygia|@ogygia/core|packages/core/(src|dist)/…`). Used by
    vite `ssr.noExternal` + `optimizeDeps.exclude` + the dev `optimizeDeps.include` warning; the dev
    include names `ogygia > @ogygia/core > devalue`; package-files skip; island-deps (pkg name + own
    path + OWN_OR_DEP); context-detect (`CTX_MODULES` + import scanners); transport's wire scanners;
    region-bytes; insights/cpu (`kind_of`, own instruments); page-insights `dev_two_copies` (one package
    under two names). Devtools' profiler classifiers (analyze `OGYGIA_OWN_RE` + `package_of` naming
    `@ogygia/core` "ogygia", timeline, ledger `is_app_path`/`is_framework_pkg`, module-map) follow.
  - TOOLING: `pluginTests()` stubs → packages/core/test/_stubs; core's `verify-package.ts` takes a
    package dir and packs workspace deps beside it (`ogygia` verifies against the packed core; its own
    node_modules is now a temp dir, no more stray self-link in the repo's); e2e `fixtures/packed.ts`
    packs both and overrides `@ogygia/core` in the app's own pnpm-workspace.yaml (pnpm 11 ignores
    package.json `pnpm.overrides`, and `--ignore-workspace` skips the yaml); dev-installed unpacks core;
    pkg-pr-new publishes the shell, core and every plugin; bench build-all packs core too.
  - LEFT (user's call): publishing. `ogygia` 0.11.0 depends on `@ogygia/core` 0.11.0, so core must
    publish first (drop its `private`, trusted publishing for the new name). Until then `changeset
    status` refuses the tree ("ogygia depends on the skipped package @ogygia/core"); with core public
    the fixed group bumps core with the existing changeset (checked).
- R12 E2E SCOPED BY PACKAGE (AS BUILT; Open question 6). `apps/playground` → `apps/palaestra`
  (package `palaestra`). The hand-written ownership map (e2e/scope.ts, e2e/affected.ts,
  e2e/scope.test.ts, `test:e2e:affected`, `check:verify`) is gone; the STRUCTURE scopes the suite:
  - LAYOUT: `packages/<name>/e2e/*.spec.ts` + `packages/<name>/playwright.config.ts` (its own port) +
    an `e2e` script (`playwright test`); the fixture app at `packages/<name>/e2e/app` (a workspace
    package `<name>-e2e-app`, `packages/*/e2e/*` in pnpm-workspace.yaml) depends on `ogygia` + the
    plugin and lists only it. Core's suite: `apps/palaestra/e2e` against the palaestra, which lists NO
    plugin (its plugin pages moved out; flags had none). Shared harness `@ogygia/tooling/e2e`
    (`check()`/`test`/`REPO`, `/servers.ts`, `/re.ts`, `/packed.ts`, `/config.ts` = `suite({ port,
    serve | build, ready })`, `/build.ts` = a fixture app's build as webServer step or globalSetup;
    `tsconfig.e2e.json`). Each package's `check` adds `tsc -p e2e`; root `check` adds the fixture apps'
    and the docs' svelte-check.
  - SUITES (352 passed + 1 skipped, as before): palaestra 303 (port 3051; adapters, kit3 and the
    other core packaging specs stay here); devtools 17 (devtools, profiler-serverless,
    profiler-window-instances, dev-installed — against the DEVTOOLS LAB: every dt-* lab, the profiler's
    answer-key pages hell / inferno / purgatory / limbo / latecomer (+ -fixed twins), score-lab, slow-io,
    nettest moved here; copies of the palaestra pages the specs and the internal/bench answer keys
    visit — /, /interaction, /kit, /portable-snippet, /props-tail, /transportable, /wake-gate,
    /head-budget-kit, /detector, /plain, /restore-lab, /nested-hole, /heavy, /api; the build is a
    globalSetup); testing 10 (against the devtools lab's dev server); federation 9 (examples/mfe stays
    a user-facing demo; the suite boots it); freeze 3 (internal/repro-freeze → packages/freeze/e2e/app,
    the emulator + ESI demo beside it); router 8 (/rtr + /island-pkg; internal/repro-island-pkg →
    packages/router/e2e/island-pkg); content 2 (/content-css + the blocks demos); docs 0 + 1 skipped
    (dev-hmr-venues edits the docs app, so it moved to `apps/docs/e2e`). flags and cli have none.
  - TURBO: `e2e` = `dependsOn ^build`, `outputs: []`, cache on, `E2E_NO_BUILD` hashed, the `OGYGIA_*`
    / CI env passed through. A plugin's package turbo.json adds its own `build` and
    `<fixture-app>#fixture` — a no-script task whose `^build` builds everything the fixture app installs
    (the `ogygia` shell, the other plugins it lists) and whose hash carries the app's files. testing
    adds `$TURBO_ROOT$/packages/devtools/e2e/app/**`, federation `$TURBO_ROOT$/examples/mfe/**`, the
    palaestra its outside fixtures (apps/pure-csr, internal/repro-deep-csr, -kit3, -subpkg,
    -hole-css-kit). Those `$TURBO_ROOT$` globs do NOT honour .gitignore (the first cache proof missed
    on them), so each also negates the build output, node_modules, .svelte-kit, .ogygia… of what it
    names. `build`/`test` ignore `e2e/**`, `check` ignores `e2e/app/**`. So `--affected`
    agrees with the cache, the package graph names what each suite drives: testing → devtools,
    federation → freeze, freeze → flags + router (devDependencies).
  - `pnpm test:e2e` = `turbo run e2e --concurrency=1`; CI runs it with `--affected` on pull requests
    (`TURBO_SCM_BASE=origin/<base>`), in full on pushes (the turbo cache replays unchanged suites).
  - Fixture apps pin `svelte` 5.56.8 / `vite` 8.2.0 (the versions core and the palaestra resolve): a
    fresh importer resolved 5.57.2 and svelte-check saw two Svelte type copies.

## Performance rules (the bar every step must pass)

1. Resolved at build time. No run-time registry, no lookup by plugin name, no `import()` in boot.
2. Plugin absent = zero bytes and zero branches: no generated entries, emits defined away.
3. Plugin present = straight-line generated calls, the same work today's hardcoded calls do.
4. Proved, not argued: bundle-size snapshot unchanged for a plain app; server bench p50 unchanged;
   a tree-shake test per plugin (absent → its strings appear nowhere in client or server output).

## What it deletes ([[architecture-sphere]])

- ~10 cross-subsystem `set_*` seams → events or the bag. Core-internal setters (hooks feeding
  its own lower modules) stay; they are not subsystem seams.
- 3 claims symbols → one request fact.
- The profiler `PackageScan` special case → `compile.files`.
- Hardcoded federation/flags/content specifier constants in the compiler → `compile.specifiers`.
- Hardcoded freeze/federation/flags/profiler steps in `#core` → stages.
- The per-subsystem option keys (`devtools`, `profiler`, `freeze`, `content`) → plugin options.

## Edge cuts, one line each

- devtools ↔ profiler: the analysis engine moves to a pure-function core subpath
  (`@ogygia/core/insights`) next to the beacon whose data it reads. Tree-shaken when unused.
- federation ↔ router: `mount` lives only in federation; `ogygia/router` stops re-exporting it.
- federation → freeze: through `freeze.invalidate` events and freeze's public store API; freeze is
  an optional peer of federation.
- content ↔ core: `Blocks.svelte` moves to content; `og.code`/`og.md`/`og.loader` become content's
  `compile.macros`. Region content-CSS (`content_id`, `prebaked_region`) is a region concept and
  stays core.
- freeze → core: `stitch` → `compile.presetKeys`; `export const freeze` → `compile.routeExports`;
  `og.source` → `compile.macros`; router `freeze` fields → a generic route `meta` freeze reads.

## Packages

| Package              | From                                                                                                                                                                            | Notes                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ogygia/core`       | everything else, incl. the CLIENT nav (runtime/router.ts, runtime/router-nav.ts, `virtual:ogygia/router-config`; it has no public subpath)                                      | DONE R11: packages/core; `ogygia` (packages/ogygia) re-exports it subpath for subpath (Q4)                                                                                                                                                               |
| `@ogygia/router`     | src/router (the SERVER router: `routes()`, `page`, `mount` hosts) + `client-api.ts` (the typed `api<App>()` fetch client, was `ogygia/router/client`, now `@ogygia/router/api`) | DONE R10. Core imported one piece of it (`StandardSchemaV1`, re-exported by `ogygia/plugin/utils`), now reversed; federation + profiler build on it; the compiler's router prescan became `b.pageModules()`; router-css stays core (`ogygia/plugin/css`) |
| `@ogygia/devtools`   | src/devtools + src/profiler (MERGED, user 2026-10-31)                                                                                                                           | one plugin `devtools({ profiler })`: in-page panel + server profiler, each its own on-switch; profiler stays a lazy import; storage adapters as `/profiler/storage/*` subpaths; `@neodrag/svelte` peer moves here                                        |
| `@ogygia/content`    | src/content, Blocks.svelte, markdown macros                                                                                                                                     | mdsvex, shiki, orama, bits-ui peers move here                                                                                                                                                                                                            |
| `@ogygia/federation` | src/federation                                                                                                                                                                  |                                                                                                                                                                                                                                                          |
| `@ogygia/flags`      | flags.ts, src/flags                                                                                                                                                             | `/openfeature` subpath                                                                                                                                                                                                                                   |
| `@ogygia/freeze`     | src/freeze                                                                                                                                                                      | adapters as subpaths (no npm deps today)                                                                                                                                                                                                                 |
| `@ogygia/testing`    | src/testing                                                                                                                                                                     | depends on devtools + profiler                                                                                                                                                                                                                           |
| `@ogygia/cli`        | cli.ts, mcp.ts, perf/                                                                                                                                                           | owns the `ogygia` bin; no MCP SDK dep today                                                                                                                                                                                                              |

NOT a package: `internal/compiler-browser(-full)`. Two re-export barrels over the compiler, used only
by the docs Observatory. Keep as core subpaths.

## Order of work

1. Build the contract INSIDE the one package. Move subsystems onto it one at a time, every test
   green after each: flags → freeze → federation → content → profiler → devtools (easiest first;
   devtools last, it touches ~15 core files).
2. Only then move folders into packages. With the contract in place this is mechanical.
3. Publish under the `@ogygia` npm scope with changesets, one major-line bump. ORDER (user,
   2026-10-31): the repo moves to the `ogygiajs` GitHub org first, then trusted publishing is
   re-pointed for the 2 existing packages, then the new packages get theirs. Until then every new
   package is `"private": true`, so a release on `next` never tries to publish it.
4. VERSIONS (user, 2026-10-31): everything publishes straight as **0.11.0**. Each new package starts
   at ogygia's current version and joins the changesets `fixed` group with ogygia; when `private`
   drops, the PR's one minor changeset moves the whole group to 0.11.0 (checked with
   `changeset status`).

## Breaking changes (for the release notes)

- Option keys `devtools` / `profiler` / `freeze` / `content` → `plugins: [...]` (unless Q4 keeps them).
- Imports: `ogygia/devtools|profiler|content|federation|flag|freeze|testing` → `@ogygia/*`.
- `mount` from `ogygia/router` → `@ogygia/federation`.

## Open questions (user's call)

1. ~~Plugin declaration~~ DECIDED: `plugins: [...]` list (user, 2026-10-31).
2. ~~Public or first-party~~ DECIDED: first-party only until the ports settle (user, 2026-10-31).
   Same door; docs make no stability promise to outside authors.
3. ~~Insights home~~ DECIDED: core subpath `@ogygia/core/insights` (user, 2026-10-31). Was: core vs its own
   `@ogygia/insights` package.
4. ~~Package names~~ DECIDED (user, 2026-10-31): short first-party names (`@ogygia/flags`,
   `@ogygia/devtools`, …; apps import them daily), no `plugin-` prefix. Third-party, later:
   `ogygia-plugin-*` + the `ogygia-plugin` npm keyword.
5. ~~The main-package question~~ DECIDED (user, 2026-10-31): `ogygia` is the thin front door — it
   re-exports everything from `@ogygia/core` as-is and owns the `npx ogygia` command (its bin runs
   the app's `@ogygia/cli`). Not batteries-included: plugins are installed and listed per app. (R11.)
6. TODO TO DISCUSS (user, 2026-10-31): SCOPE THE E2E SUITE like turbo scopes unit tests. Today it is
   one root Playwright run, outside turbo, always in full. Idea: group specs by owning package, give
   each package an `e2e` turbo task keyed on its own inputs + core's build, so a devtools change runs
   only devtools e2e and a core change runs all. Blocker: most specs run against the playground, which
   depends on every plugin (any plugin change rebuilds it → everything reruns) — real scoping needs a
   small fixture app per package (federation: examples/mfe, freeze: repro-freeze exist; content and
   devtools have none). After the split, its own round.
   (First pass, superseded: an OWNERSHIP map — e2e/scope.ts OWNERS + FIXTURES, e2e/affected.ts —
   that picked specs by hand. Deleted in R12.)
   DONE BY STRUCTURE (R12, user-approved): each package's specs live with the package and run against
   a small fixture app that lists only that package's plugin; each package has a turbo `e2e` task, so
   turbo's package graph + cache decide what reruns — no map to keep in sync. See R12 in the log.
7. Event-layer export name: `ogygia/events` (recommended; added in R7 step 1) vs keeping
   `ogygia/devtools` (currently an alias) vs folding into `ogygia/insights`.

## Also found while mapping (small, unrelated fixes)

- compiler/driver.ts:218 sweeps modules importing `'ogygia'`, but compiler/flags.ts:70 resolves only
  `'ogygia/flag'`.
- `yaml` sits in tsdown neverBundle as a content dep; nothing imports it.
- compiler/macros/pipeline.ts:121 says the markdown renderer is "dynamically imported"; it is static.
- `ogygia/content/tab-group` is referenced (driver.ts:1468, region/transform.ts:844) with no export.
- `og.source` macro import is injected into client modules too (no ssr gate).
