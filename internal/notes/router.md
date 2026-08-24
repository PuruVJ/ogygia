# ogygia router — programmatic routing on components

**Status: DESIGN, loop-refined. Not implemented.** This doc is sharpened iteratively: each pass
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
import { routes, view } from 'ogygia/server';
import Home from '$lib/views/Home.svelte';
import Doc from '$lib/views/Doc.svelte';
import Search from '$lib/views/Search.svelte';

export const app = routes({
	'/': Home,                                                    // bare component — nothing else needed
	'/docs/[slug]': ({ params }) => view(Doc, { slug: params.slug }),
	'/search': ({ url }) => view(Search, { q: url.searchParams.get('q') ?? '' })
});
```

Mount it — either seam, same value:

```ts
// hooks.server.ts (a library does exactly this inside its own handle)
export const handle = sequence(app.handle, ogygia.handle());

// or src/routes/[...path]/+server.ts (app-owned catchall; Kit routes still win elsewhere)
import { app } from '$lib/router';
export const prerender = app.prerender; // 'auto' when anything stays dynamic
export const entries = app.entries;     // derived — see Freshness
export const GET = ({ request }) => app.fetch(request);
```

That's the whole beginner surface. `app.handle` falls through to the rest of the app when nothing
matches (a router that answers *some* URLs must be a good citizen for the others). `app.fetch`
returns `null` on no-match so a catchall can 404 its own way.

Three more things arrive the moment you need them (refinements 7–8):

```ts
export const app = routes({
	'/': Home,
	'/docs/[slug]': doc_page,
	'/view': get(() => view(Upload, { base })).post(upload), // verbs chain ON THE ENTRY — one path, one place
	'/login': post(login),                                   // a POST-only route
	'/api': api // a router is a value — mount one under a prefix; patterns + types flow through
});

app.href('/docs/[slug]', { slug: 'intro' }); // typed links — domain = the GET-answering keys
```

### What a route value can be

| Value | Meaning | Freshness (law 7) |
| --- | --- | --- |
| `Component` | Bare component, no props — inert page, islands inside wake | prerendered (provably static: it receives nothing) |
| `(ctx) => …` | Inline handler; `ctx.params` typed from the pattern key | request-time (it reads the request) |
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

function routes<T>(table: {
	[P in keyof T & string]:
		| Component                                             // bare, provably static
		| ((ctx: Ctx<Params<P>>) => Answer | Promise<Answer>)   // inline handler
		| RemoteView<Params<P>>;                                // RF whose input accepts the params
}, opts?: { slash?: 'ignore' | 'never' | 'always' }): Router;

interface Ctx<P> {
	params: P;
	url: URL;
	request: Request;
	/** present when mounted inside Kit (handle/catchall) — cookies, locals, platform */
	event?: RequestEvent;
}

type Answer = View | Response | null | undefined;

function view<C extends Component>(
	component: C,
	props: ComponentProps<C>,
	opts?: { title?: string; status?: number; headers?: HeadersInit; cache?: CacheOpt }
): View;

// verbs are VALUES, chained per record entry (refinement 8) — one path, one place
function get<P>(h: Handler<P>): MethodValue<P>;      // post/put/patch/del/options: same shape
interface MethodValue<P> {
	post(h: Handler<P>): MethodValue<P>;               // accumulate more verbs on THIS entry
	put: …; patch: …; del: …;                          // del(): `delete` is reserved
}

interface Router<T> {
	handle: Handle;                                    // Kit hooks seam
	fetch: (req: Request) => Promise<Response | null>; // web seam (catchall, tests, Bun)
	match: (path: string) => Match | null;             // introspection, no side effects
	prerender: boolean | 'auto';                       // derived from route values (law 7)
	entries: () => Promise<Array<{ path: string }>>;   // derived: static paths + RF inputs
	// typed links (TanStack's lesson) — domain = the keys that answer GET, because links ARE GETs.
	href<P extends GetKeys<T>>(pattern: P, ...params: ParamsArgs<P>): string;
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
