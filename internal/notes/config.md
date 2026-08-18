# The config surface — one grammar, sovereign subsystems

Status: **v3.1 IMPLEMENTED** (2026-08-17, same day as the design; ships in 0.6.0). v1 ("presets
all the way down") and v2's path mechanism (`content.scoped`) are preserved at the bottom,
REJECTED — each rejection reshaped the design, per the usual archaeology.

Implementation notes (delta from the design text below):
- `image` subsystem: skipped — images don't exist yet (user); the grammar slot is reserved.
- The content door ships on the loader macro only (see "Resolved during implementation research").
- Live-verified in pharos-playground: the blog collection compiles through a `plain` preset
  (`overrides: false`) while guides keep the app default — same app, two pipelines, no marker
  leakage. Unit coverage: test/config-surface.test.ts + the dispatch cases in test/markdown.test.ts.
- The docs app's own link audit (`links()`) caught two bad anchors in the new docs during this
  work — the check failing a page load in dev is the designed behavior, worth remembering.
- Deferred (small): the "defined preset never referenced" dev warning needs end-of-build
  accounting; not implemented.

## v3 in one sentence

Every subsystem = **defaults + a sovereign `presets` dictionary**, and every use site opts in the
same way — `preset: '<name>'`, a literal, resolved in **its own subsystem's** dictionary. Content's
use site is the **collection definition** (loader macro for files, `content()` for a CMS), not the
file tree.

## The problem

The `ogygia()` surface grew by accretion: `visible` / `presets` / `continuity` sit top-level while
`content.markdown` nests; islands have a preset system, images planned a second, content was about
to gain a third. No principle decides what goes where. Criteria for the redo (user): simplicity,
collapsing, extremely watertight — plus, from the rejections: respect domain boundaries, don't pool
everything into one open namespace, and don't mistake file paths for content's identity.

## The design

**Spine law:** one top-level key per subsystem, no orphan keys. **Grammar law:** every subsystem is
`defaults + a sovereign presets dictionary`; a preset is a named partial of that subsystem's own
vocabulary and nothing else.

```ts
ogygia({
  regions: {
    visible: { margin: '120px' },                              // defaults (schedule tuning)
    presets: { demo: { wake: 'visible', margin: '200px' } },   // named attr bundles
  },
  content: {
    markdown: { themes, code: { transformers }, remark: [...] }, // the 80% tenant, not the landlord
    presets: { playground: { markdown: { overrides: true } } },  // named partial content-config
    // room for the rest of the content domain (search, emit, formats) in defaults AND presets
  },
  image: {
    optimizer: vercel(),
    presets: { cf: { optimizer: cloudflare() } },              // calls say preset: 'cf'
  },
  router: { viewTransitions: true, forms: true },              // global-only scalars, NO presets slot
})
```

The use sites — same key, four doors, each resolving in its own dictionary:

```ts
import Chart from './Chart.svelte' with { preset: 'demo' };                     // island → regions
img(src, { preset: 'cf' });                                                    // call → image
import.meta.og.loader.folder('../content/guides', { preset: 'playground' });   // file corpus → content
content({ loader: cmsSource, preset: 'playground' });                          // CMS corpus → content
```

## Content's axis is the collection, not the path

A CMS collection has no files — path-scoping (v2's `scoped`) could never reach it. File-backed
collections merely *enumerate* by path; that is an implementation detail, not the identity. The
collection definition is the one place every corpus — files, CMS, OpenAPI, push feed — actually
exists, so that is where the name rides:

- **File-backed** → the name rides the **loader macro** (compiler-touched ⇒ the macro carries it —
  the standing law; the name must be literal). **Mechanism (v3.1): the preset creates a MODULE
  VARIANT, not a claim on the file.** The macro emits its glob with Vite's custom-query option, so
  every matched import becomes `file.svx?og_preset=<name>` — a distinct module from bare
  `file.svx`. Each variant compiles with its own merged config. Consequences:
  - The same file in two collections with two presets **works** — two variants, two renders, zero
    interference (user requirement: "sometimes you may wanna render the same file differently").
  - No routing table, no glob matcher, no ordering argument, no two-collections conflict error —
    identity is structural (the module id), so the entire seal set for routing is deleted rather
    than enforced. Watertight by construction over watertight by detection.
  - Cost, inherent: a file used under N presets compiles/ships N times (the outputs differ).
  - Delivery detail: vite-plugin-svelte strips the query from the `filename` a preprocessor sees;
    ogygia's pre-transform (which sees the full id) injects a one-line marker into the variant's
    raw markdown, and the preprocessor reads the preset from content and strips it. (If the query
    turns out to survive into `filename`, the marker is unnecessary — verify empirically.)
- **CMS-backed** → no door today, deliberately (see "Resolved during implementation research").

## Why this shape is the watertight one

The v1 pooled namespace needed runtime seals for cross-subsystem leaks (an island naming an image
preset, router config inside a preset, cross-kind name collisions). Sovereign dictionaries make
those states **unrepresentable**: a `regions.presets` entry is typed as island attrs and nothing
else; a `content.presets` entry as content vocabulary; `router` has no presets slot at all. Types
do the sealing; the runtime keeps only the genuinely dynamic seals:

| leak | seal |
| --- | --- |
| use site names an unknown preset | build-voice error listing that subsystem's preset names |
| unknown key in any bag | config-load error — each subsystem's vocabulary is closed (typed AND runtime-checked; types don't protect dynamic configs) |
| dynamic preset name (`preset: someVar`) | error — literal only, the standing macro-argument law |
| one file globbed by two collections carrying different presets | NOT an error — each gets its own module variant (`?og_preset=`), by construction (v3.1) |
| a loader-macro glob matches zero files | loud warning (the folder() brace-glob dev bug is the precedent: silence ships broken) |
| empty preset | config-load error (a bundle with nothing is a mistake) |
| legacy spellings | rename map with pointed errors, never silent aliasing |
| config in a second home | not representable — `ogygia.extensions()` / `ogygia.preprocess()` / `handle()` stay value-free and must behave identically with or without plugin config (svelte-check path guarantees this today) |

Resolution: depth-2 replace (subsystem key → setting key; inner bags replace whole, no deep concat
of transformer arrays): inline option → preset → subsystem default → built-in.

Determinism: each artifact's **resolved** bag hashes into its build-cache key (`settle_key`
recipe) — a preset edit invalidates exactly the files, imports, calls, and collections that name
it.

**One flagged mechanical question (not a design risk):** how the runtime CMS render path receives
config *values* (bags hold functions; vite-config inline functions cannot be re-exported into the
server bundle). This is exactly today's delivery question for the single global markdown config —
v3 adds only a name lookup on whatever channel already exists. Verify the channel during
build-out; if today's channel turns out to be build-side only, request-time CMS markdown needs it
extended regardless of presets.

## Migration map

| old | new |
| --- | --- |
| `visible: {…}` | `regions.visible` |
| `presets: {…}` | `regions.presets` |
| `continuity: { forms }` | `router.forms` |
| `content.markdown` | **unchanged** |
| `router: false \| {…}` | unchanged |

## Open

- `regions` vs `region` as the subsystem key (lean plural: it governs all regions).
- Whether a collection-level preset may eventually carry non-markdown content vocabulary (typed to
  allow it; no v1 use case).

## Resolved during implementation research (2026-08-17)

- **The CMS door is NOT `content({ preset })`, and ships nowhere for now.** Verified: the source
  contract says `body` "is already a region" (source.ts:25); `render_markdown` has exactly one
  consumer, the build-time `md()` macro (vite/index.ts:1880); no `content/` runtime module imports
  any markdown machinery. There is no request-time markdown rendering for CMS bodies, so a
  `content()` preset option would configure nothing — omitted per the no-silent-no-op law. If a
  runtime "markdown string → region" helper ever ships for source authors, the preset name rides
  THAT call (name at the use site, same law) — not `content()`.
- v1 therefore has exactly one content door: the loader macro's `preset` option.

---

## Appendix: the rejected shapes

### v1 — "presets all the way down" (REJECTED)

One flat `presets` dictionary; the config top level as the unnamed base preset; every preset a
cross-cutting bag (island attrs + `markdown` + `image`), applied by use-site naming or an
`include` glob; a closed vocabulary table with scope classes (global-only/file/call/import) and a
seal table catching cross-kind references ("empty slice" errors), global-only keys in presets, and
shared-namespace collisions.

**Why it died (user, same day):**

1. "Content is not limited to markdown — it's the 80% consumer, but that's not all it is." v1
   collapsed `content.markdown` → top-level `markdown`, deleting the category because its *config*
   had one child — but the *domain* (collections, sources, site, emit, search, blocks) is a real
   subsystem. Categories earn existence from the domain, not from key count.
2. "The preset puts everything out in the open for each." One communal dictionary meant every use
   site reaches into an untyped-per-kind shared bag; the "empty slice" seal existed only to patch
   the leak the pooling created. A design that needs a rule to detect nonsense is worse than one
   where the nonsense cannot be typed.

### v2's `content.scoped` — path-scoped overrides (REJECTED)

Sovereign subsystems (which survived into v3) but with content varying by an ESLint-style ordered
array of `{ include: glob, …config }` entries.

**Why it died (user, same day):** "Content doesn't necessarily differ by path — content may be
fully CMS-driven, so path isn't it." The file tree is how *one kind* of collection enumerates, not
what a collection *is*. Scoping by path could never express a CMS corpus's flavor; the collection
definition can express every corpus's. v3's per-collection literal name replaced it, and dropped
the include/brace-glob/ordering seals wholesale (nothing to seal — the mechanism is gone).

**Durable pieces carried forward:** the seal-everything table discipline; sovereignty via types
(unrepresentable > detected); depth-2 resolution; literal-only names; the zero-match warning; one
matcher dev+build; resolved-bag cache hashing; value-free auxiliary touchpoints; the
rename-map-not-aliasing migration law.
