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

## Server, round 2 — 2026-09-19

Same bench, re-profiled on the (6) checkout. The seed/props path had grown five tree walks per
request: the full `page.data` (for the seed index), the SHAPED copy (a new root → its own memo →
a full re-walk), each block island's props (`{ block }` is a new root, so the block subtree it
holds was walked again — 20 blocks = the whole seed a third time), and the tail's sidecars were
PLANNED AND SERIALIZED TWICE whenever seed shaping was active (a dry run against the full index to
learn `touched`, then the real render against the shaped index). Plus `fnv1a` over ~420 KB of
canonical props text per request in a JS char loop.

| # | finding | replacement (delete → add) |
| --- | --- | --- |
| S13 | `measure` memo per ROOT: a props object that IS a seed node re-walks its subtree; the shaped seed re-walks everything. | ONE memo per request (`set_measure_memo_reader`, hooks.ts hands out `bag.measure_memo`): every root measured in the request shares it — a block's props cost one lookup, the shaped root a handful. Off-request (hole endpoint, tests) each root keeps its own memo. |
| S14 | A `Measure` object + a cycle `Set` add/delete per node (7 K nodes per request here). | Packed measure: one NUMBER per node (`bytes*8 + flags`) in the memo; the memo's own in-progress mark is the cycle detector, written only when a child is an object (a leaf-only row writes the memo once). `analyze()` unpacks the root. |
| S15 | `index_seed` allocated a path ARRAY (`[...path, key]`) + two WeakMap entries + a `SeedNode` per indexed node, and built the byte buckets eagerly. | Parent-pointer `PathNode` per indexed node; the path array materialises on the first `by_identity.get` (only referenced nodes — ~20 a page). Bytes read from the memo. Buckets built on the first structure ask. Prune on `bytes < min_bytes` alone (a child is never larger than its parent). |
| S16 | The dry-run tail render for seed shaping (plan + `stringify` every sidecar twice). | The tail renders ONCE against the FULL `page.data` index; the plan's `touched` keys join `seed_keys`; then the seed is shaped. Paths are structural and shaping keeps top-level keys whole, so a full-tree path resolves identically against the shipped seed. `wire(seed)` also memoises per index. |
| S17 | `plan_seed_refs` descended into every plain node, and `stringify_props` ran the five prop-family `mint` matches on a seed node before the seed-ref reducer saw it. | Prune below `min_bytes`; the seed-ref reducer registered FIRST (a seed node is plain data, never a wired class / store / snippet / fn). |
| S18 | `fnv1a` (JS, 2 lanes × charCodeAt) over the canonical props text: 0.19 ms per 131 KB. The client never recomputes an island's fingerprint (it reads `data-og-fp`; `region_props_fp` computes only for regions that carry none). | `server/fingerprint.ts`: native SHA-1 → 16 hex, 0.043 ms per 131 KB, reached from Region.svelte through the client-stubbed `virtual:ogygia/region-endpoint` (`islandFingerprint`). Hole identity (`data-og-hole`) stays on the universal `fingerprint_of` — the client leg recomputes that one. |
| S19 | Region built the modulepreload `<link>` markup, the tail regex-parsed the hrefs back out of it. | Regions hand the tail hrefs (`DocumentTail.hints(hrefs)`); `modulepreload_tag(href)` is built once at render. `hint(html)` deleted. |

| | before (this checkout) | after |
| --- | --- | --- |
| ogygia p50 overhead per request | +17.3 ms | **+11.2 to +11.6 ms** (two runs) |
| ogygia p95 overhead | +34.5 ms | +23.6 ms |
| `Region.js` self time / 1,200 requests | 1,592 ms (`measure` 428, `fnv1a` 409, index+plan visits 339) | 717 ms (`measure` 262, native digest 94, visits 127, `fnv1a` gone) |
| GC | 533 ms | 462–486 ms |
| HTML / RSS | 629 KB / flat | unchanged |

Micro (`analyze` + `index_seed` + 20 block plans, no shared memo): 1.51 → 1.17 ms; with the
request memo the block plans are lookups. What is left of ogygia's own CPU per request (~2.5 ms at
4× concurrency ≈ the +11 ms): `measure` 0.43 ms (40 % of it `Object.getOwnPropertySymbols` — the
brand check; a known-brands `in` probe measured no cheaper), `plan_props_wire` 0.26 ms (native
`JSON.stringify` of the canonical texts), the `locate` flatten 0.2 ms, `inject_client_seeds` 0.13
ms, the two visits 0.2 ms, the digest 0.16 ms — and Kit's ETag `hash()` + encode scaling with the
+435 KB, ~0.6 ms. K1 (Kit's dead csr=false `uneval`, 2.0 s / 1,200 requests, both routes) is
still the largest single line on the profile and still upstream.

Guards: `test/seed-refs.test.ts` "the shared request memo" (a block's props add ONE memo entry,
a shaped root one more, a cycle through the memo stays opaque); `test/props-wire.test.ts`
`island_fingerprint` (16 hex, deterministic, field-separated).
