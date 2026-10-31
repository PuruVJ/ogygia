/**
 * Router v2 value layer — the pieces you compose a table from. Every Kit routing concept is a VALUE
 * here, never a file convention: `load()` (a per-request-memoized data function), `page()` (a
 * component + its `+page.server.ts`-shaped `{ load, actions }`), `layout()` (a named table→table
 * wrapper — the component's `{ data, children }` + its own load + error boundary), and `get()`/verb
 * endpoints. `routes()` (router.ts) assembles them; `$infer` (infer.ts) types them. The design and
 * the Kit dictionary live in internal/notes/router-v2.md.
 */
import type { Component } from 'svelte';
import type { Ctx } from './ctx.ts';
import type { Params } from './view.ts';
import type { StandardSchemaV1 } from './view.ts';

import type { InferOutput } from './view.ts';

/** A per-request component chooser for `page()` — what `flag.pick({ … })` returns
 *  (`page(hero.pick({ control: A, bold: B }))`). Branded, not a bare function, because Svelte 5
 *  components ARE functions. Structural: the flags package builds the same shape without importing
 *  the router. */
export interface ComponentPick {
	__ogpick: (c: { request: Request; url: URL }) => unknown;
}

/** TYPE helper for a pulled-out or inline load — annotate a bare function so its `c` (and `c.params`)
 *  are typed without the `load()` value wrapper: `const l: Load<'/docs/[slug]'> = async (c) => …`.
 *  Pass it straight to `page(Comp, { load: l })`. Use the `load()` VALUE wrapper only when a load must
 *  be SHARED across loads (`await other(c)` — memoized per request). */
export type Load<P extends string = string> = (c: Ctx<Params<P>>) => unknown;
/** TYPE helper for a pulled-out or inline action (mirrors {@link Load}). */
export type Action<P extends string = string> = (c: Ctx<Params<P>>) => unknown;
/** TYPE helper for an endpoint handler written OUTSIDE its table. `In` (a schema output) types
 *  `c.input` — the validated JSON body of a `POST`/`PUT`/`PATCH`. Verb-agnostic (the method doesn't
 *  change the ctx). Check against it with `satisfies`, which keeps the handler's own return type (the
 *  payload `$infer` and `api()` read): `const getPost = ((c) => …) satisfies Handler<'/p/[id]'>`.
 *  Inside a table nothing is needed: the key types the handler. */
export type Handler<P extends string = string, In = undefined> = (
	c: Ctx<Params<P>, Record<string, string>, In>
) => unknown;

/** Any component. Props are a component's INPUT, so `never` props is the one shape every
 *  component's props can stand in for: every `Component<Props>` is assignable to this. */
export type AnyComponent = Component<never>;

/** A load is a CALLABLE, memoized per request: `await session_load(c)` runs `.run(c)` once per
 *  request (the memo lives on `c`), so a layout and its child sharing a load never double-fetch —
 *  Kit's `parent()`, generalized. `pattern` (optional) binds `c.params` AND is checked against the
 *  table key at assembly. `$infer` reads `Data`. */
export interface LoadDef<Data = unknown, P extends string = string> {
	(c: Ctx): Promise<Data>;
	readonly __ogload: true;
	readonly pattern: P | undefined;
	readonly run: (c: Ctx) => Data | Promise<Data>;
}

/** Per-request memo store, hidden on ctx (keyed by the LoadDef). */
type LoadMemo = Map<LoadDef, Promise<unknown>>;
function memo_of(c: Ctx): LoadMemo {
	const holder = c as { __ogloads?: LoadMemo };
	return (holder.__ogloads ??= new Map());
}

/** `load(fn)` / `load(pattern, fn)`. The returned function memoizes on `c` (run once per request);
 *  the dispatcher's concurrent branch-load pass and any `await other_load(c)` share the same promise. */
export function load<Data>(run: (c: Ctx) => Data | Promise<Data>): LoadDef<Awaited<Data>, string>;
export function load<Data, P extends string>(
	pattern: P,
	run: (c: Ctx<Params<P>>) => Data | Promise<Data>
): LoadDef<Awaited<Data>, P>;
export function load(
	a: string | ((c: Ctx) => unknown),
	b?: (c: Ctx) => unknown
): LoadDef<unknown, string> {
	const pattern = typeof a === 'string' ? a : undefined;
	const run = (typeof a === 'string' ? b! : a) as (c: Ctx) => unknown;
	const fn = ((c: Ctx) => {
		const memo = memo_of(c);
		let p = memo.get(fn as LoadDef);
		if (!p) {
			p = Promise.resolve(run(c));
			memo.set(fn as LoadDef, p);
		}
		return p;
	}) as LoadDef<unknown, string>;
	(fn as { __ogload: boolean }).__ogload = true;
	(fn as { pattern: string | undefined }).pattern = pattern;
	(fn as { run: unknown }).run = run;
	return fn;
}

/** A form action def (symmetric with `load`): `action(fn)` / `action(pattern, fn)`. Returns
 *  `fail(...)` for validation, throws `redirect()` on success, or returns data for the `form` prop —
 *  Kit's action contract. `pattern` types `c.params`; `$infer` reads `Ret` into the `form` prop. */
export interface ActionDef<Ret = unknown, P extends string = string> {
	(c: Ctx): Ret | Promise<Ret>;
	readonly __ogaction: true;
	readonly pattern: P | undefined;
}

/** `action(fn)` / `action(pattern, fn)` — one form action. Called once on POST (no memoization). */
export function action<Ret>(run: (c: Ctx) => Ret | Promise<Ret>): ActionDef<Awaited<Ret>, string>;
export function action<Ret, P extends string>(
	pattern: P,
	run: (c: Ctx<Params<P>>) => Ret | Promise<Ret>
): ActionDef<Awaited<Ret>, P>;
export function action(
	a: string | ((c: Ctx) => unknown),
	b?: (c: Ctx) => unknown
): ActionDef<unknown, string> {
	const pattern = typeof a === 'string' ? a : undefined;
	const run = (typeof a === 'string' ? b! : a) as (c: Ctx) => unknown;
	const fn = ((c: Ctx) => run(c)) as ActionDef<unknown, string>;
	(fn as { __ogaction: boolean }).__ogaction = true;
	(fn as { pattern: string | undefined }).pattern = pattern;
	return fn;
}

/** Either load form `page()` / `layout()` accept: the `load()` value wrapper OR a bare typed fn. */
export type LoadInput = LoadDef | ((c: Ctx) => unknown);
export type ActionInput = ActionDef | ((c: Ctx) => unknown);

/** The `+page.server.ts`-shaped second argument to `page()`. Always an object (ruled). Route input is
 *  declared here (`params`/`search` schemas — coerced, typed into `c`, shown in `$infer`); `load` and
 *  `actions` are the behaviors (each a wrapper or a bare typed fn). Actions read `FormData` themselves
 *  (Kit-identical) — no action schema; typed mutation input is a `command` RF, not a form action. */
export interface PageServer {
	/** Coerce + validate path params (garbage → 404); `c.params` and `App['/p']['params']` = its output. */
	params?: StandardSchemaV1;
	/** Coerce + validate query (bad → 400, or lenient via `.default()`); `c.search` + `App['/p']['search']`. */
	search?: StandardSchemaV1;
	load?: LoadInput;
	actions?: Record<string, ActionInput>;
	/** PRERENDER param sets for a DYNAMIC pattern — Kit's per-route `entries` export. Each item
	 *  fills the pattern (`/posts/[id]` + `{ id: '1' }` → `/posts/1`) and joins the router's
	 *  `entries()` crawl list; a dynamic page without this is skipped (crawled or SSR'd live). */
	entries?: () => Array<Record<string, string>> | Promise<Array<Record<string, string>>>;
	/** FREEZE opt-in/out for this page — the programmatic twin of `export const freeze` in a
	 *  `+page.server.ts`. Cascades: page > innermost layout > … > `routes(table, { freeze })`;
	 *  undeclared everywhere = the vite config's `freeze.default`. Only makes the page ELIGIBLE —
	 *  observed purity still decides per render. */
	freeze?: boolean;
}

/** A page route def, generic over its layout chain / load / actions so `$infer` reads them. `L` is
 *  the OUTERMOST-first layout chain (empty = no chrome); the runtime prepends to it as `layout(...)()`
 *  wraps this entry's table. `Load`/`Actions` keep the AUTHORED form (wrapper or bare fn) for infer. */
export interface PageDef<
	L extends readonly LayoutDef[] = readonly LayoutDef[],
	Load = unknown,
	Actions = unknown,
	ParamsSchema = undefined,
	SearchSchema = undefined
> {
	readonly __ogkind: 'page';
	/** The page component, a per-request `ComponentPick` (`page(flag.pick({...}))`), or a
	 *  STREAMED page (`page(async function* (c, data) { … })` — see {@link StreamSlot});
	 *  the dispatcher resolves it with the ctx. */
	readonly component: AnyComponent | ComponentPick | StreamSlot;
	readonly load: LoadDef | undefined;
	readonly actions: Record<string, ActionDef> | undefined;
	readonly params_schema?: StandardSchemaV1;
	readonly search_schema?: StandardSchemaV1;
	/** a deferred page's loading placeholder — the component's reserved `ogygiaFallback` slot */
	readonly fallback?: AnyComponent;
	/** prerender param sets for a dynamic pattern — see {@link PageServer.entries} */
	readonly entries?: PageServer['entries'];
	/** declared FREEZE opt-in/out — see {@link PageServer.freeze} */
	readonly freeze?: boolean;
	readonly layouts: L;
	/** phantom — carries the authored load/actions/schema types to `$infer`; never read at runtime */
	readonly __types?: { load: Load; actions: Actions; params: ParamsSchema; search: SearchSchema };
}

/** Normalize a bare function to a memoized LoadDef; a `load()` wrapper passes through. */
export function to_load(input: LoadInput | undefined): LoadDef | undefined {
	if (!input) return undefined;
	if ((input as LoadDef).__ogload) return input as LoadDef;
	return load(input as (c: Ctx) => unknown);
}
/** Normalize a bare function to an ActionDef; an `action()` wrapper passes through. */
function to_action(input: ActionInput): ActionDef {
	if ((input as ActionDef).__ogaction) return input as ActionDef;
	return action(input as (c: Ctx) => unknown);
}

/** A page slot that resolved to RAW HTML (a mounted fragment document): rendered through
 *  ogygia's own pure-HTML region component — no bespoke page component. `css` tags and the
 *  (escaped) `title` join the DOCUMENT head. */
export interface PageHtmlView {
	__oghtml: true;
	html: string;
	css?: readonly string[];
	title?: string;
	/** Extra raw head markup (a mounted document's SEO/social meta — trusted federation). */
	head?: string;
	/** STATUS CHANNEL: `>= 400` becomes the response status — a mounted app's 404 page must
	 *  answer 404 THROUGH the shell (a 200-wrapped error page poisons caches and SEO). */
	status?: number;
}

/** THE page-slot primitive: a branded per-request resolver, run AFTER the branch's loads —
 *  returns the component to render, or a {@link PageHtmlView}. Everything else is sugar over
 *  this ONE shape: a bare component is the constant resolver, `experiment().pick()` is the
 *  single-arg public face (it ignores `data`), and `mount()` resolves its wire document out of
 *  `data` into an html view. Branded (not a bare function) because Svelte 5 components ARE
 *  functions. */
export interface PageSlotResolver {
	__ogpick: (c: Ctx, data: Record<string, unknown>) => unknown;
}

/** A STREAMED page slot: `page(async function* (c, data) { yield fast; yield await slow; })`.
 *  The first yield flushes with the document; later yields ride the SAME response as template
 *  chunks. Yield regions or HTML strings. Params are contravariant-friendly (`never`) so any
 *  authored `(c, data) => AsyncGenerator<…>` fits without ceremony. */
export type StreamSlot = (c: never, data: never) => AsyncGenerator<unknown, unknown, unknown>;

/** `page(Component)` / `page(Component, { params?, search?, load?, actions? })`. The second arg mirrors
 *  +page.server.ts; `params`/`search` are input schemas (typed into `c` + `$infer`), `load`/`actions`
 *  are behaviors (wrappers or bare typed functions — see {@link Load} / {@link Action}). The
 *  component slot also takes a `flag.pick()`, a {@link PageSlotResolver}, or a streamed-page
 *  generator ({@link StreamSlot}). */
export function page<S extends PageServer>(
	component: AnyComponent | ComponentPick | PageSlotResolver | StreamSlot,
	server?: S
): PageDef<readonly [], S['load'], S['actions'], S['params'], S['search']> {
	const actions = server?.actions
		? Object.fromEntries(Object.entries(server.actions).map(([k, v]) => [k, to_action(v)]))
		: undefined;
	return {
		__ogkind: 'page',
		component,
		load: to_load(server?.load),
		actions,
		params_schema: server?.params,
		search_schema: server?.search,
		entries: server?.entries,
		freeze: server?.freeze,
		layouts: []
	} as never;
}

// ── layouts ───────────────────────────────────────────────────────────────────────────────────────

/** A table of route defs — the value `routes()` and `layout(name, C)(...)` both take. A page is a
 *  `page(...)` value; an endpoint is a plain `{ GET, POST, … }` object (the `+server.ts` shape). */
export type RouteDef = AnyPageDef | Endpoint;
/** Any page def. Every PageDef parameter sits in a read-only (covariant) slot — `layouts`, and
 *  the phantom `__types` — so the widest of each is the type every page def is assignable to. */
export type AnyPageDef = PageDef<readonly LayoutDef[], unknown, unknown, unknown, unknown>;
export type RouteTable = Record<string, RouteDef>;
/** A table as `routes()` / `layout()` take it: any entries, checked by {@link KeyedTable} — which
 *  is what types each entry by its key. (The constraint itself stays shapeless: a handler signature
 *  here would be a second contextual type for every handler, and the two would cancel out.) */
export type TableShape = Record<string, object>;

/** A layout def, generic over its NAME and own LOAD (authored form) so `$infer` can key
 *  `App['(name)']` and merge its data into the chains that contain it. */
export interface LayoutDef<Name extends string = string, Load = unknown> {
	readonly __ogkind: 'layout';
	readonly name: Name;
	readonly component: AnyComponent;
	readonly load: LoadDef | undefined;
	readonly error?: AnyComponent;
	/** FREEZE opt-in/out for every page under this layout (a page's own value wins) */
	readonly freeze?: boolean;
	/** phantom — carries the authored load type to `$infer`; never read at runtime */
	readonly __loadType?: Load;
}

/** Prepend a layout to one entry's chain, preserving all generics (endpoints pass through). */
type WithLayout<D, Def extends LayoutDef> =
	D extends PageDef<infer L, infer Load, infer A, infer PS, infer SS>
		? PageDef<readonly [Def, ...L], Load, A, PS, SS>
		: D;

export interface LayoutFn<Def extends LayoutDef> {
	readonly __oglayout: Def;
	// `NoInfer`: spread into an outer table, this call's contextual type is that table's, still being
	// inferred — letting it feed `T` hands the inner handlers a half-inferred `c`. `T` comes from the
	// argument alone, where each key types its own entries.
	<const T extends KeyedTable<T>>(table: T): NoInfer<{ [K in keyof T]: WithLayout<T[K], Def> }>;
}

/** `layout(name, Component, { load?, error?, freeze? })` — a named table→table wrapper. Applying it PREPENDS
 *  this layout to every entry's chain and returns a table with the SAME KEYS, so `...admin({...})`
 *  spreads the tagged entries into the parent (a wrapped table nested in another accumulates the
 *  chain — Kit's nested layouts). `load` may be a `load()` wrapper or a bare typed fn. The name keys
 *  the layout's `{ data, children }` type as `App['(name)']`; duplicate names are a build error. */
export function layout<
	Name extends string,
	S extends { load?: LoadInput; error?: AnyComponent; freeze?: boolean }
>(name: Name, component: AnyComponent, opts?: S): LayoutFn<LayoutDef<Name, S['load']>> {
	const def: LayoutDef = {
		__ogkind: 'layout',
		name,
		component,
		load: to_load(opts?.load),
		error: opts?.error,
		freeze: opts?.freeze
	};
	const fn = (<T extends RouteTable>(table: T) => {
		const out = {} as Record<string, RouteDef>;
		for (const key in table) {
			const entry = table[key];
			out[key] = is_page(entry) ? { ...entry, layouts: [def, ...entry.layouts] } : entry; // endpoints have no chrome — never wrapped
		}
		return out;
	}) as LayoutFn<LayoutDef<Name, S['load']>>;
	(fn as { __oglayout: LayoutDef }).__oglayout = def;
	return fn;
}

// ── endpoints ─────────────────────────────────────────────────────────────────────────────────────

/** A verb entry produced by the `GET`/`POST`/… value wrappers — a handler plus (for body verbs) a
 *  body schema (`POST(schema, fn)`). Symmetric with `load()`/`action()`. `Out`/`In`/`P` are PHANTOM
 *  types for `$infer` + the typed `api()` client: a PLAIN return is the endpoint's JSON payload
 *  (finalize() serializes it), a `Response` return erases to `unknown`; `In` is the body schema's
 *  output; `P` the params the handler was typed with (its table key's, inside a table). */
export interface VerbEntry<Out = unknown, In = undefined, P = unknown> {
	readonly __ogverb: true;
	readonly handler: (c: Ctx) => unknown;
	readonly bodySchema?: StandardSchemaV1;
	/** phantom — never read at runtime */
	readonly __types?: { out: Out; in: In; params: P };
}

/** Params a handler sees with no table key to type them (a wrapper outside a table): indexable. */
type LooseParams = Record<string, string | undefined>;

/** One verb slot of an endpoint object, as `RouteTable` accepts it: any handler, or a verb wrapper.
 *  What a slot's `c` IS comes from its table key ({@link KeyedTable}). */
export type VerbSlot = ((c: never) => unknown) | VerbEntry<unknown, unknown, unknown>;

/** An endpoint route entry — the `+server.ts` shape, as an object of uppercase verb slots. Each verb
 *  is a bare handler or a verb wrapper. Distinguished from a page by having no `__ogkind`. */
export interface Endpoint {
	GET?: VerbSlot;
	DELETE?: VerbSlot;
	HEAD?: VerbSlot;
	OPTIONS?: VerbSlot;
	POST?: VerbSlot;
	PUT?: VerbSlot;
	PATCH?: VerbSlot;
}

/** The endpoint a table KEY types: every verb's `c.params` is that key's params, a bare handler's
 *  and a wrapper's alike (the wrapper takes them through its contextual return type). */
export type EndpointFor<K extends string> = {
	[V in (typeof VERBS)[number]]?: Handler<K> | VerbEntry<unknown, unknown, Params<K>>;
};

/** What `routes()` and `layout()` check a table against: each endpoint entry typed by its own key, so
 *  `'/posts/[id]': { GET: (c) => c.params.id }` reads a STRICT `id` and keeps its return type — no
 *  pattern restated. A page is the other member (its params come from its `params` schema).
 *
 *  It is the table's own CONSTRAINT (`<const T extends KeyedTable<T>>(table: T)`), never intersected
 *  with the table: the constraint depends on the keys alone, so it is a complete contextual type even
 *  while the entries are being inferred — a wrapper (`GET(fn)`, `when(gate, entry)`, a spread
 *  `layout()`) reads its key's params through it. No condition on an ENTRY here for the same reason:
 *  a type that waits on the entry gives its handlers no contextual type at all. */
export type KeyedTable<T> = {
	[K in keyof T]: EndpointFor<K & string> | AnyPageDef;
};

const VERBS = ['GET', 'DELETE', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH'] as const;

// ── verb value wrappers (exported; used INSIDE the endpoint object) ────────────────────────────────
const verb_entry = (handler: (c: Ctx) => unknown, bodySchema?: StandardSchemaV1): VerbEntry => ({
	__ogverb: true,
	handler,
	bodySchema
});

/** `GET(handler)` — a verb wrapper for a GET slot (no body, so no schema). Inside a table its
 *  `c.params` are the key's; a bare `{ GET: (c) => … }` is the same thing — the wrapper exists for
 *  symmetry with the body verbs. */
export function GET<P = LooseParams, R = unknown>(
	handler: (c: Ctx<P>) => R
): VerbEntry<Awaited<R>, undefined, P> {
	return verb_entry(handler as (c: Ctx) => unknown) as VerbEntry<Awaited<R>, undefined, P>;
}
/** `DELETE(handler)` — a verb wrapper for a DELETE slot (no body schema). */
export function DELETE<P = LooseParams, R = unknown>(
	handler: (c: Ctx<P>) => R
): VerbEntry<Awaited<R>, undefined, P> {
	return verb_entry(handler as (c: Ctx) => unknown) as VerbEntry<Awaited<R>, undefined, P>;
}
/** `POST(handler)` / `POST(bodySchema, handler)` — a POST slot. The schema validates the JSON body
 *  into `c.input` (400 on failure), like a `command` RF's typed argument. */
export function POST<P = LooseParams, R = unknown>(
	handler: (c: Ctx<P>) => R
): VerbEntry<Awaited<R>, undefined, P>;
export function POST<Sch extends StandardSchemaV1, P = LooseParams, R = unknown>(
	schema: Sch,
	handler: (c: Ctx<P, Record<string, string>, InferOutput<Sch>>) => R
): VerbEntry<Awaited<R>, InferOutput<Sch>, P>;
export function POST(a: unknown, b?: unknown): VerbEntry {
	return body_verb(a, b);
}
/** `PUT(handler)` / `PUT(bodySchema, handler)`. */
export function PUT<P = LooseParams, R = unknown>(
	handler: (c: Ctx<P>) => R
): VerbEntry<Awaited<R>, undefined, P>;
export function PUT<Sch extends StandardSchemaV1, P = LooseParams, R = unknown>(
	schema: Sch,
	handler: (c: Ctx<P, Record<string, string>, InferOutput<Sch>>) => R
): VerbEntry<Awaited<R>, InferOutput<Sch>, P>;
export function PUT(a: unknown, b?: unknown): VerbEntry {
	return body_verb(a, b);
}
/** `PATCH(handler)` / `PATCH(bodySchema, handler)`. */
export function PATCH<P = LooseParams, R = unknown>(
	handler: (c: Ctx<P>) => R
): VerbEntry<Awaited<R>, undefined, P>;
export function PATCH<Sch extends StandardSchemaV1, P = LooseParams, R = unknown>(
	schema: Sch,
	handler: (c: Ctx<P, Record<string, string>, InferOutput<Sch>>) => R
): VerbEntry<Awaited<R>, InferOutput<Sch>, P>;
export function PATCH(a: unknown, b?: unknown): VerbEntry {
	return body_verb(a, b);
}
function body_verb(a: unknown, b: unknown): VerbEntry {
	return b === undefined
		? verb_entry(a as (c: Ctx) => unknown)
		: verb_entry(b as (c: Ctx) => unknown, a as StandardSchemaV1);
}

/** Normalized runtime shape the dispatcher reads (built once by routes() from the Endpoint object). */
export interface MethodEntry {
	handler: (c: Ctx) => unknown;
	bodySchema?: StandardSchemaV1;
}
export interface EndpointDef {
	readonly __ogkind: 'endpoint';
	readonly methods: Map<string, MethodEntry>;
}

export const is_page = (d: unknown): d is PageDef => (d as PageDef).__ogkind === 'page';
/** An endpoint object: not a page, and carries at least one uppercase verb slot. */
export function is_endpoint_object(d: RouteDef): d is Endpoint {
	if (is_page(d) || typeof d !== 'object' || d === null) return false;
	return VERBS.some((v) => v in d);
}
/** Compile an `{ GET, POST, … }` endpoint object into the dispatcher's method map — a bare handler,
 *  or a `GET(...)`/`POST(...)` wrapper (unwrapped to its handler + optional body schema). */
export function compile_endpoint(ep: Endpoint): EndpointDef {
	const methods = new Map<string, MethodEntry>();
	for (const verb of VERBS) {
		const v = (ep as Record<string, unknown>)[verb];
		if (v == null) continue;
		if ((v as VerbEntry).__ogverb) {
			const e = v as VerbEntry;
			methods.set(verb, { handler: e.handler, bodySchema: e.bodySchema });
		} else {
			methods.set(verb, { handler: v as (c: Ctx) => unknown });
		}
	}
	return { __ogkind: 'endpoint', methods };
}
