---
name: ogygia
description: Use when writing or changing code that uses ogygia (SSR islands for SvelteKit) — islands, regions, wake/render import attributes, held regions, content collections, site(), markdown, the SPA router, or cross-island state/context. Read BEFORE inventing a workaround — nearly every "hard" problem here has a one-line primitive, and the complicated solution is usually the wrong one.
---

# ogygia — SSR islands for SvelteKit

Astro-style islands on stock SvelteKit (no Kit patches). Pages ship as server HTML with `csr = false`; only marked components get JS. The runtime is a small custom element (`<ogygia-region>`) plus only the features the app uses (~8 KB min+brotli for a load-only app). Not a new framework — it sits on Kit; remote functions, form actions, async Svelte all work.

**The one mental model:** ogygia has ONE primitive, the **region** — a piece of the page with its own rendering and waking rules. Everything (island, lake, server island, held region, content body, block) is the same envelope with different dial settings. If you understand the two dials, you understand all of it.

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
up (`npx ogygia ai`, or `claude mcp add ogygia -- npx ogygia mcp`), you have five tools — **prefer them
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

If the tools are not present, tell the user to run `npx ogygia ai` (or add the server manually).

## The boundary laws (why islands feel different)

Each island is its own hydration root. Props cross by **value** (devalue), never by reference. Everything below follows from that.

1. **Props must serialize**: plain data, `Date`, `Map`, `Set`, `BigInt`, nested — fine. **Functions/callbacks never cross** (no `onSave` props — do the work inside the island or call a remote function).
2. **Children and snippets DO cross — automatically, as region snippets.** Static content freezes to server HTML (ships no JS); a `{#snippet}` whose body needs to wake compiles to its own entry and hydrates on the far side (params supported). Plain wrapper components can forward children into islands — it just works. `region.snippet()` is the manual form (raw-HTML `createRawSnippet` mirror). The `ogygiaFallback` snippet on a server island is the reserved loading slot.
3. **Captured host state is a snapshot.** A host variable read into island markup is serialized once; mutating it inside the island updates nothing (build error on captured writes; dev proxy warns at runtime). Own mutable state inside the island: `let count = $state(props.initial)`.
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
   Must be a top-level `export class`. Liveness is identity: every island holding the prop reunites into the same instance; `$state` inside is reactive across all of them. Server never memoizes (no cross-request leaks) — make the instance per request.
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
- **Loading UI lives on the region.** Pass the **promise** straight to `of` and use the `placeholder` snippet on `<Region>`. Don't `await` it yourself in a boundary — the boundary un-suspends before the paint (HTML swap + stylesheet load) finishes. (`ogygiaFallback` is server islands only; `placeholder` is held regions.)
- **CSS travels with the region**: the page never imported the component, so its scoped stylesheet rides the response and is hoisted to `<head>`; the runtime never paints unstyled.
- **Live**: `query.live` `yield region(…)` per tick → HTML rides the SSE channel. Raw regions **morph** in place (focus/typed text survive); interactive ones **keep alive** (props pushed into the mounted island, local state intact). One slot = latest tick; collect into an array yourself for feeds.
- **Single-flight mutation**: a `command` returning a region repaints the mounted `<Region>` at that address from the command's own response — one round trip mutates and repaints.
- `preload(regionValue)` from `'ogygia'` warms a hole's HTML ahead of its schedule.

## Timing and nesting

- `interaction` (islands only): zero JS until first pointer/key/focus **inside** the region. The waking click is captured and replayed; typing survives; hover prefetches the chunk. Caveat: the replayed event is not a trusted gesture — `window.open`/clipboard/fullscreen will be blocked; detect with `hydratedBy() === 'interaction'` and render e.g. a real `<a target="_blank">`.
- Nesting — one rule, **closest marked parent decides**: island-in-island shares the parent's JS (one tree, child's schedule ignored, dev warns); lake-in-island stays static; island-in-lake wakes on its own; server-island-in-island renders inline (`deferred` ignored).
- Dedupe: same component + same strategy/options = ONE wrapper module and ONE client chunk, however many instances (each instance still gets its own region + props payload).
- `wake: 'none'` + any `render: 'deferred'` is nonsense (HTML later, no JS) — dev warns, treated as defer-only.

## csr=false lifecycle rules

- The page/layout `<script>` **never runs in the browser**. Top-level `onMount`, `$effect`, listeners = dead code. Any "run this on the client" need is an island (usually a boot island).
- Inline `<script>` tags in markup run **once on first full load, never on SPA navigations** (body swaps don't execute scripts — standard browser behavior). Per-navigation code = an island (`wake: 'load'` islands remount and re-run per nav; add `keep` to persist instead).
- Pre-paint code = `script(fn, ...args)` from `'ogygia'` — fn is inlined via `toString`, must be self-contained (browser globals only; pass closed-over values as args, JSON-serialized). `preference()` is the built-in persisted theme/tabs primitive.

## Router facts

- **On by default, app-wide, no component to render.** Config lives only in the plugin: `ogygia({ router: false })` opts out (tree-shakes it); `{ router: { viewTransitions: false } }` keeps SPA nav without VT; `{ router: { forms: false } }` disables form-field continuity. Per-page VT opt-out: `<meta name="ogygia-router" content="plain">` in that page's head.
- Kit's `data-sveltekit-preload-*` attributes work unchanged.
- **Single-flight navigation** is automatic: incoming page's `deferred` load-holes are prescanned and batched into one request, streamed back out of order.
- `data-ogygia-keep="name"` on a subtree relocates its DOM (island state, scroll, playing media) across navigations. `with { keep: 'name' }` does it per island (needs the router; props are pushed fresh, `$state` survives).
- `invalidateAll()` is a **soft seed refresh**, not a navigation: no body swap, no VT, no island remount, no nav hooks. After a mutation, update queries with `.refresh()`, or `submit().updates(query)` **paired with** server `requested(query).refreshAll()` — `updates` alone sends keys but does not populate the response.
- MPA mode (`router: false`) auto-injects native Speculation Rules (prerenders likely next pages); control with `data-ogygia-speculate="off"` / `"on"`. With the router on, rules are deliberately not emitted (a body-swap router can't consume speculation caches) — prefetch + module warming covers it.
- **PPR**: `export const prerender = true` + `render: 'deferred'` holes = static CDN shell, per-visitor holes. Prerendered capabilities are signed effectively-forever; set `OGYGIA_SECRET`. `sessionCookie` can't bind prerendered holes — personalize inside the island.

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

Compile constructs — rewritten by the Vite plugin, no runtime object exists. Family: `loader.*`, `code`, `md`, `regions`, `wire`, `bake`. Shared laws: **literal arguments** (a `${…}` interpolation is a build error), AST-detected, loud `[ogygia]` build errors, zero runtime cost. `bake(fn)` runs `fn` at build (self-contained: may use module imports, not other locals; no `$app/*`; result devalue-serializable) and inlines the answer — imports that only fed it are dropped from the output.

## How it works underneath (why the rules are what they are)

- The transform (Vite plugin, enforce:pre, before sveltekit) rewrites a **marked import binding itself** into a virtual wrapper component — that's why the binding is portable (lists, `{@const Active = A}`, dynamic use) and why attributes must be static: SSR must emit a shell per usage site.
- SSR emits `<ogygia-region hydrate|render|when|entry|endpoint …>` + a devalue `<script data-ogygia-props>` sidecar. The runtime custom element schedules per `wake`, dynamic-imports the entry URL written **on the element** (Astro-style — the shared runtime never embeds an app-wide island map), parses props, `hydrate()`s in place. `disconnectedCallback` unmounts — SPA swaps clean up for free.
- Free-variable analysis captures host values referenced in island markup → serialized per instance; that's the snapshot law, enforced at build (mutated captures error) and in dev (proxy warns).
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
- Two wire codecs with the same `id` clobber each other in the session Keep (dev warns).
- `maxAge: 60` = 60 **seconds** on a deferred hole (HTTP), 60 **ms** on live/remount (JS staleness). Use duration strings (`'1h'`, `'30s'`) and the trap disappears.
- Dev ≠ prod: SSR query seeding degrades to refetch in dev; the mutation proxy is dev-only; `import.meta.glob` behavior can differ between dev and build. Verify data flows against `pnpm build` + preview.
- Docs-site routes: forgetting `export const load = docs.load` (404s/redirects/checks) or `entries` (prerender misses leaves).
- Config lives in ONE grammar: `regions.{visible,presets}` / `router.{viewTransitions,forms}` / `content.{markdown,presets}`. Legacy keys (`visible`, `presets`, `continuity` top-level) are hard errors, not aliases.

## In this monorepo

- Library src: `packages/ogygia/src`; build it first: `pnpm build:lib` (apps consume dist). Full check: `pnpm check`; e2e: `pnpm test:e2e` (`:fast` skips rebuild).
- Internal naming: non-public exports are `snake_case`; only public API + classes/types are camel/Pascal.
- Design/trust rationale: `internal/notes/DESIGN.md`, `INVARIANTS.md`, `regions.md`, `config.md`. Docs source of truth: `apps/docs/src/content/docs`.
