# frozen fragments — design v2 (not built)

Status: DESIGN, 2026-10-05. Nothing here is implemented. The public surface needs a user go
before any code (api-surface sign-off rule).

**Read §17 before §2-§14.** A footgun sweep (§16: Kit + five ogygia feature areas) changed the
stitch points, the key, the context rule and the signing model; §17 lists every change and wins
where it disagrees with earlier sections.

v2 change (user): **placeholder + stitch**, not "wait in place". The page render never waits on
the store. The component leaves a marker, the store read runs in the background, and the
handle fills the marker before the response leaves. v1 of this note (await during render)
is replaced; its research findings are kept in §15.

## 1. The ask

> "I have a header which is static on client but very heavy on server, and it has multiple
> holes in it. The holes are fine as is, but it's the one component I want to do the Redis
> thing on, like the frozen one."

One plain (non-island) component's server markup is kept in the freeze store and pasted into
later page renders. The rest of the page renders per request. Holes inside keep working.

What it is NOT:
- Not a hole: no extra browser request, no fallback flash.
- Not a frozen page: loads still run; the page around it is per request.
- Not the R6 hole render cache (in-process, hole endpoint only, no invalidation).
- Not a lake (`wake="none"` is a client idea; it says nothing about server cost).

## 2. How it works

### The timeline of one request

```
page render (Kit, one pass)                          handle (transformPageChunk)
──────────────────────────────────────────────       ─────────────────────────────────────
… layout …                                           
<Header nav={…}/> → wrapper:                         
   key = frag(build, identity, props, vary…)         
   emit  <!--og-frag:NONCE:0-->                       
   bag.frags[0] = {key, component, props, ctx}       
   store.get(key)  ─────── in flight ───────┐        
… rest of the page renders …                 │        
                                             ▼        chunk with the marker arrives:
                                                       await bag.frags[*].read
                                                       HIT  → body + journal
                                                       MISS → render Header now (isolated,
                                                              with the saved contexts),
                                                              build the entry, put (deferred)
                                                       replace marker with body
                                                       replay journal (head bits, claims,
                                                              page asks, tail calls)
                                                       … then the usual seeds/tail/head work
```

- **Hit**: the header's component code never runs. The cost is one store read that already
  happened while the rest of the page rendered, plus one string paste.
- **Miss**: the header renders at the end, not in the middle. Server JS is single-threaded, so
  the CPU cost is the same either way. The only loss is overlap with I/O the page was waiting on.
- **Marker**: an HTML comment carrying a per-request random nonce (`<!--og-frag:k3x9:0-->`).
  User content (CMS `{@html}`) can't fake it. Found with `indexOf` on the nonce, no regex.
- **Where stitching runs**: inside ogygia's existing `transformPageChunk`
  (`hooks.ts:1013`, `inject_client_seeds`), as its FIRST step. That ordering matters: the
  journal's page asks and tail calls land in the bag BEFORE the seeds and document tail are
  built in the same pass. So replay gets the real dedupe for free.
- **Streamed pages**: each chunk is scanned for the nonce. A fragment in a later chunk can't
  put tags in a `<head>` that already left, so its head bits go inline right before it
  (a body `<link rel=stylesheet>` works; it blocks only from that point).

### Why placeholder + stitch beats wait-in-place

| | wait in place (v1) | placeholder + stitch (v2) |
|---|---|---|
| Needs Svelte async mode | yes | **no** |
| Page render blocked on Redis | at that spot | **never** |
| Replay of side effects | inside Svelte, scattered | **one place, before seeds/tail** |
| Tail journaling (seed refs, shared sidecars) | hard (tail is live) | **easy (tail not built yet)** |
| Holes re-minted per visitor | extra pass | **same pass** |
| Nested fragments resolved together | serial | **one batched read** |
| Miss cost | overlaps the render | after the render (same CPU) |

## 3. Surface (NEEDS SIGN-OFF)

Recommended: a fourth `render` mode on the existing import-attribute grammar.

```svelte
<script>
  import Header from './Header.svelte' with { render: 'frozen' };
  let { data } = $props();
</script>
<Header nav={data.nav} locale={data.locale} />
```

- `render: 'static'` already means "inline HTML". `'frozen'` reads as "inline HTML, kept".
- Lifetime and vary live in presets, matching the rule that `maxAge`/`margin` are config, not
  inline (`compiler/region/transform.ts:1129`):
  ```js
  ogygia({
    regions: { presets: { header: { render: 'frozen', maxAge: '1h', vary: ['locale'] } } },
    freeze: { store: valkey(…) }
  })
  // import Header from './Header.svelte' with { preset: 'header' };
  ```
- `maxAge` already exists on `OgygiaPreset`. For `frozen` it means store lifetime.
- Invalidation by the imported value, no strings: `freeze.invalidate(Header)`,
  `freeze.invalidate(Header, { locale: 'fr' })` (only that variant).

Other surfaces worth having later (same machinery):
- **Config by file, zero code change**: `freeze: { fragments: { 'src/lib/Header.svelte': 'header' } }`.
  Ops can turn it on without touching components.
- **Component-side**: `export const freeze = 'header'` in Header's `<script module>`.
- **Kill switch**: `freeze.fragments.enabled` readable through `flag()`, to turn every fragment
  off in an incident without a deploy.

Rejected: a `<Frozen>` wrapper (children are a snippet; their inputs can't be hashed, so a
hand-written key is needed and easy to get wrong silently).

## 4. The key

```
frag:<app>:<code-hash>:<identity>:<host>:<props-hash>:<vary…>[:d<depth>]
```

- `app`: the app name, so two apps sharing one Redis never collide.
- `code-hash` (NEW, replaces "build id"): a hash over the component's compiled module, its
  import closure, and the asset file names it references. The compiler knows this graph.
  **An unchanged header survives deploys warm.** A build id in the key would make every deploy
  start every fragment cold. Fallback when the graph is unknown: Kit's `version.name`.
- `identity`: the component's root-relative file id (ogygia's identity rail).
- `host`: on by default. One app serving several domains must not paste domain A's header on
  domain B. Opt out with `vary: { host: false }`.
- `props-hash`: fnv1a over devalue-stringified props (existing ref reducers). Props must be
  serializable; a function, snippet or `children` prop → compile error naming it. Optional
  `ignore: ['trackingId']` drops props that don't change markup.
- **Props are safe by construction.** `<Header user={data.user}/>` gives one entry per user:
  never a leak, just a poor hit rate (the cardinality guard in §8 then says so).
- `vary`: named buckets resolved per request.
  - Built-ins: `'path'`, `'params'`, `'locale'`, `'search'`, `'day'` (for "© year", "open
    today"), `'auth-state'` (anon/signed-in, never the user), `'variant:<flag>'` (one copy per
    A/B arm), `'device'` (from `sec-ch-ua-mobile`: mobile/desktop).
  - Function form: `vary: [(event) => event.cookies.get('consent') ?? 'none']`.
  - Declared buckets are the only personal-ish reads the purity check allows (§8).
- `depth`: Kit's `paths.relative` (default on) makes `resolve()` / `asset()` return `../`
  paths during SSR, so the header's own `<a href>` changes with URL depth. With relative paths
  on, depth joins the key. ogygia's own URLs are made absolute at capture, so only user markup
  needs it.

## 5. Capture (miss) and replay (hit): ONE path

The miss path renders, turns the result into an entry, then REPLAYS that entry exactly like a
hit. Hit bytes == miss bytes, by construction, and one test proves both.

### Capture

1. Isolated `render(Component, { props, context, idPrefix: 'f' + key6 })`, where `context` is the
   `getAllContexts()` snapshot the wrapper took during the page render (layouts, `<Provide>`,
   Kit's `__request__`/`__svelte__`), plus a `FRAGMENT_CAPTURE` entry.
   - `idPrefix` keeps `$props.id()` values from colliding with the page's.
   - The context Map is a **recording Map** (§8): it notes every key read.
2. Regions inside see `FRAGMENT_CAPTURE` and:
   - **journal their claims instead of consuming them**: `claimRuntimeEmit`,
     `claim_region_css`, `claim_kit_island`. Else a page that already claimed the runtime would
     store a fragment with no runtime, and a later page with no other island would break;
   - **journal** `record_page`, `record_ctx`, and the document-tail calls (`props`, `graph`,
     `hints`, `locate`, `hole`). The tail is built after stitching, so tail calls replay into
     the real tail: seed refs and shared sidecars keep working (v1 of this note had to give
     these up);
   - **use a fragment-scoped slot prefix** (`'og' + key6 + …`, the prefix endpoint renders use);
   - **leave hole addresses unsigned**: each hole's `endpoint` becomes a sub-marker
     `<!--og-hole:NONCE:i-->`-style token, and the journal keeps `{entry, payload, ttl}`. §6;
   - **ignore `known_region_fps`** (render every island body).
3. `absolutize_hole_html` over body and head (extended to graph/hint hrefs), against the page URL.
4. Nonce scrub: the request's CSP nonce, if present in the captured bytes, becomes a token,
   refilled per request at replay (else every later page's inline tags would be refused by CSP).
5. Gates (§8). Pass → entry + put. Fail → this response still uses the render, nothing stored,
   a dev note names the reason.

### Entry (new `FreezeEntry` kind)

```ts
type FragmentEntry = {
  kind: 'fragment';
  body: string;              // absolutized markup with hole/nonce/nested-fragment tokens
  head: string;              // non-claimed head bits (component <style> under css:'injected')
  journal: {
    runtime: boolean;
    css: string[];
    kit_islands: string[];
    page_asks: { seed: string[] | true; remotes: string[] | null; entry: string }[];
    ctx: [key: string, value: string][];
    tail: TailCall[];        // props (raw props, re-planned per page), graph, hints, locate
    holes: { entry: string; payload: string; ttl: number }[];
    nested: string[];        // keys of fragments inside (§7, late binding)
  };
  render_ms: number;         // what a hit saves
  bytes: number;
  created: number;
  sig?: string;              // HMAC over the entry when entries are signed (§8)
};
```

### Replay

Every journal line calls the REAL per-request API, so dedupe behaves as if it rendered:
- `claimRuntimeEmit()` won → `runtime_bootstrap()` into the head.
- `claim_region_css(css)` → `region_css_tag` for winners (inline-under-threshold per page).
- `record_page(current page, …)`: the page seed is fresh even when the markup isn't.
- tail calls → the real `DocumentTail`.
- holes → minted now, for this visitor (§6).
- one devtools event `server.fragment` stands for all the inner region events.

### Same fragment twice on one page

Identical slot ids twice. The second instance is rendered live (rare; headers appear once).

## 6. Holes inside (the original ask)

The store keeps the hole's ingredients, never a signed address. At stitch time each hole is
signed for THIS visitor with normal `regions.ttl`:
- **Session visitors work.** Today a frozen page's hole, minted on an anonymous render, fails
  the MAC for a visitor with a session cookie (403, and renewal refuses session holders).
  Re-minting at stitch fixes that for fragments. Frozen pages should adopt the same trick.
- **No 10-year capabilities sit in storage.**
- Cost: one HMAC per hole per request, the same as rendering them live.

Combinations that fall out:
- **`stitch: 'serve'` holes inside a fragment**: at stitch time the hole's answer is rendered
  server-side too (`stitch_html` exists) and pasted. Result: a frozen header shell + the
  personal bits (cart count, user menu) filled in the SAME response. No client fetch, no
  flash, no layout shift. The hole render cache still applies to those answers.
  **This is probably the best version of the user's header.**
- **`stitch: 'edge'` holes inside a fragment on an edge-cached page**: ESI includes, as today.
- **Plain deferred holes**: the browser fetches them as today.

## 7. Where a fragment can sit, and what can sit in it

| Fragment inside… | v1 behaviour |
|---|---|
| a normal csr=false page | **the main case** |
| a frozen page | page capture keeps the fragment MARKER (late binding, default at origin) or bakes it in (early binding, needed for edge-cached pages). Late: a header change evicts zero pages; a page hit costs one more read (batched). Early: tags cascade, the header change evicts every page holding it |
| another fragment | the inner stays a marker in the outer's stored body; both resolve in one batched read; the inner can change without the outer recapturing ("Russian dolls") |
| a hole's answer (endpoint render) | works: `render_region` runs the same stitch on its body. Hole answers get cheap |
| a woken island (inline SSR) | live, dev note: the island hydrates and would mismatch frozen markup |
| a csr=true route | live, dev note (Kit hydrates; stale markup = hydration mismatch). Later: allowed when byte-identical, which the shadow check (§11) can measure |
| a prerendered page | renders inline at build (no store). Or seeds the store (§11, baking) |
| a federated (MFE) document | works per app; see shared fragments in §11 |

| …inside a fragment | v1 behaviour |
|---|---|
| deferred hole | re-minted per visitor (§6) |
| serve-stitched hole | rendered per request, pasted (§6) |
| island | journaled (CSS, runtime, sidecar, graph) |
| lake | fine (static markup) |
| another fragment | late-bound marker |
| late region (streamed) | refuses: a late region is per request by definition |
| `{#await}` | csr=false: the pending branch is final markup anyway; stored as rendered |

## 8. Safety: when a capture refuses to store

Same law as frozen pages: default-valued reads are the canonical render; anything personal
refuses. Reads are recorded during the CAPTURE WINDOW (start to end of the isolated render).
With v2 the miss render runs after the page render, so **there are no concurrent siblings in
the window**: attribution is exact without AsyncLocalStorage. (v1 had to accept over-blame.)

Refuses when the capture:
- reads a cookie (non-default), `getAll`, writes a cookie, calls `setHeaders`;
- reads `cookie`, `authorization`, `accept-language`, `user-agent`, `referer`, `x-user*`,
  `x-session*`;
- reads a non-default `locals` value;
- reads a flag (unless `vary: ['variant:<flag>']`; exposures must ride the client leg);
- reads `page.url` / `params` / `route` / `status` / `error` / `form` / `state` / `data` not
  covered by `vary` (the `page` handed in is a recording proxy). `page.data` refuses with
  "pass `nav` as a prop so it joins the key";
- **reads a Svelte context key not in the allow list.** Contexts are inputs NOT in the key:
  an i18n context from the layout would freeze French text onto the German page. Ogygia's own
  keys are allowed; app keys need `vary` coverage or `stableContext: ['theme']`;
- **reads the clock or `Math.random`** (patched during the window): "Header reads Date.now:
  add `vary: ['day']` or move it into an island";
- **reports an error**: `handleError` or `console.error` during the window, or a
  `<svelte:boundary>` failure. Never freeze a broken header.

Belt-and-braces checks on the bytes (cheap, `indexOf` per value):
- **Personal-data canary**: any request cookie value, `authorization` value, or CSRF token of 8+
  characters found in the captured body or head → refuse. Catches leaks the observers can't
  see, like `event.fetch('/api/me')` forwarding cookies.
- **Shrink guard**: a recapture under half the size of the last good copy (or under
  `minBytes`) → keep serving the last good copy, log "Header shrank 41 KB → 3 KB; CMS
  down?". Stops a CMS outage from freezing an empty header for an hour.
- **Cardinality guard**: distinct keys per identity counted in L1. Over `maxVariants`
  (default 50) → stop storing new ones, dev note "Header varies by `user` (1,204 variants):
  that's per-user data, make it a hole".

Shared-gap fix to do in frozen pages first: wrap `event.fetch` in the observer; a forwarded
`cookie`/`authorization` counts as a personal read.

Store trust:
- **Signed entries** (`freeze.signEntries: true`): HMAC over the entry with `OGYGIA_SECRET`;
  a tampered entry is a miss. Anyone who can write a shared Redis could otherwise inject HTML
  into every page.

## 9. Store, lifetime, invalidation

Reuse `FreezeStore` (memory / valkey / upstash / cloudflareKv), `frag:` namespace. Page keys
start with `/`, so `invalidate('/x')` never touches fragments.

- **Two tiers**: L1 in-process `SizedLru` (cap `min(ttl, 10s)` so an invalidation reaches every
  instance within 10 s) over L2 (the configured store).
- **Batched reads**: all fragment reads of one request (and nested ones) go out as one
  `getMany` (Redis MGET, Upstash pipeline). New optional store method; stores without it fall
  back to parallel `get`s.
- **Read budget**: 50 ms default. Over budget or an error → render live. Never fail the page.
- **Single-flight** per key: concurrent misses wait for one capture (capped, then live).
- **Lifetimes, as combinable dials**:
  - `maxAge`: plain lifetime.
  - `swr`: after `maxAge`, keep serving the old copy while one background recapture runs
    (`platform.context.waitUntil` when present, else after the response).
  - `refreshAhead` (default on with a store): a hit in the last 10% of its life triggers one
    background recapture. A hot header never misses.
  - `staleIfError` (default 7 d): if a recapture throws or fails the shrink guard, serve the
    last good copy. **The fragment becomes a circuit breaker for the CMS behind it.**
  - `maxAge: Infinity` is allowed only when the key covers every input (props-only, no vary
    functions): content-addressed, nothing to invalidate, old entries just age out of LRU.
- **Tags**: `f:<identity>` on every entry (so `invalidate(Header)` hits all variants), plus every
  `og.source` receipt read during the capture (`s:<id>:<fp>`), so existing publish webhooks
  thaw the header without new wiring.
- **Frozen page composition**: early-bound fragments add their tags to the page; late-bound
  ones don't need to.
- **Ops verbs** (made up, cheap given the store): `freeze.warm(Header, props, vary)` (render
  now, before anyone asks), `freeze.pin(Header)` (ignore lifetimes during an incident),
  `freeze.rollback(Header)` (serve the previous copy; the store keeps the last 2),
  `freeze.peek(Header, …)` (debug: what's stored, its age, its tags).

## 10. Things you might not have thought of

1. **Context reads.** The layout's i18n/theme context is an input the key can't see. Refused
   unless declared (§8).
2. **Freezing a failure.** CMS times out → empty nav → frozen for an hour. Shrink guard +
   staleIfError (§8, §9).
3. **Deploys go cold.** Build id in the key = every deploy re-renders every variant. Code-hash
   keys keep unchanged components warm (§4).
4. **CSP nonces.** Per request; a stored nonce gets refused everywhere else. Scrubbed and
   refilled (§5).
5. **Session holes 403.** Already true for frozen pages with `sessionCookie`. Re-minting at
   stitch fixes it (§6).
6. **Multiple domains.** Host in the key by default (§4).
7. **Clock and randomness.** "© 2026", "open now", a random promo: observed, refused or
   `vary: ['day']` (§8).
8. **Per-user props.** Safe but useless: the cardinality guard says so (§8).
9. **Small components.** A 0.3 ms component costs more as a Redis round trip than as a
   render. Adaptive admission: if `render_ms` < 2× the measured store read time, stop freezing
   it and say so in devtools.
10. **Shared Redis.** App namespace in the key; signed entries (§8).
11. **Draft/preview mode.** A preview cookie is a personal read → previews always render live
    and never pollute the store. Falls out of the rules; worth a test.
12. **A/B tests.** Variant as a bounded vary; the exposure must fire on the client leg, or a
    hit page undercounts the experiment.
13. **Module-level state** (`$state` in a shared `.svelte.ts`) read during render is shared
    across requests and invisible to observers. Document; the shadow check (§11) catches it.

## 11. Made-up extensions (ranked by value / cost)

1. **Shadow check (production canary).** Sample `verify: 0.01` of hits: also render live in the
   background and compare bytes. A mismatch means the header reads something not in the key;
   report what differs. Turns "is my fragment pure?" from a guess into a measurement, and
   licenses csr=true support where bytes match.
2. **TTL advisor.** Track how often a recapture produces identical bytes. "Header recaptured
   288 times today, changed twice: maxAge could be 12h." Insight, not UI weight.
3. **Profiler candidate finder.** "Header: 48 ms on 96% of requests, reads nothing personal:
   freeze it, saves ~2.1 CPU-hours/day." The profiler already attributes CPU to compiled
   component functions.
4. **Baked fragments.** When the compiler proves a component has no props and no reads, render
   it at build and embed the string in the server bundle. No store, no runtime cost, ever.
   Known variants (one per locale) can be baked the same way, or written to the store on
   deploy (`ogygia warm`).
5. **Render-on-write.** A CMS webhook calls `freeze.warm(Header, …)` for each locale: the next
   request is a hit, not a miss. Ties into [[materialize-design]].
6. **Router fragment delta.** On ogygia router navigations the client sends the fragment
   hashes it already holds (`x-ogygia-known` grows a fragment list). Matching fragments become
   a keep marker; the morph leaves that DOM alone and the bytes aren't sent. The header
   travels once per visit.
7. **Shared fragments across apps.** Team A owns the header, renders it on deploy into a shared
   store under a public name; apps B, C, D paste `frag:shared:header:<locale>` without
   redeploying. Needs absolute cross-origin asset URLs or inlined CSS. Merges with the
   federation peer cache (which today is an in-process Map, not shared across instances).
8. **Edge stitching without ESI.** Origin returns the page with markers; a Cloudflare worker
   (or similar) fills them from KV. The cloudflareKv adapter already exists.
9. **Auto-freeze.** `freeze: { fragments: 'auto' }`: freeze any component the profiler marks as
   heavy and the shadow check marks as pure. Too much magic for v1; the two checks above
   would make it safe.

## 12. Visibility

- **Devtools**: one `server.fragment` event per paste: name, outcome (`hit-l1 | hit-l2 |
  miss-stored | miss-refused(reason) | bypass(csr|island|dup|dev|budget) | stale(swr|error)`),
  age, bytes, `render_ms` saved, tags. Page tab lists fragments; an overlay outlines each with
  "Header · hit · 12 m old · saves 48 ms". Dev/devtools builds keep comment markers around
  pasted fragments for this.
- **Server-Timing**: `og-frag;desc="Header hit-l2";dur=0.9`.
- **Dev mode**: never reads or fills the store (HMR truth beats bytes, as for pages). Gates
  still run and print "would store" or the refusal reason once per key. `freeze.dev: true`
  tests real storage. `?og-thaw` (dev, or with the secret) forces a recapture.
- **Profiler**: fragment time as its own line; the candidate finder and TTL advisor (§11).
- **ogygia/testing**: `expect(page).toHaveFrozen('Header', 'hit')`.

## 13. Failure modes

| What fails | What the visitor gets |
|---|---|
| Store down / slow | Live render, one log line |
| Miss render throws | Last good copy if any (staleIfError), else Kit's error page as today |
| Gates refuse | This response uses the render; next request renders live |
| Recapture shrinks | Last good copy, log |
| Old code's entry | Unreachable (code-hash in key); ages out |
| Header publish | Bounded by maxAge; `invalidate(Header)` / `og.source` tags fix it now |
| Tampered entry (signed mode) | Miss, log |
| Same fragment twice | Second renders live |
| csr=true / inside an island | Live, dev note |

## 14. Build plan

1. **Spine** (memory store, csr=false): `render: 'frozen'` + wrapper (marker, context
   snapshot, key); stitch step first in `inject_client_seeds`; capture context; journal
   (claims, page asks, ctx, tail); slot prefix + `idPrefix`; absolutize; nonce scrub; replay;
   gates incl. recording context Map + page proxy. Test: hit bytes == miss bytes across two
   depths, with an island, a deferred hole and a serve hole inside.
2. **Holes re-minted at stitch**, then frozen pages adopt it.
3. **Store**: L1/L2, `getMany`, single-flight, read budget, deferred puts, tags, `invalidate`.
   Valkey lane in the freeze deck.
4. **Lifetimes**: swr, refreshAhead, staleIfError, shrink guard, cardinality guard.
5. **Visibility**: devtools event + overlay, Server-Timing, profiler line.
6. **Nesting + frozen-page late binding**, code-hash keys, signed entries.
7. **Extensions** by rank (§11): shadow check, TTL advisor, candidate finder, baking, …

## 15. Research facts this rests on (2026-10-05)

- `passage.md:566-588`: inline components render inside Kit's one pass; no per-component cut.
  Placeholder + stitch sidesteps it: the cut is the marker.
- A Region's output reaches five places besides its markup: `<svelte:head>`, the document tail,
  the request bag (`record_page`, `record_ctx`, late regions, tags, devtools), per-request
  claims (`claimRuntimeEmit`, `claim_region_css`, `claim_kit_island`, `next_slot_id`,
  `known_region_fps`), and request-tied values baked into markup (relative asset URLs, slot
  ids, `$props.id()`, signed endpoints, `data-og-skipped`).
- Isolated `svelte/server` renders inherit no parent context (`#open_render` sets `p: null`);
  ogygia passes only Kit's two entries today (`kit_render_context`). `getAllContexts()` fixes it.
- `inject_client_seeds` runs in `transformPageChunk` (async), builds seeds and the tail in the
  chunk carrying `</body>`, and skips all body work when `bag.page === null`.
- The hole render cache (`server/render-cache.ts`) is in-process, keyed `id|props|session`,
  TTL only. Its comment (and `hooks.ts:1782`) wrongly says Region.svelte uses it.
- The hole endpoint observes no cookie/header reads; with `sessionCookie: false` a `maxAge`
  hole's cached answer is shared across all visitors regardless of what it read.
- Frozen pages: `observe_event` attaches only on freeze page requests; `event.fetch` is not
  observed; session-cookie visitors fail frozen holes' MAC.

## 16. Footgun register

Severity: **S1** = wrong or broken page / leak, **S2** = silent waste or confusing behaviour,
**S3** = edge case. "Verified" = read in code, with the reference.

### Kit

- **S1 · The miss render runs outside Kit's render window.** Verified: Kit 2.70
  `page/render.js:238-279` wraps only `root.render()` in `with_request_store({…, is_in_render:
  true})` and `paths.override`; `transformPageChunk` runs later (`:634`). A miss render inside
  the stitch sees `is_in_render: false` (remote `query()` calls in the header may behave
  differently or refuse) and Kit's non-relative `base`. Treatment: run the miss render inside
  `with_request_store` from `@sveltejs/kit/internal/server` (ogygia's hooks already import it;
  `hooks.ts:5`), with `is_in_render: true`. Check the same export on Kit 3. Side effect worth
  keeping: outside the override, `asset()`/`resolve()` give absolute paths, so **depth may drop
  out of the key**: verify, then delete the `d<depth>` part.
- **S1 · ogygia's app `transform` runs before the stitch point.** Verified: `hooks.ts:1013-1014`
  calls `#transform_document` BEFORE `inject_client_seeds`. An app transform would see markers,
  not the header (and a link rewriter or a foreign SSR pass would miss it). Treatment: the stitch
  is the first thing in that `transformPageChunk` lambda, before the app transform.
- **S1 · Other transforms and middleware can eat the marker.** An HTML minifier, a comment
  stripper, or a post-SSR rewriter that runs before the stitch deletes the marker; the header
  silently vanishes. Kit even warns about comment removal on csr pages (`render.js:647-652`).
  Treatment: the bag knows how many markers it issued; any not found at stitch time → loud log
  and a devtools error naming the fragment (never a guessed paste position). Document "ogygia's
  handle goes first in `sequence()`"; `compose_resolve_opts` (`hooks.ts:472-490`) already runs
  ogygia's transform before the profiler's.
- **S2 · ETag follows the stitched bytes.** Verified: `render.js:640-642` hashes the transformed
  HTML. Good: a header change changes the page ETag. Nothing to do; noted so nobody "fixes" it.
- **S2 · Error renders.** An error page re-renders the layout in the same request: markers from
  the aborted render stay registered in the bag. Treatment: marker ids are a per-request counter
  plus nonce; unclaimed registrations are dropped silently (no "missing marker" alarm when the
  status is an error). Also: Region decides island forms from `page.error` (the error twin map),
  so an error-render capture must never be stored under the normal key: the key carries an
  `error` bit, or error renders don't capture.

### Keys and identity

- **S1 · Code-hash keys meet build-unstable file names.** Rolldown chunk naming is not
  deterministic across builds (memory: compiler stress + determinism). An unchanged header kept
  warm across a deploy would carry the OLD build's island and CSS URLs in its markup; after the
  old assets are gone they 404. Treatment: the stored body never carries asset URLs. Island
  `entry`/`src` and CSS hrefs are stored as identities (tokens) and resolved through the current
  build's `island_url` / `islandCss` maps at replay, like the journal already does for CSS.
- **S1 · Structural contexts change the markup.** Inside a lake, a slot boundary, or a nested
  island, Regions render differently (`NESTED_KEY`, `LAKE_KEY`, `HOLE_INLINE_KEY`). The same
  header in two such places would share one key. Treatment: those ogygia flags join the key.
- **S1 · Host from the request is attacker-controlled.** `host` in the key by default lets
  anyone fill the store with junk `Host:` values (and bake that host into absolute links in the
  markup). Treatment: key on the configured origin / an allowed-hosts list, never the raw header.
- **S1 · Attacker-controlled vary fills the store.** `vary: ['path']` on a catch-all route, or
  `'search'`, lets a crawler or attacker create unlimited keys. Treatment: store only from 200
  responses when path/params/search are in vary; the cardinality guard also caps per identity.
- **S2 · Props hashing can cost as much as rendering.** A 200 KB nav tree is stringified and
  hashed on every request, hit or miss. Treatment: measure `key_ms`, show it in devtools; offer
  `key: (props) => props.nav.version` for big inputs; fail the adaptive-admission check when the
  key costs more than the render saves.
- **S2 · Object key order.** devalue keeps insertion order: `{a,b}` vs `{b,a}` are two keys.
  Treatment: canonical (sorted) serialization for the hash.
- **S2 · Environment mismatch on a shared store.** Staging and production (or a canary with
  different `$env/dynamic` values) sharing one Redis paste each other's headers: same code,
  different env. Treatment: the `app` part includes an environment name; reads of
  `$env/dynamic/*` during capture are observed like cookies.
- **S3 · Recursive components.** A frozen `Menu` that renders a frozen `Menu` would nest markers
  per level. Treatment: a fragment inside the same identity renders inline.
- **S3 · Function props.** `onsearch={…}` makes the props unhashable. On csr=false pages it can
  never run on the client anyway; still refuse (the component might call it during render) with
  a message that says why.

### Freshness and invalidation

- **S1 · Invalidation race.** A publish evicts the header while a capture that started before
  the publish is still running; the capture then writes the OLD markup back for a full lifetime.
  Treatment: a generation number per identity in the store (`INCR` on invalidate); a capture
  reads it before rendering and its put is refused if it moved. The federation peer cache
  already uses this pattern in-process.
- **S1 · Lost writes on serverless.** Without `waitUntil`, a Lambda freezes after the response
  and a deferred `put` never lands: every request misses, forever, silently. Treatment: await the
  put before returning when there is no `waitUntil` (a miss pays one store write), and count
  failed puts in devtools.
- **S2 · staleIfError hides outages.** A header that fails to render for a week is served a
  week old with no one noticing; prices or legal banners go stale. Treatment: loud and repeated
  logs, a devtools badge, per-fragment `staleIfError: false` for content that must be current.
- **S2 · refreshAhead stampede across instances.** Single-flight is per process: N pods refresh
  the same key at once. Treatment: a store lock (`SET NX` with short expiry) for background
  refreshes; foreground misses keep per-process flights.
- **S2 · L1 lag after a publish.** Up to the L1 cap (10 s) some pods still serve the old header;
  editors think "publish didn't work". Treatment: document; later pub/sub eviction.
- **S2 · Store adapter limits.** Cloudflare KV is eventually consistent (about 60 s) and limits
  writes per key; Upstash bills per command. Treatment: per-adapter notes; KV gets a longer L1
  and no refreshAhead.

### Leaks and safety

- **S1 · `getRequestEvent()` bypasses the page proxy.** A header reading
  `getRequestEvent().url.pathname` or `.params` is not seen by the recording `page`. Treatment:
  the capture also wraps the event's `url`, `params`, `route` getters.
- **S1 · Islands inside that read `page`.** Their frozen SSR markup shows the capture page's
  state; they hydrate with the current page's seed and visibly jump (an active-link island).
  The page-read rule refuses these captures, which will surprise users. Treatment: say so in the
  refusal ("NavIsland reads page.url: render it client-only, or vary by path").
- **S2 · Refusal messages must not print values.** Dev notes and logs name the cookie or header,
  never its value (consent strings, tokens).
- **S2 · Devtools in builds expose keys.** `devtools: true` works in production builds; show
  vary values only as hashes when they come from a function (could be cookie-derived).
- **S3 · Two headers in different `<Provide>` scopes** with the same props read different
  context values under one key. Covered by the context recording rule, but the treatment must
  put the declared context VALUE in the key (`vary: [{ context: 'theme' }]`), not just allow it.

### Order and look

- **S2 · Turning freezing on can change CSS order.** Region CSS for islands inside the header
  is now added at stitch time, after the page's own claims, so it can land later in `<head>` than
  in a live render. Hit and miss match each other, but both differ from "not frozen". Mostly
  harmless with scoped CSS; document, and keep the order "where the header sat" when it's cheap.
- **S3 · `<title>` from inside the header.** Svelte keeps the last `<title>`; replay order can
  change which one wins. Document.

### Server features (frozen pages, flags, stores, security) — sweep 2026-10-05

Design corrections first:
- **S1 · Page capture bakes in the stitched fragment.** `capture_freeze` reads
  `response.text()` (`hooks.ts:697`) AFTER `transformPageChunk` ran, so every frozen page stores
  the pasted header: early binding by accident. And the page HIT path (`freeze_response`) never
  runs `transformPageChunk`, so a late-bound marker would never be filled. Treatment: during a
  page capture, keep fragment markers in the stored copy (stitch a second copy for this
  response), and stitch on the page hit path the way `#serve_stitched` does. Early binding needs
  `tags` on `FragmentEntry` (missing in §5) so a hit can add its receipts to the page.
- **S1 · Every ogygia request seam is dead in the miss render, not just Kit's.** All recorders
  resolve through `bag_of()` → `try_get_request_store()` (`hooks.ts:239-242`, `:367-380`): flag
  observer, `og.source` receipts, `freeze_capture_active` (`region-endpoint.ts:121`), tail, ctx,
  page asks, devtools, `requestEvent()`. Outside Kit's store they return undefined: flag reads
  disqualify nothing, receipts vanish, holes mint short capabilities. Treatment: the
  `with_request_store` re-entry from the Kit section fixes these too; add a test that fails if any
  seam returns undefined during a miss render.
- **S1 · Serve-stitched holes in a frozen header leak across visitors** when they carry a
  `maxAge`: the R6 cache key is `id|props|session` (`render-cache.ts:30`) and with
  `sessionCookie` off a cart count is shared by everyone; a flag variant isn't in the key either,
  and a cache hit skips the flag read (no exposure). This undercuts §6's "best version".
  Treatment: observe hole renders; refuse to cache a render that read cookies or flags, or key by
  the assigned variant. Until then §6 must say: serve holes inside fragments without `maxAge`.
- **S1 · Global patching leaks across requests.** Patching `Date.now`/`Math.random` "during the
  window" is only safe if the miss render is synchronous. Async SSR, or two requests stitching at
  once, interleave and leak the patch. Treatment: no global patches; observe the clock only when
  the render is sync, otherwise skip that check (the shadow check covers it).
- **S2 · Serve stitch skips rate limits, and the gate queue is unbounded.** `#serve_stitched` →
  `#render_capability` charges no `probe_rate`/`render_rate`; `render_gate` (4 slots) queues
  without limit and the 10 s timeout starts only once a slot is held (`hooks.ts:1789-1808`,
  `runtime/concurrency.ts:14-33`). A fragment miss holding a slot while its serve holes wait for
  slots can deadlock. Treatment: a stitch deadline covering queue time; page-path work never
  nests inside the hole gate; stitched holes get the app transform too (`batch=false` skips it,
  `hooks.ts:2018`).
- **S2 · The profiler beacon gets frozen.** The profiler handle decides to inject its beacon
  before `observe_event` patches anything (`profiler/index.ts:5985-5992`); its composed
  transform then writes the beacon into the captured bytes. Same risk for a fragment captured on
  a profiler user's request. Treatment: no capture while a beacon is active.
- **S2 · CSP nonce plumbing does not exist.** ogygia's injected inline scripts carry no nonce
  (`script.ts:35` takes only a user-supplied one), and `capture_freeze` rebuilds headers from
  scratch, dropping Kit's `content-security-policy` on hits. §5's "nonce scrub" assumes plumbing
  that isn't there. Treatment: read Kit's nonce, stamp every ogygia script, tokenize at capture,
  refill and replay the CSP header at serve.
- **S2 · Observer blind spots.** Only `headers.get` is patched (`freeze/observe.ts:89-97`):
  `new Headers(req.headers)`, `entries()`, `forEach` pass cookies unseen; geo headers
  (`cf-ipcountry`, `x-vercel-ip-country`), `getClientAddress`, `platform` aren't disqualifying.
  Treatment: proxy the whole Headers object; extend the list.
- **S2 · Vary reads disqualify the enclosing frozen page.** A fragment's `vary: ['variant:x']`
  reads the flag during the page render (`hooks.ts:370`), which disqualifies the page.
  Treatment: vary resolution runs under a "declared read" scope the page observer ignores, and
  the page key then has to carry the same bucket.
- **S2 · Error re-render reuses the bag** (`hooks.ts:971-998`, built once): tail, ctx, page,
  late counters carry over from the failed pass. Treatment: an epoch per render pass; markers carry
  pass + nonce. (Likely a live bug for tails too; verify.)

Live frozen-page bugs found on the way (not fragment-specific; fix first, fragments inherit):
- **Verified · `invalidateWhere({ prefix: '/' })` misses everything on shared stores.**
  `normalize_prefix('/')` = `/`, and `scan_prefix(p + '/')` scans `//*` (`valkey.ts:103`;
  same in upstash `:74`, cloudflare-kv `:67`). Only the exact `/` key goes; edges purge
  everything and refill from the stale store. The memory store gets it right, so tests pass.
- **Verified · Tag-set expiry gets shortened.** Each put runs `EXPIRE og:t:<tag> <this entry's
  ttl>` (`valkey.ts:92-95`, upstash `:64-67`). A short-lived entry sharing a tag with a 24 h
  page shortens the tag set; after it expires, a publish no longer evicts the page. Fragments
  (short `maxAge`) make this common. Treatment: only extend (`EXPIRE … GT`) or a long tag TTL.
- **Purge-then-refill race.** `invalidate` runs `store.evict` and `edge.purgeUrl` in parallel
  (`registry.ts:180-182`): a purge landing first lets the CDN refetch the old copy for its
  `s-maxage`. Plus the capture race (no epoch). Treatment: evict, then purge; epoch guard;
  delayed second purge on eventually consistent stores.
- **Duplicate receipt tags** (`hooks.ts:379`, a push per `og.source` call): 200 calls → 200
  tags → 401 sequential Upstash commands awaited before the response, KV per-key write limits.
  Treatment: a Set, pipelined writes, put under `waitUntil`.
- **Edge purges get non-URL keys and decoded paths** (`registry.ts:83`): `frag:` keys would go to
  CDNs; `/café` is purged decoded while CDNs cache encoded; CloudFront XML unescaped
  (`cloudfront.ts:47`), one invalidation per key. Treatment: skip namespaced keys, encode, batch,
  escape.
- **No store timeouts; refusals not remembered** (`hooks.ts:923`, `:931-933`; upstash fetch
  has no AbortSignal): a hanging store hangs every page; refused pages pay a GET + flight +
  observation on every request. Treatment: read budget + abort; cap flight waits; negative
  verdict LRU.
- **No `waitUntil` anywhere** (`registry.ts:224-234`, `flags.ts:139-146`): `self_evict`,
  exposures, `notify_thaw` are fire-and-forget; serverless kills them. Self-evict is origin-only
  (edge stays stale).
- **Memory store counts non-page entries as 64 bytes** (`memory-store.ts:16-17`): fragments
  would bypass the byte budget; the tag index grows without bound.
- Smaller: dev "would-store" skips prod checks (`hooks.ts:630-638` vs `:690-701`);
  `prime_flags` runs before the hit check (`hooks.ts:899` vs `:923`); page keys have no host
  (`freeze/key.ts:12`).

### Federation (MFE) — sweep 2026-10-05

- **S1 · Fragments inside a peer never get stitched.** An exposed render goes through
  `serve_expose` before any bag exists (`hooks.ts:903` vs bag at `:970`) and through the
  router's `document()` (`document.ts:130-218`), neither of which runs `transformPageChunk`. The
  raw marker ships to the host and lands in its SWR cache and frozen pages. Treatment: stitch
  in `document()` and in `serve_expose`/`serve_widget` before the body is lifted; a wrapper with
  no stitch host (no bag) renders live instead of emitting a marker. **This generalizes: every
  render path ogygia owns needs a stitch point, or the wrapper must know there is none.**
- **S1 · Visitor claims are invisible to the purity gates.** On a peer, `user(c)` reads claims
  from a Symbol on the Request (`wire.ts:67-78`): not a cookie, header or locals read. "Hi Alice"
  gets stored for every visitor. And vary built-ins resolve against the server-to-server hop,
  where `signed_fetch` forwards no cookie, `accept-language` or client hints (`peer.ts:55-72`):
  `'locale'`, `'device'`, `'auth-state'`, `host` all collapse to one bucket. Treatment: `user()`
  is a personal read unless `vary: ['claim:<key>']`; claim values join the canary; warn when
  request-derived vary is used on an expose render.
- **S1 · Federation holes are pre-signed with a 5-minute expiry.** `cms.widget('cart', p,
  {render:'deferred'})` passed as a prop already carries `exp` + signature (`hole.ts:39-56`):
  the props hash changes every request (0% hits), or with `ignore` a dead capability gets stored
  (410s after 5 min). §6's re-mint only intercepts `mintServerIsland`. Treatment: journal the
  federation hole's inputs `{peer, kind, target, search}` and re-sign at stitch; refuse
  pre-signed region URLs inside props or the context snapshot.
- **S2 · A fragment hit drops provenance, so the host never thaws.** On a hit no `og.source`
  call runs, so the peer doc's `sources` (`serve.ts:145-159`) lacks the header's tags; the host
  files its copies under fewer tags. Worse: `active_sources` is one module global
  (`federate.ts:28-42`), and the design adds awaits mid-render, so concurrent exposes clobber
  each other. Treatment: journal receipt tags and replay them through `record_source_read`; make
  source capture request-scoped.
- **S2 · Peer content reached through context/props escapes thaw.** `setContext('nav', await
  cms.page('/nav'))` records the peer tags into the page bag during the load, outside the capture
  window: the entry has no peer tags, and a peer deploy leaves its hashed URLs 404ing for up to
  `maxAge` + `staleIfError`. Also `fetch_doc` serves stale while revalidating (`peer.ts:120-137`)
  and thaw notices go only to `origins[0]` (`federate.ts:122-123`), so a recapture elsewhere can
  write stale peer HTML back into the shared store. Treatment: region values carry their tags;
  capture adopts tags of any pasted region value; capture-time peer reads skip stale entries;
  thaw all origins.
- **S2 · "Re-minted per visitor" doesn't survive the hop.** A peer re-mints its holes for the
  shell's server request, not the browser visitor; the host can't re-mint (peer secret, peer
  origin, `wire.ts:273-279`). Treatment: cap host cache lifetimes at the peer's hole TTL when the
  doc has holes, or ship hole inputs in the wire document.
- **S2 · The documented remote-region syntax always refuses.** `page()`/`widget()` are async
  (`peer.ts:226,232`), so `<Region of={cms.page('/nav')}/>` is a late region (§7: refuses). A
  header with a remote nav (the most likely thing to freeze) never freezes. Treatment: the miss
  capture runs async anyway; under `FRAGMENT_CAPTURE` await `of` promises first and adopt tags.
- **S2 · Forged markers and tokens.** A short nonce (the note's `k3x9` example) is guessable
  from a large peer document; stored tokens (`og-hole`, nested fragments) aren't nonce'd at all,
  so captured peer HTML could inject them, and a nested token carrying a store key could pull
  another key's entry (another user's variant) into the page. Treatment: 128-bit nonces; escape
  any `<!--og-` already present in captured bytes; tokens reference journal indexes with a
  per-entry salt, never store keys.
- **S3 · Peer-owned islands escape the journal** (a baked peer region is `RawHtml`, claims no
  runtime, `Region.svelte:706`), and foreign islands hydrate against the shell's page
  (`current-region.ts:20-27`). Treatment: a cross-origin `entry=` in captured bytes forces
  `vary: ['path']` or refuses; journal "runtime needed".
- **S3 · A peer's 404 document gets frozen** (`peer.ts:99`, `:203-217` bake regardless of
  status). Treatment: status ≥ 400 counts as an error for the gate.
- **S3 · §11.7 shared fragments don't fit the journal** (build-relative ids; B can't compute A's
  code-hash; `signEntries` with `OGYGIA_SECRET` would share the hole MAC key between teams).
  Treatment: ship them in the `FragmentDocument` shape, signed with A's Ed25519 peer key,
  invalidated through `/og/thaw`.
- **S3 · Thaw noise.** `f:` tags broadcast to every peer and echo back (`federate.ts:100-102`).
  Treatment: forward `f:` tags only to peers that adopted them.

### Islands runtime + data wire — sweep 2026-10-05

- **S1 · Verified · The recording context Map is blind.** Svelte's server
  `get_or_init_context_map` does `ssr_context.c ??= new Map(parent)` (svelte 5.56.8
  `internal/server/context.js:78`): every component copies the map on its first context call, so
  reads hit plain copies and §8's context rule records nothing. Then the island on the client
  takes context from the CURRENT page's `<ogygia-provide>` ancestors (`context-bridge.ts:160-176`)
  and mismatches the pasted markup; Svelte silently discards the server DOM and the warning
  blames "transformPageChunk mutated the HTML". Treatment: **deny by omission**: pass only
  ogygia's keys, allow-listed and vary-covered keys into the isolated render; unknown app keys are
  simply absent (a read gets `undefined`, which fails loudly in dev or renders visibly wrong in
  the miss render, never silently on other pages). Stamp pasted regions `data-og-frag` so warnings
  and devtools name the fragment.
- **S1 · Re-planning "raw props" changes the fingerprint.** Island props holding a store, an
  `og.wire` class, an `og.$` fn, a derived, a live snippet or the `children` slot pointer can't sit
  in Redis as values; reviving re-mints them with a new `crypto.randomUUID` id (`ref.ts:126-150`),
  the canonical text changes, the fp changes (`Region.svelte:430-434`): the body says
  `data-og-fp=<old>`, the tail writes `og-props-<new>`, and the island hydrates with `{}`.
  Treatment: journal the canonical devalue text plus its fp, never values. At replay apply seed refs
  with a reviver that keeps every ref opaque and byte-identical, or skip seed refs for fragment
  islands. Test: replayed fp == stored fp.
- **S1 · Build-specific URLs, again, and code-hash can't be computed as planned.** The server
  bundle is built before the client bundle, so the compiler can't hash client asset names into the
  key. Stale `src=`, graph, CSS and `locate` entries break differently: CSS has no fallback (styles
  missing); JS recovers via `og-fresh` but reports "page outlived its build"; the client graph keeps
  the first list it sees, so a stale list wins for the whole tab (`runtime/island-graph-preload.ts:46`).
  Treatment: identities only in storage (as the Keys section says); rebuild `src`, graph, CSS,
  locate from the current handoff (`islandDeps`/`islandCss`, `entry_src`) at stitch. Code-hash
  covers server-side inputs only, plus the svelte version (hydration markers change).
- **S1 · Remote query results aren't journaled.** On a hit Header never runs, so Kit's
  `remote.implicit` lacks the island's query; `collect_remote_seed` seeds nothing
  (`remote-seed-gate.ts:57-88`); the island re-fetches and flashes (the exact bug the remote seed
  fixed), and may disagree with the frozen markup. On POST responses, form/action state
  (`issues()`, echoed values) is replaced by the frozen empty form. Treatment: journal `{id,
  payload, value}` for public queries and merge into the seed at replay, or refuse captures that
  call non-prerender remotes; **always bypass fragments on non-GET requests and when form results
  exist.**
- **S1 · Signed URLs live in more places than `tail.hole`.** The `defer:'load'` fetch preload in
  the head (`Region.svelte:623-627`; re-minted endpoint ≠ preload → double fetch), the SWR lake
  `endpoint` (`:648-650`, `makeRegionEndpoint`), and dual-region tickets signed at crossing
  (`transport.ts:69-79`) that end up in `<Provide>` text, island props, `<Region of>`.
  Treatment: tokenize AT THE SIGNERS: under `FRAGMENT_CAPTURE`, `mintServerIsland`,
  `makeRegionEndpoint` and the dual `sign` return tokens; attributes, head bits and props text are
  re-minted together; the fp is computed over tokenized text.
- **S2 · The entry assumes a live document tail.** Pasted into a hole answer (no tail) the
  journaled sidecars have nowhere to go; late-bound in a frozen page there is no Kit render at
  serve: no tail, no seed index, no claim API, and the baked seed lacks the fragment islands'
  `islandPageKeys`. Treatment: the render-root kind (page pass vs self-contained) joins the key;
  late binding uses the self-contained form (adjacent sidecars, own graph script, runtime
  injection) and merges seed keys into the frozen page's seed at capture.
- **S2 · Frozen stateful ref ids break cross-island sharing.** A `cart` store passed to a header
  island and a page island: on a miss the process `WeakMap` gives one id (shared instance); on a
  hit the header carries the capture's UUID and the client builds two instances (the badge stops
  updating). It also breaks "hit bytes == miss bytes", and hashing props with ref ids gives 0% hits.
  Treatment: hash the data part `d`, not the id `i`; refuse (dev warn) a stateful ref crossing the
  fragment boundary without a `keep_name`/stable id.
- **S2 · Region's own reads trip the gate.** Every Region calls `record_page({data: page.data,
  …})` (`Region.svelte:319`): the `page` recording proxy would refuse every fragment with an
  island. Treatment: under `FRAGMENT_CAPTURE` Region journals the ask without reading.
- **S2 · Slot counters continue from the page.** `next_slot_id` counts per request per entry
  (`region-snippet.ts:328-344`); a miss in the same request continues the page's count, so stored
  ids depend on what the capture page rendered earlier. Treatment: a fresh sequence map for the
  capture (a prefix alone isn't enough).
- **S3 · ctx journal type and order.** `bag.ctx` holds live values (serialized later), the
  journal holds strings: needs a raw-insert path with `BRIDGE_FAMILIES`. Replay at stitch puts
  Header's `setContext` last, beating a later sibling's write that would have won in document
  order. Treatment: record document position.
- Checked fine: wake gate, drift-watch/self-heal (copy taken at connect: pasted markup counts as
  server copy), lakes, `LateIsland` (csr=true only), morph and hole keys (`endpoint_key` ignores
  the signature), `keepFallback` in serve-stitched holes.

### Router + navigation — sweep 2026-10-05

- **S1 · Router documents never pass through `transformPageChunk`.** `render_page` /
  `handle_thrown` return `document()`'s Response directly (`router.ts:428`, `:534`; `handle`
  skips `resolve`, `:551-553`). A header in a `routes()` layout ships its raw marker: no header,
  on error and 404 pages too. Rewriting the Response afterwards is too late (`read_seed_ask()`
  already decided the seed, `document.ts:171`; head, runtime, CSS already built). Treatment:
  stitch inside `document()` right after `render()`, merging `fragment.head` into `head[]` before
  the title and runtime presence checks.
- **S1 · Kit calls the transform ONCE.** Verified (`render.js:633-680`, "TODO flush chunks"):
  one `transformPageChunk` call with `done: true`; streamed chunks are appended untouched. §2's
  "each chunk is scanned" is wrong for Kit. For router streams, later yields and late regions are
  baked after `document()` returns (`router.ts:441-453`, `stream.ts:117-164`). Treatment: stitch
  inside `page_slot_chunks` / `late_region_chunks`, head bits inline in the template, hoisted by
  the boot script and `apply_late_templates`. Side bug found: `apply_late_templates`
  (`router-nav.ts:292`) passes `<link>` elements to `install_head_style`, turning each into an
  empty `<style>`.
- **S1 · Hole answers on client navigation take the batch path, with no bag.** `batch_regions`
  → `render_batch` → `#render_capability` (`hooks.ts:1138`, `:1951-2018`), not `render_region`;
  endpoint requests get no RequestBag (`hooks.ts:974-998`). A header inside a hole works on a full
  load and is blank or broken after a click. Treatment: stitch inside `#render_capability` BEFORE
  `absolutize_hole_html` (else re-minted endpoints come out relative to `/__ogygia__`); give
  endpoint renders a small fragment scope (nonce + list).
- **S1 · Capture output depends on the render root; the key ignores it.** `kit_page_pass` is true
  only when `__request__` has no `event` (`Region.svelte:204-217`), and the context snapshot
  carries it. A Kit-page capture journals tail calls; replayed into a router document they go to
  `bag.tail`, which router documents never emit: islands silently never hydrate. Treatment
  (matches the islands sweep): **always capture self-contained**; replay moves sidecars and hints
  into the tail only when stitching in Kit's pass.
- **S1 · `vary: ['params']` collides on router pages.** A router request's Kit event has
  `params = {}` and `route.id = null`; `/docs/a` and `/docs/b` share a key while the recording
  proxy (reading the router's `pageState`, `document.ts:86-99`) thinks params are covered.
  Treatment: resolve vary from the router page snapshot (`set_kit_page_reader`, `hooks.ts:331`),
  never `event.params`.
- **S1 · Serve-stitched personal bits on a publicly cached page.** Frozen pages stamp
  `private, no-store` when they serve-stitch (`freeze/stitch.ts:11-12`); a fragment stitched in
  `transformPageChunk` can't change headers, and router pages merge app `setHeaders`
  (`router.ts:284-291`). A `public, s-maxage=300` page then serves user A's cart to everyone;
  `spa_html_cacheable` also keeps it in the prefetch cache. Treatment: stamp `private` afterwards
  in the handle, and inside `document()`. §6 correction: re-mint with `mint_ttl_sec`
  (`shared-cache.ts:74`), not plain `regions.ttl`, so holes outlive an edge-cached copy.
- **S2 · Kept header islands remount on navigation.** Slot pointers feed `data-og-fp`
  (`Region.svelte:380`, `:426-441`), the morph key and the `x-ogygia-known` match. A key-derived
  slot prefix differs between hit and live bypass (budget, store down, duplicate) and between
  variants: fp flips, morph re-mounts the island, an open dropdown or typed search is lost.
  `idPrefix: 'f'+key6` likewise changes `$props.id()`, and morph keys elements by `id`
  (`morph.ts:457-465`). Treatment: derive slot prefix and `idPrefix` from the component identity
  only, and use the same scheme on live/bypass renders of frozen-marked components.
- **S2 · Verified-by-two-sweeps · Depth in the key buys nothing.** The miss capture runs after
  Kit's `paths.reset()`, and router documents never get the relative override: captured bytes are
  always absolute. Drop `d<depth>` from the key.
- **S2 · `<title>` inside the header wins the page title.** An isolated capture produces its own
  `<title>`; a hit page has two, the browser takes the first, router navigation copies
  `doc.title` (`router-nav.ts:703/717`), and `document()` skips `options.title` once any title
  exists (`document.ts:149`). Treatment: journal the title separately and replay it only when the
  page set none, or refuse captures containing a title.
- **S2 · Handle order turns fragments off on router documents.** `sequence(app.handle,
  ogygiaHandle())` → no bag; asks fall to `doc_asks`, `record_ctx` dropped (`hooks.ts:247-273`,
  `:351`). Treatment: bypass with a once-only dev note ("keep ogygiaHandle outermost").
- **S3 · §11.6 router fragment delta would keep stale content**: late-bound outer bytes don't
  change when an inner changes, and kept DOM keeps stale serve-stitched bits. Treatment: hash the
  resolved tree; never keep fragments containing serve holes.
- Checked fine: kit-page thread, frame-store addresses (`id|props`), navigation lifecycle events,
  prefetch-triggered captures, router CSS.

### Compiler + build + tooling — sweep 2026-10-05

- **S1 · The code-hash misses most inputs.** The only closure walker (`mark_island_closure`)
  stops at bare package specifiers (`compiler/driver.ts:738`), skips `$app/`, `$env/`,
  `virtual:` (`:770-776`), follows only string-literal imports (`:178`, so `@use`,
  `import.meta.glob`, template `import()` are invisible), and never sees macro output, defines
  (`vite/index.ts:593`) or `id_salt` (from `OGYGIA_SECRET`, feeds every iid,
  `transform.ts:1733`). Upgrade `@acme/ui`, edit a SCSS partial, change a `?raw` logo: same hash,
  old markup (SCSS case: old `svelte-xxxx` classes, new CSS → unstyled header). Machine paths
  (absolute component paths, pnpm store paths with peer hashes, `transform.ts:848-855`,
  `:1396-1399`) make the hash differ per CI directory. Kit builds server before client
  (`vite/paths.ts:126`), and Kit 3 shares plugin state across both legs. `og.bake` output can
  change with no source change. **Verdict: code-hash is not v1.** Key on Kit's `version.name`
  (cold after each deploy; `ogygia warm` / refreshAhead soften it). Code-hash becomes a later
  opt-in only if it hashes post-transform module code over the whole server closure, plus
  versions, compile options, defines, `id_salt`, lockfile integrity, with root-relative paths and a
  build-twice CI test.
- **S1 · Header's CSS vanishes in production only.** Routing the mark through `binding_rewrite`
  swaps the import for a stub on the csr=false client leg; Kit links only CSS in the client graph,
  and the fouc link is dropped by design (Region links only islands that rendered). On a hit
  nothing renders → Header's and its children's CSS is gone. Dev adds the fouc link and hides it
  (`transform.ts:1754-1796`). Treatment: client leg strips the attribute and keeps a plain import
  (like `transform_csr_true_host`, `:903-915`); wrapper on the server leg only; prod e2e asserting
  CSS on a store hit.
- **S1 · The import-attribute validator rejects or misreads frozen marks.** A frozen preset sets
  neither hydrate nor defer and fails `transform.ts:1182`; `wake`/`keep` alongside it turns it into
  an island (`:1170-1171`); `vary`/`ignore` aren't in `REGION_PRESET_KEYS` / `ATTR_SCHEMA`; a bare
  number means ms in `parse_max_age` (`:570`) and seconds in `parse_cache_ttl_sec` (`:600`);
  `DURATION` has no `d` and rejects Infinity; and `strategyKey` falls through to
  `hydrate:${strategy}` (`identity.ts:63`), so two sites differing only in maxAge/vary share one
  wrapper (four past bugs of this kind are recorded at `identity.ts:23-35`). Treatment: a
  dedicated `frozen` branch before wake handling; duration strings only (add `d`); every baked
  option folded into `strategyKey`; `'frozen'` in the `OgygiaPreset.render` type; MCP `build_ctx`
  gets presets (`mcp.ts:78`).
- **S1 · Functions and stores can't travel from vite.config.** Presets reach wrappers as
  `JSON.stringify` (`emit.ts:383-398`); the server bundle never imports vite.config. Treatment:
  presets hold string vary names only; vary functions and the store are registered at runtime
  (`freeze.configure`, as frozen pages already do).
- **S2 · One component, several identities.** Alias vs relative specifiers are kept verbatim
  (`transform.ts:855-858`, `:1393-1404`): `invalidate(Header)` and the `f:` tag miss a copy.
  Treatment: identity from the file Vite resolves (`<pkg>/<rel>` or root-relative); tags on the
  component path only; the wrapper registers component function → identity in a WeakMap.
- **S2 · Config-by-file and component-side surfaces skip most import sites.** Files without an
  island hint bail early (`transform.ts:1468-1470`); csr=true hosts strip region keys silently;
  `.ts` registries, `import()`, `<svelte:component this>` are never rewritten. Treatment: if
  those surfaces ship, redirect in `resolveId` to a proxy virtual module importing the real,
  unforked id (the `?og-region` fork broke scoped CSS, `driver.ts:618`, `:700`).
- **S2 · Frozen imports inside an island's closure.** The client leg must bind the real Header or
  hydration mismatches (`driver.ts:626`). Treatment: inside a woken island the mark is ignored
  (§7 already says live).
- **S2 · Async mode.** Always `await render()` on a miss. §7's "`{#await}` pending branch is
  final" doesn't hold in async mode. Wire codecs register only via `transportables-eager` in island
  entries (`emit.ts:59-60`): the wrapper must import it or props hashing throws.
- **S2 · Props checks are runtime, not compile-time.** Spreads are skipped at compile time
  (`transform.ts:795`); functions, `SvelteMap`, wired classes inside data need a runtime devalue
  guard that falls back to live. `bind:` reuses the live-region error (`:797-801`).
- **S2 · Devtools/profiler on a hit.** No `server.region.rendered` events for islands inside
  (orphans in Page/Hydration tabs); `server.fragment` must join the schema union
  (`devtools/schema.ts:116`); the devtools define changes bytes, so it joins the key. Header's
  CPU disappears from profiles on hits: the candidate finder must read misses or stats.
- **S3 · `og.source` in loads isn't in the window.** Data passed as props was read in `load`,
  outside the capture: publish webhooks won't thaw the header. Treatment: carry the page's
  receipts that fed the props (or document "props-fed fragments rotate by key, not by tag").
- **S3 · Dev with `freeze.dev: true`**: no build graph, dev URLs (`/@fs/`) could pollute a shared
  store. Treatment: mode in the key; flush L1 in `handleHotUpdate`.
- **S3 · Naming.** "frozen" already means a lake (`wake:'none'`, `transform.ts:1268`,
  `regions.md:111`) and frozen pages. Expect confusion in errors and devtools.

## 17. What the sweep changes in the design (supersedes earlier sections where they differ)

1. **Stitch points: every render path, in a fixed order.**
   - Kit pages: first step of the `transformPageChunk` lambda, before the app `transform`
     (`hooks.ts:1013`). Kit calls it once (`done: true`); there is no per-chunk scan.
   - Router documents: inside `document()` right after `render()`; router streams inside
     `page_slot_chunks` / `late_region_chunks`.
   - Hole answers: `render_region` AND `#render_capability` (batch, serve-stitch), before
     `absolutize_hole_html`, with a small fragment scope (no bag there).
   - Federation: `document()` covers exposes; `serve_expose`/`serve_widget` before the body lifts.
   - Frozen page hits: stitch on serve like `#serve_stitched`; page captures keep markers.
   - **No stitch host → the wrapper renders live.** Never emit a marker nobody will fill.
2. **Miss renders re-enter the request scope** (`with_request_store`, `is_in_render: true`), so
   Kit remote functions and every ogygia seam (flags, receipts, devtools, tail) work. A test fails
   if any seam returns undefined during a miss render.
3. **Always capture self-contained** (adjacent sidecars, own graph/hints in `fragment.head`);
   replay moves them into the tail only in Kit's page pass. Sidecars journaled as canonical text
   plus fp, never revived values; seed refs re-applied by an opaque reviver, or skipped.
4. **Storage holds identities, never asset URLs.** `src`, CSS, graph, locate rebuilt at replay.
5. **Tokenize at the signers**: `mintServerIsland`, `makeRegionEndpoint`, dual `sign`, federation
   `mint_hole` return tokens under `FRAGMENT_CAPTURE`; re-minted with `mint_ttl_sec` at stitch.
   Tokens reference journal indexes with a per-entry salt, never store keys; 128-bit nonces;
   captured `<!--og-` sequences escaped.
6. **Context: deny by omission**, not a recording Map.
7. **Key: `frag:<app>:<env>:<kit version.name>:<identity>:<origin>:<props-hash over data>:<vary>:<root-kind>:<flags>`**.
   No depth (bytes are absolute). No code-hash in v1. Origin from config, not `Host`. Props hash
   over data (`d`), not ref ids. Structural flags (nested/lake/hole-inline, error render, devtools
   define, mode) included. Slot prefix and `idPrefix` from identity only, used on live renders too.
8. **No global patches** (clock/random): the shadow check covers it.
9. **Bypass on**: non-GET, form results present, csr=true, inside a woken island, no stitch host,
   wrong handle order, active profiler beacon, duplicate instance.
10. **Serve-stitched holes inside fragments**: only without `maxAge` until hole renders are
    observed; the response is stamped `private`.
11. **Title**: journaled separately, replayed only if the page has none.
12. **Fix first in frozen pages** (fragments inherit): prefix `/` on shared stores, tag-set
    expiry, purge order + epoch guard, store timeouts, `waitUntil`, Headers proxy, CSP nonces,
    receipt-tag dedupe, edge purge encoding, memory-store sizing.

What survives untouched: placeholder + stitch, journal-and-replay as ONE path (hit == miss bytes),
the store reuse and tags, the lifetime dials, the guards (canary, shrink, cardinality), the
visibility plan, the ranked extensions.

## 18. Open decisions for the user

0. **Name**: "frozen" already means lakes (`wake: 'none'`) and frozen pages. Options:
   `render: 'cached'` (recommended: says what it does, no clash), `'stored'`, or keep `'frozen'`.
1. **Surface**: `render: 'frozen'` + presets (recommended) vs component-side
   `export const freeze` vs config-by-file only.
2. **`page.data` read inside**: refuse and teach "pass it as a prop" (recommended) vs learn the
   read keys and add them to the key automatically.
3. **Frozen page + fragment**: late binding at origin, early only for edge-cached pages
   (recommended) vs always early.
4. **Default lifetime dials**: `refreshAhead` + `staleIfError: 7d` on by default (recommended)
   vs plain `maxAge` only unless asked.
