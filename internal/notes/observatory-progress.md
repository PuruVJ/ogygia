# Observatory + Devtools — overnight progress (2026-08-22)

Built autonomously overnight on the `devtools` branch. Everything below is committed and the **full
e2e suite is green (51/51 checks)**. Main code is untouched on your backup branch.

## TL;DR — what you can look at

Run `OGYGIA_DEVTOOLS=1 pnpm --filter playground dev`, then:

- **`/observatory`** — the ogygia compiler running **in your browser**. Type a component; watch the
  real transform, the generated modules, and the svelte-compiled JS. This is the big one.
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

## What's NOT done (the honest remainder)

- **Execution** (Rungs 2–4): the pipeline compiles but does not yet EVAL + render. Making the compiled
  app actually run needs the linker + SW sandbox + a mini-Kit server realm in a worker. That's the next
  big lift.
- **Server-realm devtools events beyond the page render** (deferred-hole timing, batch) — schema-defined,
  not yet emitted.
- The SSR/client leg toggle is wired but the host rewrite is leg-invariant, so it rarely shows; the real
  leg difference lives in the generated modules.

## Commits (newest first)

`git log --oneline` on `devtools` — the Observatory arc is 10 commits from
`b6f1b2e` (v0 + parser DI seam) → `202eb41` (the real transform runs 🎉) → the compile step + polish.
