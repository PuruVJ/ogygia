# Foreign DOM in regions — the smell the bcms/QDS incident exposed

Status: DETECTOR BUILT 2026-08-27 (same day): core.ts arms ssr_children pre-hydrate, flags zero-survivor
regions with `data-og-recovered` + attributing console.warn + `region.hydrate.recovered` devtools
event. e2e/detector.ts (playground /detector fixture + anchor-stripping hooks transform) — 51/51
green. Docs row + transform-zone guard test still TODO.
Repro + fix validation: `/experiment/mfe-poc/qdsrepro` (routes `/`, `/nokey`, `/lake`, `/lakeslot`, `/graft`).

## The incident, one paragraph

bcms runs a post-SSR middleware that hands `<qds-*>` blocks to Stencil's `renderToString`
(declarative shadow DOM injection) AFTER Svelte SSR — inside ogygia island regions. Stencil's
re-serialization ate Svelte's hydration anchors (4 openers vs 17 closers in the served region) and
injected its own comment markers. On island wake, Svelte 5's walker threw
(`skip_nodes` TypeError / `HierarchyRequestError`), recovery silently discarded the server DOM and
client-rendered — destroying the DSD (white title → black or empty, cache-timing-erratic). App-level
fix: graft middleware (splice ONLY the DSD template + host attrs into original bytes). The lake also
protects (lift/restore survives even mismatch recovery) but freezes Svelte behavior inside, so it
was rejected there ("behavior cannot change": bind:this, on:click CTAs, onMount listeners).

## Findings on ogygia itself

**A. The real smell — ogygia is BLIND to this failure.** Svelte 5's mismatch recovery is silent to
the embedder: the region's server DOM was discarded and re-rendered, yet ogygia stamped
`data-hydrated` and reported success. `data-og-fp` is an INPUTS fingerprint (entry+endpoint+props),
not a content signature — nothing can notice post-SSR mutation. A whole corporate class does this
mutation: DSD middlewares, A/B tools (the bcms page runs VWO, which rewrites DOM pre-paint),
consent injectors, edge rewriters (ESI, CDN HTML transforms). Every csr=false ogygia user in that
world can hit the same lottery with zero signal.

**Proposed detector (small, high-value):** in `#hydrate`, before claiming, capture a cheap identity
of the region's SSR DOM (e.g. firstElementChild ref + child count); after hydrate, if the original
nodes were discarded → the claim failed and Svelte recovered. Then: DEV loud `console.error`
naming the likely causes ("something mutated this region between SSR and wake — post-SSR
middleware / A/B tool / DSD injector? SSR content incl. injected shadow DOM was lost; if this
subtree is foreign-owned, freeze it: `wake: 'none'`"), plus `data-og-recovered` attr + devtools
event in prod. Turns a two-day production mystery into a first-load console line.

**B. The unstated law.** ogygia's own HTML transforms already obey "post-SSR transforms must be
invisible to hydration" — verified: hooks.ts touches only `</head>`/`</body>` appends and
head `modulepreload` link rewrites, never region DOM. But the law is tacit: no test guards future
ogygia transforms, and no docs warn app authors that their `transformPageChunk` (or their A/B
snippet) can corrupt islands. Write the law down in both places (a docs constraints section +
an internal test asserting handle() transforms leave region bytes untouched).

**C. Missing decision-table row.** "Server-injected / foreign-owned DOM inside an island" has a
correct answer (lake — mechanically proven: lift/restore preserves the DOM even through Svelte's
mismatch recovery) but nothing routes people to it. Add the row: web components with DSD,
third-party-rewritten subtrees → `wake: 'none'` boundary; interactive Svelte bits inside → nested
islands (island-in-lake wakes independently). Element-granular marker (`data-ogygia-foreign`) is a
possible later refinement; component-level lake suffices today.

**D. Known coupling, same family (no action).** The runtime manufactures Svelte anchor comments
(the `#hydrate` envelope insertion, "verified against svelte 5.56") — the same private protocol
the QDS middleware tripped over. Ours is deliberate, tested, and version-pinned; note it in the
law doc as the one place ogygia itself speaks the anchor protocol.

## Order of work (when picked up)

1. Detector (A) — runtime, ~30 lines + test.
2. Docs: constraints section for post-SSR transforms + decision-table row (B, C).
3. Internal test: handle() transform zone guard (B).
