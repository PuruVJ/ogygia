/**
 * `routes(table, opts?)` — the router. A flat table of `pattern → page()/get()` values (layout chains
 * ride on each page entry via `layout(...)()`); at construction we compile the keys into a match
 * table. A request matches one entry, runs its branch loads CONCURRENTLY (memoized — see load()),
 * merges their data (Kit's cascade), then renders the page through its layout chain via `document()`,
 * or runs the endpoint. Control flow is the throwable `redirect`/`error` and returnable `fail`
 * (respond.ts). The whole table is exposed as a typed `$infer` map. See internal/notes/router-v2.md.
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { Component } from 'svelte';
import { document } from '../document.js';
import { region } from '../region.js';
import LayoutChain from './LayoutChain.svelte';
import { compile_all, match_path, type CompiledPattern } from './match.js';
import { make_ctx, type Ctx } from './ctx.js';
import {
	compile_endpoint,
	is_page,
	to_load,
	type AnyComponent,
	type Endpoint,
	type EndpointDef,
	type LoadDef,
	type LoadInput,
	type PageDef,
	type RouteTable
} from './define.js';
import type { InferMap } from './infer.js';
import type { StandardSchemaV1, HrefArgs } from './view.js';
import {
	finalize,
	is_action_failure,
	is_http_error,
	is_redirect,
	json_response,
	method_not_allowed,
	not_found,
	options_response,
	redirect_response
} from './respond.js';
import { router_css_head } from './css-head.js';

export interface RoutesOptions {
	/** Mount prefix, stripped before matching. Required for a library that owns a subtree. */
	base?: string;
	/** Trailing-slash policy. 'ignore' (default) matches both; 'never'/'always' 308-canonicalize. */
	slash?: 'ignore' | 'never' | 'always';
	/** Response for an unmatched path UNDER `base` (default: 404). Ignored without `base`. */
	miss?: (c: Ctx) => unknown;
	/** Root error boundary component (Kit's top `+error.svelte`) for thrown `error()` with no nearer
	 *  layout boundary. */
	error?: AnyComponent;
	/** A table-wide load run before EVERY route (pages and endpoints) — Kit's root `+layout.server.ts`
	 *  load without a component. The place for a guard with no shared chrome: it throws
	 *  `redirect`/`error` to gate, and its returned data merges into every page's `data` (outermost). */
	load?: LoadInput;
}

/** The router value. `$infer` is a type-only phantom read as `typeof app.$infer`. */
export interface Router<T extends RouteTable = RouteTable> {
	readonly __ogrouter: true;
	/** `(request) => Response | null` — null on no-match (a catchall 404s its own way). */
	fetch(request: Request, event?: RequestEvent): Promise<Response | null>;
	/** Kit handle: dispatches, else falls through to the rest of the app. */
	handle(input: {
		event: RequestEvent;
		resolve: (e: RequestEvent) => Response | Promise<Response>;
	}): Promise<Response>;
	/** Rename-safe URL to a route in this table. */
	href<P extends keyof T & string>(pattern: P, ...args: HrefArgs<P>): string;
	/** The catchall crawl list (static page routes) — `export const entries = app.entries`. */
	entries(): Promise<Array<{ path: string }>>;
	/** Type-only phantom map: `export type App = typeof app.$infer`. */
	readonly $infer: InferMap<T>;
}

interface Leaf {
	pattern: string;
	/** a page value, or an endpoint object compiled to its method map at construction */
	def: PageDef | EndpointDef;
}

const HEAD_AS_GET = (m: string) => (m === 'HEAD' ? 'GET' : m);

export function routes<const T extends RouteTable>(table: T, opts: RoutesOptions = {}): Router<T> {
	const base = (opts.base ?? '').replace(/\/$/, '');
	const slash = opts.slash ?? 'ignore';
	const root_load = to_load(opts.load);

	// Validate layout-name uniqueness across the whole table (a layout is keyed by name in `$infer`).
	const seen_layout = new Map<string, AnyComponent>();
	for (const key in table) {
		const def = table[key];
		if (is_page(def)) {
			for (const l of def.layouts) {
				const prev = seen_layout.get(l.name);
				if (prev && prev !== l.component)
					throw new Error(
						`[ogygia/router] two different layouts share the name ${JSON.stringify(l.name)} — names must be unique (they key App['(name)']).`
					);
				seen_layout.set(l.name, l.component);
			}
		}
	}

	const leaves: Leaf[] = Object.keys(table).map((pattern) => {
		const raw = table[pattern];
		// Endpoint objects (`{ GET, POST, … }`) compile to their method map once here; pages pass through.
		return { pattern, def: is_page(raw) ? raw : compile_endpoint(raw as Endpoint) };
	});
	const compiled: CompiledPattern[] = compile_all(leaves.map((l) => l.pattern));
	const by_pattern = new Map(leaves.map((l) => [l.pattern, l]));

	const href_fn = (pattern: string, params?: Record<string, string | number>) =>
		base + fill(pattern, params ?? {});

	async function dispatch(request: Request, event?: RequestEvent): Promise<Response | null> {
		const url = new URL(request.url);
		let path = url.pathname;
		if (base) {
			if (path === base) path = '/';
			else if (path.startsWith(base + '/')) path = path.slice(base.length);
			else return null; // not under our base → not ours
		}

		const canon = canonical_slash(path, slash);
		if (canon)
			return new Response(null, { status: 308, headers: { location: base + canon + url.search } });

		const hit = match_path(compiled, path);
		if (!hit) {
			if (base && opts.miss) {
				const ctx = make_ctx({}, url, request, event, href_fn, '');
				try {
					return finalize(await opts.miss(ctx));
				} catch (thrown) {
					if (is_redirect(thrown)) return redirect_response(thrown.status, thrown.location);
					if (is_http_error(thrown))
						return json_response(
							{ error: thrown.message, status: thrown.status },
							{ status: thrown.status }
						);
					throw thrown;
				}
			}
			if (base) return not_found();
			return null; // no base → fall through to the rest of the app
		}

		const leaf = by_pattern.get(hit.pattern)!;
		const ctx = make_ctx(hit.params, url, request, event, href_fn, hit.pattern);

		try {
			// Table-wide load (the no-chrome guard) runs before every route, gating endpoints too. A
			// load may return a Response to short-circuit (a guard's redirect/deny) — v1 parity.
			if (root_load) {
				const rl = await root_load(ctx);
				if (rl instanceof Response) return rl;
			}
			if ((leaf.def as { __ogkind?: string }).__ogkind === 'endpoint')
				return await run_endpoint(leaf.def as EndpointDef, ctx, request.method);
			return await render_page(leaf.def as PageDef, ctx, request.method, url);
		} catch (thrown) {
			return handle_thrown(thrown, leaf.def, ctx);
		}
	}

	async function render_page(node: PageDef, ctx: Ctx, method: string, url: URL): Promise<Response> {
		const m = HEAD_AS_GET(method);

		// Route input: coerce/validate path params (bad → 404) and query (bad → 400) into typed ctx.
		if (node.params_schema) {
			const v = await validate(node.params_schema, ctx.params);
			if (v.issues) return not_found();
			(ctx as { params: unknown }).params = v.value;
		}
		if (node.search_schema) {
			const v = await validate(node.search_schema, ctx.search);
			if (v.issues)
				return json_response({ error: 'Invalid query', issues: v.issues }, { status: 400 });
			(ctx as { search: unknown }).search = v.value;
		}

		let form: unknown;
		let status = 200;

		if (m === 'POST') {
			const act = pick_action(node, url);
			if (!act) return method_not_allowed(page_allow(node));
			const out = await act(ctx); // throws redirect/error caught by dispatch's try
			if (out instanceof Response) return out;
			if (is_action_failure(out)) {
				form = out.data;
				status = out.status;
			} else {
				form = out ?? undefined;
			}
		} else if (m !== 'GET') {
			if (method === 'OPTIONS') return options_response(page_allow(node));
			return method_not_allowed(page_allow(node));
		}

		// Branch loads: the table-wide root load, then every layout's (outermost→inner), then the page's
		// — CONCURRENTLY. Each is memoized on ctx (root_load already ran in dispatch, so it's a cache
		// hit here), merged into `data` in branch order (last wins).
		const load_defs: (LoadDef | undefined)[] = [
			root_load,
			...node.layouts.map((l) => l.load),
			node.load
		];
		const results = await Promise.all(load_defs.map((l) => (l ? l(ctx) : undefined)));
		const data: Record<string, unknown> = {};
		for (const r of results) {
			if (r instanceof Response) return r; // a load may short-circuit (redirect / custom response)
			if (r && typeof r === 'object') Object.assign(data, r);
		}

		const chain = node.layouts.map((l) => l.component);
		const of = region(LayoutChain as never, {
			chain,
			component: node.component,
			props: { data, form, params: ctx.params },
			data,
			fallback: node.fallback
		});
		const css_head = await router_css_head([...chain, node.component]);
		const res = await document(of, {
			status,
			head: css_head,
			pageState: {
				url: ctx.url,
				params: ctx.params,
				route: { id: ctx.route.id || null },
				status,
				data,
				form
			}
		});
		return method === 'HEAD' ? new Response(null, res) : res;
	}

	// A thrown redirect/error/fail from a load, action, or handler. redirect → 303/…; error →
	// nearest layout boundary component (or root `opts.error`), else JSON; anything else re-throws.
	async function handle_thrown(
		thrown: unknown,
		def: PageDef | EndpointDef,
		ctx: Ctx
	): Promise<Response> {
		if (is_redirect(thrown)) return redirect_response(thrown.status, thrown.location);
		if (is_action_failure(thrown)) return json_response(thrown.data, { status: thrown.status });
		if (!is_http_error(thrown)) throw thrown;

		const { status, message } = thrown;
		// Endpoints (and pages with no boundary) → JSON error.
		if ((def as { __ogkind?: string }).__ogkind === 'endpoint')
			return json_response({ error: message, status }, { status });
		const pnode = def as PageDef;

		// Nearest layout error boundary at/above the page, keeping the chrome ABOVE it. Layout loads run
		// concurrently, so we can't know WHICH layer failed — render the innermost boundary with all
		// chrome outside it (Kit's page-load-failed shape; a layout-load failure degrades to the same).
		let boundary = -1;
		for (let i = pnode.layouts.length - 1; i >= 0; i--) {
			if (pnode.layouts[i].error) {
				boundary = i;
				break;
			}
		}
		const err_component = boundary >= 0 ? pnode.layouts[boundary].error! : opts.error;
		if (!err_component) return json_response({ error: message, status }, { status });

		const chrome = boundary >= 0 ? pnode.layouts.slice(0, boundary).map((l) => l.component) : [];
		const of = region(LayoutChain as never, {
			chain: chrome,
			component: err_component,
			props: { status, error: { message }, data: {}, params: ctx.params },
			data: {}
		});
		const css_head = await router_css_head([...chrome, err_component]);
		return document(of, {
			status,
			head: css_head,
			pageState: {
				url: ctx.url,
				params: ctx.params,
				route: { id: ctx.route.id || null },
				status,
				data: {},
				error: { message }
			}
		});
	}

	const self: Router<T> = {
		__ogrouter: true,
		fetch: dispatch,
		handle: async ({ event, resolve }) => {
			const r = await dispatch(event.request, event);
			return r ?? resolve(event);
		},
		href: ((pattern: string, params?: Record<string, string | number>) =>
			href_fn(pattern, params)) as Router<T>['href'],
		async entries() {
			const out: Array<{ path: string }> = [];
			for (const leaf of leaves) {
				if (is_page(leaf.def) && !leaf.pattern.includes('['))
					out.push({ path: base + leaf.pattern });
			}
			return out;
		},
		get $infer(): never {
			throw new Error('router.$infer is a type-only phantom — read `typeof app.$infer`.');
		}
	};
	return self;
}

// ── endpoints ─────────────────────────────────────────────────────────────────────────────────────
async function run_endpoint(node: EndpointDef, ctx: Ctx, method: string): Promise<Response> {
	const m = HEAD_AS_GET(method);
	const allow = [...node.methods.keys()];
	if (method === 'OPTIONS' && !node.methods.has('OPTIONS')) return options_response(allow);
	const e = node.methods.get(m);
	if (!e) return method_not_allowed(allow);
	// Body schema (POST/PUT/PATCH): validate the parsed JSON body → typed `c.input` (400 on failure).
	// Path params stay on `c.params`; query on `c.search`/`c.url` — three clean surfaces, no grab-bag.
	if (e.bodySchema) {
		let body: unknown = undefined;
		const ct = ctx.request.headers.get('content-type') ?? '';
		if (ct.includes('application/json')) {
			try {
				body = await ctx.request.clone().json();
			} catch {
				return json_response({ error: 'Invalid JSON body' }, { status: 400 });
			}
		}
		const v = await validate(e.bodySchema, body);
		if (v.issues)
			return json_response({ error: 'Invalid body', issues: v.issues }, { status: 400 });
		(ctx as { input: unknown }).input = v.value;
	}
	return finalize(await e.handler(ctx));
}

/** Run a Standard Schema; issues normalized to `{ message, path }[]`. */
async function validate(
	schema: StandardSchemaV1,
	input: unknown
): Promise<
	{ value: unknown; issues?: undefined } | { issues: Array<{ message: string; path?: unknown }> }
> {
	const r = await schema['~standard'].validate(input);
	if (r.issues) return { issues: r.issues.map((i) => ({ message: i.message, path: i.path })) };
	return { value: r.value };
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
const TRAILING_SLASH = /\/+$/;
function canonical_slash(path: string, mode: 'ignore' | 'never' | 'always'): string | null {
	if (mode === 'ignore' || path === '/') return null;
	const has = path.endsWith('/');
	if (mode === 'never' && has) return path.replace(TRAILING_SLASH, '') || '/';
	if (mode === 'always' && !has) return path + '/';
	return null;
}

function pick_action(node: PageDef, url: URL): ((c: Ctx) => unknown) | undefined {
	const actions = node.actions;
	if (!actions) return undefined;
	for (const key of url.searchParams.keys()) {
		if (key.startsWith('/')) {
			const named = actions[key.slice(1)];
			if (named) return named;
		}
	}
	return actions.default;
}
function page_allow(node: PageDef): string[] {
	const a = ['GET', 'HEAD'];
	if (node.actions && Object.keys(node.actions).length) a.push('POST');
	return a;
}

const fill_token = /\[(\.\.\.)?\[?([a-zA-Z_$][\w$]*)\]?\]/g;
function fill(pattern: string, params: Record<string, string | number>): string {
	return pattern.replace(fill_token, (_m, _rest, name: string) => {
		const val = params[name];
		return val == null ? '' : encodeURIComponent(String(val));
	});
}

// re-export the component type so LayoutChain's props stay in one vocabulary
export type { Component };
