# ogygia — SSR Islands for SvelteKit (no Kit patches)

## Goal

Astro-style islands in SvelteKit, delivered as a **library** (`packages/sk-islands`) + a **playground** Kit app proving it. Real, working, verified code — no hand-waving.

Requirements:
1. Islands **SSR** (full HTML present before any JS runs).
2. Page shell ships **zero Kit JS** (`csr = false`). Only islands hydrate.
3. Hydration strategies: `load`, `visible` (IntersectionObserver), `media` (matchMedia), `idle` (bonus).
4. Props serialized with **devalue** (Date, Map, Set, BigInt, nested, etc. must survive).
5. Natural authoring API:
   ```svelte
   <Island visible>
     <Comp a={x} b={new Date()}>
       {#snippet header()}<h2>{title}</h2>{/snippet}
       <p>children content {y}</p>
     </Comp>
   </Island>
   ```
   Props "as usual", snippets "as usual" — no `component={...}` / `props={{...}}` manual API.
6. Island components may use **async Svelte** (`await` in components, `<svelte:boundary>`) and **SvelteKit remote functions** (`.remote.ts` with `query`/`command` from `$app/server`).
7. **SPA navigations WITHOUT patching Kit** — this is critical. Do not fork/patch kit or svelte. The two directories `kit/` and `svelte/` at repo root are pristine upstream clones for REFERENCE READING ONLY (kit clone is on v3-next branch; we target published stable Kit 2.x). Do not modify them, do not link against them.

## Repo layout to create

```
/Users/puruvj/Projects/sk-islands/
  kit/            # upstream clone, reference only — DO NOT TOUCH
  svelte/         # upstream clone, reference only — DO NOT TOUCH
  pnpm-workspace.yaml
  package.json    # workspace root
  packages/sk-islands/   # THE LIBRARY
  playground/            # SvelteKit app using the library via workspace:*
```

Use pnpm. Published deps: `@sveltejs/kit@^2.70.2`, `svelte@^5.56.8`, `@sveltejs/vite-plugin-svelte` latest, `vite` latest compatible, `@sveltejs/adapter-node` (need a real server for remote functions), `devalue`.

Playground config: `compilerOptions.experimental.async = true` in svelte.config.js; `kit.experimental.remoteFunctions = true` (verify exact flag name/shape against the *installed* node_modules/@sveltejs/kit, not the v3 clone). Root `+layout.server.js` or per-page `export const csr = false;`.

## Architecture

### 1. Compile-time transform (vite plugin, `enforce: 'pre'`, placed BEFORE `sveltekit()` in plugins array)

For every `.svelte` file under the app root that references `Island` imported from `ogygia`:

1. Parse with `svelte.parse(source, { modern: true })` (import from `svelte/compiler` — handles TS expressions when `lang="ts"`).
2. Find `<Island ...>` component nodes. For each, take the **exact source text** of its children (magic-string slice — preserves everything: components, snippets, each blocks, text).
3. **Free-variable analysis** on that subtree: walk all expression nodes (estree-walker over the template AST's expressions + any snippet bodies), collect referenced identifiers, subtract identifiers bound *within* the subtree (snippet params, `{#each}` locals, `{@const}`, `{#await}` value). Classify the remaining free identifiers:
   - Resolves to an **import declaration** in the host file → copy that import into the virtual module (do NOT serialize).
   - JS globals (`console`, `Math`, `JSON`, `Date`, `window`, `fetch`, `undefined`, etc. — use a sane allowlist / `identifier in globalThis` at build time) → leave alone.
   - Anything else (host `<script>` vars, template-scope vars like an outer `{#each}` local) → **captured prop**. These get serialized per-instance.
   - A free identifier that is a **snippet defined outside the island** → build-time error with a clear message (functions can't cross the island boundary).
4. Generate a **virtual island module** (deterministic id from host path + index, e.g. hash): source =
   ```svelte
   <script lang="ts">  // lang copied from host
     // copied import statements (only the ones referenced in the subtree)
     let { x, y, title } = $props(); // the captured identifiers
   </script>
   <!-- exact original children source -->
   ```
5. Rewrite the host file: replace the `<Island ...>...</Island>` block with
   ```svelte
   <Island {…original strategy props} __entry="<island-id>" __component={__SkIsland_0} __props={{ x, y, title }} />
   ```
   and prepend `import __SkIsland_0 from '<virtual island id>';` to the host script.

Virtual `.svelte` module mechanics (sharp edges — solve them, empirically):
- The id must end in `.svelte` so `vite-plugin-svelte` compiles it. `\0`-prefixed ids may be excluded by vite-plugin-svelte's filter. If a plain `virtual:` id doesn't get compiled, fall back to resolving to a fake real-looking path (e.g. `<hostDir>/__sk-island__/abc123.svelte`) served from your `load` hook (enforce-pre wins over vite's fs loader). Verify whichever works in BOTH dev and build, for BOTH the client and SSR environments.
- Copied relative imports must resolve: implement `resolveId(source, importer)` — when importer is one of your virtual modules, delegate to `this.resolve(source, hostFilePath, { skipSelf: true })`.
- Preprocessors (vitePreprocess) must apply to virtual modules — they should flow through vite-plugin-svelte's normal pipeline.

### 2. `Island.svelte` (SSR-focused component exported by the library)

Renders:
```svelte
<sk-island data-entry={__entry} data-strategy={strategy} data-media={media}>
  <__component {...__props} />          <!-- real SSR of the island content -->
  <script type="application/sk-island-props">{escapedDevalueStringify(__props)}</script>
</sk-island>
<script type="module" src={runtimeUrl}></script>
```
- Strategy props: `load` (default), `visible` (true or a rootMargin string), `idle`, `media="(query)"`.
- `devalue.stringify` the props; escape `<` as `<` (script-injection safety; mirror what Kit does).
- The `<script type="module">` tag is emitted **per island** — browsers dedupe module loads by URL, so duplicates are harmless. Prefix URL with Kit's `assets`/`base` from `$app/paths`.
- `runtimeUrl`: dev → the vite dev URL of the runtime module (`/@id/...` form — verify the exact encoding empirically). Build → **deterministic filename**: in the client build, `buildStart` calls `this.emitFile({ type: 'chunk', id: '<runtime module>', fileName: '_app/immutable/ogygia-runtime.js' })` (client build only — skip when `config.build.ssr`). Deterministic name = no manifest handoff between Kit's client and server builds. Pass the URL to Island.svelte via a virtual module (`virtual:ogygia/runtime-url`) resolved differently per dev/build.

### 3. Client runtime (`ogygia/runtime`, small, tree-shaken)

- `customElements.define('sk-island', ...)`. `connectedCallback` → schedule per strategy (load / rIC idle / IntersectionObserver / matchMedia). When triggered:
  1. dynamic-import the island module: build → via a virtual manifest module `{ '<island-id>': () => import('<virtual island id>') }` (rollup code-splits and rewrites URLs automatically); dev → construct the dev URL from the id directly.
  2. `devalue.parse` the props script tag content.
  3. `hydrate(Component, { target: this, props })` from `svelte`.
- `disconnectedCallback` → `unmount(app)` (this is what makes SPA swaps clean up automatically).
- **Manifest completeness**: rollup may load the runtime/manifest before all host files transform. Pre-scan in `buildStart` (glob `src/**/*.svelte` in the app, parse, extract island ids) so the manifest is complete. Dev needs no manifest.

### 4. SPA router (`<IslandRouter />` component or `spa: true` plugin option; Astro ClientRouter equivalent)

Small client module (can live in the same runtime chunk):
- Intercept same-origin `<a>` clicks (skip modified clicks, `target`, `download`, `rel=external`, `data-no-spa`).
- `fetch(href)` → `DOMParser` → swap `document.body`, merge `<head>` (diff by `outerHTML`: remove page-specific stale nodes, add new ones — careful with stylesheets in dev vs build, and keep the runtime script alive), update `document.title`.
- Wrap the swap in `document.startViewTransition` when available.
- `history.pushState` + `popstate` handling + scroll reset / hash scroll.
- Islands on the new page initialize automatically via custom-element connection; old ones unmount via disconnection. Verify no double-hydration.

### 5. Async + remote functions in islands

- Island components must be able to `await` (top of `<script>` and in markup with `<svelte:boundary pending>`), and call remote `query()` from a `.remote.ts` file. These go through Kit's own transforms because island virtual modules are part of Kit's client build graph.
- SSR of the island awaits server-side (real remote call in-process); on hydration the query re-fetches over HTTP — acceptable, document it.
- Playground must include one island doing exactly this.

## Playground pages (the proof)

- `/` — static shell text (assert NOT hydrated: no kit scripts in HTML), counter island (`load`), a below-the-fold island (`visible`) that logs + visually marks when it hydrates, a `media` island, an island receiving `{ date: Date, map: Map, nested: {...} }` props, an island with snippet children + regular children using outer-scope vars, an island inside an `{#each}` (each-local captured as prop).
- `/about` — different content + another island; links between pages to prove SPA nav (View Transition, no full reload — e.g. set `window.__marker = Math.random()` via the runtime and assert it persists across nav).
- `/data` — island using a remote function + `await` + `<svelte:boundary>` with pending snippet.

## Verification (do this yourself before reporting done)

Write a `verify/` node script (plus Playwright tests if browsers are installed — check `~/Library/Caches/ms-playwright`; note `playwright_skip_browser_download` is set in npm config, so browsers may be absent; if absent, install chromium via `pnpm exec playwright install chromium` only if quick, otherwise rely on the node script + manual notes):

1. `pnpm build` succeeds; `node build/index.js` (adapter-node) serves.
2. `curl /` HTML: contains island SSR'd content (counter markup, list items), contains `<sk-island`, contains devalue props payloads, does NOT contain Kit's `__sveltekit` bootstrap / `_app/immutable/entry/start` scripts.
3. Browser-level (Playwright, if available): counter clicks work after hydration; visible island hydrates only after scrolling into view; SPA nav preserves `window.__marker`; devalue props revive (`date instanceof Date`); remote-function island renders data.
4. Dev mode (`pnpm dev`) works too — both transforms, styles present, islands hydrate.

## Rules for you (implementation agent)

- Svelte 5.56.8 / Kit 2.70.2 realities beat your memory. When unsure about parse output shapes, vite-plugin-svelte filters, Kit build order, dev URL encodings — **run a tiny experiment or read the installed node_modules / the reference clones**. No guessing.
- No patches to kit/svelte. No `patch-package`. If you hit a genuine hard blocker that seems to require one, STOP and report the exact blocker with evidence instead of patching.
- Keep the library dependency-light: `devalue`, `magic-string`, `estree-walker` (svelte/compiler is a peer).
- Write a `README.md` in `packages/sk-islands` documenting API + constraints (serializable props, no cross-boundary snippets, remote refetch on hydration).
- Report at the end: what works (with proof — actual command output), what's flaky, any deviations from this spec and why.
