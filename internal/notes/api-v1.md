# ogygia API v1 — one model for the whole library (design, not built)

Status: PROPOSAL, 2026-10-05. Needs a user go before any code (api-surface sign-off rule).
Prerelease: clean breaks are allowed; every removal gets a pointed error and a codemod step.

Inputs: three inventories run today (core API, server products, docs/vocabulary), the frozen
fragments design and its ~100-item footgun sweep (`frozen-fragments.md` §16-17). Every
"today" claim below comes from those inventories, with file refs there.

## 0. The problem in one paragraph

ogygia grew feature by feature. Each feature got its own words, its own config pattern and its
own cache. Today there are five ways to configure a product (vite option, `configure()` on a
namespace, a bare setter from another subpath, a runtime call, a route export), five unrelated
caches (frozen pages, the hole render cache, the federation peer cache, profiler storage, the
client frame store), durations in µs/ms/s/days with bare numbers meaning different units in the
SAME preset key (`maxAge`: seconds for deferred, ms for live), three meanings of "frozen", three
of "live", three of "source", two exports named `memoryStore`, and a fetch schedule called `wake`
on holes while `wake` means "run JS" everywhere else. Frozen fragments, built the same way,
would be one more appendage with its own words and its own store. This design instead finds the
model the features were all approximating, and makes each feature one cell in it.

## 1. The model

ogygia decides four things for every piece of UI:

| Axis | Question | Dial |
|---|---|---|
| **HTML source** | Where does the first HTML come from? | `render: 'inline' \| 'deferred' \| 'build'` |
| **Freshness** | How long can rendered HTML be reused, and when is it refreshed? | `cache`, `revalidate`, `vary` |
| **JS** | When does code run in the browser? | `wake` |
| **Lifetime** | Does it survive navigation? | `keep` |

And it applies them at three **scopes**, with the same words at each:

| Scope | What | Where the dials go |
|---|---|---|
| **Region** | one component placement | import attributes (`with { … }`) or a preset |
| **Page** | a Kit route's whole document | route exports (`export const cache = '1h'`) |
| **Remote** | a document or widget from another app | `peer.page(path, { … })` |

Every current feature is a point in this space:

| Today | Under v1 |
|---|---|
| island (`wake: 'load'`) | region, `wake: 'load'` |
| lake (`wake: 'none'`) | region, `wake: 'none'` |
| server island / hole (`render: 'deferred'`) | region, `render: 'deferred'` (+ `fetch` schedule) |
| hole with `maxAge` (in-process R6 cache) | region, `render: 'deferred', cache: '5m'` (shared store, purity-checked) |
| live region (`render: 'live'`) | region, `render: 'inline', revalidate: '30s'` |
| **frozen fragment (new)** | region, `cache: '1h'` (inline render, stored) |
| frozen page (`export const freeze = true`) | page, `export const cache = '1d'` |
| federation peer cache (`cache: { ttl }` in ms) | remote, `cache: '5m'` |
| `og.code` / `og.md` / `og.bake` regions | region, `render: 'build'` (generalized: any component) |
| "fully interactive page" (page-region dials note) | page, `export const wake = 'load'` |

Two things fall out that don't exist today and aren't appendages:
- **`render: 'build'`** for any component: rendered once at build, pasted forever (the "baked
  fragments" idea, and the generalization of `og.code`/`og.md`).
- **Page `wake`**: a whole page as one island, the `page-region-dials.md` thesis, with no
  `csr = true`.

## 2. The region grammar (import attributes)

```svelte
<script>
  import Counter  from './Counter.svelte'  with { wake: 'visible' };
  import Weather  from './Weather.svelte'  with { render: 'deferred', fetch: 'visible', cache: '5m' };
  import Header   from './Header.svelte'   with { cache: '1h', vary: 'locale' };
  import Ticker   from './Ticker.svelte'   with { revalidate: '30s' };
  import Logo     from './Logo.svelte'     with { render: 'build' };
  import Nav      from './Nav.svelte'      with { preset: 'chrome', wake: 'idle' };
  import Picker   from './Picker.svelte'   with { held: 'true' };
</script>
```

| Dial | Values | Applies to | Today |
|---|---|---|---|
| `render` | `inline` (default) · `deferred` · `build` | all | `static` · `deferred` · `live` |
| `fetch` | `load` · `idle` · `visible` · `interaction` · `media(…)` | `deferred` | `wake` (overloaded) |
| `prefetch` | same values | `deferred` | same |
| `stitch` | `server` · `edge` | `deferred` | `serve` · `edge` (presets also `true`) |
| `cache` | duration · `false` | `inline`, `deferred` | `maxAge` (preset only, unit by mode) |
| `revalidate` | duration · schedule | `inline`, `deferred` | `render: 'live'` + `wake`/`revalidate` |
| `vary` | comma list of bucket names | with `cache` | new |
| `wake` | `none` · `load` · `idle` · `visible` · `interaction` · `media(…)` | all | same (hole meaning removed) |
| `keep` | navigation key | `wake` ≠ `none` | same, silently dropped elsewhere |
| `margin` | CSS length | `visible` schedules | preset only |
| `preset` | name | all | must be the only key |
| `held` | `'true'` | `.svelte` and `.ts` | `region: 'raw'` |

Rules (each one fixes an inventory finding):
1. **Every dial is allowed inline.** The preset-only list (`margin`, `maxAge`, `onExpire`,
   `revalidate`) goes. A preset is a named bundle, not a privileged channel.
2. **`preset` combines with inline overrides**, inline wins. Today it must stand alone.
3. **A dial that doesn't apply is an error, never ignored.** `keep` on a lake, `fetch` on an
   inline region, `cache` on `render: 'build'`. Today `keep` is silently dropped on three paths.
4. **Durations are strings with units, everywhere**: `'500ms' | '30s' | '5m' | '1h' | '7d'`.
   Bare numbers are an error with a pointed message. This kills the `maxAge` seconds-vs-ms bug.
5. **One meaning per word.** `wake` = browser JS, only. `fetch` = when a deferred region's HTML
   is requested. The DOM's `when` attribute becomes `fetch`; its `hydrate-margin` folds into
   `margin` + `fetch-margin`.
6. **Values that can't be strings never go in attributes or presets.** Vary readers, stores,
   flag providers are runtime objects (§4). Presets are JSON (they already travel as
   `JSON.stringify`).
7. **`asRegion(Comp, {…})` takes exactly this grammar** (today its type omits `stitch`/
   `prefetch` and docs show a string form the parser rejects).
8. **`importKeys` renames apply everywhere** (today renaming `render`/`wake` breaks presets).
   Or drop `importKeys`; no known user needs it. Recommend drop.

Composition table (what you get):

| `render` | `wake` | `cache` | Result |
|---|---|---|---|
| inline | — | — | plain SSR component (no ogygia cost) |
| inline | load… | — | island |
| inline | none | — | lake |
| inline | — / any | `1h` | **cached fragment**: stored markup pasted, holes inside re-signed |
| inline | — / any | — + `revalidate` | self-refreshing region (today's live) |
| deferred | — | — | server island (hole) |
| deferred | load… | — | server island that wakes after arrival |
| deferred | — | `5m` | server island, shared cache across instances and visitors-without-personal-reads |
| build | — / any | — | rendered at build, pasted forever |

## 3. The page grammar (route exports)

Route files get the same words as regions. ogygia's compiler already reads and strips route
exports (`compiler/kit.ts:127-193`) and cascades them like `csr`:

```ts
// +page.ts / +layout.ts
export const csr = false;            // Kit's own; ogygia pages stay csr=false
export const cache = '1d';           // was: export const freeze = true (+ config ttl)
export const vary = 'locale';
export const wake = 'load';          // NEW: the whole page is one island (page-region dials)
```

- `cache` replaces `freeze`, with the same lifetime grammar as regions (§5).
- `vary` replaces "query strings never store, everything else binary" with declared buckets.
- `wake` on a page: the page component is hydrated as one island on a `csr=false` page. This is
  `page-region-dials.md` landing on Kit routes instead of the server router.

## 4. Configuration: two files, one rule

> **Build-time, serializable → `vite.config`. Runtime, live objects → `hooks.server.ts`.**
> Nothing else configures ogygia.

```ts
// vite.config.ts — build-time, JSON only
ogygia({
  regions: { margin: '200px', presets: { chrome: { cache: '1h', vary: 'locale', wake: 'idle' } } },
  cache:   { pages: false, defaultLifetime: '1h' },     // was: freeze: { ttl, default }
  navigation: { viewTransitions: true, forms: true, serverDelta: false },   // was: router
  security:   { capabilityLifetime: '1h', sessionCookie: false, rateLimit: { max: 60, window: '1m' } },
  content:  { markdown: {}, presets: {} },
  devtools: true,
  profiler: { path: '/__profiler', sampleInterval: '500us' },
  barrels:  true
});
```

```ts
// hooks.server.ts — runtime, live objects
import * as ogygia from 'ogygia/server';
import { redis, cloudflare } from 'ogygia/cache';
import { openfeature } from 'ogygia/flags';
import { sqlite } from 'ogygia/profiler/storage';
import { peers } from '$lib/peers';                    // federate({...}) lives in a module

export const handle = ogygia.handle({
  cache:      { store: redis(client), edge: cloudflare({ … }), vary: { consent: (e) => e.cookies.get('consent') ?? 'none' } },
  flags:      { provider: openfeature(client), onExposure: send },
  federation: peers,
  profiler:   { store: sqlite() },
  transform
});
```

What this replaces:
- `freeze.configure()`, `decide()`, `setProfilerStore()`, devtools `configure()`, the exported
  `install_federation`/`serve_federation`, `routes({ flags, freeze, visitor })`.
- The doc claim "profiler configured ENTIRELY in vite config" that its storage contradicts.
- Grouping: `sessionCookie`, `rateLimit` and `regions.ttl` (capability lifetime) all move under
  `security`: they are one concern (hole capabilities), today scattered across three places.
- `profiler.enabled` (a second on/off switch next to `profiler: true`) goes.

## 5. One cache, every scope

`ogygia/cache` replaces `ogygia/freeze`, `ogygia/freeze/source`, the R6 hole render cache and
the federation peer cache. One store layer, one observer, one lifetime grammar, one invalidation
API, one event stream.

### Lifetime grammar (same at region, page, remote)

```ts
cache: '1h'                                   // shorthand
cache: { lifetime: '1h', swr: '5m', staleIfError: '7d', refreshAhead: true }   // preset/route object
```

### Purity: one observer service for all scopes

The page observer (`freeze/observe.ts`) becomes a core service used by every cached render,
including hole renders (today unobserved: a `maxAge` hole's answer is shared across all visitors
with `sessionCookie` off). Same law everywhere: default-valued reads are the canonical render;
undeclared personal reads refuse; declared `vary` buckets are allowed. Sweep fixes land here once
(Headers proxy, `event.fetch`, claims via `user()`, geo headers).

### Vary: named buckets

Built-ins: `path`, `params`, `locale`, `search`, `day`, `auth-state`, `device`,
`variant:<flag>`. Custom buckets are registered at runtime by name (`handle({ cache: { vary } })`)
and used by name in attributes, presets and route exports.

### Tags: one vocabulary

`source:<id>:<fp>` (og.source receipts) · `component:<identity>` · `path:<prefix>` ·
`peer:<name>` · `build:<app>`. Edge header tags are derived from the same list. Today `p:` means
both an edge prefix tag and a thaw-notice path.

### One verb set

```ts
import { cache } from 'ogygia/cache';

cache.invalidate('/fr/fr/solar/');            // a URL
cache.invalidate({ prefix: '/fr/fr/' });      // a subtree (root '/' = everything; fixed today)
cache.invalidate(Header);                     // every variant of a cached component
cache.invalidate(Header, { locale: 'fr' });   // one variant
cache.invalidate(loadNav, ['fr']);            // an og.source + args
cache.invalidate(peers.cms);                  // everything a peer fed us
cache.warm(Header, props, { locale: 'fr' });  // render now (render-on-write)
cache.peek(Header, …);                        // what's stored, age, tags
cache.pin(Header) / cache.rollback(Header);   // incident tools
```

Replaces `freeze.invalidate`, `freeze.invalidateWhere`, `Peer.drop`, inbound thaw verbs,
`render_cache_clear`, and the nonexistent `freeze.invalidateApp` the federation docs cite.

### Adapters

| Kind | v1 factories (`ogygia/cache`) | Today |
|---|---|---|
| store | `memory()` · `redis(client)` · `upstash({…})` · `cloudflareKv(kv)` | `memoryStore` · `valkey` · same · same |
| edge | `akamai({…})` · `cloudfront({…})` · `cloudflare({…})` | + duplicate `awsCloudfront` |

`CacheStore` is always async, gains optional `getMany` (batched fragment reads) and a
generation counter per tag (the invalidation-race fix). `redis` accepts ioredis or node-redis
(the profiler already wraps both; one shim for both products).

### What each scope adds on top

- **Page**: whole-document capture, edge headers, ESI (`stitch: 'edge'` holes), single-flight.
- **Region (inline)**: the frozen-fragments machinery: placeholder + stitch, journal + replay,
  holes re-signed at stitch (`frozen-fragments.md` §17 corrections apply).
- **Region (deferred)**: the hole answer stored in the shared store (not per-process), browser
  `max-age` derived from the lifetime.
- **Remote**: the peer cache moves into the store (shared across instances; today an
  in-process Map), thaw notices become `cache.invalidate(peer)`.

## 6. Entry points

| v1 | Contents | Today |
|---|---|---|
| `ogygia` | `Region`, `Provide`, `region()`, `requestEvent()`, `keepFallback()`, `preference()`, `script()`, `hydratedBy()`, `isOgygiaPage()`, `SharedState` | + `og_derived`, `createContext`, `__tag_context`, `Boundary`, `transport` (gated copy) |
| `ogygia/vite` | `ogygia()`, `debarrel()` | + 12 internal helpers |
| `ogygia/server` | `handle()`, `transport`, `scanRegions`/`liftRegions`/`restoreRegions`, `transformMarkup` | split across `server`, `hooks` (alias), `markup` |
| `ogygia/navigation` | Kit-shaped navigation API for csr=false pages | `ogygia/app` (+ `bust_page_cache`, `spa_html_cacheable`; misses `pushState`/`replaceState`/`onNavigate` the shim has) |
| `ogygia/cache` | `cache`, stores, edges | `ogygia/freeze`, `ogygia/freeze/source` |
| `ogygia/flags` | `flag()`, `openfeature()`, `ofrep()` | `ogygia/flag`, `ogygia/flag/openfeature`, + exported internals |
| `ogygia/federation` | `federate()`, `mount()`, `user()` | + `serve_federation`, `install_federation`, signing helpers |
| `ogygia/profiler` | `span()`, `tag()`, `instrument()` | + `set_span_recorder` |
| `ogygia/profiler/client` · `/storage` | `mark()` · `memory()`, `sqlite()`, `redis()`, `postgres()` | `memoryStore`, `sqliteStore`, … |
| `ogygia/devtools` · `ogygia/testing` | unchanged surface, camelCase | snake exports |
| `ogygia/content` (+ `/server`, `/markdown`, `/vite`, `/components`) | unchanged surface, camelCase | `/slot`, `/docs-shell` as separate entries |
| `ogygia/types` | ambient types, generated from one source | two hand-synced files (17 vs 34 modules) |
| `ogygia/internal/*` | everything compiler/runtime-internal, undocumented, may change | 9 published subpaths mixed with public ones |

Removed: `ogygia/hooks`, `ogygia/markup`, `ogygia/app`, `ogygia/freeze*`, `ogygia/flag*`,
`ogygia/router`, `ogygia/router/client` (§8).

## 7. Naming law (one prefix, one casing, one word per idea)

- **Prefix `og` for everything in the DOM and on the wire**: elements `<og-region>`,
  `<og-slot>`, `<og-provide>`, `<og-late-slot>`; attributes `data-og-*`; events `og:*`
  (`og:hydrated`, `og:after-swap`); cookies and params `og-*` (`og-vid`, `og-exp`,
  `og-devtools`). Today: `ogygia-`, `og-`, `data-ogygia-`, `data-og-`, bare `og-h`, `ogygia:` and
  `og:` events, `og_devtools` with an underscore.
- **Public JS is camelCase, with no exceptions.** No snake_case in any public barrel
  (`og_derived`, `bust_page_cache`, `spa_html_cacheable`, `match_path`, `prime_flags`,
  `add_sink`, `escape_svelte`, …). Internals stay snake_case behind `ogygia/internal/*`.
- **Adapter factories are bare nouns** (`redis()`, `sqlite()`), never `…Store`, never two exports
  for one function.
- **One word, one meaning** (the glossary becomes the source of truth and the docs lint against
  it):

| Word | v1 meaning only | Retired meanings → new word |
|---|---|---|
| island | a region whose JS runs (`wake`) | — |
| lake | `wake: 'none'` static HTML inside an island | "frozen" (lake) → lake |
| server island | `render: 'deferred'` region | "hole" stays internal only |
| cache / cached | stored rendered HTML, any scope | "frozen page", "freeze", "thaw" → cached page, cache, invalidate |
| live | (retired) | `render: 'live'` → `revalidate`; live held regions → `query.live` stays Kit's term |
| source | `og.source` data source (cache receipts) | content source → **loader**; flag source → **provider** (OpenFeature's own word) |
| frame | internal wire unit only | content `Frame` shell → `Shell` |
| keep | survive navigation | `og-keep` transform restore list → `og-restore`; `trap.keep`/`barrels.keep` → `retain` |
| sink | devtools event consumers only | flags `exposure` → `onExposure`; profiler `sink` → `export` |
| fallback | what shows before a region's HTML | `<Region placeholder>` + `ogygiaFallback` → one name: `fallback` / `{#snippet ogFallback()}` |
| preload / prefetch | `prefetch` = warm on a schedule; `preload(region)` = warm now | removed `regions.preload` stays an error |

## 8. Cuts and merges

1. **Server router: cut.** Nobody uses it (user, 2026-10-05), and the sweep showed its cost:
   router documents bypass `transformPageChunk`, so every document-level feature needs a second
   implementation (`document()`, `stream_document`, late regions, `doc_asks`). Kit routes become
   the only page model; page dials (§3) give them what the router offered (page-as-island, cache,
   streaming via Kit). `routes`, `page`, `layout`, `load`, `action`, verbs, `api()` client go.
   `anonymousVisitor` moves to `ogygia/flags` (it's flag identity).
2. **Federation over Kit routes.** `expose: router` goes with the router. A peer exposes Kit
   pages instead: the handle answers `/og/fragment/page?path=…` by calling `event.fetch(path)`
   with an internal header (same-origin `event.fetch` runs Kit's handle in-process, no network)
   and lifting the result into a `FragmentDocument`. Widgets (components) are unchanged.
   Federation stays marked experimental.
3. **Context: two APIs, not three.** `<Provide>` and the drop-in `setContext` stay. ogygia's
   `createContext` goes: Svelte now ships its own `createContext`, which the bridge supports
   directly (one less name that collides with the platform). `__tag_context` (ABI no-op) goes.
4. **Transportables: one macro.** `import.meta.og.$` covers functions, stores and wired values;
   `import.meta.og.store` and `og_derived` fold into it. Auto-branding stays as the implicit path.
5. **`Boundary`**: rename the file to match the export, or drop it (annotation-only, no
   behaviour). Recommend drop.
6. **`render: 'live'` → `revalidate`.** It compiles to a lake with a remount today; the DOM says
   `wake="none" remount="swr"`. As a dial it composes with both inline and deferred.
7. **`importKeys`**: drop (no known user; renaming breaks presets today).
8. **`script()`**, `preference()`: keep; document (both undocumented today).

## 9. Observability: one event per decision

- Devtools gets a domain per product: `server.cache` (scope: page | region | deferred | remote;
  outcome: hit-l1 | hit-l2 | miss-stored | miss-refused(reason) | bypass(reason) | stale), plus
  `server.flags`, `server.federation`. Today only frozen pages emit, and only on string-URL
  invalidations.
- One "why not cached?" view in the Page tab, fed by the shared observer: every refusal names
  the read (`cookie:consent`, `page.url.pathname`, `flag:checkout`), never the value.
- Server-Timing names all start `og-`.
- The profiler reads the same events: fragment time as its own line, the candidate finder and
  TTL advisor from `frozen-fragments.md` §11.

## 10. Errors: one policy

| Kind | Behaviour |
|---|---|
| Config or attribute mistake | build error, pointed, with the fix (`maxAge: 300` → "durations need a unit: '5m'") |
| Removed API | build/runtime error naming the v1 replacement (the `LEGACY_OPTION_RENAMES` pattern, extended) |
| Runtime product failure (store down, provider down, peer down) | degrade, one log line, one devtools event; never fail the page |
| Programmer error at runtime (invalidate an undeclared source) | throw |

## 11. What this means for frozen fragments

They stop being a feature with a name. `cache` on an inline region is the whole surface:

```svelte
import Header from './Header.svelte' with { cache: '1h', vary: 'locale' };
```

Everything in `frozen-fragments.md` §2-§17 stays as the implementation of that cell, using the
shared store, observer, vary, tags and verbs instead of its own. The open naming question there
(§18.0, "frozen" clashes with lakes) is answered: `cache`.

## 12. Migration

- `npx ogygia migrate`: rewrites import attributes (`render: 'live'`, `region: 'raw'`, hole
  `wake` → `fetch`), route exports (`freeze` → `cache`), config keys, entry points, renamed
  exports, DOM selectors in app CSS (`ogygia-region` → `og-region`).
- Old names fail with pointed errors for one minor version, then the errors stay as plain
  "unknown" errors.
- Docs: glossary first (single source), then the getting-started path, then each page against
  the glossary. The auto-generated API reference covers every public entry (today 8 of ~40).

## 13. Build order

1. **Laws** (no behaviour change): naming/prefix/casing sweep, duration grammar, entry points,
   `internal/*`, errors for removed names, codemod skeleton, generated ambient types.
2. **Cache core**: `ogygia/cache` store layer + observer service + tags + verbs; frozen pages
   move onto it (fixing the sweep's frozen-page bugs on the way); hole cache and peer cache move
   onto it.
3. **Region dials**: `fetch` split from `wake`, `revalidate`, inline everything, preset
   overrides, strict "doesn't apply" errors.
4. **Cached regions** (frozen fragments) on the cache core.
5. **Pages**: route-export dials, page `wake`; cut the server router; federation over Kit routes.
6. **`render: 'build'`**, the extensions (shadow check, TTL advisor, warm on publish).

## 14. Open decisions (asked one at a time)

1. **The model**: one `cache` dial at region, page and remote scope, replacing freeze, the hole
   cache and the peer cache (recommended) vs keeping frozen pages separate and adding fragments
   beside them.
2. **"Router"**: cut the server router (`ogygia/router`) and keep the client navigation for
   csr=false pages, renamed `navigation` (recommended reading of "router is not used") vs cut both.
3. **`fetch` as the deferred schedule word** (recommended) vs `load`/`when`.
4. **Prefix `og` everywhere** (`<og-region>`, recommended) vs `ogygia` everywhere.
5. **Public name for deferred regions**: "server island" (recommended: Astro's familiar term) vs
   "hole".
6. **Page `wake`** (whole page as one island) in v1 (recommended, it's the page-region-dials
   thesis on Kit routes) vs later.
