# Ogygia invariants

Why certain designs exist — and what breaks if you “simplify” them.
Security and performance audits should read this before changing trust boundaries.

---

## HOLE-TRUST — signed same-origin HTML for deferred regions

**What:** The runtime fetches a capability URL and inserts HTML via `createContextualFragment` + `replaceChildren`. Scripts in that HTML do **not** run; event-handler attributes would.

**Why:** Deferred / SWR regions are MPA-equivalent: the HTML is produced by *our* SSR under a verified HMAC. Trust root is the **server MAC**, not the client.

**Do not:**

- Pipe hole HTML through a generic sanitizer (DOMPurify etc.) without allowing `ogygia-region` and lake structure — it silently breaks holes.
- Treat absolute `endpoint` URLs as a primary XSS bug; mint always emits a **path-only** URL. The client same-origin check is defense-in-depth for prior HTML injection.

**Client check:** `is_allowed_region_endpoint` + final `response.url` origin. Abort in-flight fetches on disconnect.

---

## CAPABILITY-URL — bearer token in the query string

**What:** `?id=&props=&exp=&sig=` is a time-limited bearer capability. MAC integrity ≠ confidentiality.

**Why:** Stateless edge-friendly rendering without a prop store. Props must survive the wire for defer/SWR.

**Defaults:**

| Knob | Default | Why |
| ---- | ------- | --- |
| TTL (`regionTtl`) | **3600s** (1h) | Harvested URLs age out; long enough for typical tabs. Clamp `[60, 86400]`. |
| `sessionCookie` | **off** | Prerender / shared CDN HTML cannot bind a request cookie. Opt in for personalized HTML. |

**Do not:**

- Force `sessionCookie` on by default (breaks prerendered defer holes).
- Put secrets in defer props and expect the URL to hide them — use Referrer-Policy (`no-referrer` on region responses) and keep secrets out of captured props.
- Move props into `localStorage` “for confidentiality” — XSS then reads all of them.

---

## PAGE-SEED — `application/ogygia-page` on `csr=false`

**What:** `ogygiaHandle` injects a document-level devalue snapshot of `page` (including `data` / `form` / `error` when serializable).

**Why:** Islands use `$app/state` / `$app/stores` shims. Without a seed, `page.data` is empty under `csr=false` (Kit only serializes it when `csr=true`).

**Invariant:** Same **client visibility** contract as Kit `csr=true`. Stock `csr=false` without ogygia keeps load data server-only — enabling ogygia changes that. Document it; do not treat it as an accidental leak.

**Do not:** Strip `data` by default without an opt-in API for islands that read `page.data` (would break real apps).

---

## SECRET-SPLIT — empty client secret, SSR-only mint

**What:** `virtual:ogygia/secret` is `''` on the client; sign/verify stubs no-op. SSR uses `OGYGIA_SECRET` or a per-build baked fallback. Sign/verify **HKDF-derive** a MAC key (`ogygia-mac-v1`); when `OGYGIA_SECRET` is set, region ids use a separate HKDF salt (`ogygia-id-salt-v1`). Capability MAC messages are `v1|` + UTF-8 length-prefixed fields (not raw `\0` concat). Production builds reject an `OGYGIA_SECRET` shorter than 16 UTF-8 bytes.

**Why:** Browsers must never mint capabilities. Multi-instance deploys without a shared env need the baked fallback so all replicas agree. Domain-separated keys + length-prefixed fields close classic MAC footguns without requiring the env var on every local demo.

**Do not:** Embed the real secret in a client chunk. Fail production builds only when you are ready to require env everywhere (local demos still need the fallback). Change the MAC version string without a deliberate invalidate of in-flight capability URLs.

---

## PROBE-THEN-RENDER — rate limit ordering

**What:** Pre-HMAC probe limiter → verify MAC → render limiter → render (with process concurrency gate).

**Why:** Forged floods must not burn render CPU or reveal id existence (uniform 403).

**Do not:** Charge the render budget before verify. Trust `X-Forwarded-For` when `getClientAddress()` fails — fail closed (429).

---

## RENDER-TIMEOUT — race without true cancel

**What:** `Promise.race` with 10s timeout; concurrent renders capped (`REGION_RENDER_CONCURRENCY`).

**Why:** Svelte `render()` has no AbortSignal. Timeout stops *waiting*; work may continue until the isolate finishes. Concurrency + rate limits bound damage.

**Do not:** Assume timeout frees CPU instantly. Isolating renders in workers is the real cancel story (out of default scope).

---

## PRELOAD-CACHE — `private, max-age=30` without `Vary: Cookie`

**What:** Region responses are `cache-control: private, max-age=30` so the browser can reuse `<link rel="preload" as="fetch">` for the runtime fetch.

**Why:** Without reuse, every defer hole double-fetches (preload + runtime) and verify suites that assert single render break.

**Do not:** Default to `no-store` without another way to share preload ↔ runtime. Shared CDNs must not store `private` responses.

---

## SPA-HEAD — merge allowlist / deny dangerous tags

**What:** SPA head merge skips `<base>` and dangerous `meta[http-equiv]` (refresh / CSP). Only `script[type=module][data-ogygia-runtime]` is retained across navigations. The router starts only when `meta[name=ogygia-router]` is present **and** the document is not Kit-booted (`csr=true`). Navigating toward a Kit-bootstrap HTML response does a full load.

**Why:** Adopting `<base>` rewrites relative capability fetches. Keeping every module script forever leaks memory across SPA pages. Dual routers on a Kit page would fight click interception — gradual migration needs root `<OgygiaRouter/>` to be a no-op on `csr=true` routes.

**Do not:** Assume SPA body swap can boot Kit inline scripts (it cannot — that is why Kit targets full-load).

**Do not:** Re-enable “keep all module scripts” without a runtime marker. Prefer HTTP CSP headers over CSP meta (meta is mergeable).

---

## ISLAND-GRAPH-SHIMS — `$app/*` only for island importers

**What:** Client `$app/state|stores|navigation` resolve to shims when the importer is in `island_graph`.

**Why:** Kit’s client page is uninitialized under `csr=false`; islands still need a working `$app/*`.

**Do not:** Remove shims to “fix” shared-module confusion — that pulls the Kit router into island chunks. Isolate with `?ogygia-island` only as a careful follow-up.

---

## LAKE-PLACEHOLDER — no lake JS on the client

**What:** Client build rewrites lake imports to `LakePlaceholder.svelte`; SSR keeps the real component. Runtime lifts/restores SSR DOM around hydrate.

**Why:** `hydrate: 'none'` means zero lake client JS.

**Do not:** Import lakes through dynamic components that add comment envelopes the restore path cannot round-trip (LAKE-ENVELOPE).

---

## NESTED-DEGRADE — one interactive tree

**What:** Island-in-island hydrates with the parent; server-island-in-island renders inline (`defer` ignored).

**Why:** Nested custom elements + separate hydrate schedules double-hydrate and break context.

---

## SOFT-INVALIDATE — `invalidateAll` does not body-swap

**What:** `invalidateAll()` / `invalidate()` bust the SPA HTML cache, re-fetch the current URL,
merge `<head>`, and refresh `application/ogygia-page` + `application/ogygia-remote` seeds **in
place**. No `body.replaceWith`, no view transition, no island remount, no live query-map clear,
no auto-refresh of live queries. Does **not** fire `beforeNavigate` / `afterNavigate` (Kit soft
invalidate is not a navigation). Soft fetch abort/generation is separate from hard `navigate()`
so an invalidate cannot cancel an in-flight click nav.

**Why:** Kit remote `form()` always calls `invalidateAll` on success. A full SPA navigate+VT was
tearing down live islands and could re-paint stale SSR HTML (in-memory remotes / multi-isolate).
Kit’s own invalidate re-runs loads without destroying the tree — soft invalidate matches that.

**Do not:** Route form success through `navigate(location.href, { replace: true })`. Fire nav
hooks as `type: 'goto'` from soft invalidate. Auto-refresh every live query on soft invalidate.
Islands that need fresh remote data should `.refresh()`, or Kit single-flight
`submit().updates(query)` **paired with** server `requested(query, n).refreshAll()` (updates alone
only sends keys + skips invalidate — without `requested`, the POST has no `q` and live
`.current` stays stale). Hard remount + VT only on real route change.

---

## QUERY-LIVE — Kit owns SSE

**What:** `query.live` is Kit’s remote SSE. Ogygia reuses Kit’s client remote primitives. On SPA
body swap: clear SSR seeds *before* `replaceWith` (old islands still mounted); clear
`query_map` / `live_query_map` *after* (old disconnected, new hydrates still awaiting).
The remote cache singleton lives on `globalThis` so Vite duplicate-module loads still share maps.

**Why:** Abort on `request.signal` is Kit’s job. Infinite `while (true)` generators are normal;
disconnect cancels. Kit’s `LiveQuery.#start` is `once()` — reusing a spent instance after nav
never opens SSE again (stuck on pending / “connecting…”). Clearing too early throws
“No cached query found” mid-unmount. A per-module `new RemoteCache()` breaks SPA clear when
the runtime chunk and island graph resolve the shim to different module ids.

**Do not:** Treat public demo `query.live` as an ogygia ServerIsland vulnerability. Do not clear
instance maps in `prepare_spa_document` (pre-swap).

---

## Related docs

- Product vocabulary: [`DESIGN.md`](./DESIGN.md)
- Public API: docs site + [`packages/ogygia/README.md`](./packages/ogygia/README.md)
- Spec / goals: [`SPEC.md`](./SPEC.md)
