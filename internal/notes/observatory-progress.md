# Observatory + Devtools — overnight progress (2026-08-22)

Built autonomously overnight on the `devtools` branch. Everything below is committed and the **full
e2e suite is green (51/51 checks)**. Main code is untouched on your backup branch.

## GOOD MORNING — read me first

A dev server is **already running for you** on **http://localhost:5195/observatory** (started with
`OGYGIA_DEVTOOLS=1 pnpm --filter playground dev`). Open it and play. The Observatory is now a
full multi-file REPL that **compiles AND runs** an ogygia app entirely in your browser.

**The preview has THREE modes (top-right toggle):**

- **live** — type an app, it renders AND is interactive (a fresh client mount; the counter works).
- **x-ray** — the boundary lens: see which DOM is a live island vs dead server shell, and **watch
  each island wake on its real schedule** (load now, click Menu, scroll to Chart; the lake stays
  frozen). Try the **"wake demo"** preset here.
- **islands** — 👑 THE CROWN JEWEL: the app renders with genuine `<ogygia-region>` shells and the
  **page's own real ogygia runtime hydrates them** lazily, on their real schedules. This is the actual
  framework running in the preview — not a stand-in. Counter (load) hydrates live, Menu (interaction)
  sleeps until you click it then wakes + replays the click, Chart (visible) wakes on scroll. And a
  **live runtime-events panel** streams the real lifecycle off the devtools bus (Rung 0): per island
  `connected → scheduled (schedule) → ⚡ woke → hydrating → ✓ hydrated (Nms)`.

Plus two read-outs under every preview: the **byte ledger** ("you ship X, plain Kit ships Y" — the
demo: −75% JS) and the **wire inspector** (the exact props that cross to each island).

Also new tonight: the whole thing now works in **dev** too (it previously only ran in the prod build —
two dev-only module-loading bugs fixed). ~27 commits, full suite green.

- **`/observatory`** — the ogygia compiler + REPL running **in your browser**.
- **Any page** — bottom-right **og devtools** button (Alt+O): one window, six tabs
  (Lens / Bytes / Wire / Hub / Nav / Timeline).

## The Observatory (Rung 1 of the notes — the browser compiler) ✅

The **actual `transformHost`** — not a re-implementation — runs client-side in a Web Worker and shows
the full pipeline, live as you type:

1. **source** (a `.svelte` with island marks)
2. → **ogygia transform** (real md5 region ids, real `virtual:ogygia/region|wrapper` rewrites)
3. → **generated modules** (expand any island to see the real wrapper + entry source the driver serves)
4. → **svelte compile** (the server JS that ships)

Also: island map with real ids, SSR/client leg toggle (when they differ), example presets, and a
pipeline timing (~90ms). All strategies resolve correctly (island / lake / server-hole / held / live).

### How it was made to work (the hard part)

Your call — keep rolldown (bake is first-class), use **rolldown-browser** for parsing so the oxc AST
is byte-identical — was right. The chain:

- **Parser DI seam** in `compiler/parse/oxc.ts` (`set_parser`). Node is untouched (still rolldown/utils,
  265 transform tests green). A browser build injects rolldown-browser's oxc.
- **rolldown-browser WASM** (`@rolldown/browser@1.2.2`, same version): browser binding variant,
  lazy-loaded, warmed once so `parseSync` works synchronously (what the transform needs).
- **COOP/COEP** cross-origin isolation (the WASM uses SharedArrayBuffer + WASI worker-threads).
- **vite-plugin-wasm** (main + worker pipelines).
- **SSR-safe node shims** (client only, SSR keeps real builtins): a tiny self-contained **md5** for
  `node:crypto` (region ids match the build), path-browserify, inert `node:fs`/`node:module`.
- A minimal **`ogygia/internal/compiler-browser`** entry so the node-heavy driver/Program/CompileCtx
  never get pulled into the browser.

Files: `apps/playground/src/lib/{Observatory.svelte, observatory.worker.ts, rd-process-shim.ts}`,
`apps/playground/src/routes/observatory/`, `apps/playground/observatory-node-shims.ts`,
`apps/playground/observatory-crypto-shim.ts`, `apps/playground/vite.config.ts`; `e2e/observatory.ts`.
Library: `packages/ogygia/src/compiler/{parse/oxc.ts (set_parser), browser.ts}`.

## The Devtools (Rung 0 event layer + Rung 5 instruments) ✅

- **Event layer** (`ogygia/devtools`): typed bus + schema v1 behind the `__OGYGIA_DEVTOOLS__` gate.
  Client AND server realms unified in one fingerprint-correlated stream (server events ride a
  side-channel the handle injects; the client ingests them). Tree-shakes to **zero** when off (proven
  in both client and server output).
- **One devtools app** (mounted Svelte), six tabs:
  - **Lens** — tints the page by region kind; hover fuses server props + client hydrate by fp.
  - **Bytes** — real over-the-wire JS per island + the runtime chunk.
  - **Wire** — what the server shipped (props payloads, seeds, capabilities).
  - **Hub** — shared-state registry; shows islands reuniting on one live instance.
  - **Nav** — per-nav reconcile decisions (keep/patch/mount/remove) + timing.
  - **Timeline** — client wake/hydrate events on a time axis.

## EXECUTION — the app now RUNS in the browser ✅ (overnight, second iteration)

The Observatory is a **multi-file REPL** that compiles AND runs your app, entirely client-side:

- **Multi-file editor** — a file map (App.svelte + Counter.svelte + …) with tabs, add/remove, and
  share-via-URL of the whole map (`#files=`). The in-worker linker resolves `./X.svelte` imports across
  the map, so islands render as their REAL components.
- **Rendered (SSR)** — the worker compiles every file with svelte (server), evals them via a tiny
  in-worker module linker (ESM→CJS `new Function`), and `render()`s the app to HTML.
- **INTERACTIVE** — the preview mounts the CLIENT-compiled app on the main thread (a runtime
  `svelte/internal/client` import + a main-thread linker), so it actually runs: the counter button
  works. Type an app → see it render AND run.

Full loop: **source → ogygia transform → svelte compile → link → mount**, no bundler, no server.

## INSTRUMENTS over the running app (overnight, third iteration) — the ogygia thesis, made legible

The preview now carries three read-outs, all computed from the same in-browser compile + render — the
whole islands value-prop, visible on whatever app you type:

- **Byte ledger** (Rung 5.3) — "ogygia ships X, plain Kit ships Y." Compiles every component to client
  JS; on csr=false ogygia ships ONLY the waking islands, plain Kit (csr=true) ships all of them. Demo:
  ogygia **518 B (1 island)** vs plain Kit **2.1 KB (4 components)** = **−75% JS**, with a per-file
  breakdown naming why each ships or stays free server HTML.
- **Boundary lens** (Rung 5.1) — a **live / x-ray toggle** on the preview. In x-ray every marked region
  is bracketed by an invisible boundary and tinted by strategy (island teal, lake amber, server hole
  purple, held-raw orange) with a `wake · bytes` tag; the unmarked shell greys out. You SEE a couple of
  lit islands floating in dead server HTML.
- **Wire inspector** (Rung 5.2) — the real props each island RECEIVES, devalue-encoded — exactly what
  crosses by value. children (a region snippet) and functions never cross; `$$slots` is stripped. Demo:
  Counter gets `{start: 3}` (15 B); Prose receives only children → "no props cross".
- **Wake visualizer** (toward Rung 5.5) — in x-ray, each island starts cold and lights up when it wakes
  on its REAL schedule, driven by real browser primitives: `load` next frame, `idle` on
  requestIdleCallback, `visible` on a real IntersectionObserver (scroll the preview), `interaction` on
  the first pointer/focus inside; lakes never wake (frozen). Stamped "⚡ woke +Xms · N B JS". New "wake
  demo" preset (load / interaction / visible / lake) + a "replay wakes" button. Zero runtime coupling —
  the ogygia lazy-hydration thesis, playable.

Every instrument has an e2e assertion. Suite is green.

## THE CROWN JEWEL — real island machinery in the preview ✅ (overnight, DONE)

The "islands" preview mode runs the ACTUAL ogygia runtime, no iframe, no service worker:

- The worker renders the app with genuine `<ogygia-region>` shells — each island's isolated SSR (the
  hydration-matching HTML) + a devalue `<script data-ogygia-props>` sidecar — wrapped in `<ogygia-slot>`.
- The main thread rewrites each region's `__ISLAND__:<file>` placeholder entry to a **blob** of the
  client-linked component (stashed on a global the blob re-exports, so it shares the page's svelte
  instance), then injects it into the preview.
- The **page's own ogygia runtime** upgrades the custom elements and hydrates them lazily, on their
  real schedules. Verified: Counter (load) hydrates interactive, Menu (interaction) sleeps then wakes +
  replays the click, Chart (visible) wakes on scroll. Zero errors.

**The two unlocks** (both spiked/verified before building):
1. A bare injected `<ogygia-region>` nested in the Observatory's own awake island is SKIPPED by the
   runtime's nested-region rule (it rides the parent's hydration). Wrapping it in `<ogygia-slot>` hits
   the **adopted-slot exception** (`in_adopted_slot`), so it self-runs. (Spike: bare → `data-nested`;
   slotted → self-runs + imports its entry.)
2. `island_module_url` passes `blob:`/absolute-scheme entries through untouched, so a blob entry that
   re-exports a main-thread-linked component hydrates against the shared svelte instance.

This is the endgame vision from the top of this file — "the actual framework, both halves in-tab" —
realized, and it turned out an iframe/SW was unnecessary because the page already hosts the runtime.

## What's NOT done (smaller remainders)

- The islands-mode preview reuses the page's single runtime; it does not (yet) exercise server islands
  (`render: 'deferred'`), live regions, or nav/reconcile in-preview — those need the mini-Kit server
  realm (Rung 3/4). The instruments for those (Nav lab, Hub inspector, Timeline over real events) are
  still the devtools-panel versions, not wired into the Observatory preview.
- **Server-realm devtools events beyond the page render** (deferred-hole timing, batch) — schema-defined,
  not yet emitted.
- The SSR/client leg toggle is wired but the host rewrite is leg-invariant, so it rarely shows; the real
  leg difference lives in the generated modules.

## Commits (newest first)

`git log --oneline` on `devtools` — the Observatory arc is 10 commits from
`b6f1b2e` (v0 + parser DI seam) → `202eb41` (the real transform runs 🎉) → the compile step + polish.
