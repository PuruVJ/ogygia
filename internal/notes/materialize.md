# materialize — render-on-write pages (design draft)

> STATUS: design, not built. Grounded against se-web-platform (bcms) — see §Grounding.
> One sentence: **prerendering's cost model, with data mutations instead of deploys as the
> render trigger, at page (later region) granularity.**

## The idea

> **What the store holds — say it twice: THE RENDER.** The full rendered response (HTML, head,
> page seed, hole shells). A hit skips the data fetch AND the Svelte execution. `og.source()`
> caches no data — it is eviction bookkeeping: it answers "when must this stored RENDER die".
> Layer map (bcms): Akamai caches bytes at the edge (no invalidation today) · materialize caches
> the render at ORIGIN (bytes + tags — turns every Akamai miss/expiry/POP-fanout into a byte
> read; origin SSR count drops from O(misses) to O(publishes)) · Redis/Mongo/Builder cache DATA ·
> render-by-hash caches the render GIVEN fresh data (loads run, execution skipped on hash match).

Client islands made hydration opt-in per region; the server mirror makes EXECUTION opt-in per
request. A page whose render is a pure function of (route, params, declared vary bits) renders
ONCE per data change and is stored; requests concatenate bytes. Cost moves from O(requests) to
O(writes). Prerender is the special case where the only write is a deploy.

## Drop-in surface (classic Kit vocabulary — no remote functions required)

```ts
// vite.config — the SWITCH + policy: serializable data ONLY, baked into
// virtual:ogygia/materialize-config (the profiler-config pipe). This is the whole adoption:
ogygia({ materialize: true })          // tier-1 in-process store by default

// hooks.server.ts — LIVE OBJECTS (clients, creds from env): the decide({source}) grammar.
// Optional — only for tier 2/3. Functions/clients can't ride a virtual module, so runtime
// adapters can never live in vite config; hooks is guaranteed server-only + pre-first-request.
materialized.configure({ store: valkey(client), edge: [akamai(creds), cloudfront(cfg)] });
```

- **What gets stored — observed purity, not annotations.** The handle wraps the event it already
  owns and watches the render: reads of `cookies` / `locals` / request headers → that route stays
  per-request (dev note names the disqualifying read). Response-level guards: `set-cookie`,
  `cache-control: private`, non-200, streamed load promises, non-GET → never stored. Blind spot
  (documented, undetectable): `Date.now()`/randomness in loads — "true at render time", the same
  contract as prerender/ISR.
- **Tags — Kit's own `depends()` becomes server-effective.** `depends('app:product:42')` in a
  load is the cache tag (plus route+params automatically). Remote functions, where adopted, are
  a second automatic tag source (the flicker-fix capture already records which queries a render
  consumed, with args).
- **Invalidation — three sources, two of them free:**
  1. A successful form action auto-evicts its own route's entries (mirrors Kit's
     actions-invalidate-loads semantics). Zero new lines.
  2. `requested(query).refreshAll()` / `query.refresh()` — the single-flight law apps already
     follow — evicts by query tag. Zero new lines.
  3. Explicit: `materialized.invalidate(tag)` from any server code (CMS webhook endpoints).
- **Per-component opt-out = the existing dial.** Inside a materialized page, a component that
  must stay per-visitor/per-request is a `render: 'deferred'` hole — PPR semantics, unchanged.
  The page is the storage unit (Svelte SSR is one pass); regions are the later granularity
  (identity + props-hash keys — the wire law pays out again), reachable once held regions /
  queries are adopted.

## Storage tiers (compose downward, same keys + tags throughout)

| Tier | Where | When |
| --- | --- | --- |
| 1 (default) | in-process bounded LRU + optional disk (`.ogygia/materialized/`) | single-instance adapter-node; zero infra |
| 2 | pluggable KV `{ get, put(key, html, tags), evictByTag }` | replicas / serverless (shared store solves storage AND cross-instance invalidation) |
| 3 | the CDN itself: `Cache-Tag` headers from recorded deps + a purge-by-tag adapter | zero origin CPU *and* traffic; per-host purge adapters (least drop-in) |

**Tier 3 in the v1-no-sources world**: purge Akamai BY URL (Fast Purge; the publish payload
names the urlPath) and CloudFront by path — tags are NOT needed for page publishes. ONE built-in
tag survives sources' deletion: `Edge-Cache-Tag: locale:<locale>` (derived from the URL by the
handle, no markers) so the header-publish locale nuke is a single tag purge at Akamai + a
`/xx/yy/*` wildcard invalidation at CloudFront. Phasing: **A** = origin store only, zero infra
asks (edge keeps the blanket rule; no worse than today, origin misses collapse); **B** =
property flipped to honor-origin + purge creds → publish latency seconds everywhere, per-page
proven cacheability. Origin store stays valuable under a CDN: every edge REGION's miss becomes a
byte read instead of a render.

**Tier 3 on bcms's real topology (Akamai → Amplify/CloudFront → origin)** — "move the Akamai
rules into the store": the handle's eligibility verdict stamps per-response headers
(`Cache-Control: public, s-maxage=…` + `Edge-Cache-Tag: builder:page:<id>:<locale>, …`;
ineligible pages get `no-store` from the same verdict), the Akamai property shrinks to ONE rule
(honor origin), and `invalidate()` fans out: Valkey evict + Akamai Fast Purge **by tag** +
CloudFront **path** invalidation (no tag support there, but the Builder identity carries the
urlPath — precise per publish). Config: `materialize: { store, edge: [akamai(creds),
cloudfront({distributionId})] }`. Kills the blanket-bet problem: today's 7-day rule caches
everything and hand-maintained exception code (`applyPreferenceCenterCacheHeaders`) guards the
dangerous pages; with per-page proven headers those lists die. Costs: infra-team flips the
property to honor-origin (config lives outside the repo); EdgeGrid + CloudFront invalidation
creds; tags stay coarse (header/tag-count limits).

Keys: page = `route-id + params-hash (+ vary bits: locale…)`; region = `identity + props-hash`.
Dependency index: inverted `tag → keys` in the same store (native on tier 3).

**Adapter contracts (v1)** — two tiny interfaces; each impl ≈ a page of code:
- `MaterializeStore { get(key), put(key, Entry, {locale}), evict(url), evictWhere({locale}) }`
  with `Entry = page{html,headers} | redirect{status,location}`; valkey impl = key `og:m:<url>` +
  a per-locale index SET for the nuke + EX TTL backstop.
- `EdgeAdapter { headers(meta) — the edge's storage instructions (akamai adds cache-control +
  the one built-in `edge-cache-tag: locale:<x>`; cloudfront returns {}), purgeUrl(url) (Akamai
  Fast Purge /ccu/v3/invalidate/url; CloudFront CreateInvalidation by pathname),
  purgeWhere({locale}) (Akamai tag purge; CloudFront `/xx/yy/*` wildcard) }`.
- Fan-out lives in ogygia, not adapters: `invalidate(url)` = store.evict + allSettled purgeUrl
  across edges (one edge down ≠ request down); serve path merges every edge's `headers(meta)`
  onto the response AND into the stored entry.

## Relationship to what exists

The server-cost ladder already shipped: build-time (prerender/PPR, content prebake, `og.bake`),
TTL (deferred `maxAge` + the R6 endpoint render memo, `live`/SWR), per-nav delta (`serverDelta`),
per-request (default). Materialize is the missing rung: **write-time** — invalidated by data,
never by clock or traffic. R6 explicitly stopped short of page-granular compute ("off-limits
compiler"); materialize sidesteps that: the page stays monolithic, stored whole, with holes.

## Grounding: se-web-platform (bcms)

**Write path / tags.** CMS is Builder.io (`fetchOneEntry` via `loadBuilderContent`,
apps/web/src/lib/utility/loader.ts). Content identity = **(builder space/api-key, model,
urlPath, locale)** — a perfect natural tag, e.g. `builder:page:/fr/fr/solar:fr-FR`. Spaces/models
map per category (`packages/common/src/utils/builder_space.ts`: landing-pages→`page`,
insights-*, catalog-page, …). PES/product data proxies through env-configured hosts with its own
**Mongo data cache** (TTL 3600, keyed `name-country-locale-brand-type`) that already has
Bearer-gated clear endpoints (`_server/api/(rendering-machine)/cache/clear[-all]`) — a precedent
for an invalidation endpoint, but for API responses, **not pages**.

**The decisive gap: no page-level invalidation exists at any layer.** The ~7-day page cache is
**Akamai edge config OUTSIDE the repo** (cookie-less cache key; the app deliberately emits
audience-independent SSR — loader.ts:150 says so in words), fronting AWS Amplify (CloudFront).
No webhook, no purge, no surrogate keys, no revalidation — a Builder publish today waits out the
TTL. So materialize here is not an optimization, it is **the missing correctness layer**:
Builder publish webhook → `materialized.invalidate('builder:<model>:<urlPath>:<locale>')` →
fresh render — content latency drops from "up to 7 days" to seconds, while KEEPING the 7-day
cheap-read economics.

**Store tiers on their infra.** Tier 2 lands on the Redis/Valkey they already run (redis.ts,
VALKEY_CONNECTION_MODE); tier 3 is real for them twice over — Akamai supports
`Edge-Cache-Tag` purge and CloudFront has invalidation — so the endgame is: app emits cache
tags derived from the Builder identity + PES keys, publish webhooks purge by tag, Akamai keeps
serving bytes. The design's tag flow maps 1:1 onto their stack with no new infra.

**Ogygia state (relevant because holes must stay holes).** Fully wired: root + locale-tree
`csr=false`, Header/Footer/BootEffects islands, ~60 Builder blocks as `wake:'visible'` islands
via the component factory (landing-pages.ts), the `(pes)` subtree `csr=true` (mixed world). They
use ZERO `deferred`/`live`/held regions today — meaning nothing currently escapes the cached
document per-visitor; anything personalized that later appears must become a `deferred` hole for
materialize (and for their existing Akamai cache!) to stay correct. `render: 'live'` regions are
the self-freshening option inside the 7-day-cached pages until tag-purge lands.

**Loads / purity census (route families → verdicts).** No load in the tree calls `setHeaders`;
none stream (explicit "do not stream" comment); ONE form action exists in the whole app
(preference-center) — mutations live in BFF `+server` endpoints and external CMS publishes.
- **Materialize cleanly, keyed (urlPath, locale) + Builder content id**: the `[...catchall]`
  landing pages (the primary CMS renderer), FAQ, se_brand, Wiztopic newsroom, partner-channel,
  insights v1+v2 (v2 already Redis-memoizes its model resolution), techcomm (which ALREADY has
  publish webhooks — `_server/webhook/tc/publish-catalog-page` — the cleanest first wiring), and
  the locale layout data (header/footer/taxonomy/dictionary — pure per locale).
- **Materializable with a coarse vary bucket**: PES range/category listings — impure only via a
  consent cookie (gates hyperPES/Amazon Personalize) and a reverse-proxy header; variation is
  (locale, id, consent-bucket), never per-user. PDP `product/[id]` always 301s → store the
  REDIRECT, not HTML.
- **Never materialize** (correctly detected by observed reads): myschneider (~280 authed SPA
  routes), preference-center, digital-entitlement, carts, auth flows, builder-preview
  (unpublished by intent), ups-charts, PDF generators.
- **The detector nuance their code forces**: the PRIME family reads the session cookie
  (`knownUserId` hash embedded in output) yet is EXPLICITLY designed audience-independent —
  anonymous ⇒ `undefined` ⇒ one canonical render (Akamai already caches it cookie-less). A
  binary "read a cookie → disqualify" rule would disqualify their best pages. See deltas.

## Design deltas forced by the bcms grounding

1. **Vary-bucket keying replaces binary purity.** The store key extends to the FINGERPRINT OF
   OBSERVED INPUT VALUES: a cookie/locals read that resolved to its anonymous/default value
   (user=null, knownUserId=undefined) still materializes — that IS the canonical render (their
   CDN's cookie-less key, formalized). Non-default observed values → per-request in v1; bounded
   declared buckets later (`vary: ['consent']` for the PES case — two stored variants).
2. **The store holds redirects** (status + location), not just HTML — permanent-canonical 301s
   (their PDP) are the hottest cheap wins.
3. **Auto-tags from app-recorded render context, not only `depends()`.** Their loader already
   calls `updateRenderContext({ contentId, model, locale })` per render — apps that announce
   content identity get tagging for free via a tiny `materialized.tag()` (or an adapter reading
   such a context). `depends()` and queries remain the other two automatic sources.
4. **Layout-dependency tags for mass eviction.** The stored unit is the whole document, so the
   locale layout's inputs (header/footer Builder ids) tag every page in that locale — a header
   publish evicts the locale in one tag (`builder:header:fr-FR`); exactly what tier-3
   `Edge-Cache-Tag` purge is for.
5. **csr-agnostic.** Materialization is a render-layer concern; the `(pes)` csr=true subtree's
   pages store the same way (Kit hydrates them client-side regardless).

**Adoption path for bcms**: tier 2 on their existing Valkey → techcomm first (webhooks already
exist) → Builder publish webhook endpoint (their `_server/webhook/*` + Bearer-gated cache-clear
endpoints are the in-house precedent) → tier 3 Akamai tag purge when infra cooperates. Interim,
`render: 'live'` regions self-freshen drift inside today's 7-day cached pages.

## Internals (no compiler involvement — one handle layer)

Read path: key `(route-id, params-hash, vary-fingerprint)` → store hit returns bytes/redirect
BEFORE `resolve()` — Kit/loads/svelte never run. Miss path: hand `resolve()` an OBSERVED event
(proxied cookies/locals/headers recording reads + values), render normally, gate on
response (set-cookie/private/non-200/streamed) + observations (non-default read → skip), then
`store.put(key, html, bag.tags)`. Tags accumulate in the existing `request_als` RequestBag
(`materialized.tag()` + the flicker-fix query capture; `depends()` capture may need a shim —
Kit builds load events itself). Store = R6's shape + inverted tag index + redirect entries.
**Capability subtlety**: stored pages must mint PRERENDER-GRADE (effectively-forever)
capabilities for their deferred/live holes — normal `regionTtl` mints would expire in-store;
the prerender leg already does exactly this (requires stable `OGYGIA_SECRET`). Page seed is the
stored render's own snapshot — consistent by construction.

## RESTRUCTURE (user, 2026-09-01: "why source at all if the page is cached whole?") — v1 needs NO sources

The store's key IS the URL, and a Builder publish payload CARRIES its urlPath — so:
- **v1, zero markers**: `invalidate('/fr/fr/<urlPath>/')` for one-doc-one-URL publishes (the
  primary case: landing/insights/faq/se_brand); `invalidateWhere({ locale })` coarse nuke for
  shared content (header/footer — rare publishes, lazy re-render); a TTL backstop (≤24h) so
  nothing is stale forever. The flag + the webhook = the whole feature.
- **`og.source()` demoted to the v2 PRECISION upgrade**: it buys exactly ONE thing — the
  reverse index for one-document-on-many-unknown-pages (bcms reals: `enrichBuilderContent`
  referenced docs; insights "latest posts" carousels). Without it: locale nuke (over-evict) or
  TTL backstop (bounded staleness). With it: evict exactly the pages whose receipts name the doc.
  Adopt only if the embedded-content staleness window hurts in practice.

## Compiler-native design (user: "we're a compiler — full rights; make it vanish")

The runtime design asks "can we skip the render?" and needs observation + tags to stay safe.
The compiler inverts it: PROVE what every render depends on at build; address renders by inputs.

- **L1 — purity as a compile-time proof.** AST-walk the loads + their import graphs (the flag
  collector's machinery) → per-route manifest (`virtual:ogygia/materialize-manifest`, the
  route-csr pattern): `mode: store|never` with a SOURCE LOCATION for every "never", and `vary`
  dimensions DERIVED from seen `cookies.get(...)` calls. Observation proxies deleted; blind
  spots (Date.now in a load) become dev notes pointing at the line.
- **L2 — `import.meta.og.source()`: declared sources, typed string-free invalidation.**
  RULING (user, 2026-09-01): auto-wrapping awaits inside plain `.ts` loads is too much magic —
  compiler behavior belongs on `import.meta.og` (the macro law). The marker moves to the
  DEFINITION site of the data source, and everything else becomes boring runtime:
  ```ts
  export const loadBuilderContent = import.meta.og.source(async (event, category) => {…});
  // loads: untouched plain TS, forever.
  materialized.invalidate(loadBuilderContent, ['landing-pages', { urlPath, locale }]);
  ```
  Macro semantics (same laws as wire/asRegion): literal `export const X = og.source(fn)` only,
  AST-detected, loud error otherwise. The compiler stamps the id from THIS definition's
  `file#export` (root-relative; `<pkg>/<rel>` under ogygia.files — the identity rail) and
  rewrites to `__og_source('id', fn)`. Runtime wrapper: pass-through + (when a render is in
  flight) push `(id, fingerprint(args))` into the request ALS bag — event-shaped args
  canonicalize to `(route, params, locale)`; `{ key: (…args) => …}` option for exotic
  signatures. `invalidate(fn, args)` reads the stamp off the function — one side, no strings,
  typos are type errors. Calls are tracked WHEREVER they happen (load, helper, six frames deep).
  **Deleted by this ruling**: the load-body await-transform, the entire resolution+shape
  discrimination rule, and the `sources:[…]` allowlist valve — the macro IS the allowlist,
  declared next to the thing it describes. (The earlier auto-wrap design is preserved in git
  history; do not resurrect — it rewrote user logic in regular ts files.)
  bcms cost: ~3 markers (loadBuilderContent, loadFooterHeader, fetchPESData); zero load changes.
- **L3 — content-addressed renders (the vanish).** The wire law makes a region's serialized
  captured props its COMPLETE input set → memoize region renders by `(identity, props-hash)`:
  no tags, no eviction, no staleness — data changes ⇒ props change ⇒ key rotates ⇒ old entries
  LRU out. Correct by construction. Not "off-limits" compiler surgery: placements compile to
  the held-region out-of-band render we already emit, splicing stored HTML. One level up:
  **render-by-hash** for the page shell — run loads (data always fresh), hash the data, look up
  the rendered document by hash. Skips component execution (the profiler-dominant cost) with
  NOTHING to invalidate. True load-skipping materialize then shrinks to an opt-in crust on
  L1-proven routes with L2 invalidation.
- **Build order**: L3 render-by-hash (zero-risk, immediate CPU win) → L1 manifest → L2 + load
  skipping.

## Open questions

- **Page-level SWR (revalidate-on-load)** — the no-write-hooks fallback: when the cached page
  lives in a CDN we can't purge by tag (bcms's 7-day cache today), let the whole document re-SSR
  once after load and MORPH changed regions (the router/live-partial morph machinery exists).
  Region-level already exists as `render: 'live'`; page-level would bridge until (or instead of)
  materialize where invalidation can't be owned. Decide: worth a `page`-level dial, or is
  marking the drifting regions `live` always enough?

- Eager re-render on evict (hot paths) vs lazy render-on-next-read (default)?
- Vary dimensions beyond params (locale headers? currency?) — explicit `vary` declaration or
  observed-and-refused?
- Streamed loads: always per-request, or await-to-completion for materialization?
- Tier-3 purge adapters: which hosts first (their CDN)?
