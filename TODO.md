# sk-islands — status & remaining work

## Landed & verified this round (build + dev, real browser)
- **No csr=true route required.** When Kit skips its client build (every route `csr=false`),
  the plugin runs its OWN client build (`src/vite/standalone.js`) into Kit's client output
  dir, so islands + runtime + remote client are bundled and adapters pick them up. When a
  `csr=true` route exists, islands ride Kit's own client build (unchanged). Both paths proven.
- **Single authoring syntax:** the import attribute only —
  `import Comp from './Comp.svelte' with { island: 'visible' }`. The `<Island>` wrapper and
  `*.island.svelte` filename convention were removed from the public API (the transform still
  emits a private wrapper via `sk-islands/internal`). Per-use strategy = import the same
  module twice with different attribute values (verified).
- **Opt-in SPA router:** `<ClientRouter/>` (from `sk-islands`) emits a `<head>` marker; the
  runtime starts the router only when present, and hands over to a real document load when
  navigating to a page without the marker (mixed sites verified).
- **Mixed mode:** an island on a `csr=true` page single-hydrates (Kit hydrates it; our runtime
  detects Kit's bootstrap and skips), stays interactive, warns in dev, and the `$app/*` shims
  never leak into normal components (real `$app/state` works alongside).
- **Vite 8 / Rolldown:** upgraded to `vite@8.2.0` + `@sveltejs/vite-plugin-svelte@7.2.0`.
  emitFile (deterministic runtime + script chunks), virtual/fake-path `.svelte` resolveId/load,
  dynamic-import manifest chunk-splitting, and the standalone secondary build all work under
  Rolldown, in build and dev. All 6 suites pass on vite 8.

## NOT done this round (acknowledged; ran out of budget) — next up
### tsdown library build (requirement)
- Build `packages/sk-islands` TS sources → `dist` with `.d.ts` via tsdown (Rolldown-based),
  ship `.svelte` files (ClientRouter, private Island wrapper) as source referenced by exports,
  point the emitFile runtime/shim references at `dist` consistently (dev + build), and wire the
  playground to consume the built `dist`. Not started.

### TypeScript everywhere + svelte-check (requirement) — feasibility CONFIRMED
- Convert all library + playground `.js`/`.server.js`/config/verify files to `.ts`; components
  get `lang="ts"`. Exceptions that must stay `.js`: `svelte.config.js` (Kit loads it as JS).
- **svelte-check 4.7.4 TOLERATES `with { island }`** on `.svelte` imports — no parse error, so
  svelte2tsx is NOT a blocker (no special language-tools version needed for that syntax).
- Remaining svelte-check items to fix during conversion: (1) the bundled `<script island>`
  element attribute needs an ambient type augmentation (svelte-check flags `island` as an
  unknown `<script>` attribute — a type warning, not a parse error); (2) `$types` errors need
  `svelte-kit sync`; (3) strict-mode `implicit any` in the library `.js` files (resolved by the
  TS conversion). `svelte-check` is installed as a devDep; a `check` script is still TODO.

## Standing caveats (unchanged)
- Remote `command` (POST) needs a correct `ORIGIN` in production (Kit CSRF; dev skips it).
  Custom `hooks.transport` types + remote `form` unsupported by the island remote client.
- `$app/*` shims reliably reach island-boundary imports; deep imports in shared components:
  use props or `sk-islands/app`. `page.data` is snapshotted per island (bloat with many islands).
- Standalone build assumes `kit.appDir === '_app'` and uses `vitePreprocess()` (custom
  svelte.config preprocessors aren't reapplied in that secondary build).
