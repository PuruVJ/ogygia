---
name: ogygia
description: Use when writing or changing code that uses ogygia (SSR islands for SvelteKit) — islands, regions, wake/render import attributes, held regions, content collections, site(), markdown, the SPA router, the server router (routes/page/$infer), fragment federation (expose/mount), experiments & feature flags, streamed pages, cross-island state/context, or packaging islands in an npm dependency. Read BEFORE inventing a workaround — nearly every "hard" problem here has a one-line primitive, and the complicated solution is usually the wrong one.
---

# ogygia — SSR islands for SvelteKit

Astro-style islands on stock SvelteKit (no Kit patches). Pages ship as server HTML with `csr = false`; only marked components get JS. The runtime is a small custom element (`<ogygia-region>`) plus only the features the app uses (~8 KB min+brotli for a load-only app). Not a new framework — it sits on Kit; remote functions, form actions, async Svelte all work.

**The one mental model:** ogygia has ONE primitive, the **region** — a piece of the page with its own rendering and waking rules. Everything (island, lake, server island, held region, content body, block, federated fragment) is the same envelope with different dial settings. If you understand the two dials, you understand all of it.

## The two dials (import attributes)

Marked on a component import: `import X from './X.svelte' with { … }`.

| Key | Question | Values |
| --- | --- | --- |
| `render` | Where/when does the HTML come from? | `'static'` (default, inline in the page's SSR pass) · `'deferred'` (fetched later from a signed endpoint) · `'live'` (baked, revalidates in background) |
| `wake` | When does JS run (static) / when does the HTML fetch (deferred, live)? | `'load'` · `'idle'` · `'visible'` · `'interaction'` (islands only) · `'(media query)'` · `'none'` (frozen — a lake) |
| `region` | Held-across-a-boundary marker (registries the transform can't see into) | `'raw'` (only value) |
| `keep` | Island keeps its live node + `$state` across SPA navigation | a name (unique per class of thing) |
| `preset` | Named bundle from `ogygia({ regions: { presets } })` | preset name (literal) |
| `margin` | IntersectionObserver rootMargin for `visible` | e.g. `'200px'` |

## Choose the right primitive (decision table)

| You need | Use | Not |
| --- | --- | --- |
| Interactive widget (counter, menu, form) | `with { wake: 'load' \| 'visible' \| … }` | wrapping the page in one island |
| Static content — not inside an island | nothing. Unmarked markup is free server HTML | an island "to be safe" |
| Heavy static subtree INSIDE an island (prose, chart, code) | `with { wake: 'none' }` (lake) | letting it compile into the island bundle |
| Request-specific but NOT interactive HTML (greeting, unread count, slow upstream) | `with { render: 'deferred' }` (server island) + `ogygiaFallback` snippet | a client island that fetches |
| Personalized AND interactive | server island whose own `.svelte` file contains a nested `wake` island | stacking both dials on one import |
| Server picks WHICH component (search results, mixed feed, SDUI) | held region: `region(Comp, props)` returned from a remote, rendered `<Region of={…}>` | client-side branching over imported components |
| Slow data below the fold, paint the rest NOW | streamed page `page(async function* …)` or a late region: promise handed to `<Region of={p}>` + `placeholder` snippet | client fetch-on-mount |
| A whole app section owned by another team/deploy | federation: `'/cms/[...rest]': mount(client(origin))` in the shell's routes table; the MFE `expose()`s its router | iframes, module federation |
| A/B test, rollout, kill switch, or flag, zero client JS | `flag()` from `'ogygia'` (read by calling it), `flag.pick({...})` as a page slot; `decide({ source })` for OpenFeature | client-side bucketing / a vendor SDK in the bundle |
| Calling your own endpoints with types | `api<App>()` from `'ogygia/router/client'` | hand-rolled fetch + casts |
| Run client code, render nothing (telemetry, listeners, store boot) | boot island: headless component whose job is its `$effect` | `onMount` in the page (dead code on csr=false) |
| Code that must run BEFORE first paint (theme, font kickoff) | `{@html script(fn, ...args)}` from `'ogygia'` in `<svelte:head>` | hand-rolled `<script>` strings |
| JS chunk that downloads only after a click | plain `await import('./Widget.svelte')` (no attributes) inside a host island — mounts a regular component | `import('X.svelte', { with: { wake } })` — **build error by design** |
| Delay a real island until click | keep the static marked import, gate `<X />` with `{#if}` | dynamic import tricks |
| Share live state between two known islands | wired class passed as a prop (see boundary laws) | store libraries, events, DOM hacks |
| Value for many islands down a subtree (theme, user, cart) | `<Provide values={…}>` / drop-in `setContext` from `'ogygia'`; read with plain `getContext` | prop drilling every island |
| Set of typed content (docs, blog, CMS) | `content({ loader, schema })` in a `.server.ts` | hand-rolled `import.meta.glob` plumbing |
| A corpus that reads as a *site* (nav, search, prev/next, shell) | `site({ outline })` + `remotes()` | assembling nav/search by hand |
| CMS/visual-builder page tree | `blocks(source, registry)` + `import.meta.og.regions('./blocks/*.svelte')` | N hand-written imports |
| Static page + per-visitor holes at CDN speed | `export const prerender = true` + `render: 'deferred'` holes (PPR) | SSR-per-request |
| Shipping islands/route tables in an npm package | `"ogygia": { "files": […] }` in the dep's package.json (see Packaging) | asking apps to scan node_modules |

## Wiring (once per app)

- `vite.config.ts`: `plugins: [ogygia(), sveltekit()]` — **ogygia() must come before sveltekit()**.
- `src/routes/+layout.ts`: `export const csr = false;` (per route or app-wide; islands also work on `csr = true` Kit pages — there Kit owns navigation and ogygia's router stays out of the way).
- `hooks.server.ts`: `export const handle = ogygia.handle()` from `'ogygia/server'` — serves the signed endpoint for `deferred`/`live`. Compose with `sequence()`.
- `src/hooks.ts`: `export const transport = { ...ogygia.transport }` — needed only when a held region crosses the wire (remotes, live content).
- `src/ogygia.d.ts`: `/// <reference types="ogygia/types" />` — or svelte-check flags `virtual:ogygia/*`.
- Markdown: `ogygia({ content: { markdown: {} } })` in vite config; `extensions: ogygia.extensions()` + `preprocess: [vitePreprocess(), ...ogygia.preprocess()]` in **svelte.config.js** (never inline on `sveltekit()` — Kit would ignore svelte.config.js and hide them from svelte-check). No separate mdsvex plugin ever.
- Production env: `ORIGIN` (server-island/command/form POSTs go through Kit CSRF), `OGYGIA_SECRET` (stable HMAC across deploys; required in practice for PPR so old static pages' holes keep verifying).
- `npx ogygia init` does the whole wiring; `npx ogygia site init` scaffolds a docs site.
- `npx ogygia ai` installs this skill + registers the MCP server (below) into the app's `.claude/` — run it once so any agent on the repo gets both.

## AI tooling — the ogygia MCP server (use it)

`npx ogygia mcp` runs a stdio MCP server that runs the REAL `transformHost` in Node. When it is wired
up (`npx ogygia ai`, or `claude mcp add ogygia -- npx ogygia mcp`), you have eleven tools — **prefer them
over guessing** what the transform (or the running app) does:

- `ogygia_check(source)` — **run this on any ogygia component you write or change before trusting it.** It
  runs the real transform and returns the exact `[ogygia]` rule violation (captured-state write, illegal
  nesting, non-literal macro arg, island dynamic-import) or `✅ passes`. This is ground truth, not a guess.
- `ogygia_compile(source)` — the island map (which imports became islands, their render/wake dials, real
  ids) + the rewritten host module. Use it to SEE the transform's output instead of imagining it.
- `ogygia_islands(source)` — the island map alone (structured JSON), the fast overview.
- `ogygia_explain(source)` — prose runtime story per island (where its HTML comes from, when JS wakes,
  how props cross). Good for explaining a design to a human.
- `ogygia_debug({ url })` — **the runtime half.** Loads a page of the RUNNING app in a headless browser,
  lets islands hydrate (scrolls for `visible`; pass `click` to wake an `interaction` one), and returns the
  ACTUAL per-island story from the devtools bus: SSR → wire → connected → woke → hydrated (with ms), plus
  anomalies (SSR'd-but-never-connected, hydration failures). Use it to see what really happened when an
  island misbehaves. Requires the app to run with `OGYGIA_DEVTOOLS=1` and Playwright installed.
- `ogygia_profile({ url })` — **SSR cost.** Runs the ogygia SSR profiler on a route (N renders) and digests
  its report: verdict (compute/io-bound), render p50, CPU findings, where the time went by category, the
  hottest functions + components, network calls, heap growth (+ links to the full report/.cpuprofile). Use
  it when a route renders slowly. Needs `ogygia({ profiler: true })` in vite config — the tool tells the
  user how if it is missing. Profile a PROD build for real numbers (dev is dominated by Vite + instrument cost).
- `ogygia_profile_open({ file })` — open a downloaded `.ogp` profiler report and return the same digest as
  `ogygia_profile` (for reports a user hands you).
- `ogygia_observatory({ files })` — bundle the user's files into a CLIENT-ONLY Observatory link (gzip-packed into the URL # fragment, which browsers never send to a server) so they can SEE their code compiled + running live in the browser. Great for showing how one of their real pages becomes islands.
- `ogygia_scan({ dir })` — scan a WHOLE project: every island/lake/server-island by file, plus a lint pass (hard `[ogygia]` errors + soft anti-patterns: island-in-island, wake:none+deferred). Use it to understand or audit a real app, not one snippet.
- `ogygia_flags({ dir })` — inventory every `flag()` call site: reads the build manifest (`node_modules/.ogygia/flags-manifest.json`) when present, else live-scans the source with the real AST collector. Names, file:line, drift vs the last build — use it to audit rollouts and find dead flags.
- `ogygia_fragment({ origin })` — probe a federation MFE: fetches its unsigned `__catalog` widget manifest (names + props) and reports whether the fragment endpoint verifies signatures (401 without a signature = signed, 200 = OPEN). Use it when wiring a shell to an MFE, before writing `mount()`/`proxy()` code.

If the tools are not present, tell the user to run `npx ogygia ai` (or add the server manually).

## The boundary laws (why islands feel different)

Each island is its own hydration root. Props cross by **value** (devalue), never by reference. Everything below follows from that.

1. **Props must serialize**: plain data, `Date`, `Map`, `Set`, `BigInt`, nested — fine. **Functions/callbacks never cross** (no `onSave` props — do the work inside the island or call a remote function).
2. **Children and snippets DO cross — automatically, as region snippets.** Static content freezes to server HTML (ships no JS); a `{#snippet}` whose body needs to wake compiles to its own entry and hydrates on the far side (params supported). Plain wrapper components can forward children into islands — it just works. `region.snippet()` is the manual form (raw-HTML `createRawSnippet` mirror). The `ogygiaFallback` snippet on a server island is the reserved loading slot.
3. **Captured host state is a snapshot.** A host variable read into island markup is serialized once; mutating it inside the island updates nothing (build error on captured writes; dev proxy warns at runtime). Own mutable state inside the island: `let count = $state(props.initial)`. **Store auto-subscriptions obey the same law**: a `$store` read inside a snippet that crosses into an island is auto-captured as the store's VALUE at render time — the compiler rewrites the crossed copy and warns with a file:line trace (silence it by reading the store into a plain host variable outside the snippet). A store OBJECT handed across arrives as a disconnected copy, never live (warned); `$$props` in a crossing snippet is a build error.
4. **Live class across islands = wire codec.** A class opts into crossing as ONE live shared object:
   ```ts
   export class Cart {
     items = $state<string[]>([]);
     static wire = import.meta.og.wire({
       encode: (c: Cart) => $state.snapshot(c.items),
       decode: (items: string[]) => Object.assign(new Cart(), { items }),
       // optional: id: 'cart' → session lifetime (survives SPA nav, tab-scoped);
       // merge: (live, fresh) => { … } reconciles server truth into the live instance (live wins by default)
     });
   }
   ```
   Must be a top-level `export class`. Liveness is identity: every island holding the prop reunites into the same instance; `$state` inside is reactive across all of them. Server never memoizes (no cross-request leaks) — make the instance per request. Related live primitives: `og_derived` (a derived whose recipe crosses and re-derives against the reunified live sources on the far side) and `SharedState` (cross-fragment shared page store, server-seedable) — both from `'ogygia'`, see docs 03-data-state.
5. **Context**: Svelte's tree-`setContext` can't reach inside islands on the client (separate roots). ogygia bridges via the DOM:
   - Drop-in: swap `import { setContext } from 'svelte'` → `from 'ogygia'` in a csr=false layout; string-keyed values reach child islands, read with **unchanged `getContext('key')`**. Flat page root.
   - Scoped: `<Provide values={{ theme: 'dark' }}>…</Provide>` wraps a subtree (array form merges entries, falsy skipped). Shadows the page root on the same key.
   - Typed sugar: `const theme = createContext<'light'|'dark'>('theme', 'light')` — `theme('dark')` makes a `<Provide>` entry, `theme.get()` reads typed. Same string key as plain `getContext`.
   - Values must serialize (wired classes OK, functions never). Read during island **setup**. A `render: 'deferred'` island renders in isolation on the endpoint — it sees only defaults; put a context reader in a nested `wake` island instead.
6. **Module-level `$state` in a `.svelte.ts` already shares across islands** with zero ceremony (one client chunk = one instance). Reach for `wire` only when the instance is born on the server and handed down as a prop.
7. `page.data` works inside islands: `$app/state`/`$app/stores` resolve to shims fed by a document-level devalue seed the handle injects (Kit alone leaves them empty under csr=false). `$app/navigation` inside islands: prefer `'ogygia/app'` (`goto`, `invalidate`, `invalidateAll`, `preloadData`, `beforeNavigate`, …).

## Held regions and the wire law

`region(Comp, props)` packages a component + props into a value; `<Region of={value} />` renders it. Type-checked at the call site.

- **Marks decide the schedule**: `with { wake: 'load' }` on the import bakes interactivity; `with { region: 'raw' }` bakes nothing (HTML only — zero JS). `region: 'raw'` is for registries where the transform can't see the `region()` call; a direct `region(Comp, …)` of a plain import needs no mark. Per-data schedules: `region(block, data, (d) => ({ wake: d.interactive ? 'load' : undefined }))`.
- **The wire law**: *a region is the only unit of code that crosses; everything else is data; any shape crosses if its leaves are regions.* Arrays, records, nested regions-as-props — the transport walks the value and signs one capability per leaf.
- **`await region(…)` bakes its SSR HTML into the ticket** (paints instantly, no extra fetch). A bare `return region(…)` from an async remote does the same (the language awaits thenables at return). Leaves nested inside containers cross as addresses and fetch on mount. To force a lazy top-level return (CDN-cacheable endpoint): `({ ...r })` — the spread drops the non-enumerable `then`.
- **Loading UI lives on the region.** Pass the **promise** straight to `of` and use the `placeholder` snippet on `<Region>`. Don't `await` it yourself in a boundary — the boundary un-suspends before the paint (HTML swap + stylesheet load) finishes. (`ogygiaFallback` is server islands only; `placeholder` is held regions.) On the server router, a promise `of` becomes a **late region**: the placeholder flushes with the document and the resolved HTML streams down the same response (see Server router).
- **CSS travels with the region**: the page never imported the component, so its scoped stylesheet rides the response and is hoisted to `<head>`; the runtime never paints unstyled.
- **Live**: `query.live` `yield region(…)` per tick → HTML rides the SSE channel. Raw regions **morph** in place (focus/typed text survive); interactive ones **keep alive** (props pushed into the mounted island, local state intact). One slot = latest tick; collect into an array yourself for feeds.
- **Single-flight mutation**: a `command` returning a region repaints the mounted `<Region>` at that address from the command's own response — one round trip mutates and repaints.
- `preload(regionValue)` from `'ogygia'` warms a hole's HTML ahead of its schedule.
- `document(regionValue)` from `'ogygia/server'` renders a held region into a complete `Response` — routeless documents (the profiler UI is built on it).

## Timing and nesting

- `interaction` (islands only): zero JS until first pointer/key/focus **inside** the region. The waking click is captured and replayed; typing survives; hover prefetches the chunk. Caveat: the replayed event is not a trusted gesture — `window.open`/clipboard/fullscreen will be blocked; detect with `hydratedBy() === 'interaction'` and render e.g. a real `<a target="_blank">`.
- Nesting — one rule, **closest marked parent decides**: island-in-island shares the parent's JS (one tree, child's schedule ignored, dev warns); lake-in-island stays static; island-in-lake wakes on its own; server-island-in-island renders inline (`deferred` ignored).
- Dedupe: same component + same strategy/options = ONE wrapper module and ONE client chunk, however many instances (each instance still gets its own region + props payload).
- `wake: 'none'` + any `render: 'deferred'` is nonsense (HTML later, no JS) — dev warns, treated as defer-only.

## csr=false lifecycle rules

- The page/layout `<script>` **never runs in the browser**. Top-level `onMount`, `$effect`, listeners = dead code. Any "run this on the client" need is an island (usually a boot island).
- Inline `<script>` tags in markup run **once on first full load, never on SPA navigations** (body swaps don't execute scripts — standard browser behavior). Per-navigation code = an island (`wake: 'load'` islands remount and re-run per nav; add `keep` to persist instead).
- Pre-paint code = `script(fn, ...args)` from `'ogygia'` — fn is inlined via `toString`, must be self-contained (browser globals only; pass closed-over values as args, JSON-serialized). `preference()` is the built-in persisted theme/tabs primitive.
- **Lifecycle DOM events** (router on): `document` fires `og:before-swap` / `og:after-swap` around each body swap and `og:page-load` after every page view **including the initial load** (Astro parity — the inline-script substitute for analytics/per-view code). Regions also dispatch `ogygia:server` / `ogygia:live` / `ogygia:hydrated` as they progress.

## SPA router facts

- **On by default, app-wide, no component to render.** Config lives only in the plugin: `ogygia({ router: false })` opts out (tree-shakes it); `{ router: { viewTransitions: false } }` keeps SPA nav without VT; `{ router: { forms: false } }` disables form-field continuity; `{ router: { serverDelta: true } }` (opt-in) sends `x-ogygia-known` so the server skips re-rendering islands the client already has live. Per-page VT opt-out: `<meta name="ogygia-router" content="plain">` in that page's head.
- Kit's `data-sveltekit-preload-*` attributes work unchanged.
- **Single-flight navigation** is automatic: incoming page's `deferred` load-holes are prescanned and batched into one request, streamed back out of order.
- `data-ogygia-keep="name"` on a subtree relocates its DOM (island state, scroll, playing media) across navigations. `with { keep: 'name' }` does it per island (needs the router; props are pushed fresh, `$state` survives).
- `invalidateAll()` is a **soft seed refresh**, not a navigation: no body swap, no VT, no island remount, no nav hooks. After a mutation, update queries with `.refresh()`, or `submit().updates(query)` **paired with** server `requested(query).refreshAll()` — `updates` alone sends keys but does not populate the response.
- MPA mode (`router: false`) auto-injects native Speculation Rules (prerenders likely next pages); control with `data-ogygia-speculate="off"` / `"on"`. With the router on, rules are deliberately not emitted (a body-swap router can't consume speculation caches) — prefetch + module warming covers it.
- **PPR**: `export const prerender = true` + `render: 'deferred'` holes = static CDN shell, per-visitor holes. Prerendered capabilities are signed effectively-forever; set `OGYGIA_SECRET`. `sessionCookie` can't bind prerendered holes — personalize inside the island.

## The server router (`ogygia/router`) — routes as values

Programmatic routing for dashboards, CMS catchalls, federation. Not a Kit replacement — mount it inside Kit (a catchall `+server.ts`, or `app.handle` in hooks) or any fetch host.

```ts
import { routes, page, layout, load, action, GET, POST, redirect, error, fail } from 'ogygia/router';

const admin = layout('admin', AdminShell, { load: loadUser, error: AdminError });
const app = routes({
  '/':              page(Home),
  '/docs/[slug]':   page(DocPage, { params: slugSchema, load: (c) => …, entries: () => [{ slug: 'a' }] }),
  '/api/todo/[id]': { GET: GET(get_todo), POST: POST(todoSchema, add_todo) },   // c.input = validated body
  ...admin({ '/admin': page(AdminHome) }),
}, { error: RootError, visitor: anonymousVisitor(), experiments: [heroExp] });

export type App = typeof app.$infer;   // TYPE-ONLY — reading $infer at runtime throws
```

- Patterns are Kit grammar (`[slug]`, `[...rest]`, `[[optional]]`). `app.fetch(request)` returns `null` on no-match (fall through to Kit); `app.href('/docs/[slug]', { slug })` is the typed URL builder; `app.entries()` feeds prerender.
- `page(component, server?)`: `params` schema fail → 404, `search` → 400; `load` is **memoized per request** (Kit's `parent()` generalized — share one `load()` def across pages/layouts, it runs once); `actions` are Kit-shaped; `fallback` snippet = deferred-page loading slot.
- Layouts wrap sub-tables (spread them in); an `error` boundary renders INSIDE the surviving chrome at the shallowest failing layer; duplicate layout names are a build error. `redirect`/`error` throw; `fail(status, data)` is **returned** (form re-render + status).
- `$infer`: pages → `{ data, form, params, search }` (data = merged root→layout→page); layouts (`App['(name)']`) → `{ data, children }`; endpoints → lowercase verbs `{ get: { out, in }, … }`.
- The page slot can be: a component · `exp.pick({...})` · a `PageSlotResolver` (`{ __ogpick: (c, data) => … }`) · a `PageHtmlView` (`{ __oghtml, html, css?, title?, head?, status? }` — `status >= 400` becomes the response status, no 200-wrapped errors). Scoped `<style>` on router page components reaches the document.
- **Streamed pages**: `page(async function* (c, data) { yield fast; yield await slow; })` — the first yield flushes immediately with status/title/headers; later yields ride the SAME response as `<template>` chunks an inline boot script swaps in during parse. Yield regions or HTML strings. Non-GET runs to completion (final yield only). Streamed responses set `cache-control: no-transform`.
- **Late regions** compose with it: any load can hand a PROMISE of a `region()` to `<Region of={p} >` + `placeholder` — each hole flushes its placeholder and streams its resolution in completion order, failures isolated per hole.
- **`when(gate, entry)`** — flag-gate ANY table entry (page, endpoint, `mount()`): OFF = the route DOES NOT EXIST for that request (404/error page under an owned `base`, fall-through to the rest of the app without). The gate is any `(c) => boolean` — a boolean `flag()` slots in directly (`'/checkout-v2': when(checkoutV2, page(NewCheckout))`, `'/api/export': when(exportsFlag, { GET })`, `'/cms/[...]': when(cmsRollout, mount(cms))`). Decided AFTER `decide({ source })` primes (a vendor kill switch gates whole routes) and carried like any flag read. Type-transparent to `$infer`.
- **Typed client**: `import { api, ApiError } from 'ogygia/router/client'` (browser-safe) — `const c = api<App>(base); await c.get('/api/todo/[id]', { params: { id } })`. `params` required exactly when the pattern has them; `body` typed by the endpoint schema; non-2xx throws `ApiError { status, body }`.

## Federation — fragments across deploys (EXPERIMENTAL)

One team's app renders inside another team's page, server-side, with security and identity handled. The MFE exposes its router; the shell mounts it under one table entry.

```ts
// MFE: src/routes/og/fragment/page/+server.ts   (the fixed FRAGMENT_ROUTES_PATH)
export const { GET, POST, PUT, PATCH, DELETE } =
  expose(app, { base: '/cms', verify: { publicKeys: [env.SHELL_PUBLIC_KEY] } });

// Shell: prebuilt transport + one routes-table entry
const cms = client('https://cms.internal', { sign: { privateKey: env.SHELL_SIGNING_KEY }, cache: { ttl: 30_000 } });
'/cms/[...rest]': mount(cms, { user: (c) => c.visitor, stream: { fallback: Skeleton } }),
```

- `client(origin | [origins], { sign?, name?, timeout?, cache?, audience? })` — an origin ARRAY is a replica pool: **reads fail over** in order on unreachable/5xx, **mutations stay pinned to the primary**, a 404 is an answer (no retry). LRU doc cache (SWR) keyed per-visitor-claims.
- `mount(target, opts)` also accepts a flag pick of clients — `mount(v2.pick({ off: cms_v1, on: cms_v2 }))` — or a `(c) => FragmentClient` resolver (canary / blue-green per request; keep clients as prebuilt singletons; carry keeps the canaried team consistent). Buffered by default; `stream: true | { fallback }` flushes shell chrome + fallback first (GET only; a fallback component from a server-only module needs `with { region: 'raw' }`). MFE 4xx/5xx render under shell chrome with the real status; POST follows PRG redirects. Per-cohort fragment rollout = `when(cmsRollout, mount(cms))`.
- `mount.kit(target, { user?, param? })` — the same mount from a PLAIN Kit catchall (`return { load, actions }` shapes; no ogygia router needed). Upstream errors become Kit `error()` pages. (Renamed from `kitMount`.)
- **Widgets** (named holes instead of whole pages): MFE serves `catalog({ kpis: { props: ['range'], make } }, { verify })`; the shell stitches lazily via `proxy({ cms }, { user, widgets: { cms: ['kpis'] } })` — **`widgets` is the allowlist; omitting it is an open proxy**. `__catalog` is the unsigned inventory manifest; `npx ogygia fragments <origin> --out src/lib/cms-widgets.ts` generates typed stubs and `--check` fails CI on drift.
- **Signing**: Ed25519. `npx ogygia keys shell` prints `SHELL_SIGNING_KEY` / `SHELL_PUBLIC_KEY` export lines to stdout — redirect to a gitignored keys.env, NEVER commit. `expose`/`catalog` without `verify` still serve but warn loudly; `verify: false` is the explicit opt-out. `verify.publicKeys` is a LIST (rotation: add new, deploy, swap signer, remove old). Signatures bind method+path+body+claims+audience+nonce with a ±120s window and replay rejection.
- **Identity flows through**: `routes(table, { visitor: anonymousVisitor(), experiments: [exp] })` — the shell's visitor + experiment buckets auto-carry as signed claims; the MFE reads them with `user(c)` (or its own `c.visitor` — signature claims beat the local resolver). `anonymousVisitor({ cookie = 'og-vid', days = 365 })` mints a first-party anonymous id.
- Tracing: W3C `traceparent` continuity + per-team `Server-Timing` on every hop.

## Flags & experiments (ONE primitive, zero client JS)

`import { flag, decide } from 'ogygia'` — a kill switch, rollout, targeting rule, and A/B/n test are ALL `flag()`, decided server-side during SSR (csr=false pages A/B for free). You READ a flag by CALLING it; you branch with `.pick()`; you wire a vendor with one `decide()`. `experiment`/`layer`/`allowOverrides`/`onExposure`/`batchExposures`/`.bucket`/`.on` are GONE — collapsed into these.

- **Declare** — second arg is the shape: `flag('x')` (kill switch, off) · `flag('x', 10)` (number → sticky rollout %) · `flag('x', (c) => boolean|undefined)` (targeting: `true` on, `false` definitively off, `undefined` falls through) · `flag('x', { control: 80, bold: 20 })` (record → weighted variants; weights are RATIOS, first key is control). Third arg = `{ layer?, value?, fallback? }`.
- **Read by calling**: `checkout(c)` → boolean, `hero(c)` → `'control'|'bold'` (sticky per visitor, hash of name+`c.visitor.sub`).
- **`.pick()` — one verb, two forms**: `hero.pick({ control: A, bold: B })` (no `c`) = a `page()` slot (`ComponentPick`); `hero.pick(c, { control: 7, bold: 30 })` = this visitor's VALUE (typed + total, return = union of the map). At 3+ variants; a ternary is fine for 2.
- **`.value(c)`** — vendor-authored payload validated by the flag's `value` schema (Standard Schema); invalid → the required `fallback` (never undefined). `.stamp(c)` → `'hero:bold'` for `data-og-exp`/logs.
- **`decide({ source?, overrides?, exposure?, batch? })`** — ONE setup (hooks.server.ts). `source` is OpenFeature/OFREP/any resolver, resolved ONCE per request over the app's declared flags, then reads stay sync; `overrides` gates `?og-exp` beyond dev; `exposure` gets a batched array (built-in batching, drained at request end). No `decide()` = pure native, still sticky + zero-JS.
- **OpenFeature**: `import { openfeature, ofrep } from 'ogygia/openfeature'` (no vendor SDK dependency — you pass your own client). `decide({ source: openfeature(client) })` or `ofrep({ url })`. A source variant not in the declared set is ignored; a slow/down source degrades to the native rule (never gates first byte).
- **Decision order**: `?og-exp=name:variant` override (dev-only unless `decide({ overrides })`) → carried signed claims (federation) → source → native rule (targeting/weights/rollout) → control. Anonymous (no visitor sub) → control.
- **Federation auto-carry**: every flag DECIDED this request self-registers its bucket into the signed claims — mounted teams render the same world, no hand-list. A shell that only routes (never reads the flag) pre-decides it: `routes(table, { flags: [csrMode] })`.
- **Manifest**: every literal-named `flag()` call site (AST-resolved 'ogygia' imports, renames + namespaces) lands in `node_modules/.ogygia/flags-manifest.json` on the client build — `ogygia_flags` reads it; diff in CI to catch dead flags.
- **Plain Kit** (no ogygia router): `import` your flags module in hooks.server.ts so the source primes them before the first request (router apps register all at startup).

## Content

**The server/wire split is the whole architecture.** The corpus (compiled markdown, possibly MB) lives in server modules; only tickets and plain data cross.

- Define collections in **`.server.ts`** (or `.remote.ts` / `src/lib/server/`): `content({ loader: import.meta.og.loader.markdown('../content/docs'), schema, filter })`. Defining one elsewhere = build warning (a client import would drag the corpus into the bundle).
- **Loaders** (macros, literal dir/glob/spec only): `.markdown('./docs')` (all .svx/.md, `meta.headings` free), `.folder('./docs')` (`+doc.svx` pages, `+meta.json` section labels, `NN-` ordering — what docs sites use), `.json('./data')`, `.git('owner/repo@ref:path')` (shallow checkout at build, cached). Lazy by default — each file is its own chunk, loaded on `get(id)`. Optional `{ preset: 'name' }` compiles the whole collection through a `content.presets` markdown variant (per-file module variants — same file in two collections with two presets works).
- **Reads**: `get(id)` (server-only) → `{ id, data, meta, body, rel, backlinks }`; returns `null` for unknown/filtered (404 in `load` with `error()`). `refs()` = shallow catalog. `body` is a held region → `<Region of={e.body} />` in the same SSR pass, islands inside wake. **To cross the wire, `await e.body`** — baking is the ONLY body representation that crosses (returning a raw body from a server load/remote is a caught error).
- **Wire**: `withRemotes(collection).list({ map })` / `.live.list` in a `.remote.ts`. Custom sources are just `{ refs, get }` (+ async-generator `live()` yielding change signals — anything = full re-read, `string[]` = incremental); `defineSource`/`toRawSource`/`mapRaw` build them.
- **site()** (in `.server.ts`, `outline` is the only required key) arranges collections into a navigable site: `nav/meta/page/search/switcher/emit.*/check/entries/load`. `remotes(site, { base })` from `'ogygia/content/server'` mints the wire (`nav`, `meta`, `page`, `search`) — prerendered by default, `modes: { page: 'query' }` for per-request/preview (pairs with `site({ context })`). Route wiring: `export const entries = docs.entries; export const load = docs.load;` (`docs.load` = 404 guard + `redirect_from` 308s + dev checks — the piece people forget). Shell: `<DocsShell meta={await meta()}>` from `'ogygia/content/docs-shell'` + theme.css/shell.css; `<Doc {view} />` renders a page view. `checks: [links()]` fails the build on broken in-prose links.
- **Blocks** (CMS/builder trees): registry maps `type` → component; `import.meta.og.regions('./blocks/*.svelte')` globs one `region: 'raw'` import per file, keyed by basename (spread manual `wake:` imports over the top for interactive blocks). `blocks(source, registry)` is a content source; page JSON tree → `entry.body`. **Call `get()` in a universal `+page.ts` load, NOT `+page.server.ts`** — a server load's data is serialized and a body is a same-pass live render (ogygia errors with exactly this). `blocks.resolve(tree, registry)` for a tree you already hold (server-side only — signing key). A 1000-block registry costs a page only the chunks/sheets of blocks it names.
- **Markdown authoring dialect** (zero imports in content; components auto-injected): `::: tip|warning|…` admonitions, `::: code-group` / `::: tabs` (same-label groups sync via localStorage), fence meta (`title=`, `{2-4}` highlights, `twoslash`), `+++`/`---` diff markers (opt-in transformers from `'ogygia/content/markdown'`). Marked island imports work inside `.svx` — live demos in prose.
- Inline snippets in components: `import.meta.og.code(src, lang, meta?)` (one highlighted block through the app's own fence pipeline) and `import.meta.og.md(text)` (whole markdown passage, static only) — both return regions, build-rendered, cached.

## Macros (`import.meta.og.*`)

Compile constructs — rewritten by the Vite plugin, no runtime object exists. Family: `loader.*`, `code`, `md`, `regions`, `wire`, `bake`, `asRegion`, `$`. Shared laws: **literal arguments** (a `${…}` interpolation is a build error), AST-detected, loud `[ogygia]` build errors, zero runtime cost.
- `bake(fn)` runs `fn` at build (self-contained: may use module imports, not other locals; no `$app/*`; result devalue-serializable) and inlines the answer — imports that only fed it are dropped from the output.
- `asRegion(Comp, 'load')` marks a barrel/named import as a region where import attributes can't reach (re-exports, named exports).
- `$(fn)` brands a function so a REF can cross context into an island and rebind on the far side (bound captures).

## Packaging — islands from npm dependencies

A dependency ships islands, marked components, or whole route tables by declaring its own compile surface:

```jsonc
// the DEPENDENCY's package.json
{ "ogygia": { "files": ["./src/widgets", "./src/pages/**/*.svelte", "./src/routes.ts"] } }
```

- npm-`files`-style, package-relative: bare dirs recurse, globs allowed, escaping the package errors, missing entries warn + skip.
- The app's plugin auto-discovers **direct** deps with the field — no blind node_modules scan. Declared files are compiled exactly like app `src/` (`.svelte` AND `.ts`, `with { }` marks intact), and the package is auto-added to `ssr.noExternal` + `optimizeDeps.exclude`.
- Island ids key on `<pkg>/<rel>` — install-independent (pnpm store paths never leak; prod HTML keeps matching chunks across machines).
- A dep using `with { }` marks WITHOUT declaring the field gets a **loud build warning** (marks would otherwise be silently inert).
- If your package imports `ogygia` itself, keep `ogygia` external in your lib build.

## Plugin config + env (one grammar)

`ogygia({ … })` keys — legacy top-level keys (`visible`, `presets`, `continuity`) are hard errors, not aliases:

- `regions: { visible: { margin }, presets: { name: { render, wake, margin, maxAge, onExpire, revalidate, keep } } }`
- `router: false | { viewTransitions?, forms?, serverDelta? }` (defaults true/true/false)
- `content: { markdown?, presets? }`
- `profiler: boolean | { secret?, path = '/__profiler', sampleInterval, maxReports, network, heap, … }` — the ONLY profiler wiring (the handle auto-mounts it; nothing in hooks)
- `devtools: boolean` — dev-server-only (coerced false on build with a warn); use `devtools: command === 'serve'`
- `rateLimit: false | { max = 60, windowMs = 60_000 }` — per-IP budget on the signed island endpoint
- `sessionCookie: false | '<name>'` — seals capability URLs to a cookie (not compatible with PPR holes)
- `regionTtl: 3600` — capability-URL lifetime in seconds (clamped 60–86400)
- `importKeys` — rename the `with { }` attribute keys the transform claims

Env: `OGYGIA_SECRET` (stable MACs + island-id salt across deploys; required for PPR; prod rejects short secrets) · `ORIGIN` (Kit CSRF — POSTs 403 without it) · `OGYGIA_PROFILER_SECRET` (profiler UI auth in prod) · `OGYGIA_DEVTOOLS=1` (devtools-enabled run, needed by `ogygia_debug`) · federation keys are app-chosen names from `npx ogygia keys` (passed explicitly, never auto-read).

CLI: `npx ogygia init` · `site init` · `keys [name]` (Ed25519 pair to stdout, never a file) · `fragments <origin> [--out f|--check f]` (typed widget stubs; `--check` exits 1 on drift) · `ai` (installs this skill + MCP into `.claude/`) · `mcp` (stdio server).

## How it works underneath (why the rules are what they are)

- The transform (Vite plugin, enforce:pre, before sveltekit) rewrites a **marked import binding itself** into a virtual wrapper component — that's why the binding is portable (lists, `{@const Active = A}`, dynamic use) and why attributes must be static: SSR must emit a shell per usage site.
- SSR emits `<ogygia-region wake|render="defer" when|entry|endpoint …>` + a devalue `<script data-ogygia-props>` sidecar. The runtime custom element schedules per `wake`, dynamic-imports the entry URL written **on the element** (Astro-style — the shared runtime never embeds an app-wide island map), parses props, `hydrate()`s in place. `disconnectedCallback` unmounts — SPA swaps clean up for free.
- Free-variable analysis captures host values referenced in island markup → serialized per instance; that's the snapshot law, enforced at build (mutated captures error; `$store` reads hoisted to value snapshots with a warn) and in dev (proxy warns).
- `deferred`/`live` holes fetch `GET <endpoint>?id&props&exp&sig` — a time-limited HMAC **capability URL** minted at SSR. The handle verifies the MAC before spending render CPU, renders the component server-side (cookies/remotes/await work), streams HTML back. Fetched HTML is inert (`createContextualFragment` — scripts don't run); trust root is the server MAC. Don't "sanitize" hole HTML or gate the endpoint differently — read internal/notes/INVARIANTS.md before touching any of this.
- Inside island graphs, `$app/state|stores|navigation` resolve to shims (Kit's client is uninitialized under csr=false); a page seed script provides `page.data`. Don't "fix" the shims away — that pulls Kit's router into island chunks.
- The runtime entry is **feature-selected at build**: router, lakes, live, keep, interaction each add code only when the app's marks use them.

## Traps (each has burned an agent before)

- `import('./X.svelte', { with: { wake|render|preset } })` — **fails the build on purpose** (Vite strips attributes; there'd be no SSR shell). Host island + plain `await import()` = regular component, not an island.
- Hand-rolling `import()` + `mount()` for laziness — that's `wake: 'visible'`/`'idle'` with SSR HTML and a signed boundary already.
- A block-level island (`<div>`-rooted) placed inline in a `<p>` **hydrates twice** (parser hoists it out). Inline placement needs a `<span>`-rooted component; the framework warns.
- Making a `deferred` region interactive "somehow" — it never ships JS. Nest a `wake` island inside its component.
- `csr = true` for one interactive widget — mark one import instead. Conversely, one island wrapping the whole page = `csr = true` with extra steps.
- Reading context in an event handler — read during setup, keep the reference.
- `$store` read in a snippet crossing into an island = frozen VALUE snapshot (auto-hoisted, warned with a trace). Wanting it live means a wired class / `og_derived`, not the store.
- Two wire codecs with the same `id` clobber each other in the session Keep (dev warns).
- `maxAge: 60` = 60 **seconds** on a deferred hole (HTTP), 60 **ms** on live/remount (JS staleness). Use duration strings (`'1h'`, `'30s'`) and the trap disappears.
- `app.$infer` is type-only — READING it at runtime throws. `export type App = typeof app.$infer`.
- Yielding a component from a server-only module in a streamed page/mount fallback without `with { region: 'raw' }` — no client leg, bake errors loudly into the slot's error card.
- Streamed pages: status/title/headers flush with the FIRST yield; later `setHeaders` are lost.
- `proxy()` without a `widgets` allowlist is an **open proxy**; `expose()` without `verify` serves unsigned (loud warn — `verify: false` only on purpose).
- Federation failover: reads walk the pool; **POSTs never fail over** (pinned to primary).
- Dev ≠ prod: SSR query seeding degrades to refetch in dev; the mutation proxy is dev-only; `import.meta.glob` behavior can differ between dev and build. Verify data flows against `pnpm build` + preview.
- Docs-site routes: forgetting `export const load = docs.load` (404s/redirects/checks) or `entries` (prerender misses leaves).

## In this monorepo

- Library src: `packages/ogygia/src`; build it first: `pnpm build:lib` (apps consume dist). Full check: `pnpm check`; e2e: `pnpm test:e2e` (`:fast` skips rebuild).
- Internal naming: non-public exports are `snake_case`; only public API + classes/types are camel/Pascal.
- Design/trust rationale: `internal/notes/DESIGN.md`, `INVARIANTS.md`, `regions.md`, `config.md`. Docs source of truth: `apps/docs/src/content/docs`.
- This skill has TWO copies that must stay identical: the bundled source `packages/ogygia/ai/SKILL.md` (what `npx ogygia ai` installs into consumer apps) and this repo's own `.claude/skills/ogygia/SKILL.md`.
