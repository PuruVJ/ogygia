/**
 * The builder value layer for `ogygia/router`.
 *
 * A route table is a record of `pattern → (r) => …`, where `r` is a per-route builder carrying that
 * key's params (and the accumulated parent data) as TYPES. The callback shape is what makes the whole
 * thing typed with zero codegen:
 *
 *   - `r.page(Comp).load(fn).action(name, fn)` — a page (Kit's +page.svelte/.ts/.server.ts)
 *   - `r.layout(Comp).load(fn).routes({ … })`  — a layout layer (Kit's +layout.* + children)
 *   - `r.GET(fn).POST(fn)`                       — an endpoint (Kit's +server.ts)
 *   - `r.routes({ … })`                          — a transparent group (no chrome)
 *   - `r.mount(subRouter)`                       — delegate a subtree
 *
 * Each `.load()` captures its return type and threads it DOWN into children's `c.data` (the cascade,
 * Kit's implicit `parent()`), and the whole tree is collected UP into a path → { data, params, form }
 * map exposed as `router.$infer`. A component reads its props by indexing it: `Routes['/docs/[slug]']`.
 * See internal/notes/router.md and router-forms.md for the design.
 */
import type { Component } from 'svelte';
import type { RequestEvent } from '@sveltejs/kit';
import type { Params, StandardSchemaV1, InferOutput } from './view.js';

// ── small type utilities (all compile-time) ────────────────────────────────────────────────────
type Simplify<T> = { [K in keyof T]: T[K] } & {};
/** Union → intersection. Used to merge every child's map contribution into one flat map. */
type U2I<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
/** Concatenate a parent path with a child key. A `/` child is the parent's index route. */
type Join<Pre extends string, K extends string> = K extends '/'
	? Pre extends ''
		? '/'
		: Pre
	: `${Pre}${K}`;

// ── ctx — SvelteKit's load event, in object form ───────────────────────────────────────────────
export interface Ctx<
	P = Record<string, string | undefined>,
	D = Record<string, unknown>,
	I = undefined
> {
	/** Path params, typed from the route pattern. */
	params: Simplify<P>;
	/** Data cascaded DOWN the layer tree — every ancestor `load` merged, typed. Kit's `parent()`, free. */
	data: D;
	/** The validated input when a method declares a schema; else `undefined`. */
	input: I;
	url: URL;
	request: Request;
	/** The matched route pattern, e.g. `/docs/[slug]` (Kit's `route.id`). */
	route: { id: string };
	// Kit `RequestEvent` passthroughs — present when mounted in Kit (handle / catchall). `fetch` always
	// works (global fetch when standalone); the rest are undefined off-Kit.
	fetch: typeof fetch;
	cookies?: RequestEvent['cookies'];
	locals?: RequestEvent['locals'];
	setHeaders?: RequestEvent['setHeaders'];
	platform?: Readonly<RequestEvent['platform']>;
	/** The raw Kit event, when mounted in Kit. */
	event?: RequestEvent;
	/** JSON response (default: application/json, cache-control: no-store). */
	json(data: unknown, init?: ResponseInit): Response;
	/** Redirect response (default 303). */
	redirect(location: string, status?: number): Response;
	/** Plain-text response. */
	text(body: string, init?: ResponseInit): Response;
	/** An error Response (Kit's `error()`), returned from a load/handler to short-circuit. */
	error(status: number, message?: string): Response;
	/** A rename-safe URL to a route in this router: `c.href('/report/[id]', { id })`. */
	href(pattern: string, params?: Record<string, string | number>): string;
	/** A per-request scratch bag for one request's own bookkeeping. */
	state: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any>;
// A load returns its data, OR a `Response` (Kit-style redirect/error, short-circuits the render), OR
// nothing. Only the data part feeds `R` — Response/void are stripped so they never pollute the cascade.
type Load<P, D, R> = (c: Ctx<P, D>) => R | Response | void | Promise<R | Response | void>;
type Handler<P = Record<string, string | undefined>, D = Record<string, unknown>, I = undefined> = (
	c: Ctx<P, D, I>
) => unknown;

/** Page-level options (a subset of Kit's `+page` module exports). */
export interface PageOpts {
	prerender?: boolean | 'auto';
	trailingSlash?: 'ignore' | 'never' | 'always';
	title?: string;
	status?: number;
	headers?: HeadersInit;
	cache?: false | { maxAge?: number; swr?: number; private?: boolean };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	config?: any;
}

// ── the builder types (proven surface — see the integration probe) ─────────────────────────────

/** A page builder. Chains `.load` / `.action` / `.layout` (reset) / `.set` / `.guard`. Carries its
 *  full Path, the cascade-in D, the component's Data (D ⊕ its loads) and the Form (action returns). */
export interface PageB<P, DIn, Path extends string, Data, Form> {
	readonly __page?: [Path, Data, Form];
	load<R extends Record<string, unknown>>(
		fn: Load<P, DIn, R>
	): PageB<P, DIn, Path, Simplify<DIn & R>, Form>;
	action<FR>(name: string, fn: (c: Ctx<P, Data>) => FR | Promise<FR>): PageB<P, DIn, Path, Data, Form | FR>;
	action<FR>(fn: (c: Ctx<P, Data>) => FR | Promise<FR>): PageB<P, DIn, Path, Data, Form | FR>;
	/** Break out of the inherited layout chain — `false` for no chrome, or an ancestor layout to reset up to. */
	layout(reset: AnyComponent | false): PageB<P, DIn, Path, Data, Form>;
	set(o: PageOpts): PageB<P, DIn, Path, Data, Form>;
}

/** An endpoint builder (Kit's +server.ts). Verbs are UPPERCASE to match Kit's exports; each takes
 *  `(handler)` or `(schema, handler)`. `D` is the cascaded data so `c.data` is typed in endpoints too. */
export interface EndpointB<P, D, Path extends string, Form> {
	readonly __end?: [Path, Form];
	GET<FR>(fn: (c: Ctx<P, D>) => FR | Promise<FR>): EndpointB<P, D, Path, Form | FR>;
	GET<S extends StandardSchemaV1, FR>(
		schema: S,
		fn: (c: Ctx<P, D, InferOutput<S>>) => FR | Promise<FR>
	): EndpointB<P, D, Path, Form | FR>;
	POST<FR>(fn: (c: Ctx<P, D>) => FR | Promise<FR>): EndpointB<P, D, Path, Form | FR>;
	POST<S extends StandardSchemaV1, FR>(
		schema: S,
		fn: (c: Ctx<P, D, InferOutput<S>>) => FR | Promise<FR>
	): EndpointB<P, D, Path, Form | FR>;
	PUT<FR>(fn: (c: Ctx<P, D>) => FR | Promise<FR>): EndpointB<P, D, Path, Form | FR>;
	PATCH<FR>(fn: (c: Ctx<P, D>) => FR | Promise<FR>): EndpointB<P, D, Path, Form | FR>;
	DELETE<FR>(fn: (c: Ctx<P, D>) => FR | Promise<FR>): EndpointB<P, D, Path, Form | FR>;
	OPTIONS<FR>(fn: (c: Ctx<P, D>) => FR | Promise<FR>): EndpointB<P, D, Path, Form | FR>;
}

/** The per-route builder handed to every `(r) => …` callback. Layer methods keep chaining on `r`;
 *  `.page`/`.GET`/`.mount` branch to a leaf; `.routes` finalizes a layer and collects the child map. */
export interface R<AllP, D, Path extends string> {
	// `page` takes a bare `AnyComponent` (NOT generic over the component) on purpose: the returned
	// PageB doesn't reference the component's props, so `router.$infer` stays independent of them. That
	// is what lets a component type its props as `Routes['/path']` without a component→router→component
	// type cycle. The load↔component `data` check is done the other way (a component declares its need).
	//
	// The page renders as MARKUP (`<Page {...} />`), so any import-attribute mark on the component —
	// `with { wake }`, `with { render: 'deferred' }`, `with { region: 'raw' }`, `with { keep }` — emits
	// its shell exactly as it would anywhere else. Per-page interactivity/deferral lives on the import.
	//
	// `opts.fallback` is the loading placeholder for a DEFERRED page — the router provides it as the
	// component's reserved `ogygiaFallback` slot (a deferred page can't hold its own, since it's the
	// hole). Ignored by a non-deferred page.
	page(c: AnyComponent, opts?: { fallback?: AnyComponent }): PageB<AllP, D, Path, D, never>;
	/** Set this layer's chrome (renders `{@render children()}`); keep chaining `.load`/`.routes`. */
	layout(c: AnyComponent): R<AllP, D, Path>;
	load<Rr extends Record<string, unknown>>(fn: Load<AllP, D, Rr>): R<AllP, Simplify<D & Rr>, Path>;
	/** This layer's error component (Kit's +error.svelte). */
	error(c: AnyComponent): R<AllP, D, Path>;
	GET<FR>(fn: (c: Ctx<AllP, D>) => FR | Promise<FR>): EndpointB<AllP, D, Path, FR>;
	GET<S extends StandardSchemaV1, FR>(
		schema: S,
		fn: (c: Ctx<AllP, D, InferOutput<S>>) => FR | Promise<FR>
	): EndpointB<AllP, D, Path, FR>;
	POST<FR>(fn: (c: Ctx<AllP, D>) => FR | Promise<FR>): EndpointB<AllP, D, Path, FR>;
	POST<S extends StandardSchemaV1, FR>(
		schema: S,
		fn: (c: Ctx<AllP, D, InferOutput<S>>) => FR | Promise<FR>
	): EndpointB<AllP, D, Path, FR>;
	PUT<FR>(fn: (c: Ctx<AllP, D>) => FR | Promise<FR>): EndpointB<AllP, D, Path, FR>;
	PATCH<FR>(fn: (c: Ctx<AllP, D>) => FR | Promise<FR>): EndpointB<AllP, D, Path, FR>;
	DELETE<FR>(fn: (c: Ctx<AllP, D>) => FR | Promise<FR>): EndpointB<AllP, D, Path, FR>;
	routes<T extends Record<string, unknown>>(t: {
		[K in keyof T & string]: (r: R<Simplify<AllP & Params<K>>, D, Join<Path, K>>) => T[K];
	}): U2I<{ [K in keyof T & string]: Contribution<T[K]> }[keyof T & string]>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	// oxlint-disable-next-line no-explicit-any -- accepts a router of ANY route map (M is invariant).
	mount(router: Router<any>): Record<string, never>;
}

/** One route callback's contribution to the `$infer` map: a page/endpoint keyed at its full path, or
 *  a nested layer/group's already-collected map (passed through). */
export type Contribution<E> =
	E extends PageB<infer P, infer _D, infer Path, infer Data, infer Form>
		? { [K in Path]: { data: Data; params: Simplify<P>; form: [Form] extends [never] ? null : Form } }
		: E extends EndpointB<infer P2, infer _D2, infer Path2, infer Form2>
			? { [K in Path2]: { data: Record<string, never>; params: Simplify<P2>; form: Form2 } }
			: E; // nested layer/group: already a collected map

// ── runtime node tree ──────────────────────────────────────────────────────────────────────────
type Fn = (c: Ctx) => unknown;
export interface MethodEntry {
	handler: Fn;
	schema?: StandardSchemaV1;
}
export interface PageNode {
	t: 'page';
	component: AnyComponent;
	load?: Fn;
	actions: Map<string | null, Fn>;
	reset?: AnyComponent | false;
	opts: PageOpts;
	/** Loading placeholder for a deferred page — provided to the component as its `ogygiaFallback` slot. */
	fallback?: AnyComponent;
}
export interface EndpointNode {
	t: 'endpoint';
	methods: Map<string, MethodEntry>;
}
export interface LayerNode {
	t: 'layer';
	layout?: AnyComponent;
	load?: Fn;
	error?: AnyComponent;
	children: Array<[string, AnyNode]>;
}
export interface MountNode {
	t: 'mount';
	// oxlint-disable-next-line no-explicit-any -- a mount holds a router of ANY route map; M is invariant, so no concrete type accepts them all, and it's erased at runtime.
	router: Router<any>;
}
export type AnyNode = PageNode | EndpointNode | LayerNode | MountNode;

/** A leaf's flattened ancestor layer (chrome + data + error). */
export interface Layer {
	layout?: AnyComponent;
	load?: Fn;
	error?: AnyComponent;
}
/** One matchable route: full pattern, its ancestor layer chain, and the leaf node. */
export interface LeafRoute {
	pattern: string;
	layers: Layer[];
	node: PageNode | EndpointNode | MountNode;
}

// UPPERCASE to match Kit's +server.ts exports — the method name IS the HTTP method.
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
// A builder holder carries its runtime node under `__node`; the builder TYPES are phantom, so every
// method casts through `unknown` at the return. This is the single seam between the two views.
interface Holder {
	__node: AnyNode;
}
const node_of = (v: unknown): AnyNode => (v as Holder).__node;

function make_page(component: AnyComponent, opts?: { fallback?: AnyComponent }): unknown {
	const node: PageNode = {
		t: 'page',
		component,
		load: undefined,
		actions: new Map(),
		reset: undefined,
		opts: {},
		...(opts?.fallback ? { fallback: opts.fallback } : {})
	};
	const p = {
		__node: node,
		load(fn: Fn) {
			node.load = fn;
			return p;
		},
		action(a: string | Fn, b?: Fn) {
			if (typeof a === 'function') node.actions.set(null, a);
			else node.actions.set(a, b as Fn);
			return p;
		},
		layout(reset: AnyComponent | false) {
			node.reset = reset;
			return p;
		},
		set(o: PageOpts) {
			Object.assign(node.opts, o);
			return p;
		}
	};
	return p;
}

function make_endpoint(): { __node: EndpointNode } & Record<string, unknown> {
	const node: EndpointNode = { t: 'endpoint', methods: new Map() };
	const e: { __node: EndpointNode } & Record<string, unknown> = { __node: node };
	for (const verb of VERBS) {
		e[verb] = (a: Fn | StandardSchemaV1, b?: Fn) => {
			node.methods.set(
				verb,
				typeof a === 'function' ? { handler: a } : { handler: b as Fn, schema: a }
			);
			return e;
		};
	}
	return e;
}

function make_builder(): unknown {
	const layer: LayerNode = {
		t: 'layer',
		layout: undefined,
		load: undefined,
		error: undefined,
		children: []
	};
	const r: Record<string, unknown> & { __node: AnyNode } = {
		__node: layer,
		layout(c: AnyComponent) {
			layer.layout = c;
			return r;
		},
		load(fn: Fn) {
			layer.load = fn;
			return r;
		},
		error(c: AnyComponent) {
			layer.error = c;
			return r;
		},
		page: (c: AnyComponent, opts?: { fallback?: AnyComponent }) => make_page(c, opts),
		mount(router: Router<unknown>) {
			r.__node = { t: 'mount', router } as MountNode;
			return r;
		},
		routes(table: Record<string, (r: unknown) => unknown>) {
			for (const [pattern, fn] of Object.entries(table)) {
				const child = make_builder();
				const res = fn(child);
				layer.children.push([pattern, node_of(res ?? child)]);
			}
			return r;
		}
	};
	for (const verb of VERBS) {
		r[verb] = (a: Fn | StandardSchemaV1, b?: Fn) => {
			const e = make_endpoint();
			(e[verb] as (a: Fn | StandardSchemaV1, b?: Fn) => unknown)(a, b);
			return e;
		};
	}
	return r;
}

/** Join a parent path with a child key (runtime mirror of the `Join` type). */
export function join_path(pre: string, key: string): string {
	if (key === '/') return pre === '' ? '/' : pre;
	return pre + key;
}

/** Walk a built node tree into a flat list of matchable leaf routes, each carrying its ancestor layers. */
function flatten(node: AnyNode, prefix: string, layers: Layer[]): LeafRoute[] {
	if (node.t === 'layer') {
		const mine: Layer = {
			layout: node.layout,
			load: node.load,
			error: node.error
		};
		const next = [...layers, mine];
		const out: LeafRoute[] = [];
		for (const [key, child] of node.children) {
			out.push(...flatten(child, join_path(prefix, key), next));
		}
		return out;
	}
	return [{ pattern: prefix || '/', layers, node }];
}

/** Run a route-tree builder and flatten it. Called once at `routes()` construction. */
export function build_routes(build: (r: unknown) => unknown): LeafRoute[] {
	const r = make_builder();
	const res = build(r);
	return flatten(node_of(res ?? r), '', []);
}

// ── the Router value ───────────────────────────────────────────────────────────────────────────
import type { Handle } from '@sveltejs/kit';
export interface Router<M = Record<string, unknown>> {
	readonly __ogrouter: true;
	/** Phantom: the whole route tree as `path → { data, params, form }`. Read via `typeof router.$infer`. */
	readonly $infer: M;
	handle: Handle;
	fetch(request: Request, event?: RequestEvent): Promise<Response | null>;
	match(pathname: string): { pattern: string; params: Record<string, string | undefined> } | null;
	href<K extends keyof M & string>(
		pattern: K,
		...args: {} extends Params<K> ? [params?: Record<string, string | number>] : [params: Record<string, string | number>]
	): string;
	entries(): Promise<Array<{ path: string }>>;
}

/** The public `routes()` signature — a `(r) => …` builder callback in, a typed Router out. */
export type RoutesFn = <E>(build: (r: R<Record<never, never>, Record<never, never>, ''>) => E) => Router<
	Contribution<E>
>;

export type { AnyComponent };
