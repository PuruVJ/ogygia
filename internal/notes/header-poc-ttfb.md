# Header POC deploy: why the TTFB is 6.5 s (2026-09-10)

Measured on the deployed POC (`amp3`) vs the ogygia baseline (`amp2`), same page, `curl` from here.

| | baseline | header POC |
| --- | --- | --- |
| GET TTFB (3 rounds) | 3.4 / 4.2 s | 6.4 / 8.0 / 8.9 s |
| HEAD TTFB (3 rounds) | 2.5 / 2.9 s | 2.1 / 2.6 / 3.7 s |
| GET − HEAD ≈ the app's post-render HTML middleware | ~1 s | **~4 s** |

`HEAD` skips exactly one thing in the app: `addDynamicHtmlAttributesUnlessHead`
(`hooks.server.ts`) — the post-render transform that extracts every `<qds-*>…</qds-*>` block and
runs Stencil's `renderToString` on it (`hydrateQds.ts`: two passes for `qds-web-*`, websites then
core). Loads, the Svelte render and ogygia are all inside HEAD's 2–3 s and are the SAME on both
deploys. The extra ~4 s on the POC is that middleware.

## Why the middleware is 4× slower on the POC

`hydrateQds.ts` caches the rendered output of each block in a module LRU keyed on **the block's
exact bytes** (`renderQdsTag(tag)` → `getCachedRender(tag)`). A hit costs nothing; a miss is a
full two-pass Stencil hydrate of the block.

- Baseline: the `<qds-web-header>` block is 450 KB and contains no ogygia markup — byte-identical on
  every request → cache hit after the first render on a warm instance.
- POC: the `<qds-web-header>` block is **738 KB** and contains **7 `<ogygia-region>`s, 5 of them
  holes with signed endpoints** (`…&exp=…&sig=…`). ogygia minted `exp = now + ttl` per render, so
  the block's bytes changed on every request → cache **miss every request** → the whole 738 KB
  header is Stencil-hydrated twice, per request, on a Lambda-class CPU. Evidence: two consecutive
  fetches of the POC page differ in exactly two QDS blocks — the header (738 KB) and a carousel
  (215 KB); the other 29 blocks are byte-identical.

Two more things the POC put on the SSR path that the baseline did in the browser (smaller, but
real): the country-selector lake `await`s `countrySelector` → a Builder `fetchOneEntry` with no
Redis cache (`server/header/readers.ts` `country_selector_entry`), and its result rides the page
as a 117 KB `application/ogygia-remote` seed (baseline: 7 KB).

## Fixes

ogygia (done on `passage`):
1. **Window-aligned capability expiry** (`server/endpoint.ts` `capability_expiry`): every render of
   the same hole in the same half-TTL window mints the same `exp` → same signature → same URL. The
   header block becomes byte-identical across requests and the app's cache hits again. Validity
   stays between ttl/2 and ttl.
2. **Per-request slot ids** (`region-snippet.ts` `next_slot_id`): a process-wide counter made
   every page differ from its previous render; now the same page mints the same ids (endpoint
   renders are prefixed by their region id so a spliced hole never collides).

App (header port owner):
3. Redis-cache `country_selector_entry` like `header_options` (or make the panel a `deferred`
   hole so the Builder call leaves the TTFB path).
4. Keep the mega-menu fallback markup OUT of the `<qds-web-header>` element the middleware
   hydrates as one block: a 738 KB block is a 738 KB Stencil hydrate on every miss. Even with a
   stable key, a per-instance miss (cold Lambda, eviction) pays it in full.
5. Longer term: key the QDS render cache on a normalized block (strip `<ogygia-region …>`
   attributes) and re-insert the live tags, so hole URLs can rotate without defeating the cache.
6. Redeploy on `passage` HEAD (this deploy is `pkg.pr.new/ogygia@3094f98`, before today's server
   perf commits: +28 → +12–17 ms per request, JSON lane, one document pass).
