# ogygia performance audit — 2026-09-10

Target: a large CMS-driven production page (2.6 MB HTML, 21 islands, one island with ~300 KB props
outside `page.data`, ~690 KB page seed, ~181 tail module-preload hints, router on) served from a
Lambda-style host on **Node 20**, viewed on a slow phone. Goal: ogygia's per-request server cost near zero and memory-flat;
client boot with no long task of ogygia's making; every fix REPLACES the machinery it obsoletes.

## Measurements (before)

Server, `internal/bench/server-cost.mjs` (playground `/bench-cms` vs its no-ogygia twin `/bench-cms/plain`,
same components, same data; 300 req × 4 concurrent; `--cpu-prof` on the vite preview process):

| | plain | islands | delta |
| --- | --- | --- | --- |
| HTML | 194 KB | 683 KB | +488 KB (seed ~190 KB + header props ~300 KB) |
| p50 | 18.4 ms | 46.3 ms | **+28 ms** |
| p95 | 24.2 ms | 65.3 ms | +41 ms |
| RSS over 1,200 requests | flat | flat | no growth |

CPU self-time, 1,200 requests (~10 s non-idle):

| ms | what | owner |
| --- | --- | --- |
| 2,800 | devalue `stringify` (flatten 935, `stringify_string` 741, `get_escaped_char` 671, …) | ogygia seed + props |
| 1,480 | devalue `uneval` | **Kit** unevals every load node's data even on csr=false (`render_page` → `add_node`, no csr gate; result unused) |
| 829 | Kit `hash(transformed)` for the ETag over the whole HTML | Kit; scales with our +488 KB |
| 564 | GC | mostly our transient copies |
| 357 | `inject_client_seeds` self (full-document copies) | ogygia |
| 224 | `KitBoot.html_has` (`[\s\S]*?` regex + copy over the whole doc) | ogygia |
| 154 | `dedupe_stylesheet_links` + `dedupe_modulepreload_links` (full-doc regex replace) | ogygia |
| 158 | `/\/[^"\s]+\/immutable\/og-region\.…/g` over each island's payload | ogygia |
| 370 | `mint` + `register_kind` + `match`/`is_store` (reducer fan-out per value) | ogygia |
| 340 | `measure_subtree` + `visit` + `index_seed` + `is_plain` (seed walks) | ogygia |
| 181 | `fnv1a` (inherent: content fingerprint over 300 KB) | ogygia |

≈ 7.5 ms of ogygia CPU per request at this shape, ~80 % of it serialization + whole-document passes.

Client, the real production page (4× CPU throttle, load + 12 s): first-party JS self time 488 ms,
of which og-runtime **15 ms**, Svelte runtime 146 ms (header island hydration), app chunks the rest.
Light DOM is only 2,013 elements (the design system's shadow roots hold the rest):
150 attribute `querySelector`s = 4–8 ms unthrottled; `JSON.parse` of the 674 KB seed = 2 ms;
`getElementById` ×150 = 0.1 ms. After load the 21 props sidecars (300 KB) and the seed (674 KB)
stay in the DOM. The seed is devalue-parsed **twice** at boot (`seed_page_once` and `seed_data_of`)
and the second cache is keyed by an element the morph reuses → stale seed refs after a reconcile nav.

## Findings and the replacement for each

### Server

| # | finding | replacement (delete → add) |
| --- | --- | --- |
| S1 | `request_als` (`hooks.ts:179,762`) wraps every render in a second AsyncLocalStorage; on Node 20/22 each ALS is a store copy per async hop (~0.2 s on a 475k-hop page, measured for the profiler in 44c9b43). The production host runs Node 20. | Delete `request_als`. One request store: Kit's. `bags: WeakMap<RequestEvent, RequestBag>`; every reader (`set_*_reader/recorder`) resolves through Kit's request event. Region path reads the bag off the `__request__` context it already re-sets. |
| S2 | `inject_client_seeds` makes 8–9 full-document scans and 4–5 full copies (`kit-boot.ts:29-30`, `head-presence.ts:77,87`, `hooks.ts:958-964,1006,1014,1161`). | Delete the pass chain. One `assemble_document(html, …)`: `indexOf('</head>')`, `lastIndexOf('</body>')`, presence/dedupe only on the head slice, runtime-script fact from the bag's claim (not a regex), one final concatenation. Zero-region pages skip the body side entirely; fn manifest only when islands render. |
| S3 | `KitBoot.html_has` scans the whole document for a build-time fact. | Delete the scan. `documentIsCsrTrue()` (route fact from `csr_true_routes`). Fallback (no route id) bounded to the last 64 KB. |
| S4 | devalue output re-escaped (`Region.svelte:406,535,746`, `page-seed.ts:57`) though devalue already emits `<`; N reducers per value; `mint()` loops 5 kinds per object. | Delete the post-escape on devalue output. One combined reducer. `mint` short-circuits on non-objects and checks brand symbols first. |
| S5 | devalue's JS string escaping is the single hottest thing; the seed is a plain tree on CMS pages. | Add a JSON lane: `analyze_seed` proves plainness → `JSON.stringify` (native) + one `<`/U+2028/9 replace, emitted with `data-format="json"`; client `JSON.parse`. devalue stays for trees with Dates/Maps/refs/thenables. Same lane for props whose payload is plain and ref-free. |
| S6 | Seed refs only apply to islands rendered after the first `$page` reader (`Region.svelte:397-404`). | Route fact: build emits `page_readers` per route (from `islandReadsPage`); `bag.seed_wanted` initialised from `event.route.id`. Render-time flip stays only as the fail-open for held regions. |
| S7 | Seed tree walked 3× (`measure_subtree`, `has_deferred`, devalue); `[...path,key]` allocated before the prune. | One `analyze_seed(data)` → `{ plain, has_thenable, bytes, nodes }` used by seed-refs, deferral, and S5. Prune before the spread. Delete `has_deferred`'s separate walk. |
| S8 | Portable-snippet regex over each island's whole payload (`Region.svelte:499`). | Delete the regex. The snippet kind's `encode` already sees every live descriptor; collect entries in the reducer closure. |
| S9 | Render cache (500 entries) and freeze memory store (1,000) bounded by count; entries up to 2 MB. | Byte-bounded LRU (64 MB default), one shared `SizedLru`. |
| S10 | Streamed pages accumulate a second copy of the doc to find `</body>`. | Keep the last 6 decoded chars; never accumulate. |
| S11 | `hkdfSync` on every sign/verify. | Memoise the derived key per secret. |
| S12 | Freeze hit copies the 2.6 MB entry per hit (`hooks.ts:462`). | Store `[before_head_close, after]`; concatenate. |
| K1 | Kit: `render_page` unevals every load node on csr=false and discards it (~1.2 ms/req here, ~2–3 ms at 690 KB). Kit: ETag `hash()` over the full HTML. | Upstream issue/PR to Kit (gate `add_node` on `page_config.csr`). Not ours to patch. |

### Client

| # | finding | replacement (delete → add) |
| --- | --- | --- |
| C1 | `props_sidecar_of` = attribute `querySelector` per island; `seed_data_of` = `querySelector` per seed ref before its cache. | Sidecar gets `id="og-props-<fp>"` (server) → `getElementById`. Seed element resolved once per `read_region_props`; reviver closes over a lazily resolved `data`. |
| C2 | `customElements.define` upgrades all regions in one task; `wake:'load'` islands hydrate back-to-back in microtasks (one long task, no viewport priority). | Delete the immediate `fire()` for load. Hydration scheduler: one island per task via `scheduler.yield()` / `MessageChannel`; intersecting-now first, then document order. `connectedCallback` allocation-free. |
| C3 | Seed parsed twice at boot, twice per nav (once against stale text); `seed_data_cache` keyed by an element the morph reuses (stale refs after reconcile nav). | Delete `seed_data_cache`. One graph: `seed_data_of` returns `page_state.data` for the live document; foreign (incoming) docs parsed once per `Document`. Lazy parse on first read. `softInvalidate` is the only writer on a nav and marks seeded. Script text blanked after parse (router on). |
| C4 | Nav swap is one task inside `startViewTransition`: `html_has` regex copy, `region_in_shadow(doc.body)` (always false: DOMParser never attaches shadow roots), `region_in_shadow(document.body)` `'*'` walk, whole-body morph, seed re-parse. | Delete both shadow walks (connected-region `Set` vs light-DOM count). Delete `html_has` from nav (parse first, `document_has(doc)`). Split: fetch → parse + preflight + incoming-seed parse in a task BEFORE the VT; only head merge + morph + title inside it. Drop incoming hint links already in `warmed_modules`. |
| C5 | 129 seed refs deep-copied (`clone_plain`); keyed sidecar text kept forever. | Delete `clone_plain` on the read path (share by reference like `page.data`; DEV-only write guard). Blank keyed sidecars after parse. |
| C6 | `has_low_priority_hint`: full attribute walk + 181 `URL`s per visible island. | One lazily built per-document `Set` of resolved hint hrefs, invalidated by `prepare_spa_document`. |
| C7 | Kit-bootstrap detection runs 3× at boot (only one cached); inline-script regex scan. | Server stamps `<meta name="ogygia-csr">` when the route is csr=true; client checks the meta; single cached probe; router callers use the cache. |
| C8 | One `IntersectionObserver` per visible island; 5 capture listeners per interaction island and per on-demand hole. | Shared IO per `rootMargin` + `WeakMap<Element, fire>`; delegated capture listeners on `document`. |
| C9 | `afterNavigate`/`beforeNavigate` shims never auto-unsubscribe (leak per mount per nav). | Lifecycle-bound like Kit (`onDestroy` when called in a component). |
| C10 | One runtime chunk: router nav/morph/reconcile, interaction replay, Svelte `hydrate` + `NestedProvider` all parsed at boot. `bundle-size` only prints a delta. | Lazy chunks: `router-nav` (on first prefetch/click), `interaction-replay` (first arm), `hydrate-core` (first `#hydrate`). `e2e/bundle-size` FAILS on regression. |
| C11 | Hover: `composedPath` + 2 `closest()` per `mouseover`; post-nav scan of every anchor. | Early bail via `target.closest('a')`; scan only preload-marked anchors; post-nav scan in idle. |
| C12 | Leftover `window.__marker = Math.random()` at boot. | Delete. |

## Server: after (S1–S12 implemented)

Same bench, same machine, 300 req × 4 concurrent per route:

| | before | after |
| --- | --- | --- |
| ogygia p50 overhead per request | **+28 ms** | **+12 to +17 ms** (three runs; the machine, not the code, moves it) |
| ogygia p95 overhead | +41 ms | +21 to +30 ms |
| islands HTML | 683 KB | 627 KB (JSON lane; devalue's string dedupe was worth less than its escaping cost) |
| non-idle CPU over 1,200 requests | ~10.1 s | ~6.7 s |
| RSS over 1,200 requests | flat | flat |

What is left in ogygia's own CPU (1,200 requests): `fnv1a` 454 ms (the fingerprint over the
canonical props text — now the full text for every island, the price of a seed-independent
fingerprint), `locate` 247 ms (the ONE flatten of Kit's rope; Kit would flatten it anyway),
`measure` 216 ms (the one walk), `plan_props_wire` 165 ms (native `JSON.stringify`), the
transform's own body 255 ms. devalue no longer appears on the seed/props path at all.

What is left that is Kit's (K1, both routes pay it): `uneval` 1,377 ms — `render_page` unevals every
load node's data on csr=false and discards it — and the ETag `hash()` 769 ms over the whole HTML.
Together ~1.8 ms per request at this page shape; worth an upstream issue.

Deliberately NOT done (measured too small to justify a wire change): folding the N devalue
reducers into one tagged reducer (would change the client revivers; the reducer fan-out measured
~0.3 ms per request before the JSON lane and is now off the props/seed path entirely).

## Regression guards to add

- `test/document-assembly.test.ts`: synthetic 2.6 MB document through the handle's assembly with a
  counted `String.prototype.replace/indexOf/lastIndexOf` — asserts ≤ 2 whole-document operations and
  exactly one result allocation. Plus `hooks.ts` must not import `node:async_hooks`.
- `test/seed-json-lane.test.ts`: plain tree → `data-format="json"`; a Date/Map/thenable → devalue; byte
  and round-trip equality.
- `internal/bench/server-cost.mjs` is the before/after harness (numbers above are the baseline).
- Browser: `test/browser/hydration-schedule.test.ts` (no task > 50 ms of ogygia's making for 21 load
  islands; viewport-first order), `test/browser/seed-single-parse.test.ts` (parse count = 1; stale-ref
  regression across a reconcile nav), `e2e/long-task-budget.spec.ts` on the bench page.
- `e2e/bundle-size.ts` hard-fails above the snapshot + 2 %.
