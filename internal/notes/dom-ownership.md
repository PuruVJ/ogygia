# DOM ownership — one model for every ogygia DOM writer

Status: BUILT 2026-10-06 (user: "yes all three" — keep = foreign everywhere, compile stamps, conflict
event). See §10 for what shipped and what was deliberately left. Design written the same day. Trigger: a field report (fbb52bc3) where the pre-hydration repair strips
a third-party web component's own nodes inside `data-ogygia-keep`. The user asked for the long-term,
architecture-wide change, diagnosed properly first. Evidence: three code sweeps on 2026-10-06 (every
client DOM writer; every ownership signal + 15 past incidents; Svelte 5.56.8's hydration internals).

## 1. The bug that started it

An island server-renders a third-party widget inside `{@html}` and marks its root
`data-ogygia-keep`. The widget's definition loads before the island wakes; on upgrade it prepends a
backdrop and appends a suggestions pane to its own light DOM. At wake:

1. drift-watch saw the widget's own childList mutation → island marked "changed";
2. `sequence_differs` compared the whole tree with the server copy, inside the kept element too →
   "drift";
3. `align_to` recursed; at the widget the element skeleton differed → it called
   `morph(widget, server_children, REPAIR_MORPH)` with the WIDGET AS THE MORPH ROOT
   (`hydrate-core.ts:335`);
4. the morph never vets its root (`morph.ts:249`; `is_preserved` runs on descendants only, `:554`,
   `:580`) → backdrop and pane removed. Search suggestions dead.

None of that repair was needed: Svelte never walks inside `{@html}`.

## 2. Diagnosis: the six root causes

These are not one bug. The same shape has now cost 15 incidents (catalogued in §9), each fixed in one
write path while the next path stayed open.

**R1 · Ownership is decided per CALLER, not per NODE.** There are 19 distinct ownership concepts in
the runtime (keep, persist, hydrated-on-hyphenated, upgraded-CE, self-owned, `preserve_self_owned`,
`keep_children`/`keep_extra`, stale-region exception, lakes, nested riding vs self-running regions,
`<ogygia-slot>`, reconcile keys, focus, head registry, restore marks, server-copy truth, diagnostic
marks, opt-outs, Kit ownership). Each of the 5 morph call sites, the repair, drift-watch, restore,
lakes, router and form continuity re-derives "may I touch this?" with its own subset. "Upgraded custom
element" alone is detected three different ways (`morph.ts:510` shadow-or-definition, `restore.ts:304`
shadow-only, the repair: not at all).

**R2 · The morph engine never vets its own root.** Every ownership check runs on descendants. A
caller that picks a root (`align_to` on a child, hole `#apply` on an already-hydrated island,
`#morph_live`) bypasses all of them. Whether `keep` is honoured during repair depends on how deep the
first divergence is.

**R3 · The truth flips by phase, and that flip is encoded as a per-caller FLAG.** Before wake the
server bytes are the truth; after an upgrade or hydrate the live DOM is. ogygia expresses this as
`preserve_self_owned: true` (live morph) vs `false` (repair), so the same signal (`is_self_owned`)
means opposite things in two callers (incident 8). The flip is really about WHO owns a node, which
does not change with the caller.

**R4 · ogygia's model of "what Svelte needs" is wrong in both directions.** `sequence_differs` says it
reads "exactly what Svelte's walk reads" (`hydrate-core.ts:182`). Svelte's actual contract
(svelte 5.56.8, file:line in the sweep):
- the walk matches ELEMENTS BY POSITION ONLY; it never checks tags (template.js:66-70, 114-118);
- it never descends a STATIC element (no dynamic content, literal attributes, not a custom element:
  `is_static_element`, fragment.js:141-185) — it only counts it as a sibling;
- it never descends `{@html}` content: it scans siblings to the closing `<!---->`
  (client html.js:103-131); a controlled `{@html}` (sole child) starts at `parent.firstChild`;
- `createRawSnippet` adopts its element whole (snippet.js:80-84);
- a missing TEXT slot is not fatal: Svelte inserts an empty text node (operations.js:120-124);
- attributes are never compared;
- what IS fatal: a comment where an instruction is expected, a leftover sibling at `reset(el)`
  (hydration.js:48-58), a null cursor, the root `<!--]-->` not where expected.

So the repair is OVER-broad (it rewrites static subtrees, `{@html}` content and adopted slots that
Svelte never reads — destroying foreign content there for nothing) and BLIND (it cannot tell which
elements Svelte walks, so it cannot be precise).

**R5 · ogygia writes whole values where ownership is shared.** `replaceChildren`, `sync_attributes`
on `<body>` with `keep_extra=false`, whole-`class` writes, `merge_head` before the head registry: each
assumes one owner. The fixes skip the write or restore afterwards (`keep_host_classes`, the class
MutationObserver).

**R6 · Guarantees rest on timing, not on declared boundaries.** "The runtime script runs first",
"snapshot at first connect", "restore inlined before anything upgrades", drift-watch catching the
mutation. Every guarantee is "ogygia saw it before the other owner". Only `<head>` has a real owner
registry (677409fd), and lakes are the only boundary proven to survive a foreign edit.

## 3. The model

> **Every node in a region has exactly one OWNER. Every ogygia DOM writer asks the same function who
> owns a node and obeys one contract table. No writer re-derives ownership, and no flag changes it.**

### 3.1 The owners (a closed set)

| Owner | What | Truth | Example |
|---|---|---|---|
| `walk` | nodes Svelte's hydration walk binds by position | the server copy until hydrate; Svelte's references after | dynamic children of an island's elements |
| `static` | render output Svelte never descends: static element subtrees, `{@html}` content, raw-snippet roots | whatever is there (nobody re-reads it) | a static footer list; the widget inside `{@html}` |
| `foreign` | nodes another runtime owns: an app-declared kept subtree; children/attributes an upgraded custom element added that the server never sent | the live DOM, always | the widget's backdrop and pane |
| `lake` | `wake="none"` content | the server bytes (ogygia lifts/restores them) | header lake |
| `region` | a nested region boundary that runs on its own (deferred, adopted slot, foreign entry, already hydrated) | that region's own owner rules | a hole inside an island |
| `page` | `<ogygia-slot>` content: host-page content the island adopts | the host page | slot children |
| `runtime` | ogygia's own nodes | ogygia | announcer, region-css links, sidecars |

`walk` is the ONLY owner whose sequence ogygia must keep in the server's shape before hydration.
Everything else is opaque to the repair: compared by tag and position only (the walk counts it as one
sibling), never entered.

### 3.2 `owner_of(node)` — one function, one precedence

`runtime/ownership.ts`, used by every writer. First match wins, walking up from the node:

1. inside a `lake` (nearest region is a lake) → `lake`
2. a nested region that runs on its own → `region`
3. inside `<ogygia-slot>` → `page`
4. inside an element the app declared foreign-owned (§5, decision 1) → `foreign`
5. inside an element the compiler stamped `data-og-opaque` (§4) → `static`
6. a child or attribute of an UPGRADED custom element that is not in the server copy → `foreign`
   (one detection, `is_upgraded_ce`, used everywhere: shadow root OR registered definition)
7. otherwise → `walk`

Rule 6 needs the server copy to answer "was this node sent?". The repair already holds the parsed
copy; the live morph has the incoming answer. Both pass it in.

### 3.3 The contract table (every writer × every owner)

| Writer | walk | static | foreign | lake | region | page |
|---|---|---|---|---|---|---|
| pre-hydrate drift check | compare fully | tag + position only | ignore | lifted (as today) | tag + position only | tag + position only |
| pre-hydrate repair | rebuild to the server sequence | leave | leave (see 3.4) | lifted | leave | leave |
| live morph (hole, live, nav) | patch to the answer | patch to the answer | **leave** (keep) | its own revalidation | leave if running | leave |
| morph ROOT | — | — | **no-op** | — | **no-op if hydrated** | — |
| drift-watch | counts | ignores | ignores | ignores | ignores | ignores |
| raw swaps (`swap_body`, first live tick, late templates) | route through the morph, or refuse on foreign/region | same | same | same | same | same |
| attribute sync | Svelte's attrs | answer's attrs | foreign attrs kept | — | — | — |
| class tokens | Svelte's tokens | answer's | foreign tokens kept | — | — | — |

What disappears: `preserve_self_owned`, the second morph contract, `keep_children`/`keep_extra` as
separate concepts, the three upgraded-CE detections, and the depth-dependence of keep. The live morph
and the repair differ in their TARGET (the new answer vs the server copy), never in their ownership
rules.

### 3.4 The one real conflict: a foreign node in a walked position

If a widget inserts nodes into a position Svelte WILL walk (dynamic children of a custom element in
the template), Svelte's positional walk breaks: no rule can keep both. The model makes the conflict
explicit instead of silent:
- the repair removes the foreign node (the walk needs the position) — today's behaviour, now a
  decision, not an accident;
- it emits ONE devtools/console event, `ownership.conflict`, naming the element, the owner it
  overrode and the fix: "render the widget subtree with `{@html}` or as static markup (Svelte never
  walks it), or move it into a lake".
- An app-declared foreign element (§5, decision 1) is never touched: if that breaks the walk, Svelte's
  recovery re-renders the island, and the conflict event says why.

## 4. Declared ownership instead of inferred: compile-time stamps

R4 and R6 share one fix: make the compiler say which elements Svelte does not walk, instead of the
runtime guessing after the fact.

A server-leg transform over island component files stamps `data-og-opaque` on:
- an element whose sole child is `{@html}` (controlled form);
- an element with `bind:innerHTML` / `bind:textContent` / `bind:innerText` (Svelte owns it
  wholesale, by value);
- a custom element whose template children are entirely static (Svelte never descends it).

Uncontrolled `{@html}` (not a sole child) can't carry an attribute of its own; its parent gets
`data-og-html="<n>"` (the child index of each opening `<!---->`), so the runtime knows exactly which
comment pair delimits unwalked content. (PROD output alone can't tell an `{@html}` opener from any
other `<!---->` separator; the stamp is what makes it knowable.)

Why this is safe: Svelte's hydration never compares or strips static attributes, and the stamp is
server-only (the client template is not changed, so `set_custom_element_data` paths are untouched).
It adds no nodes (adding nodes would shift the positional walk).

Cost: ogygia's `FileCompilation` parses only HOST files today. The stamp needs a light server-leg
pass over island component sources, reusing the existing `walk_template` (`free-vars.ts`). Same
parse the compiler already does elsewhere; only on files in the island graph.

The customer's case under this model needs NO marker at all: the widget is inside `{@html}` → the
compiler stamps it opaque → the repair never enters it, drift-watch ignores its mutations, the live
morph keeps it.

## 5. Open decisions (for the user)

1. **The app's way to declare "foreign-owned".** Options:
   - (a) `data-ogygia-keep` on an element means "the live DOM owns this subtree" in EVERY writer
     (recommended: it already means that in the morph and the router; this removes the exceptions;
     no new API). Its region-level second meaning (KeepHost) stays a region concern.
   - (b) a new attribute (`data-og-own="foreign"`) separate from navigation keep. Cleaner words, but
     new public API, and two markers for what is mostly one idea.
2. **Compile-time stamps (§4).** Recommended: yes. Without them the repair stays blind (R4), and
   every widget inside `{@html}` needs a hand-written marker.
3. **A foreign node in a walked position (§3.4).** Recommended: remove it and emit the conflict event
   (today's behaviour, made explicit), unless the app declared the element foreign.

## 6. What changes, file by file

- `runtime/ownership.ts` (new): owners, `owner_of`, `is_upgraded_ce` (moved from morph), the stamp
  readers.
- `runtime/morph.ts`: vet the ROOT with `owner_of`; replace `is_preserved` / `is_self_owned` /
  `preserve_self_owned` / `keep_children` with owner checks; foreign nodes kept, walk/static nodes
  patched; keyed replace no longer bypasses ownership (today a keyed tag mismatch replaces a preserved
  node before the check, `:549-551`).
- `runtime/hydrate-core.ts`: `sequence_differs`, `describe_divergence` and `align_to` walk only
  `walk`-owned children (opaque owners compared by tag + position); `repair_markup` passes the copy so
  rule 6 can answer; one `ownership.conflict` event; host-class noting moves before the repair.
- `runtime/drift-watch.ts`: ignore mutations whose target is not `walk`-owned (a widget upgrading no
  longer arms the repair).
- `runtime/core.ts`: hole `#apply` and `#morph_live` go through the vetted root (no morph over a
  hydrated island); `applyLive`'s first-tick `replaceChildren` and `swap_body` refuse foreign/region
  subtrees or route through the morph.
- `runtime/reconcile.ts`: `<body>` attribute sync keeps foreign attributes (today third-party body
  attributes are stripped every navigation).
- `runtime/restore.ts`: uses the shared upgraded detection; its `data-og-head` inserts are claimed in
  the head registry (today they are unowned: never retired, never removed).
- `runtime/lakes.ts`, `<ogygia-slot>`: become owners in the one function (slot content is lifted /
  skipped like lakes, which today it is not).
- Compiler: the server-leg stamp pass (§4).
- Docs: one page, "Who owns the DOM": the owners, what each writer does, and the guidance for
  third-party widgets (inside `{@html}`, static markup, or a lake; or declared foreign).

## 7. Tests: the matrix, not the incidents

- **Unit, `owner_of`**: every owner, the precedence, nesting (a lake inside a slot inside a region).
- **Browser, writer × owner**: each writer (drift check, repair, live morph, morph root, drift-watch,
  raw swaps, attribute and class sync) against a fixture holding one node of each owner. Asserts node
  identity kept/patched per the table.
- **Every past incident as a row** (§9): the design is accepted when all 15 still pass and the field
  case passes.
- **The field case e2e**: an island with a custom element inside `{@html}`; its definition loads
  before the island wakes and adds P and Q around children A and B. Expect: no discard, no repair
  inside it, P A B Q with the same node identity, Svelte's walk past it unaffected. Variant: the same
  element with walked children → conflict event, island still hydrates.
- **Stamp tests**: the compiler stamps exactly the three shapes; a server-only attribute; the client
  template unchanged; the HTML byte cost on a large page (one attribute per opaque element).

## 8. Build order

1. `ownership.ts` + `owner_of` + the shared upgraded detection; the matrix test, written against
   today's behaviour (it documents every current inconsistency as a failing row).
2. Morph: vet the root, owner checks replace the flags. Repair: walk-owned only. Drift-watch filter.
3. The compile-time stamps.
4. Raw swaps, body attributes, restore head claims, slot ownership.
5. Docs page; the conflict event in devtools; the incident rows.

## 9. The 15 incidents this has to keep fixed

1. A DSD middleware re-serialized regions after SSR (anchors eaten) → zero-survivor detector.
2. A web-component runtime reshaped Kit-owned light DOM before Kit hydrated → lakes remember + refill.
3. A design-system script stripped whitespace inside sleeping islands → repair before the walk,
   `align_to` keeps elements (4 rounds).
4. Hole morph stripped `popover` a dropdown set on itself → self-owned keeps extra attributes.
5. Hole morph removed a component's slotted light DOM → self-owned keeps children.
6. `replaceChildren` destroyed an open upgraded mega-menu item → morph on every schedule.
7. The morph wrote a fresh id/scope class over a live host → upgraded hosts skip attribute sync.
8. Keep-children left a nested component's residue where Svelte's cursor landed → the repair contract
   (`preserve_self_owned: false`).
9. A foreign upgrade ran over a hole answer before its nested island snapshotted → pristine capture.
10. Third-party head pollution broke Svelte's head walk → neutralize head markers.
11. `merge_head` fought `<svelte:head>` → the head owner registry.
12. A whole-document scoped renderer after SSR broke regions four ways → app-side + `ogygia/rewrite`.
13. Server transforms reshaped Svelte-owned markup → reversible marks + restorer + host-class merge.
14. Kit's hydration vs ogygia (rebuild wiped holes; `data-kit-hydrated` dead island; lake CSS; page
    thread race).
15. Svelte's parser hoisted a block island out of `<p>` → dev warning.

Incident 8 is the proof the model is needed: under it, the nested component's residue is `foreign`
in a `walk` position → removed with a conflict event (the walk needs it), while the hole morph's
"keep self-owned children" (incident 5) is the same `foreign` owner under the live morph → kept. One
owner, one table, both incidents fixed without a flag.

## 10. What shipped (2026-10-06)

- `runtime/ownership.ts`: `Owner` (`foreign | region | page | static | walk`), `owner_of`,
  `walk_enters`, the ONE `is_upgraded_ce` / `is_self_owned`, the two stamp constants. `data-ogygia-keep`
  / `data-persist` on a plain element = `foreign`; on a region = `region` (a kept island, still Svelte's).
- Morph: the ROOT is vetted (`foreign` → no-op; toward the walk, any non-walk owner except the region
  being repaired → no-op); `off_limits` replaces `is_preserved`, checked BEFORE a keyed tag-mismatch
  replace; `MorphOptions.target: 'live' | 'walk'` replaces `preserve_self_owned` (same ownership rules,
  different target).
- Repair: `sequence_differs`, `describe_divergence`, `align_to` enter `walk`-owned children only;
  `region.hydrate.conflict` (devtools + DEV console + session finding) when a self-owned element in a
  walked position had to lose its own nodes.
- Drift-watch: a mutation under a non-walk element does not mark its island changed.
- Compiler (`compiler/ownership-stamps.ts`, server leg, app + declared packages): `data-og-opaque` on a
  sole-child `{@html}` host, `bind:innerHTML|textContent|innerText`, and a custom element with static
  children; `data-og-html` on an element holding an `{@html}` beside other children (its child elements
  are compared by tag + position, never entered — the exact range is not knowable from PROD markup).
- Navigation: `<body>` attributes — only the previous page's SERVER attributes are removed; a script's
  are kept.
- Lazy-chunk rule kept: the hydrate core reaches ownership through `slots.boot` (`BootLink`).
- Docs: `01-regions/07-dom-ownership` ("Who owns the DOM").
- Tests: `test/browser/dom-ownership.test.ts` (owner_of; the field case for both markers; slot; the
  conflict; morph root + keyed replace + walk-vs-live; drift-watch), `test/ownership-stamps.test.ts`,
  `e2e/dom-ownership.spec.ts` (three widget shapes on one island; fails on the old code exactly like
  the field report), morph body-attribute tests.

Deliberately left (each reviewed):
- Raw full swaps (`swap_body` fallback, the first live tick's `replaceChildren`, late templates):
  documented fallbacks / first renders where nothing live exists yet to own; `swap_body` now keeps a
  script's body attributes.
- Hole `#apply` morphing a region that already hydrated: unverified as a real path; a static hole's
  revalidation legitimately morphs its own `data-hydrated` root.
- Restore's `data-og-head` assets stay unowned: shared, keyed once per session, reused by hosts.
- Host-class noting order (after the repair): a re-created element has lost the expando either way.
- A widget as the DIRECT host of `{@html}` (`<x-w>{@html}</x-w>`): Svelte keeps its own `<!---->`
  markers as that element's children, so a widget prepending there breaks Svelte itself; the docs say
  to put the widget INSIDE the `{@html}` content.
- An `{@html}` at a component's root (no parent element in that component): nothing to stamp; wrap it.

## 11. Facets: finishing rule 6 (2026-10-09)

**The field case.** A hole's fallback rendered an empty `<x-panel>` inside an upgraded custom element;
the answer rendered a full one. The element's runtime, at its upgrade, had re-appended its element
children (the panel now AFTER its closing block comment). The morph matched by position, met a
comment where the panel was, inserted the answer's panel, and kept the old one ("never remove a child
a self-owned element gave itself"): two panels, the stale one painting over the real one.

**The diagnosis.** §3.2 rule 6 said a child of an upgraded element is foreign *only if the server
never sent it*. What shipped was the shortcut "every child of a self-owned element is kept", and the
model answered one question per element (who writes inside it) while four writers answered other
questions privately: `keep_children` and `drop_stale_regions` (who may remove a child), the
upgraded-host attribute skip and `carry_address` (who writes an attribute), positional matching under a
self-owned parent (who orders the children).

**The model, widened: one element, four facets.**

| facet | `render` (the answer / server render: the morph speaks for it) | `element` (its own runtime / the browser) | `region` |
|---|---|---|---|
| content | walk / static / page | — | a hydrated region root |
| attributes | default | an upgraded custom element's host | a region root, except its ADDRESS (`endpoint`): the render that minted it |
| order of its children | default | a self-owned element (it relocates / wraps its light DOM) | — |
| existence of a child | the render made it (provenance) | the element made it | — |

**Provenance** (`render_made`): a registry ogygia fills wherever it places nodes under an
element-ordered parent — a morph's claim or insertion, the restore putting Svelte's children back into
a planned host — plus two structural truths for an unmarked node: an `<ogygia-region>` is always render
output, and an element whose tag the render produces at that level is render output (a runtime does not
make the render's elements). Anything else under a self-owned parent is the element's: never matched,
never removed.

**The morph under element-owned order** matches by identity, not position: key → id-set holder → the
next render-made sibling of the same tag; each match is morphed IN PLACE (the element's arrangement
stands, nothing re-upgrades); a new node with no match is inserted after the last placed render node;
a render-made leftover is removed. Positions are the element's, so they never decide a match.

**Folded in and deleted:** `drop_stale_regions` (a region is render-made), the `keep_children` tail
rule, `carry_address` (the attribute facet), the upgraded-host attribute skip (the attribute facet).
