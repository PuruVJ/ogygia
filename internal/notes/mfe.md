# Microfrontends on ogygia — design + POC findings

Status: DESIGNED (this doc) + POC PROVEN (`/experiment/mfe-poc`, gitignored). Not implemented in the package.
Origin: 2026-08-27 design session. The POC runs two real SvelteKit+ogygia servers and stitches SSR'd.

## The one-line insight

A deferred server island is already "HTML fetched from a URL, dropped into a hole, CSS hoisted,
islands inside wake." **Fragment stitching = that URL belongs to another team's server.** No new
primitive; an existing one crosses origins. And stitch timing is already in the language: `await`
a fragment region = SSR-baked (server stitch, one paint, SEO); bare value = lazy client hole.
Same await-vs-bare law held regions already have.

## Three corporate shapes (name them apart — they get conflated)

1. **Source npm package** (v1, same deploy unit): sub-app ships ogygia-marked SOURCE + its v2
   route table as a value; host's plugin compiles it; mount = spread/mount the table. One runtime,
   one signing domain, free. Not independent deploy — it's code sharing. Needs: optimizeDeps
   exclusion so the transform sees the package.
2. **Gateway**: edge routes `/billing/*` to the billing server. Zero framework work, full-page
   reloads between apps, no shared chrome. Fine for most corporate asks; not an ogygia feature.
3. **Fragment stitching** (the prize): shell renders chrome; each MFE server renders pieces;
   one seamless SSR'd page from N independently-deployed teams. The rest of this doc.

## Decisions (each argued, some POC-proven)

### D1. The Svelte-instance seam — the hydrate contract (POC-PROVEN)
Compiled components only work with the exact svelte core they were compiled against; two builds =
two instances EVEN AT IDENTICAL VERSIONS (module-level hydration cursor / effect context).
POC failed exactly this way before the fix: `effect_orphan` + `Cannot read 'nodes'` — shell's
`hydrate()` wrote state into shell's svelte while the dash component read dash's.
**Contract: island entries export `__og_hydrate(target, props)` / `__og_unmount(app)` closed over
the PRODUCING build's svelte; the consuming runtime only schedules and delegates when the entry is
foreign-origin.** Cost: each MFE ships one svelte core (~12kB) shared by its islands. The contract
is tiny → version it with one number; response declares it; shell warns on major skew.
"One scheduler, N svelte cores, no version coupling."

### D2. Browser never talks to MFE servers — shell proxies fragment HTML
Direct client fetches = CORS + SameSite cookies + exposed internal hosts. Client-stitch holes hit
`/og/frag/<app>/<name>` ON THE SHELL; shell streams from the MFE server-side. Auth attaches in
exactly one place (shell's outgoing-request hook). Cross-app holes rejoin the router's single-flight
batch (they're shell URLs again). Static JS/CSS chunks do NOT proxy — immutable files from the
MFE's CDN (CORS = one header there). Direct-to-CDN fragment HTML = opt-in for public fragments.

### D3. Fragment response is a DOCUMENT, not an HTML string
`{ body, css[], head, status }` (+ format version). CSS links emitted immediately before the
fragment markup (legal in body; render-blocks only content after it = exactly no-FOUC). `head`
for page fragments (title/meta); `status` passes through (MFE 404 → shell 404); redirects rebased
under the mount. Asset URLs inside body must be ABSOLUTE → MFE builds know their CDN origin (one
env var).

### D4. Trust = named fragment catalog, NOT shared secret
`export const summary = fragment(Component, { props: schema })` mints a stable URL; only declared
fragments are reachable; props schema-validated at the door. The catalog doubles as the typed
contract: build emits a types-only stub package (`@corp/dash/fragments`) the shell imports —
`<Region of={await summary({ org })} />`. Kills secret distribution AND the arbitrary-component
surface. Every MFE serves `/__og/fragments.json` (live catalog + schemas + format version);
shell CI diffs stubs vs deployed catalogs → skew fails a build, not a Friday page.

### D5. Whole-app mounting: `fragment.routes(router)` + method passthrough
The MFE's entire v2 route table (its own layouts/error pages inside) as one path-keyed fragment.
Shell mount is ONE route entry owning ALL methods: `'/cms/[...rest]': mount(cms)` — forwards
method/body/search, translates the response document (routes-as-values payoff; two awkward files
in stock Kit). Link problem: MFE builds with Kit `base: '/cms'`; catalog records the base; shell
errors at boot on mismatch. Remounting = MFE rebuild (accepted; the alternative is HTML rewriting).

### D6. Boundary rules between teams
- Props: plain data, schema-checked. No wired classes, no context, no snippets/children across
  the boundary (code doesn't cross team lines). Fragment = leaf, not wrapper. (ESI-style named
  holes the shell fills = possible v2.)
- Failure: `placeholder` = loading, `failed` snippet = error card. `timeout` on an awaited
  fragment demotes to a client hole (works everywhere because proxy). Dead MFE costs its box.
- Caching: shell proxy, key = fragment id + props hash, honors MFE Cache-Control, request
  coalescing (N concurrent renders → 1 upstream call).
- Trusted federation, NOT sandboxing: any MFE's JS runs in the shell origin. Distrust → iframe.

### D7. Day two
Local dev: origins are config — run only your app, point neighbors at staging (likely the
best-loved feature). Timing stays on the COMPONENT's import (user ruling: no `wake` in `page()`);
a fragment's islands hydrate by the owning team's dials, N layers deep.

## POC (`/experiment/mfe-poc`) — what it proved 2026-08-27

Copied ogygia + `shell` (:5180) + `dash` (:5181), own pnpm workspace. All verified headless-Chromium:
- Shell SSR bakes dash's fragment (`await region(Kpis, props)` in a dash endpoint IS the fragment
  renderer — ~15 lines + URL absolutizing); one paint with dash pixels.
- Dash counter (`wake:'load'`) interactive INSIDE shell page, ticker (`wake:'visible'`) schedules,
  chunks + CSS from :5181, zero console errors; shell's own island coexists (one scheduler).
- Fragment-root scoped CSS travels via the `region:'raw'` mark (a PLAIN import in a server-only
  module has no client leg → its sheet never becomes an asset — real-feature must handle).
- Kill dash → shell renders with inline error card (failure isolation).
- The two package patches live in the POC copy only: emit.ts (entry exports the hydrate contract)
  + core.ts (foreign-origin delegation + foreign unmount). Local islands untouched.

POC shortcuts (v1 does properly): regex absolutizing → render-absolute from config; no proxy/lazy
client path; no catalog/types/cache/timeout/head channel/`fragment.routes`; foreign path skips
NestedProvider/context (BY DESIGN — context doesn't cross) but also lakes/keep/live + nested
islands untested; CSS link dedup at bake.

## ROUND 3 (2026-08-27, /loop): FOREIGN HOSTS — any server that can print HTML mounts an ogygia app

The wire document now advertises `runtime` (absolute URL of the MFE's OWN og-runtime, extracted
from the router document's `data-ogygia-runtime` script tag). A NON-ogygia host prints
css + body + one `<script type=module src={runtime}>` — the MFE's runtime wakes the MFE's islands:
one build end-to-end, NO version mixing, foreign-hydrate contract not even needed.

PROVEN on a ZERO-DEPENDENCY node:http server (~60 lines, no framework/build):
island interactive, layout cascade, form POST → action → PRG follow, link nav — all through the
plain host, 24 cross-origin assets, zero errors. A PHP host (~40 lines, same protocol) is written
at foreign-hosts/php/index.php (untested — no local php).

Findings: (a) REAL GAP — an app with ZERO Kit pages (all router-rendered) emits NO og-runtime
chunk while documents reference it — FIXED in the real repo (round 5): `hasAnyCsrFalseRoute` only
sees Kit page leaves, so the emit gate now ORs `compiler.has_hydrate_regions()` (page-independent
signal). Proven both ways: pageless cms emits the runtime; pure-csr e2e still ships zero
(51/51 green, 1179 unit). Uncommitted alongside the matcher trailing-rest fix; (b) foreign hosts must strip the MFE's base from link/form paths before the
fragment call (expose() re-prepends it); (c) vite preview binds ::1 — use `localhost`, never
`127.0.0.1`, in host configs; (d) the MFE's asset CORS header is the ONLY cross-origin
requirement (cors:true / one CDN header).

## ROUND 4 (2026-08-27, /loop): RELIABILITY CORE — mount() dials, chaos-proven

`mount(origin, { timeout, cache: { ttl } })` now implements the D6 claims, all verified against a
chaos proxy (chaos/proxy.mjs: injectable latency/failure + upstream counter, :5187→cms):
- BOUNDED LATENCY: 5s-slow upstream, cold path → 504 boundary card in 0.81s (timeout 800ms) —
  the shell page is never held hostage.
- SWR: stale cache + 5s-slow upstream → stale doc in ~2ms, background revalidate, a failed
  revalidate keeps serving stale.
- COALESCING: 10 parallel cold requests → exactly 1 upstream call (inflight map).
- FRESH CACHE: hammering within ttl → 0 upstream calls.
- MUTATION INVALIDATION: POST clears cache + follow-up GET reads post-mutation truth.

BUGS FOUND BY THE HARNESS (all real classes): (a) SWR/invalidation RACE — an in-flight
revalidation landing after a mutation's clear() repopulated PRE-mutation data; fixed with a
generation counter (clear bumps gen; stragglers' writes are dead on arrival). (b) proxy hops must
rewrite the `origin` header to the upstream's own origin or Kit CSRF 403s form POSTs. (c) proxy
hops must strip content-encoding/content-length after undici auto-decompression ("incorrect
header check" — only fires on responses big enough to be compressed, hence erratic).

## ROUND 5-6 (2026-08-27, /loop): runtime-gap fix (real repo) + LAZY CLIENT-STITCH (D2 complete)

Round 5: zero-Kit-pages runtime gap FIXED in the real repo (see round-3 finding edit above).

Round 6: the LAZY client-stitch hole, D2's last pillar, PROVEN:
- Shell proxy `/og/frag/<app>:<name>` — the browser NEVER contacts an MFE server for fragment
  HTML (verified: doc via shell 1 / direct 0); bounded 3s timeout; dead MFE → JSON error the
  hole renders as its failed card (page unharmed).
- `FragmentHole` island (placeholder → {@html css+body} → failed states); the swapped-in
  fragment's OWN islands wake: interactive counter, `visible` ticker ticking, and the AWAITED
  SSR copy of the same fragment coexists independently on the same page. Zero console errors.
- RUNTIME RULE DISCOVERED: the island-in-island nested-degrade marked post-hoc-swapped foreign
  regions `data-nested` (skipped — "parent's tree owns you"). Third principled exception added
  (copy's core.ts): a FOREIGN-ORIGIN entry is by construction not in the parent's compiled
  tree — it always self-wakes. Belongs beside the existing deferred/adopted-slot exceptions
  when the real feature lands.

## ROUND 7 (2026-08-27, /loop): VERSION-SKEW TEST — D1 refined

Shell on svelte 5.56.10 hosting dash islands built on 5.42.2 (verified: each side's version
string embedded in its own chunks). RESULT, two layers:
- FUNCTIONAL: everything works — SSR-stitched island interactive, `visible` ticker ticking,
  lazy-hole island interactive, shell island beside them. Zero user-visible breakage. The
  "one scheduler, N svelte cores" architecture HOLDS.
- DEGRADED: all 4 foreign islands logged `Failed to hydrate: HierarchyRequestError` and
  recovered via client re-render — the server DOM was not CLAIMED. Cause: the hydration
  ENVELOPE (`<!--[-->` insertion before delegation) still lives in the CONSUMER's runtime,
  shaped for the consumer's svelte anchor conventions; a 5.42 hydrate rejects 5.56-shaped
  envelopes. LAW REFINED: the envelope preparation belongs INSIDE the producer-owned contract
  (`__og_hydrate` does its own envelope, compiled by the producer's ogygia, version-paired
  with the producer's svelte). Degraded mode is safe-by-recovery (client render, flagged by
  `data-og-recovered` in real builds) — cross-version pairs lose the SSR claim, never the page.
Testbed reverted to shared svelte (re-pin dash to reproduce).

## ROUND 8 (2026-08-27, /loop): CLAIM FORENSICS — a major truth correction

Instrumentation bug in every earlier gauntlet: the console filter captured only `error`-type
messages; Svelte's `Failed to hydrate` recovery notice is a WARNING. Re-measured with warning
capture: **foreign-island hydration has been in RECOVERY MODE since round 1** — same-version,
every config. The islands were never claiming their stitched server DOM; Svelte discarded and
client-re-rendered them, which is why everything looked (and was) fully functional. ROUND 7
CORRECTION: version skew was innocent — the 4 failures are constant, not skew-caused.

A/B/C forensics on the envelope: consumer-inserted / producer-inserted (`__og_hydrate` owns it)
/ ZERO envelope → identical 4 `HierarchyRequestError` failures. Envelope count/position is NOT
the variable. The mismatch is the BAKED fragment HTML's inner anchor shape vs the entry
component's hydrate expectations (the bake path's render envelope ≠ what a component-level
`hydrate()` walks; region-endpoint deferred swaps solve exactly this with their own layer
contract — the fragment bake must replicate it). OPEN TASK for the real feature; needs DOM-shape
dumps against svelte's walker in a focused session.

The POC's honest steady state: foreign islands are SAFE-BY-RECOVERY — interactive, correct,
zero user-visible breakage; cost = client re-render of each foreign island (flash + wasted SSR
for those subtrees). The producer-owned-envelope architecture (round 7 law) stays right for the
version-pairing reason regardless. Current copy state: producer envelope stripped, consumer
stands down for foreign entries (net zero).

## ROUND 9 (2026-08-27, /loop): CLAIM FORENSICS II — the detector corrects round 8

Ported the data-og-recovered detector into the POC copy and let the page name the failures:
**ZERO regions carry data-og-recovered** — every island's SSR children survive hydration, on all
six islands (shell + 4 foreign). Round-8's "recovery mode since round 1" was ALSO wrong: the
claim substantially SUCCEEDS. The 4 `Failed to hydrate` warnings are logged by DASH'S OWN svelte
core (chunk-located via console message source) during the delegated hydrate — a nonfatal
internal throw after which the DOM is intact and interactive. Cosmetic-or-shallow; naming the
throwing line needs un-minified svelte debugging (focused session).

Also landed this round: pre-hydration DOM-shape diff proved native vs stitched regions are
BYTE-IDENTICAL in structure; the contract now hydrates through the PRODUCER'S NestedProvider +
producer-side envelope (`ogygia/internal` now exports NestedProvider) — the native runtime's
exact call shape, fully producer-owned (right for version pairing regardless of the warning).

Status ledger for the claim question across rounds: r7 "skew causes failures" → WRONG (constant);
r8 "always recovery" → WRONG (instrument error, then detector disproof); r9 truth: claim works,
one shallow producer-side throw logged, zero DOM/user impact. The detector earned its keep in
its own birthplace.

## FINAL SPEC — after nine POC rounds (2026-08-27). Implementation-ready.

Everything below was empirically exercised in /experiment/mfe-poc. Round history above is the
archaeology; this section is the contract.

### Public API

MFE side (all first-class in `ogygia/router`):
- `expose(router, { base })` → `{ GET, POST, PUT, PATCH, DELETE }` for the `+server.ts` at
  `FRAGMENT_ROUTES_PATH` ('/og/fragment/page'). Whole route tree as a path-keyed fragment;
  any method forwards into `router.fetch`; response = the wire DOCUMENT.
- `fragment(Component, { props: schema, cache? })` → widget catalog entry (designed; POC used a
  hand map). Build emits `/__og/fragments.json` (ids, schemas, format version, base) + a
  types-only stub package for shells. Schema-validated at the door; no HMAC — the catalog IS
  the public API surface (D4).
- The MFE build must know its public asset origin (one env var); documents carry absolute asset
  refs and `runtime`.

Shell side:
- `mount(origin, { timeout=5000, cache?: { ttl } })` → ONE route-table entry
  (`'/cms/[...rest]': mount(...)`). GET: cache→SWR→coalesced fetch; redirects/errors pass
  through (redirect thrown; 4xx renders the MFE's own error body under shell chrome). POST:
  bypasses cache, bumps the invalidation GENERATION, clears cache+inflight, forwards body with
  `origin: <MFE>` (Kit CSRF; the identity-header hop), follows PRG.
- Widget SSR stitch: `<Region of={await summary(props)} />` (await = baked; design D3).
- Widget lazy stitch: hole island + shell proxy `/og/frag/<app>:<name>` — browser NEVER contacts
  MFE servers for fragment HTML; chunks/CSS go direct to the MFE CDN (one CORS header there).
- Foreign hosts (PHP/Rails/anything): print `css + body + <script type=module src={runtime}>`.
  Strip the MFE's base from its own links before calling back. That is the whole integration.

### Wire document (format-versioned)

`{ status, location?, title, css[], body, runtime? }` — plus (v1 work): `head` channel beyond
title, and a `format` major the shell checks. Redirect docs carry status+location only.

### Runtime laws (each POC-proven)

1. PRODUCER-OWNED HYDRATE CONTRACT: entries export `__og_hydrate(target, props)` — inserts the
   envelope AND hydrates through the PRODUCER'S NestedProvider, all against the producer's
   svelte instance — and `__og_unmount(app)`. The consumer runtime only schedules + delegates
   for foreign-origin entries and routes teardown through the producer's unmounter.
   (Two same-version builds are still two svelte INSTANCES — module-state split-brain without
   this; r1's effect_orphan proved it.)
2. FOREIGN-ORIGIN NESTED EXCEPTION: a region whose entry origin is foreign always self-wakes —
   it is by construction not in any parent island's compiled tree (third exception beside
   deferred + adopted-slot).
3. RUNTIME ADVERTISEMENT: documents carry the MFE's own runtime URL (extracted from
   `data-ogygia-runtime`); foreign hosts load it — one build end-to-end on that path.
4. One scheduler per page, N svelte cores. Cross-version pairs: functional; the residual is a
   SHALLOW nonfatal throw logged by the producer's svelte during delegated hydrate (DOM intact,
   zero data-og-recovered — see r9); root-cause with unminified svelte before shipping v1.

### Reliability laws (chaos-proven, r4)

Bounded latency (timeout → 504 boundary card, never a hung shell); SWR (stale served ~2ms under
a 5s-slow upstream; failed revalidate keeps serving stale); request coalescing (N parallel → 1
upstream); mutation invalidation with a GENERATION counter (in-flight pre-mutation fetches must
not repopulate post-clear — the race is real); failure cards at every level (widget hole, mount
boundary via layout `error:`, foreign-host fallback block).

### Infra laws (each bitten in the POC)

Proxy hops rewrite the `origin` header to the upstream's own origin (Kit CSRF) and strip
`content-encoding`/`content-length` after undici auto-decompression; vite preview binds `::1`
(use `localhost`); assets must be render-absolute (no post-hoc regex in v1); scoped-CSS of a
fragment ROOT needs a client leg (`region:'raw'` mark or DSD-set equivalent).

### Already landed in the REAL repo during this work

`has_hydrate_regions()` runtime-emission gate (pure-router/fragment-only services get their
runtime; pure-csr still ships zero), the `[...rest]`-shadows-`/` matcher fix, and the
`data-og-recovered` detector — which disproved two of this POC's own wrong conclusions.

### Signing (ROUND 10 — user ruling: bare minimum; BUILT + verified)

Ed25519 CALLER signing on every server-to-server fragment hop. Asymmetric on purpose — MFEs hold
only the shell's PUBLIC key (safe to commit; nothing to distribute/rotate/leak — same philosophy
that picked the catalog over capability HMACs). Signature covers
`ts . METHOD . path?query . sha256(body)`; ±120s replay window; multiple publicKeys = rotation /
multi-shell. First-class: `sign_headers(privateKey, method, url, body?)` +
`verify_fragment_request(cfg, request, url, body?)` in ogygia/router;
`expose(router, { verify: { publicKeys } })` gates BEFORE any routing (401, callers learn
nothing); `mount(origin, { sign: { privateKey } })` signs GET + POST (body-hash bound).
All call sites wired: mount, awaited widget stitch, lazy-hole proxy, foreign plain-node host.
VERIFIED: unsigned → 401, garbage sig → 401, stale ts → 401, tampered path → 401 (path is
signed), signed → 200; full user gauntlet green through signed hops (widgets, mounted pages,
form POST with body hash, foreign host). PHP host note: sodium `crypto_sign_detached` (untested
here, no local php).

### Cross-fragment shared state (ROUND 11 — BUILT + proven)

The Svelte-native cross-BUILD primitive: `SharedState` (experiment copy, exported from `ogygia`),
built on `createSubscriber` from svelte/reactivity — `.current` (the MediaQuery convention),
reactive in $derived/$effect/templates; nested writes (`cart.current.items.push`) publish via a
mutation proxy (microtask-debounced). All builds meet at ONE page store keyed by
`Symbol.for('ogygia.shared.v1')` — no per-build copies to sync, no server anywhere in the loop.
The CONTRACT lives in a tiny package (`@corp/contracts`: `new SharedState('corp.cart', {items:[]})`)
owned by the concept's domain team; each app compiles its own copy; the truly-shared thing is the
NAME + shape. Three doors, one value: (1) Svelte islands — `.current`; (2) ANY server seeds via
printable `<script type="application/json" data-og-shared="name">` (seed wins over the contract
default); (3) vanilla JS via `globalThis.ogygia.shared(name)` → get/set/subscribe.

PROVEN in one run: badge boots at 1 from the SERVER seed; two clicks in dash's stitched island
(dash's build) → shell chrome badge (shell's build) reacts 1→3, zero subscription code; a
vanilla `set()` → 4. Zero console errors. Events (`defineEvent`) stay the low-level for one-shot
FACTS (toasts, pings) — state for values, events for moments.

### Visitor identity + the three-team chain (ROUND 12 — BUILT + proven)

ON-BEHALF-OF: the shell signs the visitor's claims into every hop — `x-og-user` (base64 JSON)
joins the Ed25519 payload (`ts.METHOD.pathq.bodyhash.claims`), so forging claims = forging the
signature. Claims NEVER transit the browser (the shell attaches them server-side from its own
session; the lazy-hole proxy attaches them there too). MFE-side: `expose` verifies, then rides
the claims on the forwarded Request as a `Symbol.for` property — unforgeable via HTTP, so the
STANDALONE (unsigned) front door can never smuggle identity through a header. Read anywhere in
the MFE's router with `user(c)`. `mount(origin, { user: (c) => claims })`; personalized docs get
the claims in their CACHE KEY (visitors never share a slot).

THREE-TEAM CHAIN: the cms's Home page itself stitches dash's widget — signed with the CMS'S OWN
key (dash's verify list holds both public keys), forwarding the same claims onward. PROVEN on one
page: shell chrome → mounted cms (greets "salut puru") → nested dash box showing the admin-only
KPI (claims survived two hops, two keys) with its island interactive two hops deep. Role gates:
admin button on the mounted door, ABSENT on the standalone unsigned door (anon badge instead);
tampered-claims-with-valid-signature (role escalation) → 401. Zero console errors.

### Observability (ROUND 13 — BUILT + proven; user picked it as the next feature)

W3C trace context through every hop + per-team Server-Timing:
- `expose` continues the caller's traceparent (fresh span), times its render, answers with
  `trace: { trace_id, span_id }` + `server_ms` in the document and a `Server-Timing` header.
- `mount` continues the PAGE's traceparent into the hop and answers the page with
  `Server-Timing: <name>;dur=<hop>, <name>-render;dur=<mfe_render>` (+ `x-og-trace`) — hop cost
  vs team-render cost per mount, visible in DevTools; `name` is a MountOptions field.
- THREE-HOP CONTINUITY PROVEN: a curl-supplied trace-id came out the far side in dash's markup —
  browser → shell mount → cms → cms's own nested stitch → dash, across two signatures.

REAL v2 BUG found + FIXED IN THE REAL REPO (with regression tests, 13/13 green): `c.setHeaders`
silently no-oped for router-built responses — it was Kit's `event.setHeaders`, which only affects
`resolve()`-built responses. The router now collects headers on ctx and merges them onto every
response it returns (handler-explicit headers win).

### experiment() — the assignment primitive (ROUND 14 — IN THE REAL PACKAGE, user's call)

Splits/flags/targeting/rollouts/canaries = ONE primitive: `experiment(name, { variants, split?,
assign?, layer? })`, LIBRARY-level (exported from `ogygia` root; environment-free — shared
`fnv1a32` from runtime/fingerprint, no node builtins; the three inline FNV copies were
consolidated there). Owns ASSIGNMENT only; branching rides existing primitives; measurement =
`stamp()` (`data-og-exp`) + Server-Timing. Precedence: `?og-exp` override → carried claims (the
shell assigned; dormant until the MFE feature writes the Symbol) → `assign(c)` (any condition —
cookie/claims/locale; flags = assigner that never falls through, betas = assign + split tail) →
sticky hash split → control. `layer()` = mutual exclusion (visitor lands in ≤1 member).
Composition beyond layers is ORDINARY CODE (`bucket(c)` is a function). Router consumer:
`page(exp.pick({ a: A, b: B }))` — per-request ComponentPick (branded; svelte components ARE
functions), free for `$infer` (types come from loads). 21 unit tests; 1189 unit + 51 e2e green.

THE BOSS DEMO (csr=true|false, proven end-to-end in the POC): ONE file, TWO bindings — plain
import (zero JS) vs `with { wake: 'load' }` (whole-page island) — `csr_exp.pick({ static: Lab,
hydrated: LabLive })`. Verified through the mounted shell: hydrated arm's button counts, static
arm's identical button is inert (no JS shipped), assignment sticky per visitor, and the
`?og-exp` override PROPAGATES through the signed claims (shell assigns once → cms agrees).

### ROUND 15 — THE WHOLE MFE SURFACE PORTED INTO packages/ogygia (user's call)

Everything moved from the POC copy into the REAL package, marked EXPERIMENTAL: router/fragment.ts
(expose/mount + Ed25519 signing + signature-bound claims/user() + traceparent/Server-Timing) +
Mounted.svelte; shared-state.ts (SharedState); the foreign-hydrate contract in emit.ts
(__og_hydrate with producer envelope + __og_unmount — the POC-VALIDATED direct-hydrate shape; the
r9 NestedProvider-through-contract variant turned out to be another silent python no-match and
never actually ran — the 12-rounds-validated state is what shipped); core.ts foreign delegation +
foreign unmount routing + the foreign-origin nested exception (regexes hoisted — ABSOLUTE_URL_SCHEME
now exported from region-endpoint-url, per the no-regex-in-hot-paths rule); NestedProvider exported
from ogygia/internal (future use).

PARITY PROOF: the POC copy was made byte-identical to the real package (diff -rq clean) and the
FULL mega-gauntlet re-ran green on it: 401 gate, shared-state badge across builds, identity
greeting, three-team nested admin KPI, island 2 hops deep, signed form POST, both experiment arms,
foreign plain-node host. Real repo: 1189 unit + 51 e2e + svelte-check 0 errors. One test updated
(transform.test asRegion "no named import" assertion now targets the COMPONENT import — the
contract's svelte import is expected).

SVELTE-COPIES ANSWER (user q): one svelte core per BUILD (team), shared by all that team's
islands — NOT per island. A 3-team page = up to 3 cores (~12kB gz each); the deliberate D1 price
for total version independence (no module-federation singleton dance).

### ROUND 16 — THE MEMBRANES (user ruling: "no wires crossing between the 2 runtimes")

Cross-core value crossing made STRUCTURALLY impossible, not documented-only. Audit found two
membranes that were safe by politeness; both now mechanical (in the REAL package):
- SharedState: DEVALUE snapshot-on-write (user's call over structuredClone — devalue-representable
  IS ogygia's boundary vocabulary, so store values stay seedable/serializable everywhere; errors
  carry devalue's path). Reactive proxies degrade to snapshots; functions/class instances THROW at
  the write site. Same membrane on the vanilla door + the contract initial. Bonus fix flushed out
  by the tests: the mutation proxy broke internal-slot built-ins (Set.has on a proxy receiver) —
  slotted types now run methods against the target and publish per call.
- Foreign island props: parse with wire revivers OFF (pure module runtime/foreign-props.ts —
  unit-testable, core imports it). A wired OgygiaRef in a foreign sidecar throws loudly instead of
  reviving a THIS-build class instance into ANOTHER build's svelte. Dev prop_guard proxy also
  skipped for foreign (a shell-code proxy inside another build's render is a wire too).
Already safe by construction: serialized fragment props (physics), context/snippets (don't cross).
6 new membrane tests; 1195 unit green; POC (byte-identical parity) verified live: state badge
works, foreign islands work, a live-value write from the page is REJECTED LOUDLY.

### ROUND 17 (2026-08-28) — SMELLS 1+2: ONE identity + ONE transport; demos leave /experiment

User picked two of the three unification smells ("implement the first 2, then well come to 3rd
as dedicated session"; smell 3 = region-resolver pages, deferred):
- **Smell 1 — `c.visitor`** (real package): identity was derived ad-hoc (claims symbol here,
  session fn there, hand-listed experiments map in the POC shell). Now `routes(table,
  { visitor, experiments })` declares it ONCE: `c.visitor` is a lazy MEMOIZED getter on ctx
  (signature-bound claims WIN over the resolver — proof beats config; handlers that never read
  it never pay), and `experiments: [exp]` auto-carries every bucket in every mount's signed
  claims. `experiment()`'s own `visitor()` reads `c.visitor.sub` first. The POC's hand-listed
  `experiments: { [csr_exp.name]: csr_exp.bucket(c) }` map — the forget-one-and-fork-worlds
  hazard — is deleted.
- **Smell 2 — `client()`** (real package): mount()/stitch/proxy each hand-rolled the same
  sign+timeout+fetch trio. Now `client(origin, { sign, name, timeout, cache })` is THE transport
  per MFE — SWR cache, coalescing, generation-safe invalidation live in it. Consumers:
  `mount(clientOrOrigin)` (string form = inline sugar), `client.widget(name, props, { claims,
  traceparent })` for catalog fragments (throws PLAIN Error — callers degrade to their own card;
  doc()/postDoc() throw router error() 502/504 — they run in loads/actions), and
  `proxy({ app }, { user })` minting the `/og/frag/[name]` GET handler (`<app>:<name>` split,
  `{ failed, reason }` degrade). `postDoc` is camelCase — it's PUBLIC surface (naming law:
  snake_case is for internals only). `claims_for()` folds `c.visitor` + auto-carried buckets;
  explicit `user:` override still wins, experiments still ride.
- **Demos committed** (user: "bring the MFE demos outside experiment too"): `examples/mfe/`
  (shell+cms+dash+contracts+foreign-hosts+chaos) are ROOT-WORKSPACE members consuming the LIVE
  `packages/ogygia` via workspace:* — the byte-identical-copy era is over (the gitignored POC
  remains as history only, now stale). Keys are NEVER committed: `gen-keys.mjs` mints keys.env
  (gitignored). `smoke.mjs` is a self-contained 14-check gauntlet (mints throwaway keys, boots
  the three adapter-node builds, checks SSR stitch, admin-KPI claims, mount, `salut puru`
  identity, 2-hop trace continuity, per-team Server-Timing, sticky+override experiments, proxy
  happy/miss, unsigned→401, dead-MFE isolation) — ALL GREEN. Gotcha that ate a round: STALE POC
  servers from the previous session still held :5180-5182 (IPv6), so smoke's own dash never
  bound and "kill dash" killed a corpse — lsof before you trust a port.
- Tests: `test/router-fragment.test.ts` (13) — visitor laziness/memoization/claims-precedence,
  client coalescing/SWR/generation/postDoc-origin/widget/504, and full `mount()` dispatch with
  REAL Ed25519 sign→verify asserting the auto-built claims (`{ sub, experiments: { mode } }`)
  decode from the x-og-user header AND verify at the door. 1208 unit green (76 files);
  svelte-check 0 errors; lint clean; full e2e 51/51.
- **`npx ogygia keys [name]`** (user-approved surface): mints one Ed25519 caller pair as env
  lines on STDOUT (`<NAME>_SIGNING_KEY` pkcs8-DER-b64 / `<NAME>_PUBLIC_KEY` spki-DER-b64 —
  EXACTLY what client({sign})/expose({verify}) consume), guidance on STDERR so
  `npx ogygia keys shell >> keys.env` captures only secrets; never writes files. Saves users
  the openssl `-outform DER | base64` flag maze that ends in confusing 401s.

### ROUND 18 (2026-08-28) — SMELL 3 + the two channels

- **Region-resolver pages (smell 3, the promised dedicated session)**: page slot = ONE branded
  per-request resolver `__ogpick(c, data)`, run POST-loads, returning a component or a
  `PageHtmlView { html, css?, title?, head?, status? }`. Bare component / ComponentPick / mount
  all take the same door in render_page. **Mounted.svelte DELETED** — a mounted wire doc renders
  through ogygia's own RawHtml (og_html_region's component) inside LayoutChain; fragment.ts is
  .svelte-free. Title is ESCAPED into the raw document head (breakout test `</title><script>`
  green). The feared CSS blocker was not real: router-css discovery walks the router module's
  .svelte IMPORT specs, never table values — resolver arms are covered like bare components.
- **STATUS CHANNEL (closed)**: `PageHtmlView.status >= 400` becomes the shell's response status —
  the MFE's own 404/500 page renders under shell chrome AND the shell answers with that status
  (no 200-wrapped error pages poisoning caches/SEO). Smoke check added (mounted /cms/missing →
  404 + "does not exist").
- **HEAD CHANNEL (closed)**: expose() extracts SEO/social head bits (`<meta>` + canonical links,
  NEVER charset/viewport/http-equiv — the shell owns those) into `doc.head`; the view joins them
  to the document head. og:image content passes through verbatim (crawlers need absolute; MFEs
  write absolute); canonical hrefs stay path-relative (the shell owns the address space).
- 1248 unit (30 fragment), 16-check smoke ALL GREEN.

### ROUND 19 (2026-08-28) — "finish it all": the v1 list CLOSED

- **Producer-hydrate throw ROOT-CAUSED + FIXED.** Two stacked bugs: (1) the committed demo
  served adapter-node WITHOUT asset CORS — a foreign page's dynamic import() is a CORS request,
  so every foreign island silently degraded ("Failed to fetch dynamically imported module");
  the old POC masked it because vite preview ships CORS by default, and the smoke only asserted
  HTML. Fixed with examples/mfe/serve.mjs (ACAO on /_app/immutable/*) + a real-browser gauntlet
  check + a docs section (prod: the header lives on the MFE's CDN). (2) With CORS fixed, the
  REAL round-9 bug reproduced: the entry's `__og_hydrate` hydrated the BARE component, but SSR
  rendered through NestedProvider's dynamic-component branch (`<!--[0-->` marker) — one marker
  layer short, svelte aborts mid-walk (HierarchyRequestError in `child()`) and client-re-renders.
  Fix = round 9's INTENDED contract: the entry hydrates `NestedProvider{component,props}` of its
  OWN build, mirroring the local runtime call. Browser check: interactive + ZERO warnings.
- **Error-boundary chrome nesting DONE.** handle_thrown now finds the failing DEPTH (loads are
  memoized — allSettled re-reads instantly; async-wrapped because a sync-throwing load body
  must become a rejection, found live as a 502), renders the boundary INSIDE its own layout's
  chrome with the MERGED DATA of every fulfilled load; an unmatched page GET under a base with
  a root `error` renders the HTML 404 boundary (Accept-gated; API callers keep JSON).
- **catalog() SHIPPED** — the MFE widget door as library code (signature gate fail-closed-warn,
  per-request bake, absolutize, trace, `__catalog` manifest `{names}` for CI diffs); dash's
  hand-rolled endpoint replaced. **Key-rotation runbook** in docs (4 steps over the publicKeys
  overlap). **Streaming = documented v1 non-goal** (buffering IS what makes SWR/coalescing/
  sig-over-body/replay-defense/504-card work; bounded by timeout+maxBodyBytes).
- 1256 unit; smoke 22 checks ALL GREEN (browser truth incl.).

### Open (post-v1)

Streaming fragments (wire-format change); catalog TYPED stubs (client-side codegen from
`__catalog`); Astro-style DOM lifecycle events.

## Build order when implemented

1. `fragment()` + catalog + document response + render-absolute assets (MFE side).
2. Shell: typed stubs + `await`-bake + proxy + `failed`/`timeout`.
3. Hydrate-contract in the real package (benign for local islands; enables foreign).
4. Cache/coalescing; `/__og/fragments.json` + CI diff.
5. `fragment.routes()` + `mount()` — POC-PROVEN 2026-08-27 (round 2): `expose(router,{base})` +
   `'/cms/[...rest]': mount(origin)` live in the COPY's `src/router/fragment.ts` as first-class
   router API (user ruling: fragments are programmatic routing's home turf). Verified end-to-end
   browser: nested-layout cascade crosses the mount, foreign island inside a routed page, form
   POST → action → PRG redirect follow, redirect rebase, MFE's own 404 page under shell chrome.
   FINDINGS for the real feature: (a) Kit's CSRF gate — the mount hop must send `origin: <MFE>`
   (the trust-attachment point); (b) router `miss` answers JSON, needs an error-BOUNDARY page
   render for HTML requests (Kit parity gap); (c) boundary renders EXCLUDE the erroring layout's
   own chrome (concurrent loads can't name the failing depth — but they're memoized promises, so
   they COULD); (d) matcher bug '/[...all]' shadowed '/' — FIXED in the REAL repo (match.ts
   trailing-rest depth exclusion + regression test); (e) status channel: upstream 4xx renders the
   MFE error body but shell answers 200 — load needs a status channel. Later: named holes
   (children), live regions across the boundary.
