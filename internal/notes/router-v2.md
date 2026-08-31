# ogygia router v2 — Kit's routing, expressed as values

> Rulings (2026-08-27): greenfield; the v1 builder dies. The router MIMICS SvelteKit routing —
> layouts, loads, error pages, `page.data`, form actions, `$app/state`/`$app/navigation` — so Kit
> users can make sense of it instantly. Every concept is an importable VALUE (`load()`, `layout()`,
> `page()`), not a file convention. Typing is `$infer`-style: components index ONE exported type
> map; loads are private module details. `router.md` is kept for its refinement history only.

## The whole design in one file

```ts
// src/lib/router.ts — an ordinary module; rename it, nothing breaks
import { routes, layout, page, load, get, redirect, error, fail } from 'ogygia/router';
import Root  from '$lib/views/RootLayout.svelte';
import Home  from '$lib/views/Home.svelte';
import Doc   from '$lib/views/Doc.svelte';
import Admin from '$lib/views/AdminLayout.svelte';
import Dash  from '$lib/views/Dashboard.svelte';
import Login from '$lib/views/Login.svelte';
import Oops  from '$lib/views/ErrorPage.svelte';

// ── loads are plain consts — private to this module; $infer carries their types out ─────────────
const session_load = load(async (c) => ({
	session: await auth.session(c.cookies)
}));

const doc_load = load('/docs/[slug]', async (c) => {
	const doc = await docs.get(c.params.slug);      // c.params: { slug: string } — from the pattern
	if (!doc) error(404, 'No such doc');            // throws, like Kit
	return { doc: await doc.body, title: doc.data.title };
});

const admin_load = load(async (c) => {
	const { session } = await session_load(c);      // ← Kit's `await parent()`: typed, deduped
	if (!session) redirect(303, '/login');          // layout loads ARE the guards — the Kit idiom
	return { session };
});

const do_login = async (c) => {
	const creds = await c.request.formData();
	const s = await auth.login(creds);
	if (!s) return fail(400, { incorrect: true });  // → typed `form` prop, like Kit
	redirect(303, '/admin');
};

// ── layouts wrap sub-tables; error pages scope with them ────────────────────────────────────────
// The NAME is the layout's identity in `App` — spelled like Kit's group folders: App['(admin)'].
const root  = layout('app',   Root,  { load: session_load, error: Oops });
const admin = layout('admin', Admin, { load: admin_load });

// ── one table = the whole sitemap ───────────────────────────────────────────────────────────────
export const app = routes(
	root({
		'/':            page(Home),
		'/docs/[slug]': page(Doc,   { load: doc_load }),
		'/login':       page(Login, { load: login_load, actions: { default: do_login } }),
		'/api/search':  get(search),                  // endpoints live in the same table
		...admin({
			'/admin':       page(Dash, { load: dash_load }),  // nested layout = spread a wrapped sub-table
		}),
	})
);
// A route placed OUTSIDE root(...) renders with no chrome — Kit's `+layout@` reset, by placement.

export type App = typeof app.$infer;              // ← the ONLY typing export the app needs
```

Mount — either seam, same value:

```ts
// hooks.server.ts                         // or src/routes/[...path]/+server.ts
export const handle = sequence(app.handle, ogygia.handle());
```

## Typing — `$infer`, one-directional, no codegen, no cast hack

```svelte
<!-- Doc.svelte — the whole story -->
<script lang="ts">
	import type { App } from '$lib/router';         // type-only — erased at runtime
	let { data }: App['/docs/[slug]'] = $props();   // { data } — and `form`, `params` when relevant
</script>
<svelte:head><title>{data.title}</title></svelte:head>
```

```svelte
<!-- AdminLayout.svelte — literally a Kit layout -->
<script lang="ts">
	import type { App } from '$lib/router';
	let { data, children }: App['(admin)'] = $props();
</script>
<nav>signed in as {data.session.user}</nav>
{@render children()}
```

ONE map, two key shapes, zero ambiguity: paths always start with `/`; layout keys are `(name)` —
Kit's own group-folder spelling. `routes()` collects layout names from the wrapped tables;
duplicate names are a build error. Names double as layout identity in error traces / devtools, and
are the natural handle if targeted invalidation ever lands.

How it stays acyclic (v1's `$infer` needed a hand-written prop-erasure cast to exist):

- `$infer` is computed FROM THE LOADS ONLY. `page()` deliberately erases the component's type —
  the erasure lives inside the API signature, not in user code.
- The component's declaration `App['/path']` IS the check, exactly like Kit's `$types`: the props
  are defined as the route's type. There is no table-side props-vs-component validation (that was
  the cycle), and Kit users never had one either.
- Dependency chain: loads → table → components. Loads import neither. No cycle, no generated files.
- `App['/path']` yields `{ data, form, params }` — same shape as v1's `$infer`, kept on purpose.
- **`data` is the MERGED branch type** (Kit's rule): `App['/admin']['data']` =
  `Data<app_load> & Data<admin_load> & Data<dash_load>`, right-biased on collisions. A layout's
  `App['(name)']['data']` merges its ancestors + its own — Kit's LayoutData, exactly. The wrap
  structure is statically known, so this is pure type math and stays acyclic.
- NOTHING is exported for typing except `App`. Loads and layout values stay private consts; export
  a load only when another MODULE calls it.

## The Kit ↔ v2 dictionary

| Kit | v2 | Notes |
| --- | --- | --- |
| `src/routes/` tree | one `routes({...})` table | same `[param]` / `[...rest]` / `[[opt]]` grammar, same specificity sort |
| `+page.svelte` | first arg of `page()` | a plain Svelte component; props typed via `App['/path']` |
| `+page.server.ts` | second arg of `page()` | ALWAYS an object: `{ load?, actions? }` — the file, as an object |
| `+layout.svelte` (+ load) | `layout(name, Component, { load?, error? })` | wraps a sub-table; component takes `{ data, children }` typed `App['(name)']` |
| `await parent()` | components: just read the merged `data`; loads: `await parent_load(c)` | typed, memoized; sequences only where you await |
| `page.data` | ≡ the leaf page's merged `data` | see the data law |
| `+error.svelte` | `{ error: Component }` on `layout()` / `routes()` | nearest boundary; renders inside surviving chrome |
| `+layout@` reset | placement | put the route outside the wrap |
| `(group)` | the layout NAME (`App['(name)']`) + which table you spread into | Kit's paren spelling kept on purpose |
| `+server.ts` | `get(fn)` / `.post(fn)` entries | same table — the table is the sitemap |
| form actions / `form` prop | `actions:` beside `load` | `?/name` kept; `fail()` → typed `form` |
| `throw redirect()` / `error()` | same names, from `'ogygia/router'` | loads, actions, handlers |
| `./$types` | `App['/path']` | one exported type map; no codegen |
| `$app/state` `page` | works | SSR: `document()` establishes page context; client: seed + shims (shipped) |
| `$app/navigation` | works | goto / beforeNavigate / afterNavigate / preloadData ride ogygia's SPA router |
| `depends` + `invalidate` | `invalidateAll()` re-runs the branch's loads + refreshes the seed | targeted `invalidate(load)`: see Open |
| `entries` / prerender | derived `app.entries` / `app.prerender` | the MOUNT re-exports them (see Ownership) |
| `<svelte:head>` | unchanged | components own their head; `document()` hoists (shipped) |

## Loads — the whole data story

1. **`load(fn)` / `load(pattern, fn)`** returns a per-request-memoized function. Two calls in one
   request = one run; both callers share the promise.
2. **Parallel by default.** The router invokes every load on the matched branch (each layout's +
   the page's) CONCURRENTLY with one ctx — Kit's behavior.
3. **`await other_load(c)` is `await parent()`** — sequencing exists exactly where a real data
   dependency exists, typed. It also generalizes: siblings share the same way.
4. **Waterfall and waste are structurally impossible together**: memoization kills waste;
   concurrent invocation kills accidental waterfalls; explicit awaits are the only sequencing.
5. **Guards are layout loads that throw** `redirect`/`error` — the Kit idiom, verbatim.
6. A load declared with a pattern is checked against the table key it sits under (drift-proof).

## The data law (merged, Kit's rule — ruled 2026-08-27)

A component's `data` prop is the MERGE of every load on its branch, up to its own position:
a page merges root → … → its own load (last wins); a layout merges its ancestors + its own.
This is Kit's cascade, verbatim — `data.session` from a root layout load reads in any page
component with zero re-loading. The merge is computed once per render from loads the router
already ran concurrently; types mirror it exactly (see Typing).

`page.data` (the `$app/state` observable) IS the leaf page's merged `data` — one merge, one
truth, identical to Kit. Ad-hoc props passed without a load never enter `data` or `page.data`:
*the data is what the loads loaded.* Inside LOAD LOGIC, sharing stays explicit — `await
session_load(c)` when a load needs the value; components never need it, they read the merge.
Typing posture matches Kit: precise merged types at the component prop, loose augmentable global
at `page.data`.

## Layouts and error pages

- `layout(name, Component, { load?, error? })` returns a table→table wrapper. Nesting = spreading
  a wrapped sub-table into another. Chrome inheritance is visible structure, never directory
  position. The name keys the layout's `{ data, children }` type as `App['(name)']`.
- Layout components are Kit layouts: `{ data, children }`, `{@render children()}`.
- Error semantics are Kit's: a failing PAGE load renders the nearest error component INSIDE the
  surviving chrome; a failing LAYOUT load bubbles to the boundary above it. The error component
  receives `{ status, error }`; `page.status` / `page.error` are set. `routes(table, { error })`
  is the root boundary; `miss:` handles unmatched-under-base.

## Actions

`?/name` URLs, `form` prop typed from action returns, `fail(status, data)` for validation returns,
`redirect()` for success — all Kit-shaped. Progressive enhancement rides ogygia's shipped
form-continuity (router-forms.md); no `use:enhance` import needed on csr=false pages.

## Ownership — what lives where (audit ruling, 2026-08-27)

**A. The router owns outright** (full fidelity, pure table/render logic): loads + memoization +
parent-sharing + guards; layouts, boundaries, page.data; actions/`fail`/`form`; `redirect`/`error`;
`slash` 308s; `miss`; all typing + `href`; `c.setHeaders` (we mint the Response); pass-throughs
from the mount's RequestEvent: `c.locals`, `c.platform`, `c.getClientAddress`, `c.tracing`; and
`c.fetch = event.fetch` — Kit's server-side fetch already does cookie-forwarding; the
response-inlining half only existed for client replay, which csr=false deletes.

**B. The router derives, the actual page decides** (inherent to being mounted inside ONE Kit
route): prerendering — `app.entries`/`app.prerender` are derived, but only a CATCHALL mount can
re-export them for Kit's crawler; a hooks-mounted router can never prerender (dev warns). Adapter
`config` (ISR/runtime/regions) is per-Kit-route → one config for the whole subtree, never
per-v2-route. `csr`/`ssr` are fixed by the host page. These get a loud docs section.

**C. The ogygia client runtime's domain** (not table API; rides the SPA router): the wiring of
`invalidateAll()` (re-run branch loads → refresh seed → islands' `page.data` update, no body swap);
`snapshot` capture/restore; streaming-data parity (deferred regions remain the native answer).
Universal loads need no home — csr=false deletes the reason they exist.

## Kit surface coverage audit (from @sveltejs/kit 2.70 types + docs)

| Kit surface | v2 | Status |
| --- | --- | --- |
| `+page.svelte` `data` / `form` props, `<svelte:head>` | `App['/path']` props; head hoisting shipped | covered |
| `+page.svelte` `snapshot` | nearest concepts: form-continuity + `keep` | parked |
| `+page.ts` universal `load` | one load kind (server-run) — client re-runs don't exist | n/a by architecture |
| `ssr` / `csr` options | fixed by the host page | n/a |
| `prerender` / `entries` | derived; catchall mount re-exports | covered (bucket B) |
| `trailingSlash` | `slash:` option | covered |
| adapter `config` | mount-level, one per subtree | n/a (bucket B) |
| `+page.server.ts` `load` / `actions` | the core / `page()` second arg | covered |
| `fail()` | same name → `form` | covered |
| ctx: `params`/`url`/`route.id`/`request`/`cookies` | on `c` | covered |
| ctx: `locals`/`platform`/`getClientAddress`/`tracing`/`setHeaders` | pass-through / Response-owned | covered |
| ctx: `fetch` | `c.fetch = event.fetch` (cookie-forwarding is server-side already) | covered |
| ctx: `parent` / `depends` / `invalidate` | `await load(c)` / fn-is-the-key / `invalidateAll()` | covered (better) |
| ctx: `untrack`, `isDataRequest`, `isSubRequest`, `isRemoteRequest` | exist only because Kit's client re-runs loads | n/a |
| streaming (nested promises in `data`) | deferred regions; promise-streaming needs its own pass | parked |
| `throw redirect()`/`error()`, `isHttpError` etc. | same names from `'ogygia/router'` | covered |

Reading: everything `+page.server.ts` expresses is ours at full fidelity; `+page.ts` page-options
are mostly the mount's business; Kit-client behaviors either map onto the SPA router or stopped
being necessary. The two hard "no"s — hooks-mount prerendering, per-route adapter config — are
inherent to routing inside a page.

## Deleted from the shipped v1 builder

`(r) =>` builder lambdas, `.page().load()` chains, layers, the load-cascade `Object.assign` bag,
`.reset`, `PageB`/`EndpointB`, the user-side `$infer` prop-erasure cast ritual. The builder dies
outright (greenfield rule); the profiler, playground rtr fixture, and docs 01-server-router page
migrate as the dogfood.

## Open / parked

- **Targeted `invalidate(load)` from the client**: the fn is server-only, so the client can't hold
  the reference. `invalidateAll()` is the covered path; a stable key (`load('name', …)`?) is the
  candidate design if targeted invalidation earns its keep.
- `snapshot` — map onto `keep`/form-continuity, or a `{ capture, restore }` hook on `page()`.
- Streaming loads (nested-promise `data`).
- ~~Typed search params (schema per entry — TanStack's best idea).~~ **SHIPPED** with the FINAL API below: `page(C, { search: Schema })` → coerced `c.search`, bad → 400, in `App['/p']['search']`. Runtime gate covered by `test/router-schema.test.ts` (2026-08-21).
- Endpoint `$infer` map for typed API clients.

## FINAL API — BUILT (2026-08-27)

Shipped in `src/router/` (v1 builder DELETED). Settled surface:

- **Table**: flat `routes(table, opts?)`. Pages = `page(Comp, { load?, actions?, params?, search? })`.
  Endpoints = plain `{ GET, POST, PUT, DELETE, PATCH }` OBJECT (the +server.ts shape).
- **Verbs**: uppercase. Bare handler `{ GET: (c) => … }`, OR the exported wrapper
  `{ GET: GET<'/p'>(fn) }` / `{ POST: POST(BodySchema, fn) }` (typed params / body schema → `c.input`).
  Same "bare or wrapper" duality as `load()`/`action()`, and `Handler<P, In>` type helper.
- **Bare endpoint params**: a bare `{ GET: (c) => c.params.id }` reads `c.params` as an INDEXABLE
  `Record<string, string|undefined>` (loose — no pattern restated, reliable contextual typing). Strict
  params via the `GET<'/p'>(fn)` wrapper. (A `KeyedTable<T>` constraint that key-drove STRICT params
  from the table key was tried and REVERTED — it was contextual-typing-fragile: worked in isolation,
  degraded to `Handler<string>` with real helper types like the profiler's. Loose-but-reliable beats
  strict-but-fragile for a public API.)
- **Layouts**: `layout('name', Comp, { load?, error? })(subtable)` — named (keys `App['(name)']`),
  nesting = spread a wrapped sub-table, breaking out = PLACEMENT (route outside the wrap). No `@`.
- **Loads**: `load()` wrapper memoizes per request (parent-sharing); bare fn or `Load<'/p'>` type helper.
  Branch loads run concurrently; `data` = merged cascade (Kit). `page.data` = leaf's merged data.
- **Actions**: bare `(c) => …` (read FormData) or `action()` wrapper; `fail()` → typed `form`; no action schema.
- **Control flow**: throwable `redirect`/`error`, returnable `fail` (respond.ts).
- **Input schemas**: `params` (→404) / `search` (→400) on the page object, in `$infer`; endpoint body
  via `POST(schema, fn)` (→400, `c.input`). Beyond Kit, fully opt-in.
- **$infer**: `typeof router.$infer` → `App['/path']` = `{ data, form, params, search }`, `App['(name)']`
  = `{ data, children }`. Computed from LOADS/SCHEMAS only → acyclic, so the component→$infer→router→
  component import cycle resolves with NO cast anywhere (normal apps AND the profiler's
  `ReturnType<build_profiler_router>['$infer']` form — the prop-erasure cast was removed).
  INFER BUG FIXED: `AnyPageDef` permissive match — page() fills schema generics with
  `StandardSchemaV1|undefined`, which didn't extend bare `PageDef`'s `undefined` default → keys dropped.
- **ctx**: params/search/input + Kit RequestEvent pass-throughs + json/redirect/text/href/state.
  `c.fetch = event.fetch` (Kit cookie-forwarding).
- **Files**: define.ts (values+types), infer.ts ($infer), ctx.ts, respond.ts, router.ts (dispatch),
  css-head.ts (rcss handoff, shared), match.ts + view.ts (unchanged), LayoutChain.svelte (unchanged).
- **Dogfood**: profiler-router.ts migrated CLEAN — flat table, direct component refs (no cast), bare
  `{ GET }` endpoints (no pattern repetition), `report_or_404` DRY helper. rtr fixture migrated. Docs
  page 01-server-router rewritten comprehensive. 1178 unit + 50 e2e green; rtr live-verified (nested
  layouts + merged cascade + endpoint).
