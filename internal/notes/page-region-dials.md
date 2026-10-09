# Page-level region dials — dynamic csr on the router

**Status:** design only (not built). A contained addition on top of the current builder router.

## The idea

Today `r.page(Comp)` renders the page as a **static** region: server HTML in the document, no
page-level JS, and islands *inside* the page wake as their own separate roots. That's ogygia's
csr=false default.

Letting a page carry the region dials (`render` × `wake` × `region:'raw'`) turns "csr" from Kit's
binary on/off into a **per-page, per-strategy spectrum** — and it stays entirely within ogygia's
csr=false, island architecture. There is no Kit `csr=true`, no patching. A "fully interactive page" is
simply **the whole page wrapped as one island**. Marking the page's `wake` makes the whole page a
single hydration root.

## The three dials (recap)

- **`render`** — where/when the HTML comes from: `static` (inline in the SSR pass) · `deferred`
  (fetched later from the signed endpoint) · `live` (baked, revalidates over SSE).
- **`wake`** — when JS runs (static) / when the HTML fetches (deferred/live): `load` · `idle` ·
  `visible` · `interaction` · `(media query)` · `none` (frozen — a lake).
- **`region: 'raw'`** — a modifier: HTML only, zero JS.

## The permutations, as a page-level thing

### `render: static` — page HTML lives in the SSR document

| `wake` | The page behaves as | csr meaning |
|---|---|---|
| *(unmarked)* | server HTML; inner islands hydrate on their own | **csr=false**, partial hydration — the default |
| `load` | whole page is one island, hydrates immediately | **csr=true** (SSR + full hydrate) |
| `idle` | static, then the whole page hydrates when the browser idles | csr=true, deferred TTI |
| `interaction` | zero page JS until the first pointer/key/focus, then hydrates (gesture replayed) | csr=true *on first touch* — mostly-static pages |
| `(media)` | hydrates only if the query matches (desktop yes, mobile no) | csr per viewport |
| `visible` | hydrates when scrolled in — for a whole page ≈ `load` unless below the fold | more useful on sub-regions than whole pages |
| `none` (lake) | frozen — no page JS **and** inner islands are frozen too | **hard csr=false**, guaranteed zero JS |

### `render: deferred` — page body fetched from the signed endpoint after the shell

| `wake` | The page behaves as |
|---|---|
| `load` | static shell instant (CDN-cacheable), per-visitor body fetched + hydrated → **PPR at the page level** |
| `visible` / `idle` | heavy / below-the-fold body fetched lazily |

### `render: live` — page body baked, revalidates over SSE

| `wake` | The page behaves as |
|---|---|
| `load` | the whole page updates in place as server data changes — a live dashboard/feed, no navigation |
| `none` + `raw` | live morph-in-place with **zero client JS** (raw HTML swaps) |

### `region: 'raw'` (modifier)

Pure server HTML, no runtime at all — even leaner than static-default (which still ships the runtime
for its inner islands). The absolute csr=false. Composes with `deferred`/`live` for zero-JS dynamic
bodies.

## The csr spectrum this gives you

Kit gives you `csr: true | false`. Page-level dials give the same axis, plus:

- **when** interactivity arrives: `load` / `idle` / `visible` / `interaction` / `(media)`
- **where the HTML comes from**: `static` / `deferred` / `live`
- **whether any JS ships at all**: `raw` / `none`

…chosen per page. And it's all the island mechanism you already have, so a "csr=true page" is just
"the whole page is one island" — no exception to the architecture, no Kit csr=true.

| You want | Dial |
|---|---|
| classic csr=false (shell static, islands hydrate) | *(unmarked)* — the default |
| hard csr=false (zero JS, nothing wakes) | `wake: 'none'` or `region: 'raw'` |
| csr=true (whole page interactive) | `wake: 'load'` |
| csr=true but cheap TTI | `wake: 'idle' \| 'interaction'` |
| csr per viewport | `wake: '(min-width: 900px)'` |
| PPR (static shell, dynamic body) | `render: 'deferred'` |
| live page (SSE updates) | `render: 'live'` |

## Caveats that matter

- **Nesting law applies.** A `wake` page is one hydration root, so inner island marks are ignored
  (closest-marked-parent-decides, dev-warns). It's whole-page OR island-level on a given subtree, not
  both.
- **Layouts are independent.** A static layout can wrap a `wake:'load'` page (interactive page inside
  static chrome), or you mark the layout too. Per node.
- **The SPA router.** A page-island re-hydrates per navigation (like any island), and the morpher swaps
  it. Add `keep` to persist its state across nav.
- **Data still serializes.** The page-island receives `data` via devalue (the same seed the router
  already injects); no function props (a page never had those anyway).

## API surface + implementation path

The region primitive already accepts a runtime dial — `region(Comp, props, (d) => ({ wake }))`. So the
router change is small: `r.page` gains an optional dials argument, and the render wraps the page region
with it.

```ts
r.page(Dashboard, { wake: 'load' })                    // whole page hydrates (csr=true)
r.page(Doc, { render: 'deferred', wake: 'load' })      // PPR: static shell, dynamic body
r.page(Feed, { render: 'live', wake: 'load' })         // live page over SSE
r.page(Marketing, { region: 'raw' })                   // zero JS
r.page(Settings, { wake: 'interaction' })              // interactive on first touch
```

Router side (sketch):

```ts
// today
const page = region(node.component, { data, form, params });
// with dials
const page = node.dials
  ? region(node.component, { data, form, params }, () => node.dials)
  : region(node.component, { data, form, params });
```

`document()` then emits the page-level `<ogygia-region hydrate|render|when …>` shell and the runtime
schedules it per the dial. Rides the existing dial machinery — no new runtime.

## Open question for the type layer

`r.page(Comp, dials?)` where `dials` are static literals keeps `$infer` unaffected (dials don't change
`data`/`params`/`form`). If we ever want the dial to depend on data (`(d) => ({ wake: d.live ? … }))`,
that's the per-data schedule form the region primitive already supports — but at page level a static
literal is almost always what you want.
