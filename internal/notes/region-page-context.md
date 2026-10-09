# Region page context: the page a render belongs to

Status: DESIGNED 2026-10-09; building in stages (below). Trigger: a field report on 6b927c3c, a
signed-in header rendered by a remote `query` and refreshed by a `command` came out signed out,
wrong locale, wrong path. `page.data` was `{}` and `page.url` was `/_app/remote/…`.

## The rule

A region always belongs to a page. A page has two halves:

- **identity**: `url`, `params`, `route`. Fixed by the page, so it can travel with a request.
- **data**: `page.data`. The page's loads, for this visitor, now. Never accepted from the browser
  (forgeable: `signedIn: true`) and never reused when it may be stale or another visitor's.

Every server render ogygia starts reads the page through ONE reader (`kit_render_context` →
`set_kit_page_reader` in hooks.ts). The fix is one rule behind that reader, for three venues:

1. **Inside the page request**: the live snapshot Region.svelte records (the request bag). As today.
2. **A deferred part of the page** (a hole, a batch): identity from the page (same-origin
   `Referer`). Data looked up again for this visitor (venue 3). LATER, an optimization: when the
   page render was private to this visitor (not a shared/frozen/cached document), the hole's signed
   address may carry the `page.data` keys its tree reads, like props. Never for a document a shared
   cache may serve (its snapshot is someone else's).
3. **A fresh render** (a remote `query`/`command`, a revalidate, a hole in a cached document):
   identity from the calling page (same-origin `Referer`); data looked up now.

### The lookup ("page facts")

One internal subrequest through Kit itself: `event.fetch(<page path>/__data.json<page search>)`,
the request Kit's own client makes on a navigation. The app's handle chain (auth, locals) and the
page's SERVER loads run with the visitor's cookies; the answer is decoded like Kit's client does
(devalue `unflatten` with the app's `transport` decoders; streamed promises left pending). ogygia's
handle, running inside that subrequest, reports the page's real `route.id` and `params` in a response
header, so identity needs no Kit internals.

- **Only when needed.** Holes: the build unions each module's `page.data` reads (already recorded by
  the transform for seed shaping) over the hole component's SERVER import closure; a hole whose tree
  never reads `page.data` costs nothing. Remote renders (rare, on demand): looked up whenever a
  region renders there.
- **Once per request.** Memoized on the `Request`; a batch shares it.
- **Honest misses.** Keys produced only by UNIVERSAL loads (`+page.ts` / `+layout.ts`) do not exist
  on the server outside a full page render: that is Kit's model. Dev warns, naming the key, instead
  of rendering `undefined` silently.
- **Fail-safe.** A redirect, an error, a non-Kit answer: the render keeps today's page (`{}`), dev
  says why.

### Consistency (stage 4)

A region rendered with fresher data than the page holds splits the page (new header locale, old
page locale), and islands inside it hydrate against the page's older values. The answer therefore
carries the page facts it rendered with; on an ogygia-owned page store (csr=false) the runtime
merges them before the islands inside wake; on a Kit-hydrated page (Kit owns `page.data`) dev warns
that the page's data is older and the app should `invalidateAll()` before refreshing the region.

## Built (2026-10-09)

- **One model**, `server/render-page.ts`: venue by the request's KIND (`isRemoteRequest`, the islands
  endpoint), never by whether some per-request state exists (the handle makes a bag for remote calls
  too — that was the first bug). `page_url_of`, the lookup memo, the reader's merge, the answer's facts
  and the page version all live there; hooks.ts only hands in request state.
- **One port** in `server/kit-context.ts` for render roots: `kit_page_ready(reads)` before a root
  renders (region.ts inline, render-region-html.ts, the hole render — outside the render gate, so a
  slot is never held during Kit's loads, and a cache hit never pays it), `kit_page_facts_tail()` after,
  `kit_page_version(id)` at a hole's mint.
- **The lookup**, `server/page-facts.ts`: Kit's `__data.json` via `event.fetch`; the handle answers
  ogygia's own lookup (`isDataRequest` + `x-ogygia-page-facts`) with no page-render setup and the
  route/params in `x-ogygia-page-route`. First line only; streamed promises settle in the background.
- **The gate**: `island_reads_page_data` in the server manifest, patched in renderChunk
  (`patch_page_data_reads`, BFS over static + dynamic imports, proven-clean sets shared). Dev: `null`
  → every hole looks up. A cached hole's memo key carries the page when it reads `page.data`.
- **One page, not two**: an answer rendered for a page carries `<script type="application/ogygia-page-facts">`
  (the keys its islands ask for, from the facts). `region_fragment` (the one answer seam) queues it;
  `seed_page_once` merges into the island page store before islands wake, and right after an answer
  goes in once the hydrate core is loaded (a KEPT island updates too). Kit-hydrated page: Kit owns
  `page.data`; dev warns to `invalidateAll()` first.
- **A hole's address names its page**: `frameAddress` = `id|props|pv`, `pv` = FNV-1a of the page data
  (facts or snapshot), minted only for holes whose tree reads `page.data`. The morph carries a kept
  hole's new `endpoint` (its address is the minting render's; its content its answer's: ownership),
  and a refreshed live region renews holes whose address changed (`#renew`, revalidate; the current
  answer stays until the new one lands). A refresh that changed nothing keeps every address.

Labs: `/page-context/[slug]` (e2e/page-context.spec.ts: hole, query refresh, command, one page) and
`/header-refresh` (e2e/header-refresh.spec.ts: the header region refreshed by a command morphs in place,
island state kept and reading the new locale, the hole re-fetched without a fallback flash).

## Not built (yet)

- The private-document shortcut for holes (carry the snapshot keys in the signed address).
- A dev warning naming a `page.data` key a render-for-a-page reads that the lookup did not produce
  (universal-load keys).
- On a Kit-hydrated page the merge cannot touch Kit's `page.data`: the app refreshes it
  (`invalidateAll()`) before refreshing the region; dev warns.
- `locals` a layout load sets are not part of a page: a remote call never runs the layout load, so a
  component reading such a local needs the app to set it in the remote call (Kit's model).

No new public API. No change in the app's components.
