# Pharos — the docs kit design

> Status: design only, nothing implemented. Captured 2026-08-10 from a long design conversation.
> Pharos = the Lighthouse of Alexandria (stood beside the Library). ogygia is the island; pharos is its lighthouse.

## What it is

A Starlight/VitePress-class docs kit that **mounts on a SvelteKit route group** instead of owning the repo. It can be your whole site, or one `(docs)` subtree inside a bigger app. Everything derives from a `content()` collection — pharos is the capstone of the content pillar, not a new framework.

The differentiator vs VitePress/Starlight: they take over the whole project; pharos owns one subtree, coexists with your app, and its escape hatch is the app itself. Real SvelteKit means islands and live demos work inside the prose natively.

## Packaging

- Same package, subpath: `ogygia/pharos`. Matches `ogygia/content`. One version, no peer-dep matrix.
- Dependency arrow is ONE WAY: pharos imports the core (content, islands, partials); the core NEVER imports pharos. That guarantees a non-docs app bundles zero pharos bytes.
- Heavy optional deps (search engine, if ever) = optional peers, documented, never force-installed.
- Extract to `@ogygia/pharos` later only if it earns its own release cadence. Start together (merging back is the hard direction).

## The core idiom: pharos is a MINT

Same grammar as the rest of the library: `content()` defines, `withRemotes()` mints wire access, **`pharos()` mints a site**. No config file, no vite plugin for pharos itself.

```ts
// src/lib/docs.ts — one module, the source of truth
import { content, mdsvex } from 'ogygia/content';
import { pharos } from 'ogygia/pharos';

export const docs = content({
  loader: mdsvex(import.meta.glob('../docs/**/*.svx')),
  schema: docSchema,
  relations: (self) => ({ related: self })
});

export const site = pharos(docs, {
  title: 'Ogygia',
  sidebar: 'auto',
  nav: [{ text: 'GitHub', href: '…' }],
  theme: { accent: '#6b8afd' },
  search: true,
  prevNext: 'graph'
});
```

### Why not a vite plugin / config file

- `import.meta.glob` does NOT work in `vite.config.ts` (it's transformed in the app graph, not the config loader) — so a collection literally cannot be defined/imported there. Collection is app code; config lives beside it.
- An earlier sketch had `export { load } from 'ogygia/pharos/route'` — broken: that load has no way to know WHICH collection it serves. `site.load` closes over the collection. No registry, no magic.
- The only vite-side thing pharos touches is what ogygia already owns: the markdown pipeline under `ogygia({ content: { markdown } })`.

## Tree-shaking split (important correction)

`site.Shell` / `site.Search` as properties = NOT tree-shakeable (property access defeats DCE), and `+page.ts` is a universal file — importing `site` for `load` would drag every component into the client graph.

So the grammar is split:

- **`pharos(docs, opts)` returns BRAINS ONLY** — zero components:
  `{ load, entries, index, nav(), doc(), search() }`
- **Bricks are named exports** from `ogygia/pharos` (perfectly shakeable):
  `Shell, Sidebar, Toc, Search, Pagination, ThemeToggle, …`
- `<Shell {site}>` takes the site once and sets context; bricks inside read context (pre-bound feel, no prop threading). Standalone bricks outside the shell take `{site}` explicitly: `<Search {site} />` on a homepage ships only the search brick.
- Import `Search`, ship `Search`. Never import `Shell`, never ship it. Tier-2 sites ship exactly their own chrome.

## The mount: three tiny files

SvelteKit page options (`prerender` / `ssr` / `csr`) must be LITERAL constants in route files (static analysis; re-exports are not seen). Functions (`load`, `entries`, `GET`) re-export fine — and `export const { load, entries } = site` is valid ESM.

```ts
// (docs)/[...slug]/+page.ts
export const prerender = true;
export const { load, entries } = site;
```

```svelte
<!-- (docs)/+layout.svelte -->
<script>
  import { Shell } from 'ogygia/pharos';
  import { site } from '$lib/docs';
  let { children } = $props();
</script>
<Shell {site}>{@render children()}</Shell>
```

```ts
// (docs)/search.json/+server.ts
export const prerender = true;
export const GET = site.index;
```

Constants stay visible and yours (flip prerender per section). Functions come off the mint. Move the same files to `src/routes/[...slug]/` and the docs ARE the whole site — same kit, different mount point.

## `pharos()` options

```ts
pharos(docs, {
  // identity
  title, description, logo, favicon,

  // structure
  sidebar: 'auto',              // folders → groups (NN- prefixes = order), or explicit tree w/ badges/collapse
  nav: [...],                   // top-bar links; empty/false = no top bar

  // features — each individually removable
  toc: { minDepth: 2, maxDepth: 4 } | false,      // from entry.meta.headings
  prevNext: 'graph' | 'order' | false,            // graph = content relations `related`
  search: true | {...} | false,                   // build-time index, zero backend (Pagefind-style)
  editLink: 'https://github.com/…/edit/main/docs/:path',
  lastUpdated: true,

  // look
  theme: { accent, radius, font } | false,        // false = ship ZERO css
  components: { a: SmartLink, code: MyCode, Aside, Tabs, Steps },  // element overrides + globals in every .svx
})
```

## Customization ladder

1. **Config only** — accent, sidebar mode, features on/off.
2. **Region overrides on Shell** — every region is a prop; `null`/`false` REMOVES it:
   `<Shell {site} header={MyHeader} sidebar={MySideNav} search={false} footer={null}>`
   plus seam snippets: `{#snippet sidebarTop()}…{/snippet}`, `{#snippet afterContent()}…{/snippet}`.
3. **Snippets inside bricks** — brick keeps logic, you draw the pieces:
   ```svelte
   <Sidebar>{#snippet item(entry, active)}<a href={entry.href} class:glow={active}>…</a>{/snippet}</Sidebar>
   ```
   Same per-heading on Toc, per-result on Search.
4. **Primitives, no Shell (Tier 2)** — your entire chrome, pharos brains. This is EXACTLY the current ogygia docs site: own `Contours`/`SideNav`/`PageToc`, fed by `site.nav()`, `site.doc()`, `entry.meta.headings`, `prevNext`. Zero pharos pixels shipped.
5. **Plain SvelteKit** — one weird route drops out of the shell entirely; it never stopped being your app.

## Styling story

- **Tokens**: entire default theme painted from CSS custom properties (`--ph-accent`, `--ph-radius`, `--ph-font`); `theme: {}` just sets them.
- **Your CSS always wins**: pharos styles live in `@layer pharos` → any user stylesheet beats them, zero specificity wars. Stable class hooks on every region: `.ph-sidebar`, `.ph-toc`, `.ph-doc`, `.ph-search`.
- **`theme: false`**: structure, zero CSS.
- Islands work inside docs prose natively (`with { wake: 'visible' }`) — live demos mid-prose is just normal ogygia.

## What pharos derives from the collection (the brains)

- Routing: catch-all slug → `docs.get(slug)` → `<Partial of={entry.body}>`; 404 via null-return in `site.load`.
- Sidebar/nav tree: from ids + `NN-` folder prefixes (order + sections), i.e. what the current docs' `parseDocPath` does by hand.
- On-this-page: `entry.meta.headings` (the meta axis).
- Prev/next: content graph `related` relation, falling back to reading order.
- Search: prerendered `search.json` endpoint (`site.index` as GET) serializing the collection into a static client-queryable index.
- Frontmatter contract: user's schema, extendable.

## Honest parity assessment vs VitePress/Starlight

- Customizability: MORE, by design — the escape hatch is the whole app; no ceiling.
- Out-of-box parity: sidebar/nav/toc/prev-next/typed frontmatter/search/markdown components ✓ (all fall out of existing pillars).
- The real gaps that are just work: **i18n** (locale collections + locale-aware catch-all + translated UI strings — biggest single build), **versioning** (a source per version + switcher), **default-theme polish + component kit** (Card/Tabs/Steps/FileTree/Aside — years of refinement to earn).

## Open questions for when this gets built

- `sidebar: 'auto'` derivation details (badges, collapse state persistence).
- Search index format + client (build our own tiny one vs optional-peer Pagefind).
- How `components:` mapping wires through mdsvex (layout mechanism) per-collection rather than globally.
- Base-path inference when mounted at a non-root group.
- Whether `site.load` should ALSO return the nav tree (one load for shell + page) or the shell fetches `site.nav()` separately.
