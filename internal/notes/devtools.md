# Devtools → Observatory — the event layer, the in-browser REPL, and real-app devtools

**One sentence:** ogygia grows a UI-agnostic **devtools event layer** (typed events keyed on the
identities the framework already mints — region fingerprints, hub Ref ids, island entry ids), and
every product is a listener over it: first our own e2e, then the **REPL** (the whole framework —
server AND client — running in one browser tab with the boundary made observable), and finally a
**Vite devtools plugin** for user apps. Build the layer once; nothing is REPL-only.

## The vision (endgame)

A tab where you type a multi-file app (pages, layouts, islands) and next to it the REAL ogygia runs:
a worker plays the server (`svelte/server` + our injections → real HTML with `<ogygia-region>`,
props side-channels, fingerprints), an iframe plays the browser (service worker serves the compiled
client chunks and answers `/__ogygia/*`), and instruments show what no REPL can: which DOM is dead
shell vs live island, what bytes shipped, when each region woke and why, what crossed the wire, what
the reconciler kept on nav, one live view of the hub. Not a simulation — the actual framework, both
halves in-tab, with the seam instrumented.

**Why not WebContainers (considered, rejected):** real node in-tab makes the stack opaque again
(instruments can't see into it), costs boot seconds + COOP/COEP hosting, and everything we'd build
to see inside it is the event layer anyway. Doing it ourselves: instant boot, everything reusable,
and we already own every hard piece (DI'd compiler, browser-safe `svelte/server`, `$app/*` shims).

**Why transform+link, not output-only:** the value is the *linked* picture — click an injected
import in a transformed host and land in the virtual module the driver serves for it.

## Principles

- **The layer is the product.** REPL, devtools plugin, and trace capture are sinks. No UI opinions
  in ogygia itself.
- **Identity is the spine (again).** Events carry the ids that already exist (`data-og-fp`, Ref
  `i`, entry iids). A region's server render, wire payload, client wake, and nav-reconcile decision
  correlate by id with zero new identity machinery. This is what turns a log into a story.
- **Zero-cost when off.** Emits compile out via the proven define pattern
  (`__OGYGIA_DEVTOOLS__`, typeof-guarded like `__OGYGIA_SERVER_DELTA__`). Dev: on by config.
  Prod: only when the build asks (the REPL's prod switch); user apps never ship it by default.
- **Every rung ships alone.** No rung depends on a later one to be useful.
- Naming: internals snake_case, public surface minimal (`ogygia({ devtools })` + an
  `ogygia/devtools` subpath for types/sink helpers).

## Rung 0 — the event layer (`ogygia/devtools` core)

The only rung that touches the framework. Everything after is a consumer.

- **Emitter:** `emit(event)` behind the define; a no-op export when off so call sites DCE.
  Ring buffer + pluggable sinks: `postMessage` (REPL), WS (vite plugin, later), buffer→JSON
  (traces), console (debug).
- **Schema v1** (JSON-serializable, versioned; sizes always, payload bodies lazy):
  | Domain | Events (first cut) |
  |---|---|
  | compile | island discovered (strategy, csr decision, iid, entry/wrapper), bytes per emit |
  | server | region rendered (fp, mode, ms, html/props bytes), seeds injected, capability minted, server-delta skip |
  | wire | props payload, context bridge, frame batch, `x-ogygia-known` sent |
  | runtime | features loaded, region connected, wake scheduled/fired (reason), hydrate ms, interaction replay, lake lift/restore |
  | hub | mint, resolve hit/miss, watch fired, dispose_scope/ids |
  | nav | nav start/finish, reconcile decision per region (keep/patch/mount/remove), fallback swap |
- **Emit-point audit first:** walk runtime/core, reconcile, router, ref, Region.svelte,
  server/region-endpoint, hooks — list every seam, THEN write the schema. Don't invent events the
  code can't cheaply produce.
- **Trace format:** buffer serializes to a JSON trace; attachable to bug reports, replayable in the
  REPL later. (CPU-profile energy, but for the islands lifecycle.)
- **Proof-of-value before any UI:** convert 1–2 flaky DOM-poking e2e checks (interaction.ts) to
  event-driven assertions. The bus pays for itself in our own tests first.
- Profiler stays separate for now; its events can join the bus later.

## Rung 1 — the browser compiler (the observatory, no execution)

- Package `Compiler`+`Program`+`CompileCtx` for the browser. Transform is already DI'd
  (`readFile`, `pathModule`, `routeCsr` injected).
- **fs audit (the real work):** `kit.ts`, driver prescan, `fouc-css.ts`, `macros/bake.ts`,
  `content/regions.ts` import `node:fs` directly → route through one virtual-FS module (in-memory
  map) aliased at build; `path` → path-browserify.
- Content pipeline (markdown/shiki/mdsvex) OUT of the first build (heavy; later layer, not a cut —
  both are browser-capable). Verify it tree-shakes; if not, split the entry.
- `.ts` files: ts-blank-space or sucrase (tiny). Svelte 5 handles `lang="ts"` natively.
- `routeCsr` from our own `read_csr` over the typed `+page.ts`/`+layout.ts` (regex, browser-fine).
- **Ship it:** editor left, right side = transformed hosts + every virtual module the driver serves,
  click-through from injected import → virtual, source↔output diff, SSR/client leg toggle.

## Rung 2 — the linker + client sandbox

- Enumerate + `load` every virtual id the transforms reference; `svelte/compiler` compiles every
  output twice (ssr true/false — driver already supports per-call `ssr`).
- Bare imports (`svelte`, `devalue`, `ogygia/internal`) prebundled once at lab build; import map.
  User modules → service-worker URLs under the real naming (`og-region.*`, `og-runtime.*`).
- Iframe sandbox + SW serving modules. Milestone: islands hydrate against hand-fed HTML.
- Kill-JS toggle (SW 404s the runtime) — progressive enhancement, proven live.

## Rung 3 — the server realm (mini-Kit; the only new invention)

- A worker: compose layout chain + page as plain Svelte components, render via `svelte/server`,
  apply our HTML injections.
- Head starts: `$app/*` shims already exist (`src/shims`, built for islands);
  `hooks.ts`.`inject_client_seeds` may be reusable with a synthetic RequestEvent —
  **investigation #1**. `server/hmac.ts` node:crypto → WebCrypto — **audit #2**.
- Milestone: the loop closes. Type → SSR → hydrate → click.

## Rung 4 — the wire, live

- SW intercepts `/__ogygia/*` + page navs → MessageChannel → server realm. Real server islands,
  frames, batch streams, single-flight, server-delta nav — all in-tab, all inspectable because we
  own both ends of the seam.
- Prod switch: rebuild the sandbox with prod defines (server-delta, caches behave as shipped).

## Rung 5 — instruments (each = a bus listener + small UI; order by wow-per-effort)

1. **Boundary lens** — overlay tinting dead shell vs islands vs lakes; hover → identity, schedule,
   bytes. (Also works against real apps later — it reads the bus + DOM.)
2. **Wire inspector** — every crossing decoded, with sizes.
3. **Byte ledger** — per-island JS shipped; "as plain Kit" comparison = recompile same app with
   routeCsr=true (same compiler, honest number).
4. **Nav lab** — per-region reconcile decisions live; server-delta header contents.
5. **Timeline** — wake/hydrate events on a scrubber; replay.
6. **Hub inspector** — live Ref registry: mints, resolver edges (two islands, one cart, one
   instance), dispose reaping on nav.

## Rung 6 — REPL shell, share, docs

- CodeMirror 6 multi-file editor, route-aware file tree.
- Share URLs: file map compressed into the hash. Scenario format = file map + focused instrument +
  notes. Docs embed frozen scenarios — every concept gets a "see it live"; the lab becomes the
  docs' proof system. Lives in apps/docs (route TBD; `/lab` currently holds the passage test hub).

## Rung 7 — the spinoff: `ogygia/devtools` Vite plugin (real apps)

- Same bus over WS/overlay in the user's own dev server; boundary lens + hub inspector + wire
  inspector against THEIR app. The profiler precedent: drop-in, zero-config.
- Trace capture in the field → replay in the REPL.

## Rung 8 — AiTools (AI as a first-class devtools consumer)

> **SHIPPED (v1):** `npx ogygia mcp` — a hand-rolled stdio JSON-RPC MCP server
> (`packages/ogygia/src/mcp.ts`, dispatched from the CLI, built to `dist/mcp.js`). Zero runtime deps
> beyond ogygia's own compiler (Playwright is an optional peer, only for `ogygia_debug`). Five tools:
> - **Compile-side** (real `transformHost` in plain Node — no browser/WASM, oxc auto-loads):
>   `ogygia_compile` (island map + rewritten host), `ogygia_islands` (map alone), `ogygia_check` (runs
>   the transform + reports any `[ogygia]` rule violation — the static half of `check_invariants`),
>   `ogygia_explain` (prose per island — `explain_transform`).
> - **Runtime-side** (`get_region_story` / `get_events`): `ogygia_debug({ url })` drives a headless
>   browser over a REAL page, lets islands hydrate (scrolls for `visible`, optional `click` for
>   `interaction`), reads `window.__ogygia_devtools.trace()`, and renders the per-fingerprint story
>   (SSR → wire → connected → woke → hydrated, with ms) + invariant warnings (SSR'd-but-never-connected,
>   hydrate.failed). Requires the target app to be a devtools build (`OGYGIA_DEVTOOLS=1`). NOTE: server
>   (SSR) events carry the server process's clock, so relative ms is computed from CLIENT events only.
> - **SSR cost** (`ogygia_profile({ url })`): records N renders through `ogygia/profiler`'s
>   `<base>/page?p=<route>&format=json` (the profiler already emits a curated agent report — findings,
>   hot_functions, components, budget, memory, links) and digests it (verdict, p50, where-time-went minus
>   the profiler's own overhead, top functions/components). 404 on the base → prints the hooks.server.ts
>   wiring to add. Dev is dominated by Vite + instrument overhead (flagged); profile a prod build.
>
> **Wire it up:** `npx ogygia ai` (installs the skill + registers the server), or
> `claude mcp add ogygia -- npx ogygia mcp`. In THIS repo (unpublished) use the local path:
> `node packages/ogygia/dist/cli.mjs mcp`.
> **Still to add:** `get_wire_payloads`, `check_invariants` stream checks (below), `mark(label)` to
> segment a trace around an agent's own Playwright action; a WS bridge so `ogygia_debug` can attach to
> an already-open page instead of launching its own (the vite devtools plugin, Rung 7).

The bus is already AI-shaped (JSON, identity-keyed). What AI debugging needs on top — ordered by
"add now vs later":

- **Reasons in the schema (add NOW, rung 0):** events carry `reason` where the code knows it
  (`wake: 'visible'`, `hydrate-skipped: 'kit-hydrates-document'`, `reconcile: 'fp-match'`).
  Causality is what lets a model read a story instead of guessing; painful to retrofit.
- **Self-describing traces:** schema version + event glossary in the trace header — a model reads a
  trace cold, no source needed. The trace doc is the AI's manual.
- **MCP server** (ships with the vite devtools plugin): `get_events(filter)`,
  `get_region_story(fp)` (compile→SSR→wire→wake→nav for one id), `explain_transform(file)`,
  `get_wire_payloads`, `check_invariants`, `mark(label)` (segment the trace around an agent's own
  Playwright action). We don't rebuild browser automation — we make the framework's side legible.
- **Invariants engine:** framework laws as stream checks (SSR'd-but-never-connected, double wake,
  payload budget, delta-header-sent-but-full-rendered). AI's lint layer; humans get the same checks
  as devtools warnings free. Raw material exists: INVARIANTS.md + the e2e suite's encoded
  expectations.
- **Repro bundles:** scenario file-map + trace = one file; replayable headlessly in the REPL
  sandbox by an agent. Shared format with rung 6 scenarios.
- **The cookbook:** symptom → cause playbook wired into the ogygia Claude skill; every fixed bug
  deposits an entry (entry #1: islands paint-then-vanish + redundant warning → document-vs-host csr
  desync).

Payoff loop: agent connects to the dev server's MCP → region story names the bug in one turn; the
REPL grows an "ask AI" that ships scenario + trace.

## Risks / open questions

- `hooks.ts` reuse vs thin rewrite for the harness (investigation #1 — decides mini-Kit's shape).
- `node:crypto` in hmac (audit #2).
- Content-pipeline tree-shake out of the browser build (check early in rung 1).
- Event overhead discipline: ring buffer caps, sampling for high-frequency events (hub watch).
- Schema stability: version field from day one; the trace format is a public artifact eventually.
- Name for the whole thing (working title: Observatory). `/lab` name collision in docs.

## Sequence summary

0. Event layer + e2e adoption (in-framework, ships now)
1. Browser compiler + observatory UI (public artifact #1)
2. Linker + SW sandbox (islands wake)
3. Server realm (loop closes)
4. Wire live (navs/frames/server islands in-tab)
5. Instruments 1→6
6. Editor/share/docs scenarios
7. Vite devtools plugin
8. AiTools: MCP server + invariants engine + repro bundles + cookbook (reasons-in-schema lands in rung 0)
