# The ogygia compiler — a design, not a patch

ogygia already **is** a compiler. It lowers a high-level authoring surface — import attributes,
`import.meta.og.*` macros, `region()`, content collections — into low-level artifacts: rewritten host
modules, per-island virtual modules (entry / wrapper / binding), and whole-program artifacts
(manifests, island-deps, a feature-selected runtime, the transport map). Today that compiler is
smeared across `vite/` (~4,750 lines) and shaped like a plugin. This note designs it as what it is: a
compiler with phases, an IR, a driver, and a linker — with Vite demoted to **one adapter** that drives
it.

**Hard constraint: zero runtime change.** Every emitted byte stays identical. This is a pure
re-architecture of correct logic into a compiler shape, guarded by `internal/bench/compiler-stress.ts`
(deterministic digest) + the full unit + e2e suites. Nothing about the output, the runtime, the
server, or the content-render trees changes.

## The pipeline

A file flows through phases; the whole program is assembled by the linker. Each arrow is a pure
function except where marked stateful.

```
                 ┌─────────── per file (pure) ───────────┐
 source ──▶ Parse ──▶ Analyze ──▶ Lower ──▶ Emit ──▶ IslandDescriptor[]
                        (AST)      (IR)      (code)   (artifacts)          │
                                                                          ▼
                                                       Link (stateful) ──▶ Program
                                                       dedup by id, whole-program artifacts
```

1. **Parse — front-end.** Turn a file into what analysis needs. `.svelte` → svelte AST;
   `.ts`/`.js` → oxc AST; `.svx`/`.md` re-enter as `.svelte` through the markdown preprocessor. Plus
   the string-aware macro **scanner** that finds `import.meta.og.*` calls without a full parse (the
   cheap-bailout path). No file ever reads another file.

2. **Analyze — read AST → IR.** A pure "what does this file declare" pass: region marks (import
   attributes, normalized), `asRegion` / `region()` call sites, the csr tri-state, free-var captures,
   macro invocations with their literal args, content-collection definitions. Output is `FileIR`, a
   plain data structure. *(Today this is fused with Lower inside `transformHost`; see migration.)*

3. **Lower — IR → rewritten source.** From the IR, rewrite with MagicString: import→binding rewrites,
   `asRegion` const→hoisted import, macro expansion (code/md/bake/wire/loader/regions → inlined
   results), csr-reset injection. Output: rewritten code + `IslandDescriptor[]` (the islands this file
   mints, each carrying a **content-hashed id**).

4. **Emit — codegen per island.** Each `IslandDescriptor` → its virtual-module sources: the entry
   (component re-export), the wrapper (`.svelte` rendering `<ogygia-region>`), the binding legs (SSR
   signer + client metadata). Pure functions of the descriptor.

5. **Link — whole program (the only stateful phase).** A `Program` accumulates every file's
   `IslandDescriptor[]`, **dedups by id**, and generates the whole-program virtual modules: client
   manifest, server manifest, island-deps map, feature-selected runtime entry, transport manifest. The
   linker knows about all files — but only through their descriptors, never their sources. It is a
   deterministic reduction.

## The IR is the seam

Two data types are the whole contract between phases:

- **`FileIR`** — Analyze's output, Lower's input: the marks, macro calls, and call sites in one file.
- **`IslandDescriptor`** — Lower's output, Emit's + Link's input: one island's identity, component
  path, export name, schedule, kind, held/server flags. This is the ONLY thing that crosses the
  file boundary. Cross-file knowledge flows one way: source → descriptor → Program.

The **content-hashed id** (`regionId(regionIdentity(comp, mark))`) is the join key. It is why a blind
per-file front-end and a dumb cross-file reducer stay decoupled: two files that mark the same
component the same way independently mint the **same id**, and the linker collapses them. No file
needs to know what another file did — the id does the joining.

## The driver

`compiler/driver.ts` is the compiler's public API and the session that holds the `Program` + the
resolved context:

- `transform(source, id)` → parse ▸ analyze ▸ lower ▸ emit, register the descriptors into the
  `Program`. Returns `{ code, map }`.
- `emit(virtualId)` → serve a per-island artifact (from its descriptor) or a whole-program artifact
  (from the `Program`).
- `invalidate(id)` → drop a file's descriptors from the `Program`, ready for re-`transform` (HMR).

The driver is bundler-agnostic. It never imports Vite. That independence has a payoff beyond
tidiness: **a future REPL / playground is just a second adapter over the same driver.** Feed it source
under a synthetic id, run parse ▸ analyze ▸ lower ▸ emit in a worker (no bundler needed), and render
the left→right view — input source on the left, and on the right not only the rewritten `{ code }` and
the emitted island artifacts, but the `FileIR` and `IslandDescriptor[]` themselves. That IR view is the
"reasoning" layer that makes the compiler legible: you see the *marks and descriptors* a file lowers
to, not just its output bytes. Keeping the driver Vite-free is therefore a design goal, not only a
cleanliness one — it is what makes that tool a thin shell instead of a reimplementation.

## Classes carry the state

State has an owner. Where there is long-lived or ephemeral **state + the behavior over it**, it is a
class — not for ceremony, but because a bag of state and its operations belong together. Pure
transforms of data stay functions.

- **`Compiler`** (the driver) — the long-lived session. Holds the `Program`, the `CompileCtx`, the
  transform cache. `compiler.transform(source, id)` / `.emit(virtualId)` / `.invalidate(id)`. This
  object *is* the compiler's public API.
- **`Program`** (the linker / island graph) — the long-lived cross-file state: the descriptor
  registry, `entryOf`, `regionKinds`. `program.register(descriptors, hostId)` / `.unregister(hostId)`
  / `.entry(iid)`, and the whole-program codegen (`clientManifest()`, `serverManifest()`,
  `islandDeps()`, `runtimeEntry()`) reads it. One instance per `Compiler`, never module-global — so
  Kit's throwaway plugin instance is a different `Program` and can't leak.
- **`FileCompilation`** (per file, ephemeral) — the compilation unit for one file, and the biggest
  win of the whole rewrite. `transformHost` today threads ~30 locals — the AST, the marks map,
  `islands_by_id`, the MagicString, the rewritten-nodes set, the free-var sets — through nested
  closures. As a class those become `#fields`, and the phases become methods over shared `this`:
  `#analyze()` → `#lower()` → `#emit()` → `result()`. A fresh instance per file, discarded after, so
  it stays **pure per file**: the class organizes ephemeral state, it never holds cross-file state.
- **`CompileCtx`** — the resolved config plus its derived accessors (`islandVirtualId(iid)`,
  `wrapperPathFor(...)`, dev/ssr flags). A class with getters, constructed once from `OgygiaOptions`.

Pure leaves stay functions: `regionId` / `strategyKey` (identity), the macro lexer/scanner, the
`emit` codegen (`descriptor → source string`). They own nothing across calls; a class there is noise.

The test: **does it own state that outlives one call, or ephemeral state shared across several
steps?** → class. **Is it `data in → data out`?** → function. Turning `FileCompilation` into a class
is part of the deep `region/` stage — a mechanical reorganization of the same bytes (locals → fields,
closures → methods), so it must stay byte-identical or stop.

## The Vite adapter

`vite/` becomes thin — it only maps bundler lifecycle to driver calls and owns the things that are
irreducibly Vite (`this.emitFile`, `this.resolve`, the dev server):

| Vite hook | does |
| --- | --- |
| `config` / `configResolved` | `OgygiaOptions` → `CompileCtx`, construct the driver |
| `resolveId` | virtual ids, injected-import resolution (`PKG_ROOT`, no `this.resolve` — see the 0.7.0 sub-package fix), `$app/*` shims |
| `transform` | `driver.transform(code, id)` by file type |
| `load` | `driver.emit(id)` |
| `buildStart` | scan the corpus, feed `.ts`/`.js` region files through `driver.transform` up front (server-manifest must exist before an endpoint is hit) |
| `handleHotUpdate` / `configureServer` | `driver.invalidate` + full-reload decisions |
| `generateBundle` / `writeBundle` / `renderChunk` | island-deps handoff, island sourcemap rewrite, chunk emit |

## Module tree

Dependency flows one way: `parse` ← `ir` → `region`/`macros`/`content` → `link` → `driver`; the
adapter depends only on `driver`.

```
compiler/
  driver.ts          session: transform / emit / invalidate; holds Program + ctx
  program.ts         the cross-file graph: register + dedup descriptors, whole-program state
  ctx.ts             the resolved CompileCtx (from OgygiaOptions)
  ir.ts              FileIR, IslandDescriptor, RegionMark, MacroCall
  ids.ts             virtual:ogygia/* ids + islandVirtualId + RESOLVED

  parse/             front-end: svelte.ts, oxc.ts (og-parse), scan.ts (og-lexer + og-extract)

  region/            the core region language
    analyze.ts       marks / asRegion / region() → IR
    lower.ts         IR → rewritten source
    emit.ts          descriptor → entry / wrapper / binding sources
    identity.ts      regionId / regionIdentity / strategyKey  (the join key)

  macros/            import.meta.og.* family: code.ts, bake.ts, wire.ts, dollar.ts, store.ts, dedent.ts

  content/           collections: regions.ts (glob registry), loaders.ts, git.ts, transportables.ts

  link/              whole-program codegen: manifest.ts, server-manifest.ts, island-deps.ts,
                     runtime-entry.ts, transport.ts, caps.ts (sign/secret/rate-limit/session/ttl)

  dev/               hmr.ts (reload decisions), dev-hmr.ts (client), css-scope.ts

  fouc-css.ts  free-vars.ts  standalone.ts     (existing, slotted in)

vite/
  index.ts           the adapter: hooks → driver (target < 500 lines)
  sourcemaps.ts      the island-sourcemap sub-plugin
```

## Invariants

- **Front is pure and file-local** (parse → analyze → lower → emit). No file reads another. The
  `Program` (link) is the only stateful thing, and it is a deterministic reduction of descriptors.
- **Byte-identical output.** Same rewritten code, same virtual sources, same chunk names. Guarded by
  the compiler-stress digest + the suites.
- **The id is the join key.** Cross-file dedup happens by content-hashed id in the linker, never by the
  front-end knowing about other files.
- **Per-instance Program.** Constructed in the plugin factory closure, never module-global — Kit's
  throwaway plugin instance can't leak into the real build.
- **No new parse pass.** The pipeline reuses one parse per file.

## Migration — grow the skeleton, relocate byte-for-byte

Build the compiler's spine first, then move the (correct) logic into its phase modules unchanged. After
**every** stage: `pnpm run check` → `pnpm test` → `pnpm run e2e` → `node internal/bench/compiler-stress.ts`
(digest **unchanged**). Commit per stage so any regression bisects to one move.

1. **Backbone: `driver.ts` + `program.ts` + `ctx.ts` + `ids.ts`.** Lift the plugin's `registry` +
   `register`/`unregister` into `Program`; the transform/load dispatch into `driver`. The plugin now
   calls the driver. Behavior identical — this only relocates the orchestration. Do it first so every
   later move has a home.
2. **`link/`** — extract the whole-program source emitters from the `load` hook into
   `(program, ctx) => string` functions; `load` becomes `driver.emit`'s dispatch table. Trivial
   emitters first (secret/sign/ttl), the big three last (island-deps, manifest, server-manifest).
3. **`macros/` + `content/`** — move `vite/og-*.ts`, `regions.ts`, `loaders.ts`, `git.ts`,
   `transportables.ts`, `dedent.ts`, `standalone.ts`, `runtime-entry.ts` verbatim; fix the ~15 import
   sites. Biggest line move, lowest risk — already standalone modules.
4. **`dev/` + pure helpers** — relocate the HMR-decision fns, `dev_hmr_client_source`,
   `derive_css_scope_owners`, `mpaSpeculationRules`, `collectIslandDepModulepreloads`,
   `rewrite_island_sourcemap_sources`, `runtime_content_hash`. Several are already `export`ed +
   unit-tested; pure relocation.
5. **`region/` split (the deep one, LAST).** Carve `transformHost` / `transformTsRegions` into
   `analyze.ts` (AST → `FileIR`) + `lower.ts` (`FileIR` → code) + `emit.ts` (descriptor → sources),
   with `FileIR` as the seam. Do this **only if it stays byte-identical**; the IR is an internal
   refactor of a combined pass, and this is the correctness-critical code. If a clean split risks a
   byte, stop: keep the transform fused as `region/transform.ts` (still a proper phase module) and
   leave the analyze/lower IR split as a follow-up. The design tolerates a fused front-end; it does not
   tolerate a changed byte.

## Aspirational vs immediate

The **driver / program / adapter split** and the **module tree** (parse / region / macros / content /
link / dev) are the immediate, high-value re-architecture — they turn a plugin-shaped blob into a
compiler with a spine, and they are all relocation, near-zero risk. The **explicit IR** (analyze/lower
split inside `region/`) is the finishing move: it makes the front-end read like a textbook compiler,
but it earns its place only when it lands byte-identical. Ship the spine first; refine to the IR when
it's safe.

## Sequencing

Do this on `passage` after its history is settled against `main` (0.7.0). A large file-move rebased
under 24 commits is painful; land 0.7.0 first, then grow the compiler once, on the released base.

## Implemented (2026-08-20)

Landed on `passage` as 12 byte-identical commits, each guarded by `tsc` + 1003 unit tests + 48 e2e
checks + the compiler-stress digest (unchanged throughout: **`e27d5db6·ad66d3f3`**). `vite/index.ts`
went **2752 → 2063** lines.

- **The spine (all three classes):** `compiler/program.ts` (the `Program` cross-file linker — registry
  + register/unregister/note_runtime_mark + the feature-mark bag; per-instance, never module-global),
  `compiler/ctx.ts` (`CompileCtx` — the resolved config + naming accessors), `compiler/driver.ts`
  (`Compiler` — holds Program + Ctx + transform cache; `transform()` is the Vite-free front-end; the
  adapter binds the Ctx at the end of `configResolved`). `compiler/ids.ts` holds the virtual-id vocabulary.
- **The module tree:** `parse/` (oxc + scan = og-lexer⊕og-extract), `macros/` (code/bake/wire/dollar/
  store/dedent), `content/` (regions/loaders/git/transportables), `link/` (manifest/server-manifest/
  island-deps/runtime-entry/transport/caps/router-config/speculation — the whole-program emitters, each
  a pure `(…) => string`), `dev/` (hmr/dev-hmr/css-scope), `region/` (identity + emit + the fused transform).
- **The adapter split:** `vite/sourcemaps.ts` (the island-sourcemap sub-plugin as a factory). The
  adapter still owns the irreducibly-Vite orchestration (resolveId, the `load` dispatch, buildStart
  prescan/emitFile, generate/writeBundle, handleHotUpdate) — `run_transform` is now an alias for
  `compiler.transform`.

### The region/ split — the SAFE halves landed, the IR seam deferred

`region/` now holds three modules: `identity.ts` (the join key — strategyKey/regionIdentity/regionId),
`emit.ts` (the `descriptor → source` codegen — entry/wrapper/binding-leg emitters, pure leaves), and
`transform.ts` (still the FUSED analyze+lower pass — `transformHost` / `transformTsRegions`).
`regionBindingVirtualId` moved to `ids.ts` to keep a one-way flow (no emit↔transform cycle).

- **The analyze/lower IR split is DEFERRED** — assessed against the code (read in full) and found
  STRUCTURALLY not cleanly separable, not merely risky. A clean `analyze() → FileIR → lower()` seam
  needs FileIR to be DATA, but the lower half (after `new MagicString` at ~line 1333) CALLS closures
  defined in the analyze half: `marked_import_referenced` (used at ~1489) and `ast_refs_local` (used
  at ~1667/1671/1673). Closures can't ride in a data bundle, so the seam would have to move those
  closures across and re-capture `instance_body`/`module_body`/the live `ast` — a semantic restructure
  of the most correctness-critical code that risks a byte, exactly the "stop and keep fused" case the
  invariant names. On top of that, ~20 mutable locals (imports / marked_components / as_regions /
  synthetic_export / has_island_children / …) cross the boundary. `transformHost` +
  `transformTsRegions` stay FUSED in `region/transform.ts`. `ir.ts` (FileIR/RegionMark/MacroCall) +
  `parse/svelte.ts` land with that split only if it is ever done byte-identically. `IslandDescriptor`
  already lives in `program.ts`.
- **`driver.emit()` / `driver.invalidate()`.** Only `driver.transform()` was pulled Vite-free; the
  emit dispatch + HMR invalidation stay in the adapter (they read `options.ssr`, `this.emitFile`,
  the dev server) — a follow-up if the REPL adapter ever needs them driver-side.
