/**
 * `routes((r) => …)` — the router. The builder callback constructs a node tree (see builder.ts); at
 * construction we flatten it into matchable leaf routes, each carrying its ancestor layer chain. A
 * request matches one leaf, runs its layers top-down (guards + data cascade), then the leaf (a page
 * rendered through its layout chain, or an endpoint). One `document()` per page render; API routes
 * never get chrome. The whole tree is exposed as a typed `$infer` map.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { document } from '../document.js';
import { region } from '../region.js';
import LayoutChain from './LayoutChain.svelte';
import { compile_all, match_path, type CompiledPattern } from './match.js';
import {
	build_routes,
	type AnyComponent,
	type Contribution,
	type Ctx,
	type EndpointNode,
	type LeafRoute,
	type PageNode,
	type PageOpts,
	type R,
	type Router
} from './builder.js';
import type { StandardSchemaV1 } from './view.js';
import type { Layer } from './builder.js';

/** c.error() Responses are registered here with their { status, message } so the router can render the
 *  nearest error component instead of sending the JSON. A WeakMap → the tag is GC'd with the Response. */
const error_meta = new WeakMap<Response, { status: number; message?: string }>();

export interface RoutesOptions {
	/** Mount prefix, stripped before matching. Required for a library that owns a subtree. */
	base?: string;
	/** Trailing-slash policy. 'ignore' (default) matches both; 'never'/'always' 308-canonicalize. */
	slash?: 'ignore' | 'never' | 'always';
	/** Response for an unmatched path UNDER `base` (default: a 404). Ignored without `base`. */
	miss?: (ctx: Ctx) => unknown;
}

export type { Router } from './builder.js';

const HEAD_AS_GET = (m: string) => (m === 'HEAD' ? 'GET' : m);

/** Build a router from a `(r) => …` route-tree builder. */
export function routes<E>(
	build: (r: R<Record<never, never>, Record<never, never>, ''>) => E,
	opts: RoutesOptions = {}
): Router<Contribution<E>> {
	const base = (opts.base ?? '').replace(/\/$/, '');
	const slash = opts.slash ?? 'ignore';
	const miss = opts.miss;

	const leaves = build_routes(build as unknown as (r: unknown) => unknown);

	// Mount nodes delegate by prefix; everything else compiles into one match table.
	const subs: Array<{ prefix: string; router: Router }> = [];
	const matchable: LeafRoute[] = [];
	for (const leaf of leaves) {
		if (leaf.node.t === 'mount') {
			subs.push({ prefix: leaf.pattern.replace(/\/$/, ''), router: leaf.node.router });
		} else {
			matchable.push(leaf);
		}
	}
	subs.sort((a, b) => b.prefix.length - a.prefix.length); // longest prefix wins
	const compiled: CompiledPattern[] = compile_all(matchable.map((l) => l.pattern));
	const by_pattern = new Map(matchable.map((l) => [l.pattern, l]));
	// The root layer (shared by every leaf) — its error component catches miss-level c.error().
	const root_layer: Layer | undefined = leaves[0]?.layers[0];

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

		// sub-router delegation (longest prefix first). A mounted router renders its own document, so
		// layer chrome declared ABOVE a mount does not wrap it (documented limitation of mounts).
		for (const s of subs) {
			if (path === s.prefix || path.startsWith(s.prefix + '/')) {
				const inner = path.slice(s.prefix.length) || '/';
				const rewritten = new Request(new URL(inner + url.search, url.origin), request);
				const res = await s.router.fetch(rewritten, event);
				if (res) return res;
			}
		}

		const canon = canonical_slash(path, slash);
		if (canon) return redirect_to(base + canon + url.search);

		const hit = match_path(compiled, path);
		if (!hit) {
			if (base && miss) {
				const ctx = make_ctx({}, url, request, event, href_fn, '');
				const out = await miss(ctx);
				if (out instanceof Response) {
					const em = error_meta.get(out);
					// a miss c.error renders the ROOT error component (inside root chrome); else send as-is
					if (em && root_layer) return render_error([root_layer], 1, ctx, em.status, em.message);
					return out;
				}
				return finalize(out);
			}
			if (base) return not_found();
			return null; // no base → fall through to the rest of the app
		}

		const leaf = by_pattern.get(hit.pattern)!;
		const ctx = make_ctx(hit.params, url, request, event, href_fn, hit.pattern);
		const is_page = leaf.node.t === 'page';

		// Layer chain, top-down: each layer's load cascades into ctx.data. A load returning a Response
		// short-circuits — an error-tagged one (c.error) renders the nearest error component (page leaves
		// only; an API route gets the JSON), anything else (c.redirect) is sent as-is.
		for (let i = 0; i < leaf.layers.length; i++) {
			const load = leaf.layers[i].load;
			if (!load) continue;
			const r = await load(ctx);
			if (r instanceof Response) {
				const em = error_meta.get(r);
				if (em && is_page) return render_error(leaf.layers, i, ctx, em.status, em.message);
				return r;
			}
			if (r) Object.assign(ctx.data as Record<string, unknown>, r);
		}

		const node = leaf.node;
		if (node.t === 'endpoint') return run_endpoint(node, ctx, request.method);
		if (node.t === 'page') return render_page(node, ctx, leaf.layers, request.method, url);
		return not_found(); // a mount can't be a matched leaf (filtered into `subs`)
	}

	async function render_page(
		node: PageNode,
		ctx: Ctx,
		layers: Layer[],
		method: string,
		url: URL
	): Promise<Response> {
		const m = HEAD_AS_GET(method);
		// A page-level error (from an action or the page load) has its boundary at or above the innermost
		// layer — origin = layers.length (below every layer).
		const page_err = (r: Response) => {
			const em = error_meta.get(r);
			return em ? render_error(layers, layers.length, ctx, em.status, em.message) : r;
		};

		let form: unknown;
		if (m === 'POST') {
			const action = pick_action(node, url);
			if (!action) return method_not_allowed(page_allow(node));
			const fr = await action(ctx);
			if (fr instanceof Response) return page_err(fr); // error → boundary; redirect/custom → as-is
			form = fr;
		} else if (m !== 'GET') {
			if (method === 'OPTIONS') return options_response(page_allow(node));
			return method_not_allowed(page_allow(node));
		}

		// The page's own load (Kit's +page.ts) runs after any action, for the render.
		if (node.load) {
			const r = await node.load(ctx);
			if (r instanceof Response) return page_err(r);
			if (r) Object.assign(ctx.data as Record<string, unknown>, r);
		}

		const layouts = layers.filter((l) => l.layout).map((l) => l.layout!);
		const chain = apply_reset(layouts, node.reset);
		// LayoutChain places the page component AS MARKUP (`<Page {...props} />`) at the bottom of the
		// chain, so any import-attribute mark on it (wake / deferred / raw / keep) emits its shell. Used
		// even with an empty chain, so a bare page still renders as a placement site (not a held region).
		const of = region(LayoutChain as never, {
			chain,
			component: node.component,
			props: { data: ctx.data, form, params: ctx.params },
			data: ctx.data,
			fallback: node.fallback
		});
		const res = await document(of, {
			...doc_opts(node.opts),
			// Seed $app/state so islands on this page read $page.data/params/url + route.id.
			pageState: {
				url: ctx.url,
				params: ctx.params,
				route: { id: ctx.route.id || null },
				status: node.opts.status ?? 200,
				data: ctx.data,
				form
			}
		});
		return method === 'HEAD' ? new Response(null, res) : res;
	}

	// Render the nearest error component (Kit's +error.svelte boundary walk). `origin` is where the error
	// happened (a layer index, or layers.length for a page-level error). We find the closest error
	// component at/above it, keep the chrome ABOVE that boundary (its own layout too, unless that same
	// layer's load is what failed), and render the error component in its place. No boundary → JSON.
	async function render_error(
		layers: Layer[],
		origin: number,
		ctx: Ctx,
		status: number,
		message: string | undefined
	): Promise<Response> {
		let boundary = -1;
		for (let i = Math.min(origin, layers.length - 1); i >= 0; i--) {
			if (layers[i].error) {
				boundary = i;
				break;
			}
		}
		if (boundary === -1) return json_response({ error: message ?? 'Error', status }, { status });

		// The boundary layer's own layout wraps the error UNLESS its own load is what failed.
		const upto = boundary < origin ? boundary : boundary - 1;
		const chrome: AnyComponent[] = [];
		for (let i = 0; i <= upto; i++) if (layers[i].layout) chrome.push(layers[i].layout!);

		const of = region(LayoutChain as never, {
			chain: chrome,
			component: layers[boundary].error!,
			props: { status, error: { message: message ?? 'Error' }, data: ctx.data, params: ctx.params },
			data: ctx.data
		});
		return document(of, {
			status,
			pageState: {
				url: ctx.url,
				params: ctx.params,
				route: { id: ctx.route.id || null },
				status,
				data: ctx.data,
				error: { message: message ?? 'Error' }
			}
		});
	}

	const self: Router<Contribution<E>> = {
		__ogrouter: true,
		get $infer(): never {
			throw new Error('router.$infer is a type-only phantom — read `typeof router.$infer`.');
		},
		fetch: dispatch,
		handle: async ({ event, resolve }) => {
			const r = await dispatch(event.request, event);
			return r ?? resolve(event);
		},
		match(pathname) {
			let path = pathname;
			if (base) {
				if (path === base) path = '/';
				else if (path.startsWith(base + '/')) path = path.slice(base.length);
				else return null;
			}
			return match_path(compiled, path);
		},
		href: href_fn as Router<Contribution<E>>['href'],
		// The catchall crawl list: every static page route (no `[param]`), filled through the pattern.
		// Mount it as `export const entries = app.entries` and set `export const prerender = 'auto'`.
		async entries() {
			const out: Array<{ path: string }> = [];
			for (const leaf of matchable) {
				if (leaf.node.t === 'page' && !leaf.pattern.includes('[')) out.push({ path: base + leaf.pattern });
			}
			return out;
		}
	};
	return self;
}

// ── endpoints ────────────────────────────────────────────────────────────────────────────────────
async function run_endpoint(node: EndpointNode, ctx: Ctx, method: string): Promise<Response> {
	const m = HEAD_AS_GET(method);
	const allow = [...node.methods.keys()];
	if (method === 'OPTIONS' && !node.methods.has('OPTIONS')) return options_response(allow);
	const e = node.methods.get(m);
	if (!e) return method_not_allowed(allow);
	if (e.schema) {
		const v = await validate_input(e.schema, await build_input(ctx, m));
		if (v instanceof Response) return v;
		(ctx as { input: unknown }).input = v.value;
	}
	return finalize(await e.handler(ctx));
}

// ── layout reset ───────────────────────────────────────────────────────────────────────────────
/** Trim the layout chain for a page's `layout()` reset: `false` → none; a component → up to and
 *  including it (its OUTERMOST occurrence); omitted → the full chain. */
function apply_reset(layouts: AnyComponent[], reset: AnyComponent | false | undefined): AnyComponent[] {
	if (reset === undefined) return layouts;
	if (reset === false) return [];
	const i = layouts.indexOf(reset);
	return i === -1 ? layouts : layouts.slice(0, i + 1);
}

// ── ctx ──────────────────────────────────────────────────────────────────────────────────────────
function make_ctx(
	params: Record<string, string | undefined>,
	url: URL,
	request: Request,
	event: RequestEvent | undefined,
	href: (pattern: string, params?: Record<string, string | number>) => string,
	routeId: string
): Ctx {
	return {
		params,
		data: {},
		input: undefined,
		url,
		request,
		route: { id: routeId },
		fetch: event?.fetch ?? fetch,
		cookies: event?.cookies,
		locals: event?.locals,
		setHeaders: event?.setHeaders,
		platform: event?.platform,
		event,
		json: (data, init) => json_response(data, init),
		redirect: (location, status = 303) =>
			new Response(null, { status, headers: { location, 'cache-control': 'no-store' } }),
		text: (body, init) =>
			new Response(body, {
				...init,
				headers: { 'content-type': 'text/plain; charset=utf-8', ...init?.headers }
			}),
		error: (status, message) => {
			// Tagged so the router renders the nearest error COMPONENT (Kit's +error.svelte) instead of the
			// JSON — c.redirect()/c.json() Responses stay untagged and pass through as-is.
			const r = json_response({ error: message ?? 'Error', status }, { status });
			error_meta.set(r, { status, message });
			return r;
		},
		href,
		state: {}
	} as Ctx;
}

/** The route input a schema validates: JSON body (mutating methods) ⊕ search params ⊕ path params. */
async function build_input(ctx: Ctx, method: string): Promise<Record<string, unknown>> {
	const obj: Record<string, unknown> = {};
	if (method !== 'GET' && method !== 'HEAD') {
		const ct = ctx.request.headers.get('content-type') ?? '';
		if (ct.includes('application/json')) {
			try {
				const body = await ctx.request.clone().json();
				if (body && typeof body === 'object') Object.assign(obj, body);
			} catch {
				/* not JSON — leave the body out */
			}
		}
	}
	for (const key of new Set(ctx.url.searchParams.keys())) {
		const all = ctx.url.searchParams.getAll(key);
		obj[key] = all.length > 1 ? all : all[0];
	}
	Object.assign(obj, ctx.params);
	return obj;
}

async function validate_input(
	schema: StandardSchemaV1,
	input: unknown
): Promise<{ value: unknown } | Response> {
	const r = await schema['~standard'].validate(input);
	if (r.issues) {
		return json_response(
			{ error: 'Invalid input', issues: r.issues.map((i) => ({ message: i.message, path: i.path })) },
			{ status: 400 }
		);
	}
	return { value: r.value };
}

// ── small helpers (hoisted; no per-request regex construction) ─────────────────────────────────
const TRAILING_SLASH = /\/+$/;
function canonical_slash(path: string, mode: 'ignore' | 'never' | 'always'): string | null {
	if (mode === 'ignore' || path === '/') return null;
	const has = path.endsWith('/');
	if (mode === 'never' && has) return path.replace(TRAILING_SLASH, '') || '/';
	if (mode === 'always' && !has) return path + '/';
	return null;
}

function doc_opts(o: PageOpts) {
	const headers = new Headers(o.headers);
	if (o.cache !== undefined && !headers.has('cache-control')) {
		headers.set('cache-control', cache_control(o.cache));
	}
	return { title: o.title, status: o.status, headers };
}
function cache_control(c: NonNullable<PageOpts['cache']>): string {
	if (c === false) return 'no-store';
	const parts = [c.private ? 'private' : 'public'];
	if (c.maxAge != null) parts.push(`max-age=${c.maxAge}`);
	if (c.swr != null) parts.push(`stale-while-revalidate=${c.swr}`);
	return parts.join(', ');
}

function pick_action(node: PageNode, url: URL): ((c: Ctx) => unknown) | undefined {
	// Kit's form-action convention: `?/name` (a search key starting with '/'). Default = null key.
	for (const key of url.searchParams.keys()) {
		if (key.startsWith('/')) {
			const named = node.actions.get(key.slice(1));
			if (named) return named;
		}
	}
	return node.actions.get(null);
}
function page_allow(node: PageNode): string[] {
	const a = ['GET', 'HEAD'];
	if (node.actions.size) a.push('POST');
	return a;
}

const fill_token = /\[(\.\.\.)?\[?([a-zA-Z_$][\w$]*)\]?\]/g;
function fill(pattern: string, params: Record<string, string | number>): string {
	return pattern.replace(fill_token, (_m, _rest, name: string) => {
		const val = params[name];
		return val == null ? '' : encodeURIComponent(String(val));
	});
}

/** An endpoint/miss return → a Response: a Response passes through; null → 204; anything else → JSON. */
function finalize(out: unknown): Response {
	if (out instanceof Response) return out;
	if (out == null) return new Response(null, { status: 204 });
	return json_response(out);
}
function redirect_to(location: string): Response {
	return new Response(null, { status: 308, headers: { location } });
}
function not_found(): Response {
	return new Response('Not found', { status: 404 });
}
function method_not_allowed(allow: string[]): Response {
	return new Response('Method not allowed', { status: 405, headers: { allow: allow.join(', ') } });
}
function options_response(allow: string[]): Response {
	return new Response(null, { status: 204, headers: { allow: allow.join(', ') } });
}
function json_response(data: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...init?.headers }
	});
}
