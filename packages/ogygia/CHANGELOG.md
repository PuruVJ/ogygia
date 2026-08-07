# Changelog

All notable changes to **ogygia** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] — 2026-08-07

### Fixed

- **csr=false client stubs keep a side-effect entry import for island CSS.** Portable bindings (0.4.0) rewrote marked imports to `virtual:ogygia/client-binding-stub` and dropped the pre-0.4 host `__css` import of the authored `.svelte`. Kit only links stylesheets from the *client* page graph, so layout/page islands painted with scoped class hashes but **no rules** (unstyled sidenav, overflow lock / full-height TOC blocking scroll). Stub bindings still omit wrappers/entries; one deduped `import '…entry.svelte'` restores FOUC CSS.

## [0.4.0] — 2026-08-07

### Changed

- **Portable island bindings (breaking).** A marked `import A from '…' with { hydrate|defer|preset }` rewrites **`A` itself** to a virtual Island/ServerIsland/Lake wrapper. The template keeps `<A />`; `svelte:component this={A}` and `{#each}` lists of `{ comp: A, props }` work.
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

- Transform/audit coverage for portable bindings, dedupe, `svelte:component`, list/each, defer+fallback, defer+hydrate, lakes, presets.
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
