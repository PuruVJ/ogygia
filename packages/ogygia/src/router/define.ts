/**
 * Router v2 value layer — the pieces you compose a table from. Every Kit routing concept is a VALUE
 * here, never a file convention: `load()` (a per-request-memoized data function), `page()` (a
 * component + its `+page.server.ts`-shaped `{ load, actions }`), `layout()` (a named table→table
 * wrapper — the component's `{ data, children }` + its own load + error boundary), and `get()`/verb
 * endpoints. `routes()` (router.ts) assembles them; `$infer` (infer.ts) types them. The design and
 * the Kit dictionary live in internal/notes/router-v2.md.
 */
import type { Component } from 'svelte';
import type { ComponentPick } from '../experiment.js';
import type { Ctx } from './ctx.js';
import type { Params } from './view.js';
import type { StandardSchemaV1 } from './view.js';

import type { InferOutput } from './view.js';

/** TYPE helper for a pulled-out or inline load — annotate a bare function so its `c` (and `c.params`)
 *  are typed without the `load()` value wrapper: `const l: Load<'/docs/[slug]'> = async (c) => …`.
 *  Pass it straight to `page(Comp, { load: l })`. Use the `load()` VALUE wrapper only when a load must
 *  be SHARED across loads (`await other(c)` — memoized per request). */
export type Load<P extends string = string> = (c: Ctx<Params<P>>) => unknown;
/** TYPE helper for a pulled-out or inline action (mirrors {@link Load}). */
export type Action<P extends string = string> = (c: Ctx<Params<P>>) => unknown;
/** TYPE helper for a pulled-out endpoint handler. `In` (a schema output) types `c.input` — the
 *  validated JSON body of a `POST`/`PUT`/`PATCH`. Verb-agnostic (the method doesn't change the ctx).
 *  Supply the pattern for typed params — `Handler<'/p/[id]'>` → `c.params.id`. A BARE handler in an
 *  endpoint object is key-driven by `routes()` (its params come from the table key), so it needs no
 *  pattern; this explicit form is for the pulled-out case and the `GET<'/p'>(fn)` wrappers. */
export type Handler<P extends string = string, In = undefined> = (
	c: Ctx<Params<P>, Record<string, string>, In>
) => unknown;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyComponent = Component<any>;

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
	/** The page component, or a per-request `ComponentPick` (`page(exp.pick({...}))`) — an
	 *  experiment/flag choosing between arms; the dispatcher resolves it with the ctx. */
	readonly component: AnyComponent | ComponentPick;
	readonly load: LoadDef | undefined;
	readonly actions: Record<string, ActionDef> | undefined;
	readonly params_schema?: StandardSchemaV1;
	readonly search_schema?: StandardSchemaV1;
	/** a deferred page's loading placeholder — the component's reserved `ogygiaFallback` slot */
	readonly fallback?: AnyComponent;
	/** prerender param sets for a dynamic pattern — see {@link PageServer.entries} */
	readonly entries?: PageServer['entries'];
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

/** `page(Component)` / `page(Component, { params?, search?, load?, actions? })`. The second arg mirrors
 *  +page.server.ts; `params`/`search` are input schemas (typed into `c` + `$infer`), `load`/`actions`
 *  are behaviors (wrappers or bare typed functions — see {@link Load} / {@link Action}). */
export function page<S extends PageServer>(
	component: AnyComponent | ComponentPick | PageSlotResolver,
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
		layouts: []
	} as never;
}

// ── layouts ───────────────────────────────────────────────────────────────────────────────────────

/** A table of route defs — the value `routes()` and `layout(name, C)(...)` both take. A page is a
 *  `page(...)` value; an endpoint is a plain `{ GET, POST, … }` object (the `+server.ts` shape). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteDef = PageDef<any, any, any, any, any> | Endpoint;
export type RouteTable = Record<string, RouteDef>;

/** A layout def, generic over its NAME and own LOAD (authored form) so `$infer` can key
 *  `App['(name)']` and merge its data into the chains that contain it. */
export interface LayoutDef<Name extends string = string, Load = unknown> {
	readonly __ogkind: 'layout';
	readonly name: Name;
	readonly component: AnyComponent;
	readonly load: LoadDef | undefined;
	readonly error?: AnyComponent;
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
	<const T extends RouteTable>(table: T): { [K in keyof T]: WithLayout<T[K], Def> };
}

/** `layout(name, Component, { load?, error? })` — a named table→table wrapper. Applying it PREPENDS
 *  this layout to every entry's chain and returns a table with the SAME KEYS, so `...admin({...})`
 *  spreads the tagged entries into the parent (a wrapped table nested in another accumulates the
 *  chain — Kit's nested layouts). `load` may be a `load()` wrapper or a bare typed fn. The name keys
 *  the layout's `{ data, children }` type as `App['(name)']`; duplicate names are a build error. */
export function layout<Name extends string, S extends { load?: LoadInput; error?: AnyComponent }>(
	name: Name,
	component: AnyComponent,
	opts?: S
): LayoutFn<LayoutDef<Name, S['load']>> {
	const def: LayoutDef = {
		__ogkind: 'layout',
		name,
		component,
		load: to_load(opts?.load),
		error: opts?.error
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
 *  body schema. Used as an endpoint object value in place of a bare handler when you want typed params
 *  (`GET<'/p'>(fn)`) or body validation (`POST(schema, fn)`). Symmetric with `load()`/`action()`.
 *  `Out`/`In` are PHANTOM types for `$infer` + the typed `api()` client: a PLAIN return is the
 *  endpoint's JSON payload (finalize() serializes it), a `Response` return erases to `unknown`;
 *  `In` is the body schema's output. */
export interface VerbEntry<Out = unknown, In = undefined> {
	readonly __ogverb: true;
	readonly handler: (c: Ctx) => unknown;
	readonly bodySchema?: StandardSchemaV1;
	/** phantom — never read at runtime */
	readonly __types?: { out: Out; in: In };
}

/** A bare endpoint handler. `c.params` is an INDEXABLE record — `c.params.id` reads without restating
 *  the pattern (loose: `string | undefined`); reach for the `GET<'/p'>(fn)` wrapper when you want it
 *  STRICT. Concrete (not a conditional/intersection) so contextual typing reliably types `c`. */
export type BareHandler = (
	c: Ctx<Record<string, string | undefined>, Record<string, string>, undefined>
) => unknown;

/** One verb slot of an endpoint object: a BARE handler (loose indexable params) OR a `GET(...)` /
 *  `POST(...)` wrapper (strict params via the pattern arg, or a body schema). */
export type VerbSlot = BareHandler | VerbEntry;

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

const VERBS = ['GET', 'DELETE', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH'] as const;

// ── verb value wrappers (exported; used INSIDE the endpoint object) ────────────────────────────────
const verb_entry = (handler: (c: Ctx) => unknown, bodySchema?: StandardSchemaV1): VerbEntry => ({
	__ogverb: true,
	handler,
	bodySchema
});

/** `GET(handler)` / `GET<'/p'>(handler)` — a verb wrapper for a GET slot: types `c.params` from the
 *  pattern arg. No body (GET has none), so no schema. Use as `{ GET: GET<'/p'>((c) => …) }`. */
export function GET<P extends string = string, R = unknown>(
	handler: (c: Ctx<Params<P>>) => R
): VerbEntry<Awaited<R>> {
	return verb_entry(handler as (c: Ctx) => unknown) as VerbEntry<Awaited<R>>;
}
/** `DELETE(handler)` — a verb wrapper for a DELETE slot (no body schema). */
export function DELETE<P extends string = string, R = unknown>(
	handler: (c: Ctx<Params<P>>) => R
): VerbEntry<Awaited<R>> {
	return verb_entry(handler as (c: Ctx) => unknown) as VerbEntry<Awaited<R>>;
}
/** `POST(handler)` / `POST(bodySchema, handler)` — a POST slot. The schema validates the JSON body
 *  into `c.input` (400 on failure), like a `command` RF's typed argument. */
export function POST<P extends string = string, R = unknown>(
	handler: (c: Ctx<Params<P>>) => R
): VerbEntry<Awaited<R>>;
export function POST<P extends string, Sch extends StandardSchemaV1, R = unknown>(
	schema: Sch,
	handler: (c: Ctx<Params<P>, Record<string, string>, InferOutput<Sch>>) => R
): VerbEntry<Awaited<R>, InferOutput<Sch>>;
export function POST(a: unknown, b?: unknown): VerbEntry {
	return b === undefined
		? verb_entry(a as (c: Ctx) => unknown)
		: verb_entry(b as (c: Ctx) => unknown, a as StandardSchemaV1);
}
/** `PUT(handler)` / `PUT(bodySchema, handler)`. */
export function PUT<P extends string = string, R = unknown>(
	handler: (c: Ctx<Params<P>>) => R
): VerbEntry<Awaited<R>>;
export function PUT<P extends string, Sch extends StandardSchemaV1, R = unknown>(
	schema: Sch,
	handler: (c: Ctx<Params<P>, Record<string, string>, InferOutput<Sch>>) => R
): VerbEntry<Awaited<R>, InferOutput<Sch>>;
export function PUT(a: unknown, b?: unknown): VerbEntry {
	return b === undefined
		? verb_entry(a as (c: Ctx) => unknown)
		: verb_entry(b as (c: Ctx) => unknown, a as StandardSchemaV1);
}
/** `PATCH(handler)` / `PATCH(bodySchema, handler)`. */
export function PATCH<P extends string = string>(handler: Handler<P>): VerbEntry;
export function PATCH<P extends string, Sch extends StandardSchemaV1>(
	schema: Sch,
	handler: Handler<P, InferOutput<Sch>>
): VerbEntry;
export function PATCH(a: unknown, b?: unknown): VerbEntry {
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
