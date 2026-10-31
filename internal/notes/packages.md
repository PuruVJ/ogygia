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

| Mechanism today | Where | Used by |
|---|---|---|
| ~25 `set_*` setters (module `let` slots) | freeze/registry, freeze/capture, federation/hole, devtools/server-registry, profiler/span, server/request-stats, flags… | every subsystem, each its own |
| `Symbol.for('ogygia.…')` globals | ~25 keys | claims key defined 3× (flags, router/ctx, federation/wire) |
| Runtime `slots` + compiler `FEATURES` table | runtime/slots.ts, compiler/link/runtime-entry.ts | core client features only — the one that is right |
| `define` tokens | vite/index.ts:602-619 | devtools, beacon, forms, delta |
| Hardcoded steps in `hooks.ts #core` | :993-1245 | flags prime, federation serve, freeze read/write, profiler wrap, devtools seed |
| Compiler specifier collectors | driver.ts:57,200,1691; compiler/flags.ts:70 | federation, router, content, flags |
| Internal `PackageScan` entry | vite/index.ts:254 | profiler UI only |

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

| Stage | When | Today's hardcoded occupant |
|---|---|---|
| `request` | before the page/endpoint split; may answer | `prime_flags`, `serve_federation`, freeze read |
| `wrap` | around the whole of `#core` | profiler `prof()` |
| `document` | on the final HTML | freeze capture + ESI stitch, devtools seed |
| `response` | after the response exists | freeze write/self-evict, `flush_exposures` |

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

## The substrate: what plugins see, and how

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

| Member | Replaces today | Who needs it |
|---|---|---|
| `app` (read-only: root, routes dir, dev/build, kit major, `resolve(alias)`) | reaching into `CompileCtx` | all |
| `virtual(id, (ssr) => source)` | per-subsystem ids in compiler/ids.ts + driver loads | freeze routes, profiler maps, devtools meta |
| `files(scan)` | the profiler's internal `PackageScan` entry | profiler UI, content shells |
| `macro(name, fn)` with a `MacroCtx` (args, file, ssr, emitImport) | og.code/og.md/og.loader/og.source hardwired in macros/pipeline.ts | content, freeze |
| `presetKey(name, validate)` and `routeExport(name, read)` | `stitch` in REGION_PRESET_KEYS + transform; kit.ts `export const freeze` | freeze |
| `specifier(spec, collect)` | FEDERATION_SPEC, compiler/flags.ts collector, content check | flags, federation, content |
| `buildCache(name)`, `hash()` | content importing BuildCache + host createHash | content |
| `islandDeps` (read the island-deps handoff) | profiler/index reading island-deps virtual; content CSS handoff | profiler, content |
| `after(stage, fn)` (writeBundle / closeBundle legs) | profiler maps fill, flags manifest write | profiler, flags |

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

| Package | From | Notes |
|---|---|---|
| `@ogygia/core` | everything else, incl. the CLIENT nav (runtime/router.ts, `ogygia/router/client`) | `ogygia` re-exports it (Q4) |
| `@ogygia/router` | src/router (the SERVER router: `routes()`, `page`, `mount` hosts) | core imports none of it (checked); federation + profiler build on it; compiler's router prescan + router-css become its compile facet |
| `@ogygia/devtools` | src/devtools + src/profiler (MERGED, user 2026-10-31) | one plugin `devtools({ profiler })`: in-page panel + server profiler, each its own on-switch; profiler stays a lazy import; storage adapters as `/profiler/storage/*` subpaths; `@neodrag/svelte` peer moves here |
| `@ogygia/content` | src/content, Blocks.svelte, markdown macros | mdsvex, shiki, orama, bits-ui peers move here |
| `@ogygia/federation` | src/federation | |
| `@ogygia/flags` | flags.ts, src/flags | `/openfeature` subpath |
| `@ogygia/freeze` | src/freeze | adapters as subpaths (no npm deps today) |
| `@ogygia/testing` | src/testing | depends on devtools + profiler |
| `@ogygia/cli` | cli.ts, mcp.ts, perf/ | owns the `ogygia` bin; no MCP SDK dep today |

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
5. ~~Public or first-party~~ DECIDED: first-party only until the ports settle (user, 2026-10-31).
   Same door; docs make no stability promise to outside authors.
2. ~~Insights home~~ DECIDED: core subpath `@ogygia/core/insights` (user, 2026-10-31). Was: core vs its own
   `@ogygia/insights` package.
3. ~~Package names~~ DECIDED (user, 2026-10-31): short first-party names (`@ogygia/flags`,
   `@ogygia/devtools`, …; apps import them daily), no `plugin-` prefix. Third-party, later:
   `ogygia-plugin-*` + the `ogygia-plugin` npm keyword.
4. The main-package question. Option: `ogygia` = batteries included (depends on every `@ogygia/*`,
   maps today's option keys onto plugins, zero migration); `@ogygia/core` = lean. Bundles are the
   same either way; only install size differs.

## Also found while mapping (small, unrelated fixes)

- compiler/driver.ts:218 sweeps modules importing `'ogygia'`, but compiler/flags.ts:70 resolves only
  `'ogygia/flag'`.
- `yaml` sits in tsdown neverBundle as a content dep; nothing imports it.
- compiler/macros/pipeline.ts:121 says the markdown renderer is "dynamically imported"; it is static.
- `ogygia/content/tab-group` is referenced (driver.ts:1468, region/transform.ts:844) with no export.
- `og.source` macro import is injected into client modules too (no ssr gate).
