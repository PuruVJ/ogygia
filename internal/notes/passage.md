# The Passage — the Ref hub architecture (branch `passage`)

**One sentence:** everything that crosses an island boundary is a resolvable reference —
`Ref { k: kind, i: identity, t: code tag, d: data }` — minted on one side, resolved on the
other; **identity is the spine**, and transport, reactivity-reattach, nav-continuity, and the
future reconciler are all operations on `i`.

## The policy space

Every feature is a point in a three-axis space over the one primitive:

| Axis | Values | Old scattered names |
|---|---|---|
| **kind** (what resolve yields) | renderable / value / code | region, snippet · store, wire · fn, remote |
| **lifetime** (how long `i` binds) | request / page / session / forever | server `remember:false` · live map · the Keep (`codec.id`) · frozen lake |
| **schedule** (when resolve fires) | now / hydrate / visible / interact / on-arrival / on-call | inline · wake:load · wake:visible · wake:interact · defer/streaming · lazy fn |

New features = new points, not new subsystems. Examples: persistent layout = renderable ·
session · reunify-on-nav. Streamed promise = value · request · on-arrival. Qwik-style lazy
callback = code · page · on-call.

## What is built (this branch — unit 901 passed | 3 todo; **e2e 44/44 checks pass**)

- **`src/ref.ts` — the hub.** `register_kind` / `mint(value, only?)` / `resolve(ref, remember)`.
  One id space (WeakMap per live instance — one id however many props/keys carry it), one live
  map (browser reunify, MAX_LIVE-bounded), one session Keep with generalized `merge` + owner-
  collision guard, per-request server isolation (`remember:false` never memoizes). Registry on
  `globalThis` `Symbol.for` keys (bundles must not fork identity).
- **Four kinds registered:**
  - `wire` (`live-transport.ts`) — `[import.meta.og.wire]` classes. Class registry stays local;
    identity/Keep moved to the hub. Continuity (`codec.id`/`merge`) = the hub's `keep_name`/`merge`.
  - `store` (`store-transport.ts`) — subscribe-shaped values. Registered-factory tier (methods
    rebuilt from the module) + generic `svelte:writable` tier. `mark_store` brands; compiler pass
    will emit brands later.
  - `snippet` (`region-snippet.ts`) — "a snippet is a region", now literal: branded descriptors
    cross; bare snippets freeze at the boundary (server-only claim, preserving the client DCE of
    `svelte/server`). Functions are never memoized (stateless until rendered — pre-hub behavior).
  - `region` (`transport.ts`) — the RENDERABLE Ref. Encode law (ticket pass-through / dual signs
    at the crossing / awaited-inline bakes HTML / inline-unawaited throws) and decode law
    (single-flight frame write + deferred rebuild) byte-for-byte preserved. `ogygiaTransport`
    stays the Kit entry as a thin wrapper (fresh-decode semantics kept; hub-memoized region
    identity is the reconciler's future entry point).
- **ONE wire key: `OgygiaRef`.** All seams collapsed onto `ref_reducer(families)` /
  `ref_reviver(remember)`: context page-marker + `<Provide>` + `parse_ctx`, island props
  (`region-props`, `region-endpoint`), endpoint decode (`hooks.ts`, remember:false), client
  props (`slots.wire = { REF_WIRE_KEY, resolve }`, `runtime/core.ts`). Per-seam family filters
  preserve deliberate semantics: the drop-in context path EXCLUDES `snippet` so a bare function
  THROWS (and is dropped with a dev explanation) instead of silently freezing; island props
  include it (bare snippets freeze there by design). Legacy per-kind exports remain as thin
  wrappers for tests/ABI; they can be deleted once nothing imports them.
- **The boundary layer (pre-hub, still current):** classifier (`boundary.ts`) with
  path-precise warn/refuse; granularity MARKER `setContext(key, value, { islands: false })`
  (inference from `getContext` call-sites was REJECTED — aliased imports make scans
  under-inclusive, and a missing island key is the fatal direction); store auto-wire corpus
  (`test/boundary-seam.test.ts`, `test/boundary-corpus.test.ts` — the 21-case migration
  contract from a real production census, see boundary-corpus.md).

## The public surface (the story to converge docs on)

- **region** — UI as a value, the public name of the renderable Ref. Produced by `content()`,
  blocks, remotes/loads (`region(Component, props)`), snippets crossing, imports `with {wake}`.
  Mounted by `<Region>`. `region.snippet()` can dissolve (compiler already brands snippets).
- **`import.meta.og.$()` is THE UNIVERSAL BOUNDARY MARK (user decision, 2026-08-20):** the
  boundary should be EXPLICIT and teachable, and one mark generalizes to props. Semantics by
  argument: an INLINE FUNCTION hoists (capture analysis → fn ref, sync client rebind); ANY
  OTHER expression is a BOUNDARY ASSERTION — classified at the marked site, refusals throw
  with that file:line at creation (never deep in a serializer), legal values pass through
  mark-don't-wrap (their passports already ride them). Auto-detection (stores by shape,
  auto-branded factories) REMAINS as the compatibility tier — og.$ is the documented,
  recommended surface. fn refs are legal ISLAND PROPS (fn family joined all prop seams; the
  snippet kind explicitly refuses branded fns so they are never frozen).
- **The other marks:** `with { wake: … }` at an import (component islands) ·
  `import.meta.og.wire()` on a class (bespoke codec + continuity) · `import.meta.og.store()`
  (assert a factory). Plain data free.
- **Two policy words** (future surface): `when` (schedule) and `keep` (lifetime) as the uniform
  vocabulary — `wake:` is `when` for renderables; continuity `id` is `keep:'session'` for values.

## The `fn` kind — RUNTIME HALF SHIPPED (`src/fn-transport.ts`), compiler-half later

`setContext('track', import.meta.og.$((e) => sendBeacon(siteId, e)))`:

1. **Compiler (NEXT — start here):** capture analysis at the marker (module imports travel;
   local values become bound params; server-only imports / DOM / closures = build errors with
   file:line), hoist the body to a generated tagged module that self-registers
   (`__register_fn(tag, factory)`), rewrite the call site to `fn_handle(tag, [captures])`.
   Follow `og-wire.ts`'s strict-by-construction playbook (AST-precise over `og_js_regions`,
   exactly one fn-expression argument, build error anywhere else); reuse the portable-snippet
   capture analysis for scope walking.

   **DECIDED (user, 2026-08-20): option (a), the fn manifest.** Build the construct against it;
   (c) lazy QRL stays a future opt-in `schedule` policy, never the default. The options, for
   the record: the client must be able to LOAD the
   hoisted code to resolve a `fn` ref, but devalue revive is synchronous. Three options:
   - **(a) Fn manifest (recommended v1):** hoisted factories compile into a
     `virtual:ogygia/fn-manifest` module the runtime entry imports — every factory registers
     before any island hydrates, calls stay SYNC. Cost: every hoisted fn ships to every page
     (fine at v1 scale; measure later). Mirrors the island-deps virtual plumbing.
   - **(b) Per-island imports:** the compiler adds the generated module to each island entry
     that can receive the fn. Precise, no bloat — but receivers aren't statically knowable for
     context, so it under-ships. Only viable for PROPS, not context.
   - **(c) Qwik-style lazy QRL:** decode returns an async stub; the chunk loads on first call.
     No bloat, but og.$ functions become Promise-returning on the client — a semantic change
     the user must sign off on. Fits the `schedule` axis (`on-call`) as an OPT-IN later
     (`og.$(fn, { lazy: true })`), not as the default.
2. **Runtime (SHIPPED):** `__register_fn(tag, factory)` + `fn_handle(tag, bound)` (the call-site
   rewrite target — returns the LIVE fn immediately on the minting side, branded with its travel
   handle) + the `fn` kind (decode = registry lookup + rebind; re-brands so a revived fn can cross
   a further boundary; bare functions NEVER claimed — the boundary law stays loud). Bound captures
   are refs-or-data: a captured store reunites, so every rebound copy shares live state. Tests:
   `test/fn-transport.test.ts`. Original design notes: `{k:'fn', i, t: tag, d: bound}`; decode = load the chunk (same manifest
   channel as island entries), `factory(...bound)` → the live closure. Eager-at-hydration
   resolution (fits islands; lazy on-call is a later `schedule` policy). Never memoize the
   *function* by accident of object-check — decide identity semantics explicitly (bound fns are
   per-handle; two handles with the same tag+bound may share).

## What must NOT unify (guardrails)

- **Capability vs data.** A Ref that triggers server compute (signed endpoint URL) never blurs
  with a value-seeding Ref. Signing stays its own layer; the region kind carries it in `d`.
- **csr=true inertness.** One live Kit tree = no boundary = the hub does nothing beyond a
  WeakMap write. Mark-don't-wrap everywhere.
- **The classifier stays a judge.** It vets what may mint (with paths + fixes); it never
  transports. Error messages belong to KINDS, not the hub — "cannot revive store X" must never
  degrade to "cannot resolve ref".
- **Content pipeline stays its own domain.** Only its output (bodies as prebaked renderable
  refs) touches the hub.
- **The frame store is NOT merged yet.** It is the same identity idea (address → frame) but has
  live-update/subscribe semantics the hub lacks; merging it is a later, separate decision.

## og.$ — COMPLETE, PROD-VERIFIED (playground /dollar-fn: island click → x119.00, 0 errors)

Full pipeline: transform (og-dollar.ts, wired in vite/index.ts) → `__og_$` (registers + returns
the live bound fn) → the drop-in setContext bridges BRANDED fns (bare functions still refuse —
`is_branded_fn` is the exception; fn joined BRIDGE/PROVIDE families) → fn ref crosses with the
factory SOURCE riding the payload (self-contained by the capture law) → client decode: registry
hit (manifest) or source fallback (indirect eval; strict-CSP apps need the manifest). The
`virtual:ogygia/fn-manifest` is imported by the runtime entry; complete in DEV. PROD: the
virtual now emits a rename-proof placeholder (globalThis.__og_reg_fn bridge + token) that a
`renderChunk` hook patches after all transforms — but the og-runtime chunk is still patched
EMPTY: it is emitted as its own unit (see the feature-set filename busting), rendered in a
context where `dollar_hoists` hasn't seen the app's pages. RESOLVED — the runtime-chunk route was abandoned
for a better one: the PAGE-INLINE manifest. The client build's writeBundle persists
`fn_manifest` into the og-region-deps.json handoff (the ordering-safe channel islandCss
already uses); the handle reads `fnManifest()` at render and emits ONE executing inline
script (`<script data-ogygia-fnm>globalThis.__OG_FNM = { tag: (factory), … }</script>`)
before the ctx marker; the fn kind's decode prefers registry → __OG_FNM → payload-source
eval → throw. PROD IS NOW EVAL-FREE (browser-verified: x119.00 with data-ogygia-fnm present);
executing-inline is the same CSP class as the defer bootstrap. The eval fallback remains as
the last-resort tier only. `og.store` construct also
SHIPPED (og-store.ts + __og_store: factory registered at module load, products branded, corpus
C9 round-trip green). Fixture: apps/playground/src/routes/dollar-fn + e2e/dollar-fn.ts
(STANDALONE — user must register it in e2e/run.ts CHECKS).

## (historical) og.$ notes

Shipped this session (12/12 transform tests + 6/6 runtime tests green):
- `src/vite/og-dollar.ts` — `rewrite_dollar(src, id, rel_id, markup_exts)`: AST-precise
  detection over `og_js_regions`, capture analysis (free names → bound params, ~60 known
  globals pass, member-props/object-keys/labels excluded), rewrite to
  `__og_$(tag, [captures], factory)` with the `ogygia/internal` import injected, strict-position
  build errors (og-wire voice). Factories are SELF-CONTAINED by construction (every non-global
  free name is a bound param), so hoisting them into a manifest is a pure text move. Returns
  `{ code, hoists: [{tag, factory_src}] }`.
- `__og_$` runtime (fn-transport.ts, exported via `ogygia/internal`): pull-registers the
  factory + returns the live bound fn. Server leg and same-bundle islands work TODAY.

REMAINING (one session): wire into vite/index.ts —
1. transform hook: call `rewrite_dollar` next to `rewrite_wire` (~line 2228; gate on
   `out.includes('import.meta.og.$')`, mind that `.$(` must not match `.$state` — the marker
   test `import.meta.og.$` + AST already disambiguates); collect `hoists` into plugin state.
2. `virtual:ogygia/fn-manifest`: emits `__register_fn(tag, factory_src)` per hoist; runtime
   entry (generateRuntimeEntrySource output) imports it so factories register pre-hydration.
   **ORDERING TRAP (the island-deps problem again):** in build, the virtual may LOAD before all
   transforms ran → incomplete manifest. Solve like island-deps: client transform collects,
   writeBundle persists to the handoff JSON, and the manifest inlines via the patch-token slot —
   OR emit the manifest chunk in generateBundle after all transforms (moduleParsed-complete).
   Dev is trivial (virtuals load on demand, after transforms).
3. e2e: a csr=false layout `setContext('fmt', import.meta.og.$(…))`, an island calls it; a
   captured store reunites across two islands.

## The original build spec (for reference)

1. `src/vite/og-dollar.ts` following `og-wire.ts` exactly: AST-precise detection of
   `import.meta.og.$(<fn-expression>)` over `og_js_regions` (whole file for `.ts`/`.js`, each
   `<script>` for `.svelte`); anything else — bare access, aliasing, zero/two args, non-fn
   argument — is a BUILD ERROR naming file:line.
2. Capture analysis (reuse the portable-snippet scope walker): module-import captures travel
   (re-imported in the hoisted factory); local `const` values → bound params; REJECT with
   file:line + path: server-only imports (`$env/static/private`, `.server.`), `bind:this` refs,
   other bare closures, reassigned `let` (stale-capture fork — corpus failure case #1).
3. Hoist: factory source `({captures}) => <original fn>` collected into plugin state keyed by
   tag = root-relative module path + `#$<n>`.
4. `virtual:ogygia/fn-manifest`: emits `__register_fn(tag, factory)` per hoist; the client
   runtime entry imports it (same channel as runtime-url), so every factory is registered
   before any island hydrates — calls stay SYNC. `__register_fn` self-ensures the fn kind.
5. Call-site rewrite: `fn_handle(tag, [bound])` with the import injected (value import — the
   pull-registration law holds).
6. Tests: transform fixtures (detect/rewrite/errors) + an e2e page (context fn crosses, island
   calls it, captured store reunites).
7. csr gating: tri-state like og.wire — strict errors only in known-csr=false hosts; csr=true
   hosts compile the hoist but skip capture rejections (nothing crosses there).

## when/keep surface — resolved by documentation

`keep` already IS the session-lifetime name across the framework: the import attribute
(`with { keep: 'sidebar' }`), the DOM contract (`data-ogygia-keep`), and the wire-class
continuity (`codec.id` — the Keep). A `when` alias for `wake` would require touching
compiler/transform.ts's ATTR_SCHEMA (user-owned file) — document-only for now; rename is
cosmetic and can ride any future attr-schema change.

## Store auto-brand — SHIPPED (both tiers)

- `import.meta.og.store(factory)` assert construct (og-store.ts) + `__og_store` runtime:
  registers at module load, brands every product, revived stores re-brand. Corpus C9 green.
- AUTO-DETECT tier (`auto_brand_stores`, wired app-source-only): `export const x = (seed) => …`
  whose body PROVABLY returns a store (object literal with `subscribe`; direct
  `writable()`/`readable()` verified against the svelte/store import; block bodies where EVERY
  own return is provable — nested functions' returns excluded; oxc keeps ParenthesizedExpression,
  unwrap it). Ambiguous shapes skipped — under-branding is safe.
- **GRACEFUL FLOOR (the safety law that makes auto-branding additive):** decode of a branded
  store whose factory ISN'T registered in the bundle degrades to a plain `writable(seed)` +
  console.warn naming the tag — the exact pre-branding behavior, never a throw. Without this,
  auto-branding would turn working generic stores into hard failures wherever the island
  doesn't import the factory module.

## The final four (user: "do all 4") — ALL SHIPPED

1. **CSP-clean prod manifest** — page-inline registration (above). Eval-free prod path.
2. **og.$ server-only capture rejection** — capturing an import from `$env/static/private`,
   `$env/dynamic/private`, `$app/server`, or a `.server.` module is a BUILD ERROR naming the
   capture + source (it would ship into client HTML). Public env/normal imports capture fine.
3. **Boundary policy + size warnings** — `configure_boundary({ allow, deny })` (runtime config
   for the secret sniff: allow silences false positives like 'tokenColor', deny adds semantic
   secrets the regex can't see); DEV warns when the ctx marker exceeds 32kB, naming the three
   biggest keys and the `{ islands: false }` fix.
4. **e2e/dollar-fn.ts registered** in e2e/run.ts (user authorized) — the suite is 45 checks.

## Remaining phases

1. `fn` kind runtime half (`src/fn-transport.ts`) + corpus tests.
2. `og.$` compiler construct (marker parse → capture analysis → hoist → handle rewrite),
   following `og-wire.ts`'s strict-by-construction playbook.
3. Store auto-brand compiler pass (statically provable factories) + `og.store` assert marker.
4. Delete legacy per-kind wrappers once tests import the hub directly.
5. `when`/`keep` surface naming; `<Region>` mode props re-expressed as policies.
6. The reconciler: nav = diff two region-Ref id sets; same id persists, new resolves, absent
   disposes. Requires hub-memoized region identity (flip the transport wrapper to real hub ids).

## Region identity + the reconciler — STATUS (resolved this loop)

- **Hub identity SHIPPED**: `EncodedRegion.hi` carries the mint id; browser decode reunites by
  it (one descriptor per region instance per page); server + legacy payloads stay fresh.
  Tests: transport.test.ts (same instance → same hi; new instance → new id).
- **The reconciler ALREADY EXISTED**: `with { keep: 'name' }` → `__keep` → `data-ogygia-keep` →
  router persist slot (collect/relocate/end, disconnect-protection, LiveHost fresh-props,
  lakes re-settle) — e2e-covered by continuity.ts (same live node across nav). Do NOT rebuild.
- **The insight that fell out**: hub id (`hi`) is PAGE-lifetime identity (same-render dedupe);
  `keep` keys are SESSION-lifetime identity (cross-nav, author-named — stable across SSR
  renders, which per-request mint ids can never be). Same two lifetimes as the wire Keep —
  the `keep` vocabulary was already the right unification. Cross-nav reconcile-by-hub-id is
  IMPOSSIBLE by construction (new render = new mint) — never attempt it.

## No import-time side effects (LAW, user-mandated)

Kind registration is PULLED, never pushed: `register_*_kind()` is called inside the seam
functions that need it (idempotent — Map.has-cheap), NEVER at module scope. This is both the
user's requirement (side-effect-free modules) and structurally tree-shake-proof (a call inside
an executing function cannot be dropped). `__register_fn` also self-ensures the fn kind, so a
generated module's load is sufficient on any side.

## Hard-won laws (learned the expensive way on this branch)

1. **Never bare side-effect imports for kind registration.** The package marks JS side-effect-free,
   so bundlers TREE-SHAKE `import './x.js'` — the kind silently vanishes from client bundles and
   islands die with "no such kind is registered". Every seam calls `register_*_kind()` explicitly
   (a called import cannot be dropped). This bit twice: the client runtime bundle (e2e) and a test
   file's module graph.
2. **Region.svelte contains a deliberate NUL byte** (an identity-separator in `identity(f)`), so
   grep treats it as binary — always `grep -a` that file.
3. **Every seam must be found by reading, not grepping once**: Region.svelte carried its own
   `stringify_props` (the actual `data-ogygia-props` emitter) beside the server-side
   `encode_region_props` — the six "seam sites" were really seven.
4. **e2e assertions pin the wire format** (`portable-snippet.ts` asserts the devalue key) and the
   Keep collision-warn TEXT ("continuity id") — both are contract, not detail.

## HUB v2 — the primitive completion (user-approved 2026-08-20: "do these all, including dependency edges")

The hub graduates from `Map<id, instance>` + encode/decode to a **scoped, subscribable,
refcounted dependency graph with atomic batch resolution and a symmetric wire**. Every
primitive must ALSO delete existing complexity — the deletion list is the acceptance
criterion per phase. Build order: W → S → Y → D → B → E. Keep unit+e2e green after EACH.

### Phase W — DONE ✓ (45/45 e2e)
SHIPPED: `watch(id,cb)` / `notify(id,live)` / `watcher_count(id)` in ref.ts (watchers map on the
registry); resolve's reunification early-return now, FOR WATCHED IDS ONLY, folds fresh data via
kind.merge + notifies (unwatched id = byte-for-byte the old behavior, so store/snippet identity
untouched). DELETED: frame-store.ts's `subs: Set` + its notify loop — region binders now subscribe
through the hub keyed `frame:<address>`; frame-store keeps ONLY fetch orchestration
(ticket/inflight/reserve/evict), eviction refcounts via watcher_count. 946 unit + 3 todo green,
45/45 e2e (flicker/live-partial/dashboard/page-data-stress all pass through the migrated binder).
PAGE-DEFER: EVALUATED, deliberately NOT migrated — it is a one-shot promise SETTLER (each id
resolves once then deletes), not a pub-sub. Its map is needed for promise dedup + storage no matter
what, so routing through watch/notify would add a `defer:` namespace hop and use ZERO of watch's
multi-fire capability — added indirection, not collapse. The deletion criterion ("no separate
SUBSCRIPTION mechanism") is met by the frame-store migration; page-defer is a registry, not a
subscription. This is the spec's own escape hatch ("not 'no file'") applied honestly.

### Phase W (spec) — `watch(id, cb)`
Hub-level subscription: re-resolving an id with fresh data notifies watchers (decode →
update-in-place via kind.merge when present, else replace + notify). DELETES, in order:
1. the frame store as a separate subsystem (address→frame subscribe/write = watch
   specialized to regions; migrate frame-store.ts onto the hub, keep its address scheme);
2. page-defer's pending-promise registry (a streamed resolve = watch firing once);
3. SWR/live-lake refresh plumbing (re-send ref → watchers fire).
Migrate ONE at a time, e2e-gated (live-partial.ts, page-data-stress.ts, flicker.ts guard these).

### Phase S — DONE ✓ (45/45 e2e; core resolve-path rewrite preserved every identity semantic)
SHIPPED: `Scope = 'request'|'page'|'session'` + `Ref.sc?`; the registry's `live` and `keep` maps
COLLAPSED into ONE `instances: Map<Scope, Map<string,object>>` ('page' bucket keyed by ref.i,
'session' bucket keyed by continuity name, 'request' never stored). `resolve(ref, scope|boolean)` —
boolean shim (true→'page', false→'request') keeps every existing caller working; string API is the
forward form. `remember_live` → `remember_in(reg, scope, key, instance)`; MAX_LIVE now bounds only
the 'page' bucket (deleted in phase D). DELETED: the two-maps-plus-a-boolean model (one scoped
store now); the conceptual live-vs-keep split is a scope value. keep_owner stays (collision guard,
orthogonal). 946 unit + 3 todo green incl. new scope tests (string↔boolean parity, request
isolation). e2e gating the core resolve-path change.

### Phase S (spec) — scoped identity
Ref gains `sc?: string` (scope). One store keyed (scope, id). Scopes: 'request' (server,
never memoized — the old remember:false), 'page' (the old live map), 'session' (the old
Keep). `resolve(ref, remember: boolean)` becomes `resolve(ref, scope)` with a boolean shim
for ABI during migration. DELETES: the live-map/Keep/keepOwner trichotomy, keep_name hook
(a kind returns a session-scoped name instead), the C20 dup-key hazard, `remember` flags.

### Phase Y — DONE ✓ (45/45 e2e; adding OgygiaRef to the app transport broke nothing, no wire decision needed)
SHIPPED: `ogygiaTransport` now has TWO entries — `Region` (FIRST, legacy EncodedRegion+hi shape,
first-match claims regions) and `OgygiaRef` (carries wire/store/snippet/fn/derived via the SAME
ref_reducer/ref_reviver the island seams use). Kit routes universal `load` data AND remote-fn
args/returns through `transport`, so ONE entry gives total symmetry: page.data can hold a store /
wire / fn / derived, a remote can take/return one — all by identity. Decode is REQUEST-scoped on
the server (no document → ref_reviver(false) → request), PAGE-scoped in the browser. No separate
remote wiring needed (verified: hooks.ts seed_reducers already merges the app transport encoders;
page_seed_reducers only holds the defer keys — no OgygiaRef collision). DELETED: the "Kit transport
only carries regions" special case; the remote-args no-kinds gap. 948 unit + 3 todo green incl. new
symmetry tests (store crosses, plain declined, Region-first order). e2e gating transportables/
continuity/context/remote.

### Phase Y (spec) — symmetry (one codec everywhere)
ogygiaTransport carries ALL kinds (today: Region only) via ref_reducer/ref_reviver — Kit's
wire and ogygia's seams become the same codec. Remote-function ARGS go through the same
reducers → a store/wire/fn passed to a command() round-trips by identity (server resolves
request-scoped, returns same id, client reunifies). DELETES: the Kit-transport special case,
the "which seam am I on" distinction. CARE: server resolve of client-sent refs is
request-scoped (never trust client identity across requests; capability-vs-data guardrail).

### Phase D — DONE ✓ (45/45 e2e; nav-time page disposal preserved wire continuity + persist)
SHIPPED: `RefKind.dispose?(live)` hook; `dispose_scope(scope)` (tears down each bucket instance via
its kind.dispose — dispatched through a new `instance_kind: WeakMap<instance,kindKey>` — runs
registered scope-disposers, then empties the bucket; SKIPS page instances also aliased in the
session bucket so wire continuity survives); `register_scope_disposer(scope, fn)`. Router nav calls
`dispose_scope('page')` after body-swap + persist relocate, before spaLifecycle.finish (old islands
disconnected, new not yet resolved). DELETED: MAX_LIVE (the whole cross-nav creep it guarded against
is now handled precisely — the page bucket is emptied every nav). 954 unit + 3 todo green incl.
dispose tests (teardown+empty, session-alias survives, disposer fires). REMOTE-CACHE FOLD: EVALUATED,
DECLINED — clear_remote_seeds/clear_remote_instances have precise SPA-lifecycle timing (seeds before
body-connect, instances after replaceWith; documented LiveQueryProxy-throws bug history). A single
dispose_scope('page') call fires at ONE timing, so folding both halves in would FRAGMENT a coherent,
timing-correct mechanism and risk the exact race the comments warn about. The register_scope_disposer
primitive stays available for kinds that genuinely fit (a future live-ref channel closing on nav).
e2e gating continuity/persist/remote.

### Phase D (spec) — dispose
Kind gains `dispose?(live)`. Scope teardown disposes every instance in it. Nav = dispose
the 'page' scope (one line). DELETES: MAX_LIVE (refcount/scope GC replaces; keep a backstop
if paranoid), the router's hand-rolled clearing sweeps (spaLifecycle prepare/finish's
state-clearing half, clear_remote_seeds/clear_remote_instances become page-scope disposal).
CARE: persist/keep regions and session scope must NOT dispose on nav.

### Phase B — DONE ✓ (45/45 e2e; batched context resolution preserved every check)
SHIPPED: `batch(fn)` (buffers watch notifications during fn, flushes ONCE on outermost exit — a
later id overwrites an earlier so each watched id fires at most once with its final value;
reentrant via depth counter) + `resolve_batch(refs, scope)` sugar. `notify` is now batch-aware.
WIRED: parse_ctx (context-bridge.ts) wraps its devalue parse in `batch()` — a page's context keys
(a derived over a store, a wire holding a store) resolve as ONE transaction, so no watcher reacts
to a half-decoded graph. DELETED/prevented: the torn cross-ref window (a watcher firing between two
merges). 957 unit + 3 todo green incl. batch tests (no torn state, repeat-notify collapses to final
value, reentrant). e2e gating context/continuity.

### Phase B (spec) — batch resolve
`resolve_batch(refs)`: decode all, wire all, THEN notify watchers once (Svelte batching for
store notifications). DELETES: part of the router swap's manual state sequencing (settle
lakes/restore forms ordering stays for DOM; state-side folds). Guards torn cross-ref states.

### Phase E — DONE ✓ (45/45 e2e; boundary-lab 12/12 og_derived resumes; dollar-fn 4/4). HUB v2 COMPLETE.
SHIPPED: `Ref.deps?: string[]`; RefKind.encode may return `deps`; mint copies deps onto the Ref;
registry `dep_index: Map<sourceId, Set<dependentId>>`; resolve registers reverse edges from
ref.deps; og_derived's encode now MINTS its source stores + formula fn to learn their ids (mint
memoizes by instance, so devalue's recursion reuses the same ids — deps match the nested refs) and
emits them as deps; `invalidate(id)` walks the reverse index and re-fires each dependent's watchers
(batched) — the reconciler's foundation, NOT the reconciler. 959 unit + 3 todo green incl. edge
tests (derived carries source+fn ids, dep_index populates, invalidate fires the dependent).
Refcount-dispose: SKIPPED — a page-scoped og_derived and its source share the page scope and die
together on nav disposal already; refcounting adds churn with no lifetime win here. Noted for a
future cross-scope case. Final sweep (unit/tsc/oxlint/verify:package all green) e2e-gating.

## HUB v2 — COMPLETE LEDGER (all six phases W→S→Y→D→B→E)
ADDED (primitives): watch/notify/watcher_count (one subscription mechanism) · Scope +
scoped `instances` store · one-codec transport symmetry (load data + remote args/returns carry
every kind) · dispose_scope / Kind.dispose / register_scope_disposer · batch / resolve_batch ·
Ref.deps / dep_index / invalidate.
DELETED: frame-store's private `subs` set + notify loop · the live-map + keep-map + `remember`-
boolean three-way model (now one scoped store) · MAX_LIVE (nav scope disposal replaces it) ·
"Kit transport carries only regions" + the remote-args no-kinds gap · the torn cross-ref
resolution window.
EVALUATED + DECLINED (honest fit calls, not forced deletions): page-defer migration (a one-shot
promise settler, not pub-sub) · remote-cache fold (precise SPA-lifecycle timing, would fragment) ·
derived refcount-dispose (same-scope lifetime, no win).

### Phase E (spec) — dependency edges
Ref gains `deps?: string[]` (ids this ref resolves against — og_derived emits its sources +
formula). Hub maintains the reverse index. Buys: refcounted dispose (drop id when no
dependents and scope allows), closure snapshots (snapshot = dep-closure walk), partial
invalidation (server names an id → hub knows dependents → re-resolve subtree). og_derived's
recipe becomes the first emitter. The RECONCILER must consume this graph, never build its own.

### Acceptance per phase
- unit suite green + full e2e (45) green; new primitives get corpus-style tests;
- the phase's DELETION list actually deleted (grep-proof);
- passage.md updated with what died.

## STATE-DELTA RECONCILER — phased spec (design, NOT built)

THESIS: a navigation should move DOM + refs, not reset the world. Today `swap()` fetches the
full new page and does `document.body.replaceWith(newBody)` — every island re-hydrates, focus
and scroll are lost, and the server re-renders everything. The reconciler diffs old↔new by
REGION IDENTITY, keeps matched regions' live DOM + resumed state, and touches only what changed.
Two halves: client-only reconcile (snappy no-flicker nav, ships alone) then an optional server
delta protocol (the SSR-cost win — the Amplify/Kubernetes 5-10s problem).

### Rails already in place (hub v2 + prior)
- Region hub-identity: every region carries `hi` (EncodedRegion.hi) — the match key.
- State resumes by identity: wire classes / stores / og_derived reunify, so a KEPT region's
  island stays alive with its data (no re-hydrate).
- dispose is per-scope today (dispose_scope('page')); the machinery to tear down by id exists.
- invalidate(id) + dep_index: the hub already knows what depends on a changed id.
- watch/notify: a region can update in place instead of remount.
- persist/keep: the current DOM-relocation reconciler — reconcile GENERALIZES it (see R5).
- morph.ts already exists (live/held regions push new HTML) — likely reusable for the shell.

### CLIENT-ONLY RECONCILE — COMPLETE ✓ (R0-R5, 45/45 e2e, default nav path)
STATUS: R0 DONE ✓ — src/runtime/reconcile.ts (fnv1a, endpoint_key strips exp/sig, signature_of /
fingerprint_of pure core, region_signature/region_props_fp DOM wrappers), 8 unit tests, build
green. Nothing wired, so no e2e until R1. NEXT: R1.

**R0 — region signature + props-fingerprint (CLIENT-SIDE; no compiler/SSR change).**
GROUND TRUTH (verified): rendered island regions are `<ogygia-region entry="<chunk>" wake="load">`
or `<ogygia-region entry="" render="defer" endpoint="<signed id+props+sig>">`. They carry NO hub
`hi` — that field is for region-as-VALUE reunification, not DOM islands. The compiler emits the
element and is OFF-LIMITS, so both keys are derived client-side from existing attrs:
  - `region_signature(el)` = entry + endpoint-id (which region SLOT — the match key; document-order
    position disambiguates duplicates, handled by the R1 diff).
  - `region_props_fp(el)` = hash(entry + endpoint + `<script data-ogygia-props>` seed text). The
    props SEED is SSR-stable (hydration reads but doesn't mutate it), unlike live innerHTML — so
    equal props_fp old↔new means "same inputs → KEEP the live node (its island state is truth)";
    different means PATCH. Pure core `fingerprint_of(entry, endpoint, propsText)` is unit-testable
    without a DOM. Delivered as `src/runtime/reconcile.ts`. Small, low-risk, nothing wired yet.

STATUS: R1 DONE ✓ 45/45 e2e (reconcile is the DEFAULT nav path). R2 (shell morph) DONE ✓ by reuse —
morph_children already morphs non-region children in place (focus/scroll/selection preserved); the
nav/flicker e2e checks that exercise the shell pass, so R2 needs no separate code.
STATUS: R3 DONE ✓ 45/45 e2e (selective dispose; shared-instance risk did not materialize —
continuity/transportables/boundary-lab all exercise shared instances and pass).
R4 (focus/scroll/selection) DONE ✓ by reuse: morph.ts already preserves the focused control + its
text selection (the "don't clobber typing" carve-out), and a KEPT island never remounts so its
internal focus/scroll/selection survive trivially (same live node). Proven by the already-passing
forms.ts (typed + checked field survives nav) + continuity.ts (form text restored) e2e — no
speculative code added; a kept scrollable region keeps its scroll because morph keeps the node.
R5 (subsume persist) DONE ✓ document-only: reconcile preserves data-ogygia-keep via morph
is_preserved, so a matched region is kept by DEFAULT — reconcile SUPERSEDES persist's region
relocate. persist.ts is NOT deleted: it is the FALLBACK path (full-swap when RECONCILE_NAV is off
or a region is shadow-nested), which still needs collect/relocate. Marked fallback-only in-code.

(historical) R3 CODE DONE detail: SHIPPED: dispose_ids(ids) in ref.ts (dispose named page ids via
kind.dispose, skip session-aliased survivors, clean dep_index + instance_kind); REGION→INSTANCE
OWNERSHIP via a resolve-sink — ref.set_resolve_sink(fn) called from remember_in for every page id,
reconcile.ts capture_region_ids(region, fn) sets the sink around an island's SYNC prop+context
decode (core.ts wraps read_region_props + both collect_provided_context sites), recording ids into
a WeakMap<region, Set<id>>; reconcile_body computes REMOVED regions (live keys absent from next) and
dispose_ids(their owned ids) AFTER morph. Kept regions keep their ids; patched regions' old ids
dispose (fp-key changed → counted removed) and the new node re-resolves fresh. 969 unit + 4 skipped
+ 3 todo green; continuity (kept cart survives) + boundary-lab 12/12 pass standalone; full e2e gating.
NOTE: the linter normalized the earlier NUL key separators back to spaces across reconcile.ts/core.ts
— no NUL bytes now, Edit tool works normally.

R3 DESIGN NOTE (original plan, now implemented above): the reconcile branch currently SKIPS dispose_scope('page')
entirely so KEPT islands' hub instances survive — but that means REMOVED regions' page-scoped
instances LEAK (MAX_LIVE was deleted in phase D). "dispose only removed regions' ids" needs
region→instance OWNERSHIP the hub doesn't track. Approach: during an island's #hydrate, capture the
ref ids it resolves (an ambient "current region" pointer in core.ts's hydrate path → record each
page-scoped ref.i resolved into a WeakMap<regionEl, Set<id>> or a data attr). reconcile computes
REMOVED regions (old reconcile-keys absent from new) and calls a new dispose_ids(ids) in ref.ts
(dispose those ids across buckets, skip session-aliased survivors). Kept regions keep their ids.
This ownership map ALSO feeds snapshots + the eventual reconciler-proper. If the ambient-capture
proves too invasive, FALLBACK: a generational page-bucket bound that never evicts ids referenced
since the last nav (kept islands re-touch nothing, so track touch-on-resolve). Prefer ownership.

  R1 first e2e caught 2 real bugs, both FIXED:
  (1) a KEPT region whose props follow the route (persist player, track prop) was keyed by
      props-fingerprint → remounted (ticks reset). FIX: keep/persist regions key by STABLE identity
      ('k'+keepName / 'p'+signature), not fp; NON-kept regions keep the fp key. + absorb_kept_props()
      in reconcile_body pushes the incoming page's props into each kept island via absorbPersistProps
      (the same hook persist.relocate used) BEFORE morph discards the new nodes.
  (2) a KEPT island reading $app/state page.url went stale on nav (/orders/5→/6, no remount). FIX:
      the reconcile branch calls slots.spaLifecycle.softInvalidate(doc) to re-seed the shared page +
      remote store from the new doc — kept islands update reactively (a remount-nav got this free).
  NOTE: reconcile.ts now uses NUL-byte separators in the stamped keys (codebase identity convention)
  — grep -a / python for edits. continuity + page-state pass standalone; full e2e gating the rest.
The diff reduced to STAMPING + morph reuse (morph.ts already
keyed-matches + preserves data-hydrated islands & persist chrome without recursing). SHIPPED:
reconcile.ts stamp_region_keys (regions → data-key='r '+sig+' '+fp; keep-chrome → 'k '+keepName;
never clobbers authored key/id) + reconcile_body(live,next,morph) (stamp both, morph_children in
place — no replaceWith); morph.ts is_preserved now also preserves data-ogygia-keep (morph subsumes
persist.relocate); router.ts swap() branches on RECONCILE_NAV (default TRUE) — reconcile path skips
persist.collect/relocate AND dispose_scope('page') (kept islands' hub instances must survive; R3
makes dispose selective), returns early; legacy full-swap is the else fallback (flip the flag).
SHADOW-DOM GUARD (user-flagged, wds-* components): region_in_shadow(body) detects an `<ogygia-region>`
inside an OPEN shadow root (querySelectorAll/morph don't pierce shadow → morph would keep a stale
host) or a `data-og-no-reconcile` opt-out; either → fall back to full-swap for that nav. Closed
shadow roots are UNDETECTABLE → unsupported-with-reconcile, documented, opt-out available. A region
SLOTTED into a web component (light-DOM child) is safe, not flagged. 967 unit + 4 skipped (DOM
tests, no jsdom env — validated by e2e) + 3 todo green.

**R1 — the diff/patch core.** Replace `body.replaceWith` in router.ts swap() with a region-keyed
reconcile: index old regions by `hi`, index new regions by `hi`, then per region —
  - same hi + same fp → KEEP the old node untouched (island + state stay live);
  - same hi + diff fp → PATCH just that region's subtree (swap its DOM, its island re-binds);
  - hi only in new → MOUNT;
  - hi only in old → REMOVE (+ dispose its ids, see R3).
This is the bulk of the new code. Acceptance: a nav between two pages sharing a region keeps that
region's DOM node identical (===) across the swap; a changed region swaps only itself.

**R2 — shell morph.** The markup BETWEEN regions still differs page-to-page. Morph it (reuse
morph.ts / idiomorph-style keyed diff) so the non-region shell updates without a full replace.
Acceptance: nav updates the shell text without remounting kept regions.

**R3 — per-region teardown.** Today dispose_scope('page') nukes ALL page instances on nav (correct
for a full swap). With reconcile, only REMOVED regions dispose; KEPT regions' page-scoped hub
instances must SURVIVE the nav. Add dispose_ids(ids: string[]) to ref.ts (dispose those ids across
buckets, skipping session-aliased survivors — same rule as dispose_scope) and call it with only the
removed regions' ids. DELETES: the blanket dispose_scope('page') on nav becomes selective. RISK:
must not drop an id the new page still references.

**R4 — focus / scroll / selection continuity.** A full swap loses the caret; reconcile must keep it
for kept regions. Preserve activeElement + selection across the reconcile, restore scroll per kept
region. Fiddly but standard. Acceptance: typing in an input inside a kept region survives a nav
that changes a sibling region.

**R5 — subsume persist/keep.** Once R1 keeps matched regions by id, the explicit `keep` attribute
is REDUNDANT for regions — a matched region is kept by default. `data-ogygia-keep` stays only for
NON-region chrome the author wants held (arbitrary DOM with no region identity). DELETES: most of
persist.ts's region-relocation path; `keep` demotes from "opt-in survival" to "escape hatch for
non-region nodes". This is the big collapse — reconcile absorbs the older reconciler.

### SERVER DELTA (build second; the SSR-cost win)

### R6 — DONE ✓ endpoint render cache (45/45 e2e; cache HIT proven — /server-cached endpoint
### served byte-identical render on a repeat request, same timestamp, no re-render)
INVESTIGATED (Explore agent, file:line evidence): the imagined R6 — skip re-rendering unchanged
INLINE islands to save the monolithic-SSR compute — is BLOCKED by the architecture within the
off-limits constraints. WHY: a plain `wake` island renders as `<Component/>` inlined into Kit's
single whole-page render (Region.svelte:501); ogygia owns NO per-region boundary there (it only
wraps the already-rendered output in `<ogygia-region>`). Skipping inline regions would require the
page render to become region-granular = editing compiler/transform.ts or Region.svelte's inline
`<Component/>` (off-limits). Stripping regions post-render (hooks transformPageChunk) saves nothing
— compute already spent. There is exactly ONE real per-region render seam: the deferred/held-region
endpoint `#render_component(load, props) → HTML` (hooks.ts), used only by render:'defer'/'live'
regions (which already skip the page pass). It had NO render cache.
SHIPPED (user chose "build endpoint render cache"): src/server/render-cache.ts — a bounded (500),
TTL-expiring memo keyed by render_cache_key(id, props_payload, SESSION). Wired into #render_component
(hooks.ts) with a `{key, ttl}` cache param; both callers (#render_capability batch + render_region
endpoint) pass it when the hole's signed `ttl > 0`. So a region that opted into `maxAge` renders
ONCE then serves cached for ttl seconds — the only server-compute win reachable without the
region-granular page render. CORRECTNESS: session is IN the key (per-user `private,max-age` renders
never cross users, matching the browser Cache-Control the same ttl sets); ttl<=0 (default no-store)
never caches; exp/sig excluded (rotate per mint). LIMITATION: only helps render:'defer' regions —
the company must mark expensive regions deferred+maxAge to benefit; a plain inline island is
untouched (blocked as above). 6 cache unit tests (TTL, LRU, per-session isolation, no-store).
Exercised by the /server-cached playground route (maxAge:'1h'). 975 unit + 6 + 4 skipped + 3 todo.

**R6 (original imagined delta) — the delta protocol.** Client sends its current region ids + fingerprints with the nav
request (a header or query blob). Server diffs against what it would render and returns ONLY changed
regions' HTML + the ref delta (changed refs, via the phase-Y OgygiaRef transport), not the full
body. The server can SKIP re-rendering unchanged regions — that is where 5-10s SSR drops. Needs: a
nav endpoint (or a hook on the existing one), a stable server-side region-fingerprint that matches
the client's, and a fallback to full render when the client sends nothing (first load, cache miss).
RISK: fingerprint drift between client and server = silently stale regions; needs a version/echo
guard. This half is real protocol design — do it only after client reconcile is proven.

### Cross-cutting risks
- View Transitions: swap() already has VT handling; reconcile must compose with it (VT wants a DOM
  mutation to animate — patch-in-place still triggers it).
- Nested regions + lakes (region-in-lake): match/patch must recurse correctly; settle_lakes_in
  already re-marks persisted lakes — reconcile inherits that.
- Forms snapshot/restore: currently keyed to full-body swap; kept regions shouldn't need
  restore at all (they never unmounted) — simplification opportunity.
- head/title: still swap wholesale (cheap).

### Recommendation
Build R0-R5 (client reconcile) as one loop, gated e2e phase-by-phase like hub v2. It ships the
no-flicker nav + the persist collapse WITHOUT any server change. Defer R6 (server delta) to its own
effort once R1's diff is battle-tested — that is where the real design risk lives.

## REGION-GRANULAR RENDER — COMPLETE ✓ (G1-G4, 46/46 e2e, boundary-lab 12/12, dollar-fn 4/4)
## (user authorized touching the compiler)
GOAL: skip re-rendering UNCHANGED inline islands on warm requests (the real Amplify SSR-compute win),
by making an inline island render through the SAME cache-fronted render() seam a deferred region
already uses. Architectural unification, NOT a hack: an inline island with maxAge and a deferred
region become the same operation (render component→HTML through render-cache), differing only in
WHEN (page pass vs endpoint). Re-entrant svelte/server render() VERIFIED to work (a component's
script can render() another during the page's own SSR pass — the deferred path already relies on it).
maxAge is now UNIVERSAL (was deferred-only).
PHASES:
- G1 DONE ✓: compiler (transform.ts, NOW authorized — leave the pre-existing line-929 tsc error
  alone) parses a PRESET's maxAge for ISLAND marks (live_opts.maxAge, not inline — maxAge is
  preset-only by the allowlist) → options.cacheTtlSec → emits `__cacheTtl` on the island wrapper
  (mirrors the deferred `__cacheTtl`). transform test green (island preset maxAge → __cacheTtl={300}).
- G2 (next): SHARED render seam. render-cache.ts already has get/set/key. hooks.ts #render_component
  already caches. Region.svelte (island branch) needs the SAME cache key + render(). Session goes in
  the key uniformly (safe; anonymous pages have session='' → shared cache = the content-page win).
- G3: Region.svelte island branch — when __cacheTtl > 0, render the island via cached render() and
  emit {@html} instead of inline <Component/>. Region.svelte is SERVER-ONLY on csr=false (runtime
  hydrates islands independently), so this is safe. HYDRATION CORRECTNESS is the crux: render(C,
  {props}).body = `<!--[-->…<!--]-->` (verified) which is what inline <Component/> also emits and what
  the runtime #hydrate anchors on — so {@html body} should hydrate identically. PROVE with a fixture.
- G4: fixture (inline island with a maxAge preset that stays interactive after hydration + serves a
  cached render on a warm request, same timestamp) + full e2e + boundary-lab. LIMITATION stays: helps
  cacheable/anonymous content; per-user (session≠'') caches per user; a first cold render is unchanged.

## REGION-GRANULAR RENDER — G2/G3/G4 DONE ✓ (proven; full-e2e gating)
G2: `cached_render(render_body, cache, now)` in render-cache.ts = the ONE cache-fronted render seam;
hooks.ts #render_component refactored onto it (gate+timeout stay AROUND the render_body). 9 seam tests.
G3: `render_island_cached(component, props, entry, props_payload, ttl)` in server/region-endpoint.ts
(the server-only virtual, client-stubbed to null) — the SYNC inline adapter over the same render-cache;
Region.svelte island branch renders a maxAge island through it and emits {@html} instead of inline
<Component/>, gated (is_island && !inline && !slot-children && __cacheTtl>0). island_payload (the
already-serialized props) IS the stable cache key. HYDRATION PROVEN: the cached render(C,{props}).body
carries the same `<!--[-->…<!--]-->` envelope inline <Component/> emits, so the island hydrates from
the cached markup identically — verified interactive (count increments) with 0 hydration errors.
G4: fixture /cached-island (preset cachedIsland: {wake:'load', maxAge:'1h'} + CachedCounter island with
a server render stamp). e2e/cached-island.ts (registered in run.ts): cold+warm requests serve the SAME
stamp (298905==298905) = component render SKIPPED on warm request, AND the island still hydrates +
is interactive. 986 unit + 4 skipped. THE WALL DID NOT MATERIALIZE: an inline island rendered via the
standalone render() hydrates identically (islands are isolated roots anyway; they don't inherit page
Svelte context on the client, so the standalone SSR matches). LIMITATION: cold render unchanged (cache
warms after 1st); per-user when a sessionCookie is configured (session in key), shared for anonymous
pages (session='' → the content-page win); slot-children islands skip the cache (snippet not keyed).

## G4 HYDRATION WALL — hit + resolved (the honest bit)
render(Component,{props}).body hydrates INTERACTIVELY but NOT in-place: its markers differ from an
inline <Component/>, so the runtime RE-CREATES the island root instead of adopting it (hydrate-in-place.ts
caught 6/6 non-cached islands re-created when I routed all islands through render()). FIX: branch OUTSIDE
the <ogygia-region> — a cached island emits `<ogygia-region>{@html rendered}</ogygia-region>` ({:else if
island_html != null}); a NON-cached island keeps the ORIGINAL `<ogygia-region>{#if Component}<Component/>
{/if}</ogygia-region>` ({:else}) byte-for-byte, so its INTERNAL hydration structure is unchanged →
in-place hydration preserved (0/6 re-created). island_html is gated to __cacheTtl>0 + !slot-children.
TRADEOFF (documented): a CACHED island re-creates its DOM on hydrate (a minor client reflow) in exchange
for the server SKIPPING its render — an acceptable, opt-in cost for a maxAge island. Non-cached islands
are 100% unaffected. hydrate-in-place PASS (0/6), cached-island PASS (5/5).

## SERVER-DELTA NAV — skip re-rendering unchanged islands on SPA nav (progressive enhancement)
D1 DONE ✓: extracted the PURE fingerprint core → src/runtime/fingerprint.ts (fnv1a/endpoint_key/
signature_of/fingerprint_of, no deps; reconcile.ts re-exports). Region.svelte emits
data-og-fp = fingerprint_of(island_module_url, '', island_payload) on BOTH island arms (cached +
non-cached). PARITY PROVEN on real DOM: client region_props_fp === server data-og-fp for 9/9
homepage regions — the safety crux (server skips exactly what the client claims). unit parity test.
NEXT: D2 (client sends x-ogygia-known on nav, hydrated regions only, 6KB cap → omit=full render),
D3 (server request-scoped known set + Region.svelte skips render for known fps, SPA-only guard),
D4 (reconciler keeps the empty skipped region — likely already via R1 morph preserve), D5 (shared
layout-island fixture + e2e/server-delta.ts proving the server didn't re-render it on nav).
SAFETY MODEL: full-render fallback on no header / oversized / full load; hydrated-only claims;
fingerprint parity guarantees correct skips; a blank hole is the failure to gate ruthlessly against.

## SERVER-DELTA NAV — COMPLETE ✓ (D1-D5, 47/47 e2e, boundary-lab 12/12, hydrate-in-place 2/2, no blank holes)
D2: router.ts nav_headers() sends x-ogygia-known = the current doc's hydrated-region data-og-fp values
(deduped, 6KB cap → omit = full render). data-hydrated ONLY (never claim what we don't have live).
Proven: SPA nav /→/about carried 6 fps.
D3: known_region_fps() in server/region-endpoint.ts (per-event memoized Set from x-ogygia-known,
honored ONLY when x-ogygia-spa present; client-stub empty). Region.svelte THIRD template arm
{:else if island_skip} emits <ogygia-region ...attrs... data-og-fp data-og-skipped></ogygia-region>
+ props script but NO component content, for a NON-cached island whose fp ∈ known set (+ !slot-children).
Non-skipped islands keep the EXACT prior arms (in-place hydration untouched — hydrate-in-place 0/6).
D4: the reconciler KEEPS the skipped empty region for free — same data-key as the live one (via
entry+wake+props-script → region_props_fp), R1 morph preserves the live data-hydrated node → the empty
incoming is discarded. Verified: 0 blank holes after nav.
D5: fixture routes/delta/{a,b} share a layout island DeltaNav (identical fp). e2e/server-delta.ts
(registered): server SKIPS the shared island on the SPA nav (data-og-skipped in the delta response,
delta 2799 < full 3068 bytes = compute+bytes saved), the island SURVIVES the nav as the SAME live node
(server-stamp unchanged), stays interactive with click state preserved across the nav (2→3), 0 holes,
0 errors. 11/11.
SAFETY MODEL (proven): PROGRESSIVE ENHANCEMENT — no header / oversized / full-load → render everything;
HYDRATED-ONLY claims (client never asserts a region it lacks); FINGERPRINT PARITY guarantees the server
skips exactly what the client keeps (9/9 real-DOM match); a non-shared nav skips NOTHING (0 false skips).
LIMITATIONS: only SHARED islands with identical props are skipped (the layout-island nav win); cached
(maxAge) islands use their own cache; slot-children islands never skip; first load renders all.
THE FULL SERVER-DELTA IS NOW REAL: on every SPA nav the server skips re-rendering the islands the client
already has — the reconciler keeps them live. This is the capstone the client reconciler was built for.

## PRE-RELEASE SIMPLIFY #1 — one region identity (DONE, full-e2e gating)
Collapsed the fingerprint/data-key/region_props_fp trio into ONE 64-bit identity, read not recomputed:
- fingerprint.ts fnv1a is now 64-bit (canonical FNV-1a-64 via BigInt, 16-hex). WHY: the server-delta
  SKIPS on a fingerprint match, so a 32-bit collision would keep stale/wrong content silently — 64
  bits makes that a non-risk. Volume is a few short strings per region per render, negligible.
- region_props_fp now READS the server-emitted data-og-fp attribute, only recomputing when absent
  (deferred regions). This makes client↔server parity EXACT BY CONSTRUCTION — the client echoes the
  server's value, so the recompute-divergence class of bug (silent wrong skip/keep) is gone.
- the reconcile data-key 'r' variant is now just 'r'+fp (dropped the redundant signature prefix —
  the fp already hashes entry+endpoint+props; signature encoded entry twice). One identity, not two.
CORRECTNESS: the tested parity invariant (data-og-fp == region_props_fp) is now automatic, not a
coincidence of two pure-fn call sites. 987 unit green; hydrate-in-place 2/2, continuity 25/25,
page-state 17/17, server-delta 11/11, cached-island 5/5 all pass. Full e2e gating.
FOLLOW-ONS (not this pass): frameAddress (deferred content delivery, id|props) and iid (compile-time
chunk id) are the other two encodings of entry+props — collapsing them touches the endpoint scheme +
the compiler, a deeper refactor. The random hub id `hi` stays (genuinely separate: held-region VALUE
reunification, not on the DOM). DECISIONS THIS SESSION: keep render:'live'/remount (NOT subsumed by
anything built — region-level stale-while-revalidate is orthogonal to nav-diff/nav-skip/request-cache;
needs e2e, not a cut); lakes stay wake:'none' (user override). Still queued: one-nav-path (delete
persist fallback friction), rip inline maxAge cache, rip dead dep_index/invalidate.

## PRE-RELEASE CUT #1 — dead dependency graph REMOVED ✓
Deleted Ref.deps, RefKind.encode's deps return, HubRegistry.dep_index (+ init), the mint deps-copy,
resolve's edge registration, dispose_ids' dep_index cleanup, and the invalidate() function — all of
src/ref.ts phase-E. og_derived (store-transport.ts) no longer emits deps (its encode still ships the
recipe s/f/seed; devalue mints the nested source/fn refs to cross live). Removed the og-store.test.ts
"dependency edges" block. 985 unit green (−2 dead tests); boundary-lab 12/12 (og_derived still
resumes). Nothing consumed the graph, so no behavior changed. REMAINING: cut #2 (inline maxAge
cache), cut #3 (one nav path).

## PRE-RELEASE CUT #2 — inline maxAge render cache REMOVED ✓ (full-e2e gating)
Region.svelte island branch back to 3 arms (inline | skip | normal) — deleted the cached {@html
island_html} arm + island_html derived + render_island import. Deleted render_island() from
server/region-endpoint.ts (+ its now-unused render/Component/render_cache imports) + the vite client
stub + virtual export. Compiler: reverted island maxAge→__cacheTtl (island options back to
{margin,keep}; removed cache_attr from hydrate_wrapper_source); maxAge is DEFERRED-ONLY again. KEPT
the R6 deferred-endpoint cache (render-cache.ts + cached_render + hooks #render_component). Removed
the cached-island fixture (route + CachedCounter + cachedIsland preset + e2e/cached-island.ts + its
run.ts registration → 46 e2e checks). Transform test inverted (island preset maxAge → NO __cacheTtl).
WHY: it was the ONLY feature that regressed in-place hydration (cached islands re-created on hydrate);
deferred regions give clean cross-request caching with no hydration cost. 985 unit; hydrate-in-place
2/2, server-delta 11/11, continuity 25/25, boundary-lab 12/12, dollar-fn 4/4 standalone. Full e2e gating.

## PRE-RELEASE CUT #3 — one nav path, persist DELETED ✓ (full-e2e gating)
Deleted src/runtime/persist.ts entirely (collect/relocate/end/mark_tree/unmark_tree/is_persist_preserving
/index_top_level_persist + the slots.persist wiring + PersistOps type + noop + full.ts install +
test/persist.test.ts). The router swap FALLBACK (reconcile off / open-shadow-nested region) is now a
plain document.body.replaceWith(doc.body) — safe but loses keep-continuity in that rare path (documented;
islands re-mount like a hard nav). The reconcile path is UNCHANGED and is now the genuine default. Removed
the core.ts disconnectedCallback is_persist_preserving guard (no more persist detach → a disconnect always
means the island truly left; reconcile MOVES kept nodes via insertBefore, never detaching).
COUPLING FOUND + FIXED (the risky bit): feature lazy-loading gated which path ran — morph loaded only on
m.live/m.morph, and the persist manifest entry loaded `live` (LiveHost) for keep islands. Deleting persist
would have left keep-island pages without morph (→ plain-swap fallback → keep lost) or without live (→ no
prop-push). FIX in src/vite/runtime-entry.ts: morph now loads on m.router (reconcile is THE nav path, so
every router page gets it) and live loads on keep (m.persist / persistKeys). Removed the persist FeatureId
+ order + manifest entry (kept the RuntimeMarks.persist/persistKeys flags — the compiler still emits them
and live-detect reads them). VERIFIED: continuity keep-player SAME live node + ticks survive + prop-push
to /cart-b + wire cart continuity, hydrate-in-place 0/6 — all via reconcile+morph, NO persist. 980 unit.
Full e2e gating. RESULT: one nav path (reconcile) + a dumb-but-safe fallback; the mark_tree/disconnect-guard
/dual-relocate friction is gone.
