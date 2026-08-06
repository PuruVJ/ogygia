# Changelog

All notable changes to **ogygia** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
