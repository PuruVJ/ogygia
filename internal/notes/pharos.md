# Pharos — the docs kit design

> Status: design v2, agreed 2026-08-12 after a full grilling + creative pass. Supersedes the v1
> sketch (2026-08-10; see git history). Nothing implemented yet; v1 scope at the bottom.
> Pharos = the Lighthouse of Alexandria (stood beside the Library). ogygia is the island; pharos is
> its lighthouse.

## What it is

A docs kit that mounts on a SvelteKit route group (or the root) instead of owning the repo. It is
the capstone of the content pillar, not a new framework. Real SvelteKit means islands and live
demos work inside the prose natively.

Design stance (the agent-era reframe): VitePress optimizes for a human typing a one-liner. We
optimize for **legibility and ceiling-less power** — agents write the wiring, humans read it. So
verbose, explicit composition is fine, even preferred. The VitePress-style "init and go" experience
is a *template* (`npx ogygia pharos init`), not library magic. The library's only job is getting
the primitives right.

## The primitive map

```
corpus     what exists            content() collections — as many as needed   ← built (content pillar)
dialect    what prose can say     callouts, tabs, code, LIVE islands          ← half built (islands, mdsvex)
mount      where it attaches      three files, group or root                  ← trivial, by design
────────────────────────────────────────────────────────────────────────────
outline    how the corpora read   a derived collection that WEAVES corpora    ← the core new primitive
address    where everything is    typed coordinates owned by the outline      ← the sleeper
views      what a position sees   nav, doc, trail, crumbs — plain data        ← the brains (v1)
emissions  what machines fetch    search.json, llms.txt, sitemap, raw .md     ← later
────────────────────────────────────────────────────────────────────────────
chrome     what humans see        bricks + shell                              ← last, on purpose
```

One sentence: corpora, arranged by an outline, located by addresses, projected through views,
serialized as emissions, spoken in a dialect, rendered by chrome, attached at a mount.

Two differentiators: (1) live islands in real prose — corpus + dialect, nobody else has it;
(2) docs that can't silently rot and are natively machine-legible — address + emissions.

## The core model (the big v2 correction)

**Collections are the only data primitive. The outline is a derived collection that weaves any
number of collections. Pharos consumes the outline, not a corpus.** A docs site is not "one
collection with options"; it is an arrangement of collections. Single-collection is the degenerate
case, kept as sugar.

- i18n = locale dimension: outlines weaving locale corpora. Versioning = version dimension:
  outlines weaving version corpora. Neither is a plugin; both are instances of the weave. (Later.)
- API reference autogen, git changelogs, CMS content: all just *sources* minting collections
  (`defineSource`). Pharos never knows where entries came from.
- `+meta.json` directory metadata is itself a collection (json format), fed to the outline.
- Draft mode is the collection `filter`. Filtered entries vanish from every layer for free.

## Packaging

- Same package, subpaths: `ogygia/pharos` (browser-safe brains) and `ogygia/pharos/server`
  (remote minting). Matches `ogygia/content` / `ogygia/content/server`.
- Dependency arrow is ONE WAY: pharos imports the core (content, islands, partials); the core NEVER
  imports pharos. Non-docs apps bundle zero pharos bytes. Enforce via import-boundary check.
- Extract to `@ogygia/pharos` later only if it earns its own cadence.

## Full API (v1 surface)

### `outline(spec, opts?) → Outline`

The weaver. Spec grammar (every form composes with every other):

```ts
outline(guides)                                  // bare collection: convention-expanded tree
outline([                                        // array: ordered items
  guides,                                        // bare collection item = remainder of it, by convention
  { label: 'Guides', items: guides, meta },      // group holding a collection subtree (+meta.json decorations)
  { label: 'API', items: api, base: 'api', collapsed: true },  // second collection; base prefixes its slugs
  { label: 'Start', items: pick(guides, 'start/install', 'start/first-island') },  // pinned, ordered
  { label: 'Rest', items: pick(guides, 'regions/**') },        // glob slice, convention-ordered within
  { label: 'GitHub', href: 'https://…' },        // plain link
  { label: 'Extras', items: [ /* nested groups/items */ ] },
  () => computed_items,                          // thunk: computed subtree, evaluated at build
])
```

- `pick(collection, ...patterns)` — a Selection: subset of a collection, in pattern order. Patterns
  are exact ids or globs (`*`, `**`). Strings ONLY appear inside `pick()`, always scoped to a
  collection — no ambiguity with multiple collections.
- Placement rules: each entry places once; a bare collection item takes the not-yet-placed
  remainder; a fully-picked collection with leftover entries = build error naming the orphans
  (silence deliberately with a remainder item).
- Validation: unknown id in a pick = build error. Slug collision across leaves = build error naming
  both sides; fix with `base` on a group.

Convention expansion (bare collection / glob slices): group by id path segments (recursive), order
by `NN-` filePath prefixes (fallback: id order), labels title-cased. `meta` (a json collection of
`+meta.json` files) decorates a directory-group by id match: `{ label?, order?, collapsed?,
badge? }`.

The Outline object (collection-like, mostly consumed via site):

```ts
outline.tree(opts?)      // → Promise<NavTree>        serializable, no bodies
outline.resolve(slug)    // → Promise<{ leaf, collection, entry } | null>
outline.addresses()      // → Promise<string[]>       every leaf slug (prerender source)
outline.neighbors(slug)  // → Promise<{ prev?, next? }>  leaf order across the whole weave
outline.path(slug)       // → Promise<Crumb[]>        group labels root → leaf
```

### `pharos(outline | collection, opts?) → Site`

The site mint. A bare collection auto-wraps: `pharos(docs)` ≡ `pharos(outline(docs))`.

```ts
pharos(nav, {
  prevNext: 'graph' | 'order' | false   // default 'order'; 'graph' = rel.related, order fallback
})
```

Opts stay MINIMAL: only fields a brain consumes. No dead config, ever. New fields arrive with the
code that reads them (emissions/chrome opts come in those phases).

The Site object (the brains — zero components, all browser-safe except noted):

```ts
site.load        // SvelteKit load: 404 guard via outline.resolve (thin — page data comes from doc())
site.entries     // SvelteKit entries: all leaf slugs
site.nav(opts?)  // → Promise<NavTree>
site.doc(slug, opts?)  // → Promise<DocView | null>  called in the page COMPONENT (csr=false island
                       //   semantics: body partial renders in the page's own SSR pass)
site.outline     // the outline, exposed
```

`opts?: { base?: string }` on `nav`/`doc` — hrefs are `${base ?? ''}/${slug}`. Root mount omits it;
a `(docs)` group passes its prefix. Helper `mountBase(url, slug)` derives it by subtraction in a
layout. No global base config, no registry.

### Data types (the plain-data seams — chrome and users consume ONLY these)

```ts
type NavTree  = NavItem[];
type NavItem  = NavGroup | NavLeaf | NavLink;
type NavGroup = { kind: 'group'; label: string; collapsed?: boolean; badge?: string; items: NavItem[] };
type NavLeaf  = { kind: 'leaf'; slug: string; href: string; title: string; summary?: string; badge?: string };
type NavLink  = { kind: 'link'; label: string; href: string };

type Crumb    = { label: string; href?: string };
type NavRef   = { slug: string; href: string; title: string; summary?: string };

type DocView = {
  slug: string;
  href: string;
  entry: ContentEntry;          // full entry: data, body (render via <Region of={...}>), meta, rel
  section: string;              // label of the top-level group containing this leaf
  crumbs: Crumb[];
  headings: Heading[];          // entry.meta.headings (the fractal outline below the entry)
  trail: {
    prev?: NavRef;
    next?: NavRef;              // outline leaf order
    related: NavRef[];          // content graph (rel.related)
    suggested: NavRef[];        // prevNext policy applied ('graph': related else [next])
  };
};
```

### `ogygia/pharos/server` — remotes for islands

Kit remotes must be defined in a `.remote.ts`; the user mints them there, same grammar as
`withRemotes`:

```ts
// docs.remote.ts
import { remotes } from 'ogygia/pharos/server';
import { site } from './docs';
export const { nav } = remotes(site);   // prerendered remote — island sidebars await nav()
```

## The mount

Page options (`prerender`/`ssr`/`csr`) must be literal constants in route files; functions come off
the mint. Three files, group or root — moving them IS re-mounting:

```ts
// (docs)/[...slug]/+page.ts
export const prerender = true;
export const { load, entries } = site;
```

```svelte
<!-- (docs)/[...slug]/+page.svelte — v1/tier-2: user renders the view -->
const view = await site.doc(slug, { base });
<Region of={view.entry.body} />
```

Layout: user chrome (v1) or `<Shell {site}>` (later).

## Customization model (why granular mode works)

Kit-first invariants, in force from v1:

- Every brain returns plain serializable data. Structure never lives inside a component.
- (Later) bricks are functions of one seam type each, imported by name, snippet-customizable;
  the Shell composes bricks using ONLY public API — copy it out of node_modules and it still runs.
- Every region: use / wrap / replace / remove. Wrap = read the data, transform it, hand it to the
  stock brick. Day-1 and day-90 are the same system; nothing is ever ejected.

## Phases

1. **v1 — brains. ✅ BUILT.** `outline` + `pick` + validation + convention/meta expansion; `pharos`
   site mint (load/entries/nav/doc, base handling); `remotes(site)`; `apps/pharos-playground`
   proving the multi-collection weave; dogfood: `apps/docs` migrated with identical output.
2. **Emissions. ✅ BUILT (except search).** `site.emit.llms` / `site.emit.sitemap` (GET handler
   mints), `site.emit.raw()` — per-page raw markdown off `entry.source`. That required the
   architectural thread: `source?: () => Promise<string>` is now a first-class lazy face of a
   content entry (any source can fill it; the markdown preprocessor injects a STATIC-LITERAL
   `?raw` self-import — dynamic specifiers are invisible to Vite). Search still deferred to its
   own design pass (external collections in the index, algo, plug-in vs own).
3. **Address hardening. ✅ BUILT.** The honest framing: pharos detects nothing Kit can't — it gives
   link/redirect facts a HOME in the content model and checks them against the address space it
   owns, in every render mode (Kit's crawler is prerender-only; our check lives in `load`, so it
   runs on SSR/dynamic sites too — deliberate duplication for one cohesive surface).
   - `redirect_from` frontmatter (convention; `outline(spec, { redirects })` overrides): aliases
     fold into the address space, collision-checked; `site.entries()` includes them so redirect
     stubs prerender; `site.load` 308s them. Durable URLs for inbound links Kit can't see.
   - `meta.links` — a remark collector (like headings) makes every markdown link data.
   - `audit: true` on `pharos()`: each page's load validates its own links (missing page +
     missing anchor via the target's `meta.headings`); broken link = failed build / dev error,
     file-anchored. `site.audit()` returns the same as plain data for vitest/CI/dynamic sites.
   - NOT built (deferred with the dialect/components mechanism): id-form links in prose with
     render-time rewriting; edit-link/canonical/OG mappings.
4. **Chrome. ✅ BUILT.** Bricks (`Sidebar`, `Toc`, `Pager`, `Doc`) + `Shell` (region props: pass a
   component to REPLACE, `false`/`null` to REMOVE); shell context feeds bricks without prop
   threading. `Link` = id-form + redirect-aware anchor. `ogygia/pharos/theme.css` — EXPLICIT import,
   `@layer pharos`, `--ph-*` tokens, `.ph-*` hooks (skip the import = zero CSS). Playground runs the
   day-1 path (`<Shell><Doc {view} /></Shell>`).
   **Element overrides (the `components:` mechanism) ✅ BUILT.** Plain markdown gets standard-lib
   components with no author markup. The thread: `markdown: { overrides: true|{tags} }` (opt-in
   flag; default tags `a`/`img`/`code`) → a rehype pass rewrites those tags to `<Ph__Slot tag=…>`,
   the preprocessor injects `import Ph__Slot from 'ogygia/pharos/slot'` (fixed specifier — compiler
   knows only tag NAMES). VALUES live in `pharos(outline, { components: { a: Link } })` (app code,
   no import paths) and reach `PharosSlot` via shell context. `PharosSlot` renders the mapped
   component, else falls back to the plain element (broad wrapping is safe). Built-in default
   `a → Link`. This is the seam for a future `img → ogygia/image` (sharp/srcset/blur-up) default,
   `Aside`, `Tabs`, live-demo blocks. Code override needs shiki OFF to receive raw source (shiki
   runs at compile time). Dogfood: playground `overrides: true`, welcome page uses PLAIN markdown
   `[setup](intro/setup)` → resolves at render.
   NOT YET: per-collection component maps (roadmap; currently global via markdown config flag);
   id-form link REWRITE is done via the slot, not a separate remark pass.
   **Docs dogfood on chrome ✅** — `apps/docs` page body now renders through `<Doc>` (Toc + Pager
   bricks), `doc-page.css` ported onto `.ph-*` and painted from site tokens. Pixel-checked
   (desktop + mobile bottom-nav + keep-reading/pager): visually identical to the hand-built page.
   The site-wide fixed `SideNav` stayed the app's (Tier-2 — that frame is app-owned), so the
   bottom-nav is untouched. Shell is proven in the playground (day-1, pharos owns the frame). `Doc`
   gained a `keepReading` prop (feed `trail.related` to avoid pager/next duplication).
   Orphaned: old `doc-page.css` (unused, left in place).
5. **Search. ✅ BUILT (v1, the 80/20 cut).** Design settled in its own pass, then built:
   - Core model: search is a projection of the collections. `SearchDoc` = SECTION-granular chunks
     (source split by heading via `entry.source` → hits deep-link to `#anchors`); data-only entries
     index their display fields. Mount-independent docs (slug+anchor; base applied at query time).
   - Engine = adapter (`SearchEngine.build(docs) → index.query()`), isomorphic (node + browser).
     **Default: Orama** (optional peer, lazy-loaded; ~22 kB gz measured, BM25, typo tolerance,
     future hybrid/vector). MiniSearch = documented lean alternative. Swap is one line.
   - Surfaces, reshaped after a "four surfaces is bad API" complaint (correct): the **brick**
     `<Search />` is primary (zero config in Shell; `base` standalone; `query` fn prop = the
     escape hatch for CMS/Algolia). The **headless mint** `search({ base })` for bespoke chrome —
     endpoint by convention `{base}/search.json` (docs dogfood: SideNav uses it; index route lives
     at `docs/search.json`). `site.search()` = the server brain (loads/tests/remotes; lazy
     single-flight in-memory index, scope pre-filter `{ in: [collection] }`). `remotes(site).search`
     = the dynamic-site escape hatch (server corpus, wire per query) — demoted in docs, not a peer
     option. `site.emit.search()` = the static index emission.
   - Client path: Web Worker (`search-worker.ts`, bundled by consumer Vite via the static
     `new URL(...)` pattern) + `search()` handle with `ready` promise. Instant, on-device.
   - Docs sidebar UX (bespoke, in apps/docs): search replaces Home; results replace nav w/ Clear;
     mobile bottom-bar search opens the sheet w/ recent searches (localStorage) + GitHub pinned in
     sheet; term highlighting via CSS Custom Highlight API (no <mark>); nav↔search crossfade via
     View Transitions; refs via Svelte attachments (no bind:this).
   - Deferred (the user-borne 20%): `search?` facet on the Source contract (CMS-native delegation),
     hybrid merge policies, per-shard weights, live invalidation of the server index (version-keyed
     wiring stubbed), recent-searches persistence as a lib primitive (see brainstorm).
6. **Dimensions.** i18n + versioning as address dimensions over parallel corpora/outlines.
7. **Template.** `npx ogygia pharos init` — the VitePress-mode scaffolder.

### Refinements (small, deferred)

- **Toc active highlight. ✅ BUILT.** `Toc` ships a scrollspy by default (`scrollspy={false}` opts
  out): a self-contained inline script via ogygia's `script()` serializer — NOT hydration, so it
  works on csr=false pages where the brick is never an island (this was the key constraint; an
  $effect would be dead code there). Marks `.ph-active` + `aria-current` on the last heading above
  the fold line; rAF-throttled scroll listener; MPA navs re-run it naturally. Styled in theme.css +
  docs pharos-docs.css. Browser-verified on the docs.

### Post-roadmap brainstorm (not committed)

- **Recent-searches persistence as a lib primitive.** The docs sidebar-search UX (below) needs
  recent queries stored in localStorage. Custom-built in `apps/docs` FOR NOW, but it should later
  graduate into the lib so pharos presets / `Sidebar` / `Search` can offer it out of the box.
  (User idea, 2026-08-12.)
- **Docs sidebar-search UX (custom in apps/docs now).** Desktop: replace the "Home" link in the
  SideNav with a search input under the top nav; clicking it empties the sidenav and shows results
  in place, with a Clear button restoring the nav. Mobile: swap the GitHub icon in the bottom bar
  for search, move the GitHub link INTO the bottom sheet (fixed at its bottom when open); tapping
  search opens the sheet showing recent searches (localStorage), live results as you type. Built
  bespoke in the docs SideNav for now; the reusable bits (recent-searches, results-in-sidebar) are
  preset/Sidebar candidates later.

- **POC: adopt svelte.dev's search into pharos, untouched.** Pull the real svelte.dev docs search
  (FlexSearch in a worker, their index/data shape), and — WITHOUT changing its data source — make
  it run inside pharos, proving the kit can wrap an existing site's search verbatim. Vehicle: a
  `SearchEngine` adapter (FlexSearch) + the `<Search query={...}>` escape hatch / source delegation,
  fed svelte.dev's own index. Deliverable is a proof-of-concept, not production. (User idea,
  2026-08-12 — do this as a standalone POC later, not part of the search v1 build.)
  - Value beyond search: adopting a rich real site surfaces the SEAMS pharos still needs. e.g.
    svelte.dev code snippets use inline `+++added+++` / `---removed---` diff markers to show
    add/remove explicitly. Handling that well = a content-dialect seam (a code-fence transform /
    component override for diff annotations). The POC is a forcing function for "make pharos better
    aligned for complex cases," not just a search demo.

- **Pharos SHELLS (name settled 2026-08-13; "preset" is dead) — one theme, many shells.** Pharos owns the
  design LANGUAGE (theme.css tokens + the `.ph-*` visual voice — deliberately NOT the ogygia
  site's look; that stays the tier-2 showcase). A named shell adds NO new skin: it is an opinionated
  COMPOSITION — `Shell` is the neutral one, `Calypso` the VitePress-form one; later shells
  (docusaurus-style, starlight-style) are other forms of the SAME theme. A shell imports the
  theme ITSELF (opinionated = no zero-CSS mode; only neutral `Shell` keeps the explicit theme
  import). Shells are how "init template" and "VitePress parity" converge — a named shell is the
  template's payload. Usage is ONE import: `import { Calypso } from 'ogygia/pharos/calypso'`.
  **calypso v1 direction (user-set):**
  - MOBILE NAV IS A BOTTOM BAR BY DEFAULT — thumb-reachable, good UI practice (the pattern the
    ogygia docs proved). Opt-out to a provided top-nav via a setting/swappable component.
  - Mobile "On this page" needs a home — candidates: VitePress-style tack-on sub-bar up top, or
    folded into the bottom sheet (e.g. sheet with two segments: site nav / on-this-page).
    Undecided; needs a real design think, not a copy of VitePress by reflex.
  - Desktop: VitePress form — top header (brand, links, search, theme toggle), left sidebar,
    right on-this-page rail, content column.
  - Implies GENERALIZING the docs site's bespoke bottom-bar/sheet pattern into lib-grade pharos
    bricks (Topbar, BottomBar/Sheet) that calypso composes — presets never own primitives.

## Core island change — library components can declare islands (2026-08-13)

Strategic: enable an ECOSYSTEM of ogygia-hinted component libraries (Calypso is the first — a shell
that owns interactive chrome via `import CalypsoBar with { wake }`). Found while building Calypso:
a `wake:'load'` island declared INSIDE a library component didn't hydrate in production (dev worked;
prod 404'd `ogygia-island.<hash>.js`). Root cause, in `packages/ogygia/src/vite/index.ts`:
- The client leg emits deterministic island chunks (`fileName: islandChunkFileName(iid)`) ONLY in a
  `buildStart` loop over islands found by `prescan()`, which walks the APP's `src`. Lib hosts live
  outside app `src` → not prescanned → not emitted; Rolldown then content-hashed the entry to a
  DIFFERENT name than the deterministic one SSR baked into `<ogygia-region entry>`. Mismatch → 404.
- Also the transform hook SKIPPED all `/node_modules/*.svelte` outright.

Fix (two parts, verified: prod island hydrates + all 33 e2e still green):
- **Part A — ecosystem gate:** the transform hook now processes a `node_modules` `.svelte` IF it
  carries an ogygia hint (`has_island_hint`: cheap regex for `with { wake|render|region|preset }`),
  so libs opt in without taxing every lib file.
- **Part B — late emit:** during the client build, the transform emits the deterministic island
  chunk for any hydrate island discovered there that prescan missed (deduped via
  `emitted_island_chunks`). This is what makes a lib host's SSR `entry` and client chunk agree.
- KNOWN minor follow-up: an orphaned content-hashed duplicate chunk is still emitted next to the
  deterministic one (dead code, harmless). Server-islands (defer) inside libs not yet verified.

## Shells status (2026-08-13)

Calypso BUILT + prod-verified (playground dogfoods it). Primitives shipped: `ThemeToggle` (inline-
script, self-contained scoped styles), `Sheet` (bottom sheet: backdrop/handle/Escape/outside-close/
scroll-lock), `BottomBar` (fixed bar). `CalypsoBar` = the mobile island (bottom bar + sheet + segmented
Contents/On-this-page, on-this-page read from the rendered DOM since the shell lacks the page's
headings). `Calypso` = header + sidebar + main + `CalypsoBar`; imports its own theme. Subpath
`ogygia/pharos/calypso` + barrel export (barrel used in workspace to dodge the src/dist dual-type
hazard). `sideEffects: ["**/*.css"]` so a shell's internal CSS imports survive bundling.
STILL TODO from user: reuse Sheet/BottomBar/ThemeToggle in the DOCS SideNav (app-src island — works;
started ThemeToggle self-containment). The docs' desktop is a fixed morphing panel, not a sheet, so
Sheet fits the shell pattern more than the docs' pattern — assess docked-mode vs keep docs bespoke.

## Decision log (2026-08-12 grilling)

- Acceptance: dogfood parity — rebuild apps/docs on pharos brains, identical output.
- v1 is brains-only; chrome later; search deferred (own design pass).
- Same package, `ogygia/pharos` subpath; one-way dep arrow; extract later only if earned.
- Nav is a separate shared artifact (not folded into page load), minted as a remote for islands.
- `site.doc(slug)` bundles view data, called in the page component (preserves csr=false island
  hydration in the entry body); `site.load` stays a thin 404 guard.
- No base config: hrefs via explicit `base` param + `mountBase` subtraction helper in the layout.
- prevNext = graph-then-order (matches current site's "keep reading").
- Section labels: `+meta.json` directory collections (killed the SECTION_LABELS config map).
- Minimal opts forever: no stored-but-ignored fields; dead config misleads agents and humans alike.
- Mode 1 (VitePress feel) = init template over the same kit; no route-generation magic.

---

## Portable snippets — "a snippet is a region" (the Calypso actions blocker, solved for good)

**Problem.** A `{#snippet}` handed to a component and forwarded into an island can't cross the
boundary: island props serialize via devalue, and a snippet is a function ("Cannot stringify a
function"). This is why Calypso's `actions` couldn't reach the mobile sheet (inside the `CalypsoBar`
island). The snippet's BODY lives in the CONSUMER, one compile unit away from where it crosses — no
runtime trick reaches it.

**Solution (compiler + codec + runtime).** The compiler, at the snippet's DEFINITION site, compiles
its body into a standalone island ENTRY and rewrites the value to `og_portable(Entry, captures, url)`.
The value is still a real snippet (same-graph `{@render}` is unchanged), but it now carries a
serializable descriptor `{ e: entryUrl, p: captures }`. When it crosses an island boundary the new
`OgygiaS` codec ships the descriptor in the function's place; on the far side it's revived via
`createRawSnippet` — SSR renders the entry inline (the frame), the client ADOPTS that frame during
hydration and `setup()` hydrates the entry over it. The markup comes alive, exactly like a region.

**Why createRawSnippet.** It's isomorphic (server + client), calls only `render()` on the server and
only `setup()` on the client, and on the client adopts the SSR node instead of re-rendering — so one
factory serves both legs. `setup(el)` is the wake hook where `hydrate(entry, { target: el })` runs.

**Key files:** `src/portable-snippet.ts` (factory + codec), the `OgygiaS` reducer/reviver wired into
every serialize site (Region.svelte, region-props, region-endpoint, context-bridge, hooks, core+slots),
and the synthesis pass in `compiler/transform.ts` (walk non-island components for named 0-arg
snippets → synth entry → rewrite). Two bailout relaxations let the transform run on snippet-only files
(`{#snippet}` hint) and on files with no islands (`marked_components.size === 0`).

**No waterfall.** The descriptor's entry url is known at SSR, so the transform hoists a
`<link rel="modulepreload">` into `<head>` — the portable entry fetches in parallel with the host
island's chunk, not after it. Cost: ~0.24 kB brotli on the runtime; one chunk per distinct snippet.

**Scope (v1).** Named, 0-arg snippets → plain (non-island) components; one level of forwarding.
Parameterized snippets, default children, and snippets that write host state are left native.
Snippets passed DIRECTLY to an island keep the existing inline `build_child_synth` path.

**Proof:** `e2e/portable-snippet.ts` (34th check) — a snippet forwarded through a plain shell into an
island crosses, keeps its captured host value, survives hydration, and the nested island inside it
clicks 5 → 6. Calypso's `actions` now cross into the mobile sheet footer alive.

## Design-system north star: Fumadocs-level aliveness (user-declared, 2026-08-13)

Calypso's current styling is explicitly bad (user: "styling wise so bad"). When we do the design
system, the bar is how ALIVE Fumadocs feels, not VitePress flatness. Concretely:
- Clerk-style TOC: scroll progress as a moving thumb on the rail (motion tied to reading position).
- Micro-transitions everywhere: animated sidebar collapse, hover glow, springy search dialog.
- Code blocks as instruments: copy, framework/pm tabs with SITE-WIDE tab memory, annotations.
- Depth: gradients, layered surfaces, real shadows — air, not paper.
- Search dialog as a first-class scene.
Philosophical kinship: Fumadocs is the only surveyed framework treating conventions as config knobs
(suffix vs dir, prefix vs bare) — same kit-not-monolith soul as pharos.
Our angle: these are scroll/state behaviors on csr=false pages — `script()` inline serializer +
tiny islands can match the aliveness at a fraction of the JS. That's the flex.

## Design-system overhaul plan (loop task, user 2026-08-13: "extremely great, consistent, lively, beautiful")
Scope = the LANGUAGE (theme.css tokens + `.ph-*` voice), NOT apps/docs, NOT Calypso (Calypso is one
FORM composing the blocks). Baseline gaps vs the Fumadocs north star:
- Color is thin (accent + bg/text/line). Need: neutral scale, accent scale, semantic layers, real
  dark mode with layered surfaces + subtle gradients (depth, not flat paper).
- No motion system — hovers are instant. Need micro-transitions everywhere (150–250ms, reduced-motion safe).
- Type + space are ad-hoc magic rems. Need a type scale + space scale as tokens.
- Single radius, one shadow. Need radius scale + elevation/shadow scale.
- TOC is a flat list → clerk-style scroll thumb on the rail.
- Focus states are border-only → proper focus rings.
Method (needs eyes): build a KITCHEN-SINK route rendering every brick (sidebar/toc/doc/code/search/
pager/suggested/theme-toggle/sheet), rewrite theme.css token system + brick refinements + motion,
then screenshot light AND dark via playwright and iterate until genuinely beautiful.

## Loop working-state (2026-08-13 overnight autonomous run)
- Dev server for design iteration: pharos-playground `pnpm dev` (port 5274). Real page to screenshot:
  `http://localhost:5274/intro/welcome` (root `/` also works). Screenshot light+dark via playwright
  (colorScheme), Read the PNG, iterate. VERIFY IN BROWSER AFTER EVERY STEP (user directive).
- BUG (404→500): a non-leaf slug like `/intro` throws error(404) but renders as 500 — the error page /
  Calypso layout throws during error render. Fix: a `+error.svelte` and/or make the layout error-safe.
- BUG (overlap): Doc's "keep reading" suggested card overlaps the pager at the bottom. Fix in the
  design pass (spacing/height in theme.css / Doc layout).
- Current theme is flat / VitePress-tier. Execute the token overhaul (color scale, type, space, radius,
  shadow, motion, depth, clerk TOC thumb) — see the "Design-system overhaul plan" section above.
- DIRECTIVE (user): pharos INTERNALS should use CLASSES, not closured stateful functions. `dimensions.ts`
  is the prime offender (returns an object closing over spec/names/cache/many helpers) → `class Dimensions`.
  Audit outline.ts / pharos.ts / search.ts for the same and convert where it reads cleaner.
