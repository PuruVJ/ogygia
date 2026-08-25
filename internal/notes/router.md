# ogygia router — programmatic routing on components

**Status: BUILT (v1) on branch `router`; design loop-refined (14 passes).** `ogygia/router` ships
`routes()`/`view()`/verb wrappers + RF-binding detection; the profiler is rewritten on top as its
handler-mode dogfood (21 router tests, full suite green). This doc is sharpened iteratively: each pass
picks one non-obvious problem real routers must solve, tests the current design against it, rates
the experience, and expands the API only if the scenario demands it — without making the 80% case
clunkier. Elegance × power. The refinement log at the bottom is the audit trail.

Prior art: an earlier `routes.md` draft was rejected ("without the whole router thing") because what
was actually needed first was `document()` — one function that renders a region into a complete
ogygia page. That shipped. THIS design is the layer above it, now wanted for real: the profiler
hand-rolls a `sub === '/page'` dispatch chain today, docs sites want programmatic route trees, and
libraries want to mount pages under a base path without owning the consumer's `src/routes`.

---

## Why

ogygia has one primitive — the region — and one way to turn it into a page: `document()`. What's
missing is the thing in between: *given a URL, which page?* Today every consumer of `document()`
writes that by hand (the profiler's if-chain is the canonical scar). Kit's filesystem router can't
serve this need: a library cannot inject files into the consumer's `src/routes`, and dynamic route
sets (CMS trees, generated docs, admin panels) don't want to be files at all.

The router is **not** a replacement for Kit's router. It's the programmatic complement: an ordinary
value, defined in an ordinary module, mounted wherever a request can be answered.

**The remote-functions inversion (refinement 4):** we live in an RF world. A page is a query that
returns a view; a route is *giving that query a URL*. The router is not where logic lives — it is
where addresses are minted. Everything below follows from that.

## Design laws

1. **`router.ts` is not a special file.** No filesystem convention, no plugin magic, no generated
   types file. You import a function, call it, export the result. Rename the file, nothing breaks.
2. **Routes are data; the router is a value.** You can hold it, compose it, test it by calling it
   with a `Request`. Nothing happens at module load beyond building a match table.
3. **The authoring surface is components and functions, never regions.** You route a component, an
   inline handler, or a remote function. The region stays the internal currency (the router builds
   one and hands it to `document()`), but the word "region" never appears in a route table.
4. **Route pages are inert.** A routed component renders as server HTML with zero JS — exactly a
   `csr=false` Kit page. Interactivity comes from marked imports *inside* the page component
   (`with { wake }`), same as everywhere else in ogygia. There is no "wake this route" knob: dials
   live on imports, never on routes. (Routing a component that was itself imported with a wake mark
   is allowed — the mark means what it always means — but dev warns: mark the interactive parts
   inside instead.)
5. **Typed by the pattern string.** `'/docs/[slug]'` produces `params: { slug: string }` via
   template-literal types. No codegen, no `$types` import, no cast. Binding a remote function
   type-checks the pattern's params against the function's input schema.
6. **Web-standard at the seam.** The router's lowest-level surface is `(request: Request) =>
   Promise<Response | null>`. That makes it mountable in a Kit handle, a Kit catchall endpoint, a
   Bun/Deno server, or a unit test with zero adapters.
7. **The route's value IS its freshness declaration.** Nothing in the router declares caching or
   prerendering. A bare component is provably static → prerendered. A handler reads the request →
   dynamic. A remote function's flavor decides: `prerender` = baked (instances = its own `inputs`),
   `query` = per-request, `query.live` = a live page. One truth, zero router-side config.
8. **Minimal until you need it.** The 80% case is a flat record of pattern → component-or-handler.
   RF bindings, guards, canonicalization exist, but you meet them only when you reach for them.
9. **Svelte-y.** Values over config, bare-noun names (`routes`, `view` — not `defineRoutes`),
   progressive disclosure, and the feeling that the obvious thing is the right thing.

## The core (the 80% case)

```ts
// router.ts — an ordinary module
import { routes, view } from 'ogygia/router';
import Home from '$lib/views/Home.svelte';
import Doc from '$lib/views/Doc.svelte';
import Search from '$lib/views/Search.svelte';

export const app = routes({
	'/': view(Home),                                              // a static page is a view() — never bare
	'/docs/[slug]': (c) => view(Doc, { slug: c.params.slug }),    // c.params.slug is typed `string` — no annotation
	'/search': (c) => view(Search, { q: c.url.searchParams.get('q') ?? '' })
});
```

Mount it — either seam, same value:

```ts
// hooks.server.ts (a library does exactly this inside its own handle)
export const handle = sequence(app.handle, ogygia.handle());

// or src/routes/[...path]/+server.ts (app-owned catchall; Kit routes still win elsewhere)
import { app } from '$lib/router';
export const prerender = 'auto';        // static build value Kit reads off the module — you set it, not the router
export const entries = app.entries;     // the crawl list (static views + prerender-RF inputs) — see Freshness
export const GET = ({ request }) => app.fetch(request);
```

That's the whole beginner surface. `app.handle` falls through to the rest of the app when nothing
matches (a router that answers *some* URLs must be a good citizen for the others). `app.fetch`
returns `null` on no-match so a catchall can 404 its own way.

Three more things arrive the moment you need them (refinements 7–8):

```ts
export const app = routes({
	'/': view(Home),
	'/docs/[slug]': doc_page,
	'/view': get(() => view(Upload, { base })).post(upload), // verbs chain ON THE ENTRY — one path, one place
	'/search': get(SearchSchema, (c) => view(Results, c.input)), // schema gates the GET; c.input typed
	'/login': post(LoginSchema, login),                      // POST-only, body validated before login runs
	'/api': api // a router is a value — mount one under a prefix; patterns + types flow through
});

app.href('/docs/[slug]', { slug: 'intro' }); // typed links — domain = the GET-answering keys
```

### What a route value can be

| Value | Meaning | Freshness (law 7) |
| --- | --- | --- |
| `view(Component, props?)` | A page — inert HTML, islands inside wake. Static pages are `view(Home)` (never a bare component: that would break `ctx` inference) | prerenderable (a static value, takes no request) |
| `(c) => …` | Inline handler; `c.params` typed from the pattern key, zero annotation | request-time (it reads the request) |
| remote `prerender(...)` | The function IS the page; params validated by its schema | baked; instances = the RF's own `inputs` |
| remote `query(...)` | Same, per-request | request-time |
| remote `query.live(...)` | Same, and the page morphs as the query yields | live (SSE) — parking lot, scenario candidate |
| another `routes(...)` | Sub-router mounted under this prefix; patterns + types flow through | each inner route keeps its own declaration |

### What a handler / bound RF returns

| Return | Meaning |
| --- | --- |
| `view(Component, props, opts?)` | The page: rendered through `document()` — inert HTML, islands wake, CSS hoisted. `props` type-checked against the component. `opts`: `title`, `status`, `headers`, `cache` |
| `Response` | Sent as-is (JSON endpoints, redirects, files) |
| `null` / `undefined` | Not mine — fall through to the next match / the rest of the app |

```ts
'/docs/[slug]': async ({ params }) => {
	const doc = await docs.get(params.slug);
	if (!doc) return null; // fall through → 404
	return view(Doc, { doc: await doc.body }, { title: doc.data.title });
}
```

## The RF world (bindings)

The logic moves to where logic already lives; the table becomes pure URL → function bindings:

```ts
// docs.remote.ts
export const doc_page = prerender(
	v.object({ slug: v.string() }),
	async ({ slug }) => {
		const doc = await docs.get(slug);
		if (!doc) return null;
		return view(Doc, { doc: await doc.body }, { title: doc.data.title });
	},
	{ inputs: () => docs.refs().map((r) => ({ slug: r.id })) }
);

// router.ts
export const app = routes({
	'/docs/[slug]': doc_page // type-checked: Params<'/docs/[slug]'> must satisfy the input schema
});
```

What binding buys, all riding machinery that already exists:

- **Validation for free.** URL params are strings; the schema coerces and validates. `[id]` must be
  an int → garbage 404s. Inline handlers get raw strings; bindings get parsed inputs.
- **Dual addressing.** The same function answers `/docs/foo` as a full document AND embeds anywhere
  as `<Region of={doc_page({ slug })} />` — preview cards, modals, search hovers. Held-region
  tickets, signing, CSS-rides-the-response: all shipped.
- **No extra hop.** Server-side, the router calls the remote in-process in the same request. RF
  becomes HTTP only when the client calls it.
- **Method routing dissolves.** `query` = GET page, `command` = POST, `form` = progressive-
  enhancement POST. The flavor is the method. No method DSL, ever.
- **Single-flight mutation.** A command returning `view(...)` repaints the mounted region in one
  round trip — already ogygia law.
- **Search params stay composition, not API:** a bound RF receives params only. Need the query
  string? Use a one-line inline handler that calls it:
  `({ params, url }) => doc_page({ ...params, q: url.searchParams.get('q') })`.

**Rejected:** remotes declaring their own URLs (`doc_page.at('/docs/[slug]')`). It scatters URL
space across files. The table is the sitemap — one glance, one place addresses are minted.

## Patterns

Kit's grammar, exactly — zero new syntax to learn:

- `/docs/[slug]` — one segment, required → `{ slug: string }`
- `/docs/[...rest]` — rest, may be empty → `{ rest: string }`
- `/[[lang]]/docs` — optional segment → `{ lang?: string }`
- Static segments win over dynamic; more specific wins over less (Kit's sort, reused conceptually).
- Trailing slashes are ignored for matching by default (see refinement 1); `slash: 'never' |
  'always'` 308-canonicalizes, in Kit's exact vocabulary.

## Freshness (caching + prerendering)

**Law 7: the route's value is the declaration. There is no router-side freshness config.**

- `app.entries` is **derived**: bare-component routes contribute their static paths; `prerender`-
  flavored bindings contribute their `inputs` mapped through the pattern (`{ slug: 'a' }` →
  `/docs/a`). Handlers and `query` bindings contribute nothing.
- `app.prerender` is derived the same way: `true` when every route is baked, `'auto'` when mixed.
- The mount stays dumb delegation (three exports, zero knowledge).
- **Two artifacts, one declaration:** the RF's own prerender bakes its JSON result (so client-side
  embeds are CDN-static too); the page HTML at the URL is baked by Kit's crawler walking
  `app.entries`. Both flow from the single `inputs` list on the function.
- **HTTP caching** rides `view`'s `cache` option, per-response where it belongs:
  `{ cache: { maxAge: 300, swr: 3600 } }` → `cache-control: public, max-age=300,
  stale-while-revalidate=3600`; `cache: false` → `no-store`; raw `headers` for the weird cases.
- **Finer freshness needs zero router API**: a prerendered route whose page component contains
  `render: 'deferred'` imports is PPR (static shell, per-visitor holes, `OGYGIA_SECRET`).
  `render: 'live'` imports give revalidating regions inside a cached shell. The router composes
  with the region algebra instead of growing a cache engine — also the serverless lesson: an
  in-process route cache dies with every Lambda instance anyway.

**Laws that fall out:**
- Prerendering is a property of the **catchall mount** — Kit's build crawler can only see routes
  served from a route file. A hooks-mounted router is always dynamic (documented; dev warns if a
  hooks-mounted table contains prerender-flavored bindings).
- A bare component that secretly reads `getRequestEvent()` is not provably static — don't route it
  bare; the one-line opt-out is a handler: `() => view(Home, {})`. Doc + dev warning.
- ⚠ verify at implementation: `+server.ts` accepting `prerender: 'auto'` like pages do. Fallback
  shape if not: a `+page.server.ts` mount. (The `entries` export is supported in `+server.ts`.)
- `app.entries` emits `{ path }` records — the doc standardizes the catchall as `[...path]`.

## Types

```ts
type Params<P extends string> = /* template-literal parse of P */;

function routes<T extends Record<string, unknown>>(table: {
	[P in keyof T & string]:
		| View                                                  // view(Component, props?) — a page
		| ((ctx: Ctx<Params<P>>) => Answer | Promise<Answer>)   // inline handler — ctx.params typed from P
		| Methods                                               // verb wrappers (get/post/…/query)
		| Router                                                // sub-router mounted at this prefix
		| RemoteView<Params<P>>;                                // RF whose input accepts the params
}, opts?: { base?: string; slash?: 'ignore' | 'never' | 'always'; miss?: Handler }): Router;
// ✅ params inference WORKS (refinement 11): because a page is a `view()` (a non-function value), the
// handler is the ONLY function in the union, so TS contextually types `ctx` — `c.params.slug` is typed
// `string` with ZERO annotation, and `c.params.nope` on a route without that param is a type error.
// Dropping the bare-`Component` route value (a second callable) is what unlocked it.

interface Ctx<P, I = undefined> {
	params: P;                    // typed from the pattern
	url: URL;
	request: Request;
	input: I;                     // the validated input when the route has a schema; else undefined (refinement 12)
	/** present when mounted inside Kit (handle/catchall) — cookies, locals, platform, event.fetch */
	event?: RequestEvent;
	// response shortcuts (refinement 10, Hono-style) — a handler rarely constructs a Response by hand
	json(data: unknown, init?: ResponseInit): Response;   // application/json, no-store
	redirect(location: string, status?: number): Response; // default 303
	text(body: string, init?: ResponseInit): Response;
	// typed href: the pattern types its params (missing/extra param → type error). On a handler's ctx the
	// pattern KEY is any string; on `app.href` (Router<T>) the key is constrained to real route keys.
	href<K extends string>(pattern: K, ...args: HrefArgs<K>): string;
	state: Record<string, unknown>;   // per-request scratch bag — a guard writes, the handler reads (refinement 13)
}

// Guards (refinement 13) — run BEFORE the handler. Return a Response to DENY; void to ALLOW; enrich
// ctx.state. Table-wide via routes(t, { guard }), per-route/subtree via guard(fn, value); sub-router
// guards compose (parent runs first). Table guards cover unmatched paths too (deny, not 404 — good for
// auth). A guard is a PRE-check; response-modifying middleware (e.g. set a cookie) still rides the seam
// (`sequence(...)` / the handle wrapper) — the two are complementary, which is why the seam non-goal held.
type Guard = (ctx: Ctx) => Response | void | Promise<Response | void>;
function guard<V>(g: Guard | Guard[], value: V): Guarded;

// The schema gate (refinement 12) — verbs take a Standard Schema (Zod/Valibot/…) FIRST; the router
// validates `{ …jsonBody, …search, …params }` (path wins) BEFORE the handler, 400s on issues so the
// handler never runs on bad input, and hands the typed result to `c.input`. Same schema an RF takes.
get(handler): Methods;
get<S extends StandardSchemaV1>(schema: S, handler: (c: Ctx<P, InferOutput<S>>) => Answer): Methods;
// …post/put/patch/del/query/options identical. A bound RF gets the same merged input (its own schema
// validates), so search params come free with the RF's schema.

type Answer = View | Response | null | undefined;

function view<C extends Component>(
	component: C,
	props: ComponentProps<C>,
	opts?: { title?: string; status?: number; headers?: HeadersInit; cache?: CacheOpt }
): View;

// verbs are VALUES, chained per record entry (refinement 8) — one path, one place
function get<P>(h: Handler<P>): MethodValue<P>;      // also: post/put/patch/del/query/options
interface MethodValue<P> {
	post(h: Handler<P>): MethodValue<P>;               // accumulate more verbs on THIS entry
	put: …; patch: …; del: …; query: …; options: …;    // del(): `delete` is reserved
	// query() = the HTTP QUERY method — a safe, GET-like verb that carries a request body (refinement 9)
}

interface Router<T> {
	handle: Handle;                                    // Kit hooks seam
	fetch: (req: Request) => Promise<Response | null>; // web seam (catchall, tests, Bun)
	match: (path: string) => Match | null;             // introspection, no side effects
	entries: () => Promise<Array<{ path: string }>>;   // catchall crawl list (static views + RF inputs)
	// typed links — pattern constrained to THIS router's route keys, params typed from the pattern.
	href<K extends keyof T & string>(pattern: K, ...args: HrefArgs<K>): string;
}
```

The hover on `params` inside a handler shows the exact object shape derived from the key above it.
That hover IS the documentation.

## Non-goals (for now, on purpose)

- Client-side routing: ogygia's passage router already owns navigation; this router only answers
  requests. A `routes()` page navigated to via the passage router is just… a page.
- Data loaders/actions à la React Router: the handler (or the bound RF) IS the loader.
- Middleware chains: `sequence()` exists at the mount seam; inside the table, a guard is a function
  you call. (Revisit only if a fringe scenario forces it.)
- A route-level server-side memo/SWR store. Regions give partial freshness; HTTP gives page
  freshness; RF prerender gives build freshness; serverless makes in-process route caches a trap.

## Kit idioms just work (refinement 6)

**Law: reinvent nothing — build-time modules work for free; the one runtime module gets FED.**

- **Free** (`router.ts` + routed components are ordinary app modules in the app's own Vite graph):
  `$env/*`, `$lib`, `$app/paths`. `$app/server`'s `getRequestEvent()`/`read()` work unchanged —
  handlers and routed components run inside the live request (`ctx.event` is sugar over it).
  `$app/navigation` + `data-sveltekit-preload-*` are client-side: a router page is just a csr=false
  page, so the passage router already owns them.
- **Fed**: `$app/state`'s `page`. Kit populates it only in ITS page renderer; a router page renders
  through `document()`, so a shell reading `page.url` would silently see nothing (the same
  silent-failure class as trailing slashes). `document()` therefore supplies the snapshot through
  the channel ogygia islands already use (the document-level devalue seed + the `$app/*` shim
  system): `page.url` = request URL; `page.params` = the ROUTER's params (not the catchall's);
  `page.route.id` = **the table key** (`'/docs/[slug]'` — Kit's exact route.id convention: theirs
  is the file pattern, ours is the table pattern); `page.data` = `{}` unless the handler passes
  `view(…, { data })`. Server mechanism: a delegating shim — inside a `document()` render it serves
  the router's snapshot, anywhere else it re-exports Kit's real values, so Kit pages are untouched.
- **Base path**: patterns are app-relative; the router strips Kit's `base` (`$app/paths`) from
  incoming URLs automatically. Subpath deploys just work.
- **Library caveat**: `$env`/`$app` imports are app-graph only — library `.ts` (the profiler) keeps
  `process.env`/`ctx`. Library `.svelte` shipped raw and compiled by the consumer's Vite CAN read
  the fed `page`.

## Two modes, one table (refinement 5)

RFs are experimental and opt-in, so the router speaks both — **RF bindings are the primary story
for app authors; handler mode is the complete floor**, not a shim. And it must be complete, because
a LIBRARY cannot use RFs at all: `.remote.ts` only works when Kit's plugin processes it inside the
app — node_modules can't ship one. The profiler is therefore the flagship handler-mode consumer.

- Same slot, three value kinds (`Component` | handler | RF binding). Migrating a route = swapping
  its value. The table never restructures.
- The one capability refinement 4 accidentally made RF-only — prerendering a *dynamic* route — gets
  a value-level fallback that stays inside law 7: `baked(handler, { inputs })`, the `prerender`
  flavor's exact semantics with no experimental flag. ("Baked" is already ogygia's word for
  built-at-build-time. Name tentative.) When RFs land for the user, `baked(...)` → `prerender()` RF
  is a drop-in upgrade that adds schema validation + dual addressing.
- Method routing, handler mode (settled in refinement 8): **verbs are values, chained per entry** —
  `'/view': get(h).post(h2)`, `'/login': post(login)`. One path, one key, one place; a bare
  component/handler still means GET (+auto-HEAD), so the 80% never sees a verb. The entry knows its
  full method set (405 + `allow:` honest, OPTIONS auto-answered). RF bindings never need verbs —
  the flavor IS the method (`query` = GET, `command`/`form` = POST); wrappers are purely the
  handler-mode spelling. Escape hatch: a plain handler can read `request.method` itself.
  Journey, recorded honestly: `'POST /view'` string keys (rejected: stringly, splits a path) →
  `{ GET, POST }` method tables (rejected: caps-object values) → router-level `.post(pattern, h)`
  chains (rejected: defines one route in two places) → per-entry verb values.
  Warts owned: `del()` not `delete()` (reserved word, the classic JS-router scar); the `get` import
  can collide with svelte/store's `get` in a file using both.
- Handlers may `throw` Kit's `redirect()` / `error()` — the router catches both. Same muscle
  memory as load functions; returning a `Response` remains available for cases a throw can't carry
  (e.g. a redirect that also clears a cookie).

### The profiler as the router's dogfood

The profiler's hand-rolled dispatch (~400-line if-chain in `src/profiler/index.ts`), rewritten:

```ts
// src/profiler/router.ts — handler mode, base-mounted
const app = routes(
	{
		'/': ({ event }) => view(Dashboard, dashboard_props(event)),
		'/run': ({ url }) => view(Run, run_props(url)),
		'/page': async ({ url, event }) => {
			const id = await record_page(url, event); // the serverless-budgeted recording
			if (url.searchParams.get('format') === 'ogp') return ogp_response(id);
			if (wants_json(event.request)) return json(report_json_of(id));
			redirect(303, `${base}/report/${id}`);
		},
		'/report/[id]': ({ params }) => {
			const s = reports.get(params.id);
			if (!s) return view(Message, gone_props(), { status: 404 }); // its OWN 404, deliberate
			return view(Report, report_props(s));
		},
		'/report/[id].json': ({ params }) => report_json_response(params.id),
		'/report/[id]/raw': ({ params }) => raw_download(params.id),
		'/view': get(() => view(Upload, { base })).post(async ({ request }) =>
			json({ url: store_upload(await request.arrayBuffer()) })
		),
		'/login': post(({ request, event }) => login(request, event)),
		'/logout': ({ event }) => logout_response(event), // manual Response: redirect + clear-cookie
		'/reset': () => { reset_recording(); redirect(303, base); }
	},
	{ base: '/__profiler' }
);

// auth is NOT routing — it wraps the seam once, instead of being sprinkled in 12 handlers
handle = gate(app.handle); // locked → login page · disabled → 404 · else decorate set-cookie
```

What the dogfood forced into the design (each promoted from the parking lot):

- **`base`**: patterns are base-relative; the mount strips it. Required for any library.
- **`miss`**: with `base` set, the router owns its whole subtree — unmatched paths under base
  render `miss` (default: a plain 404) instead of falling through to the consumer's app. Without
  `base`, `null` keeps meaning "not mine, fall through". A *specific* not-found (the profiler's
  "report expired") is just a handler returning `view(…, { status: 404 })` — no feature needed.
- **Per-entry verb values** (`get(h).post(h2)` — see refinement 8) and **thrown redirect/error** (above).
- Auth deliberately did NOT become router API: it's one wrapper at the seam. The non-goal held.

## Parking lot

- **Live pages** (`query.live` binding → page morphs over SSE): the algebra gives it for free —
  needs a scenario pass on the client half (what subscribes on a csr=false page: auto-injected
  boot island?).
- `command` / `form` bindings: progressive-enhancement POST — scenario pass needed
  (same-URL GET+POST pairs, redirect-after-post).
- Streaming responses / regions that suspend.
- Shared chrome (layout components) without a layout DSL. (Sub-router *mounting* is settled —
  `'/api': api` as a record value, refinement 7 — but nested LAYOUTS are a separate question.)
- **Typed search params** (TanStack's `validateSearch` is the best-in-class): a schema for
  `url.searchParams` per record entry, typed into `ctx`. The RF binding already gets this from its
  input schema; the record could too. Next stolen candidate.
- `entries` param-name coupling (`[...path]`) — convention now; could learn the name from the
  event at runtime if it ever matters.
- `baked()` naming (vs the `import.meta.og.bake` macro's concept-space).

---

## Refinement log

Each entry: the fringe scenario → how the current design fares (rated /10 for ease + intuitiveness)
→ the expansion, if any, and what it deliberately does NOT do to the 80% case.

### 1 · Trailing slashes (2026-08-24)

**Scenario.** `/docs/foo` vs `/docs/foo/`. Not hypothetical: TODAY the profiler produced a garbage
report because `/fr/fr` 308s to `/fr/fr/` and the internal fetch measured five redirects. CDNs
cache both forms separately; SEO sees duplicates; Kit canonicalizes via `trailingSlash` and 308s.
A programmatic router mounted in a handle sees the RAW pathname — nobody has normalized anything
for it.

**Test.** `routes({ '/docs/[slug]': … })` receives `/docs/foo/` → no key matches → falls through →
404 (or Kit 308s first and the router only works when Kit sits behind it — in a bare catchall or
Bun mount there is no Kit to rescue it). Silent partial failure: the author tested `/docs/foo`,
shipped, and the slashed form dies in production.

**Rating.** Ease 2/10, intuitiveness 3/10 — silent failure is the worst grade a design can earn.

**Expansion.** Slash-insensitive matching by default; `slash: 'never' | 'always'` 308s to the
canonical form (Kit's vocabulary). Cost to the 80%: zero — the naive table becomes MORE correct.
After: 9/10 / 9/10 (the doc must note 'ignore' serves two URLs for one page — an SEO nit).

### 2 · The authoring surface says "region" (2026-08-24, user ruling)

**Scenario.** Not a traffic fringe — an adoption one. The draft's `'/': () => region(Home, {})`
makes the router's entry ramp teach an internal concept before the first page renders. The user's
call: *people should just import components; route pages must be inert; interactivity is marked
imports inside them.*

**Test.** The old surface forced `region()` + an arrow even for a static home page. 5/10 ease.

**Expansion.** Components ARE the surface (law 3), route pages are inert by definition (law 4 — the
same law as csr=false Kit pages, so nothing new to learn; proven by the profiler's own Run page:
inert shell, `wake:'load'` island inside). Bare `Component` allowed as a route value. Handlers
return `view(Component, props, opts?)` — chosen over the `[Comp, props]` tuple for discoverability;
`page` was unavailable (taken by `ogygia/content`), which also dissolves the old naming-collision
parking-lot item. Cost to the 80%: negative — the simplest route got simpler (`'/': Home`).
After: 9/10 / 10/10.

### 3 · Prerendering routes that aren't files (2026-08-24)

**Scenario.** Kit's build crawler prerenders by rendering route *files* and following links. A
programmatic router's routes don't exist as files, and a `/docs/[slug]` tree behind `app.fetch` is
invisible to the crawler. Bonus subtlety: one router usually holds BOTH prerenderable routes and
per-request ones (`/search`), so all-or-nothing `prerender = true` on the mount is wrong.

**Test.** No story at all: mount a catchall, get SSR-per-request forever. 0/10 for static docs.

**Expansion (v1, superseded by 4).** A `prerender` block in `routes()`' options (keys typo-checked
against the table, generators typed `Params<P>[]` per pattern) + derived `app.prerender` /
`app.entries` so the mount stays dumb. Flagged tension: freshness declared in the router while RF
bindings carry their own — two sources of truth.

### 4 · The remote-functions inversion (2026-08-24, user prompt: "design it from scratch given RF")

**Scenario.** We live in an RF world: typed input → typed output, schema validation, transport,
prerendered remotes, live queries, single-flight commands — all shipped. Does the router duplicate
any of it? (It did: the prerender block, raw-string params, an eventual method DSL.)

**Test of the v3 design.** The prerender block re-states what a `prerender`-flavored remote already
knows (`inputs`); params were unvalidated strings; POST routes had no story. 6/10 — worked, but
carried a second source of truth, and two-sources-of-truth is how designs rot.

**Expansion.** The inversion: *a page is a query that returns a view; a route gives it a URL.*
Remote functions become a third route-value kind, type-checked pattern-params-against-input-schema.
The prerender block is **deleted** — law 7 replaces it: the route's value IS its freshness
declaration (bare component = provably static → auto-prerendered; handler = dynamic by
construction; RF flavor decides the rest). `app.entries`/`app.prerender` become pure derivations.
What binding buys for free: schema validation of URL params, dual addressing (same function = full
page at its URL + embeddable region anywhere), no-extra-hop in-process calls, method routing
dissolved into flavors, single-flight mutations, live pages as a natural consequence.
Cost to the 80%: negative again — `routes()`' options shrink to `slash` alone, and the simple table
is unchanged. After: 9/10 ease, 10/10 intuitiveness for the binding law; live/command bindings
parked for their own scenario passes (the client half of live pages is genuinely unresolved).

### 5 · Two modes + the profiler dogfood (2026-08-24, user ruling: "RF primary, non-RF the fallback — and rewrite the profiler this way")

**Scenario.** RFs are experimental/opt-in, so both modes must exist. Sharper: a LIBRARY cannot use
RFs at all (`.remote.ts` needs the app's Kit plugin; node_modules can't ship one) — so the
"fallback" must be a complete floor, and the profiler (ogygia's own shipped route tree) is the
proof case. Rewriting its ~400-line if-chain against the design was the test.

**Test.** The v4 design routed the profiler's GET pages fine but had no story for: the base path,
`POST /view` and `POST /login` (method routing was "dissolved into RF flavors" — useless to a
library), redirects from handlers, clearing a wedged flag then bouncing, or the library-owns-its-
subtree 404. Prerendering a dynamic route had become RF-only — a capability regression for
flag-less users. 5/10: the flagship consumer couldn't be expressed.

**Expansion.** `base` + `miss` options; method routing via method tables — a route value may be
an inline `+server.ts` body `{ GET, POST, fallback }` (first drafted as `'POST /view'` string-
prefix keys; REJECTED by user ruling same day — stringly, splits one path across keys, and only
the method table can answer 405 + `allow:` honestly);
thrown `redirect()`/`error()` caught (Kit muscle memory); `baked(handler, { inputs })` as the
value-level, flag-free twin of the `prerender` flavor. Auth deliberately stayed OUT (one `gate()`
wrapper at the seam — the middleware non-goal survived its first real contact). Cost to the 80%:
zero — every addition is invisible until a table needs a POST, a base, or a baked dynamic route.
After: 9/10 ease (the profiler table reads like its sitemap), 9/10 intuitiveness (method-in-key is
the one thing a newcomer must be shown once).

### 7 · The elegance audit — Hono, Elysia, TanStack Router (2026-08-24, user prompt: "your non-RF designs aren't elegant; go look")

**Scenario.** Not traffic — taste. The handler-mode surface had accreted five route-value kinds
(Component | handler | RF | method-table | baked) and a caps-object method table. Audit the three
best-regarded router APIs and steal what deserves stealing.

**What each teaches.** Hono: verbs as function names read like English; `app.route('/book', book)`
is real composition; registration order beats precedence rules (we keep specificity-sort instead —
a record has no order to lean on, and Kit's sort is already learned). Elysia: chaining ACCUMULATES
types — every call returns a more-typed value; schemas live in the route line. TanStack: config
objects are the ugliest syntax of the three, but the deepest lesson — types must flow to LINKS, not
just handlers, and search params are typed state.

**Test.** `{ GET, POST }` caps-objects inside a record: 5/10 against `.post('/view', h)`. No typed
links: a rename of `/docs/[slug]` broke every hand-written URL silently. No composition story.

**Expansion.** One crisp law replaces the method table: **the record is what the URL bar can reach
(GET + auto-HEAD); the chain is what it can't** — `routes({...}).post('/view', h)`, Hono's verbs
with Elysia's type accumulation. Sub-routers mount as record values (`'/api': api`), Hono's
composition as data instead of a method. `app.href(pattern, params)` — TanStack's lesson scoped
perfectly by the law: links are GETs, so href's domain is exactly the record keys. Typed search
params parked as the next stolen candidate. The record's value kinds shrink back to four
(Component | handler | RF binding | sub-router); 405/`allow`/OPTIONS stay derivable since the
router still sees a path's full method set. Cost to the 80%: zero — a table of pages never chains.
After: 9/10 ease, 9/10 intuitiveness (the GET-in-record / verbs-on-chain line must be taught once,
then it self-enforces).

### 8 · One route, one place (2026-08-24, user ruling: "two places to define the same route is ugly")

**Scenario.** Refinement 7's law put `/view`'s GET in the record and its POST on a router-level
`.post('/view', …)` chain — the same path defined in two places. The user rejected it on sight.
They were right: "where is this route defined?" must have exactly one answer, and a rename of
`/view` in the record silently orphans the chained POST (the same split-a-path failure that killed
the string-prefix keys, wearing nicer clothes).

**Test.** Multi-verb paths: 4/10 — the sitemap virtue of the record is destroyed exactly where a
path is most complex, which is where you need it most.

**Expansion.** Verbs become VALUES, chained per entry: `'/view': get(h).post(h2)`,
`'/login': post(login)`. Bare component/handler still = GET, so the 80% never sees a verb; the
entry carries its full method set (405/`allow`/OPTIONS still derivable); RF bindings still need no
verbs (flavor = method). The router-level verb chain is deleted; `href`'s domain becomes "keys that
answer GET". Hono's verbs and Elysia's accumulation survive — relocated from the router to the
entry, which is where the route lives. Warts owned: `del()` (reserved word), and the `get` import
can collide with svelte/store's `get`. Cost to the 80%: zero. After: 9/10 / 9/10 — every question
about a path is answered by reading its one line.

### 9 · Building it — the profiler dogfood + two implementation truths (2026-08-25, user: "build it, rewrite the profiler on it")

**Scenario.** Not a thought experiment — actually implement `ogygia/router` and port the profiler
(~270-line `sub === '…'` if-chain) onto it. Implementation is where designs meet reality.

**What held.** The whole surface survived contact: `routes()` over a record, `view().action()`, verb
wrappers, `base`/`miss`/`slash`, sub-router delegation, RF detection off Kit's real `__.type` brand
(query/prerender → GET, command/form → POST), derived `entries`/`prerender`, `href`. The profiler
table reads like its sitemap; auth stayed a single `gate()` wrapper (the middleware non-goal held a
second time). 21 router tests + the full suite green; every profiler route verified live, including
`DELETE /view → 405 allow: GET, POST` (the honest-405 the string-key design never could give).

**What reality forced.**
- **Component vs handler is undecidable by type.** Both are functions, so a bare `Component` and an
  inline `(ctx) => …` sit in the same union and TS won't contextually type `ctx` — an inline table
  handler needs `({ params }: Ctx) => …` today (verb-wrapper + RF handlers infer fine). At RUNTIME
  they're told apart by ARITY: a Svelte 5 component takes `($$payload, $$props)` (length 2), a
  handler takes `ctx` (length ≤ 1). Documented; per-pattern `params` inference is the next pass.
- **`render()` must await the answer.** A handler (or `miss`) may return a `Promise<Response>`; the
  first cut type-checked the un-awaited promise, wasn't a `Response`, and got JSON-wrapped → a bogus
  200 on the profiler's 404. One-line fix (`await input` first); a reminder that the Answer union is
  really `Answer | Promise<Answer>` end to end.
- **QUERY joined the verbs.** HTTP QUERY (safe, GET-like, body-carrying) is now a verb wrapper
  alongside get/post/put/patch/del — the record still holds only URL-bar-reachable GETs.

Rating: 9/10 ease, 9/10 intuitiveness — the one scar a newcomer meets is the `: Ctx` annotation on
inline table handlers, and it's the thing to erase next.

### 10 · `ctx` is the interface — response shortcuts + the profiler goes all-in (2026-08-25, user: "it's not router enough — use more of the router's ctx, move things into the router")

**Scenario.** The first profiler port took `ctx` apart at the table (`({ url }) => this.#run(url)`,
`({ params }) => this.#report(params.id)`) and rebuilt Responses by hand (`new Response(null, {
status: 303, … })`, a local `json_response`). The router's `ctx` was a bag of four fields, not an
interface you'd want to program against.

**Test.** Handlers threaded primitives instead of `ctx`; every JSON/redirect was hand-rolled;
`ctx.event` was reached for even when `ctx.url`/`ctx.request` would do. Reads as "a router bolted
on", not "the router way". 6/10.

**Expansion.** `ctx` gains Hono-style shortcuts — `ctx.json(data, init?)`, `ctx.redirect(location,
status = 303)`, `ctx.text(body, init?)` — built once per request in `make_ctx`. The profiler now
passes `ctx` straight into every handler (`(c) => this.#report(c)`), which read `c.params.id`,
`c.url.searchParams`, `c.request`, and reserve `c.event` for the ONE Kit-only thing (`event.fetch`,
the internal SSR render). All response construction moved to `c.json`/`c.redirect`; the local
`json_response` is deleted. Login/logout are routes; the gate does auth only. Net: the profiler no
longer imports `document`/`region` OR builds a raw Response for a page — the router owns rendering
AND the common response shapes. Cost to the 80%: zero (shortcuts are additive). After: 9/10 / 9/10.
The profiler is now a faithful mirror of what an app author writes.

### 12 · The schema gate — validation before the handler, RF-symmetric (2026-08-25, user: "the whole point of a schema is to protect from running the handler at all")

**Scenario.** The first search-params sketch was `c.search(schema)` — called INSIDE the handler. Wrong:
the handler has already started. A schema must be a GATE — validate first, 400 on bad input, the
handler never fires — which is exactly how an RF works. So the schema belongs ON the route, and the
non-RF and RF stories should look nearly identical.

**Test.** `c.search()` ran the body before validating; it couldn't reject-before-run; and it left the
RF and non-RF stories asymmetric. 4/10 against "the schema protects the handler".

**Expansion.** Standard Schema (`~standard` — the very interface Kit's RFs consume) is the bridge, so
ONE Zod/Valibot schema works both ways. Verbs take it first: `get(schema, handler)`, mirroring
`query(schema, handler)`. The router builds the input `{ …jsonBody, …search, …params }` (path wins;
repeated search key → array), runs `schema['~standard'].validate` BEFORE the handler, returns a 400
listing the issues if invalid, and only then calls the handler with `c.input` typed to the schema's
output. A bound RF gets the same merged input — so **search params come free with an RF's schema**,
and migrating a handler to an RF is `get(S, h)` → `query(S, h)`, body unchanged. Cost to the 80%:
zero — the schema is a strictly-additive first arg; `view()`, bare handlers, and `get(h)` are
untouched; `c.input` is `undefined` without a schema. 7 tests. After: 9/10 / 9/10.

**Also this pass (href gets a consumer, and gets typed):** `href` moved onto `ctx`, and the profiler
builds its report redirect with `ctx.href('/report/[id]', { id })` instead of a hand-built string —
rename-safe. First cut shipped it LOOSE (`href(pattern: string, params?: Record<…>)`) and the doc
overclaimed "typed"; the user caught it. Fixed: `Router` is now generic (`Router<T>`), `app.href`'s
pattern is constrained to real route keys AND its params are typed from the pattern (a typo'd route or
a missing param is a type error); `ctx.href` types the params from the pattern literal (key stays any
string on a handler's loose ctx). Threading the table `T` into the types did NOT break the `c.params`
inference (verified). Typed-search-`href` stays parked — no link needs typed search yet.

### 13 · Per-route guards — the one clear competitive gap (2026-08-25, user picks it: "let's do #1")

**Scenario.** Guards/`beforeLoad`/context are table stakes in TanStack + Elysia and the one thing our
router lacked. We'd made middleware a NON-GOAL (one `gate()` at the seam), elegant for the profiler's
single auth concern but unable to say "this ONE route needs admin". So: add scoped guards without
resurrecting a middleware chain.

**Test.** Before: a per-route auth check meant hand-rolling `if` at the top of the handler (already
running) — the same "schema must gate, not run inside" mistake, one level up. 3/10.

**Expansion.** A `Guard = (ctx) => Response | void` runs BEFORE the handler: a Response denies
(401/403/redirect), void allows, and it can enrich `ctx.state` (the DI story, untyped v1) for the
handler. Three placements, one model: table-wide `routes(t, { guard })`, per-route/subtree
`guard(fn, value)` (flattens when nested), and a sub-router's own table guard — which COMPOSE, because
delegation runs the parent's table guards first (they fire once, early, covering sub-routes AND
unmatched paths, so an unauthed probe is denied rather than 404'd). Table guards run pre-match (no
params); per-route guards run post-match (params available) — the one wart, documented. 6 tests
(deny-before-handler, ctx.state, per-route, order/first-Response-wins, parent→sub compose, guards a
`get()`/`view()` alike). Cost to the 80%: zero (no `guard` = nothing runs).

**Design finding (guards vs the seam):** guards are a PRE-check. The seam (`sequence`, the handle) is
where response *transforms* live. They're complementary — and refinement 14 shows the profiler's auth
belonged entirely on the guard side once one URL smell was removed. After: 9/10 / 9/10.

### 14 · Remove `?key=`, auth becomes a guard (2026-08-25, user: "?key should've been removed — move it to a guard")

**Scenario.** Refinement 13 claimed the profiler couldn't migrate to a guard because it *seated a
cookie on the response* when you arrived with `?key=<secret>` — a post-effect. But the user pointed at
the real problem: a secret in a URL is a smell (logged, cached, shared, in Referer). Drop `?key=`
entirely and the post-effect vanishes with it — auth turns into a pure pre-check.

**Expansion.** `?key=` is gone from `#authed` (browser → login cookie; programmatic → the
`x-profiler-key` header, which is what the MCP tools now send). No `?key=` means no cookie-seating on a
GET, so `#authed` returns a plain boolean. The whole `#ui` gate collapses to `router.fetch()`, and auth
moves to a table guard `routes(table, { guard: #auth_guard })` that exempts `/login`/`/logout`, allows
in dev, redirects to `/login` when locked, and 404s when the UI is disabled — a textbook pre-check. So
the profiler DOES dogfood guards after all; refinement 13's "keeps its bespoke gate" is superseded.
Verified in a prod preview: unauthed → 303 to /login, `x-profiler-key: <secret>` → 200, `?key=` no
longer authenticates. Lesson: a feature that "needs" a post-effect is often carrying a design smell
that, once removed, makes it fit the cleaner primitive. After: 9/10 / 10/10.
