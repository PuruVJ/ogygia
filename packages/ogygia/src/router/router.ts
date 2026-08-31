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
import RawHtml from '../RawHtml.svelte';
import { compile_all, match_path, fill, type CompiledPattern } from './match.js';
import { make_ctx, type Ctx, type Visitor } from './ctx.js';
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
	type PageHtmlView,
	type RouteTable
} from './define.js';
import type { InferMap } from './infer.js';
import type { StandardSchemaV1, HrefArgs } from './view.js';
import {
	error,
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
import { prime_flags } from '../flags.js';
import { take_late_regions } from '../late-region-registry.js';
import {
	is_stream_slot,
	bake_yield,
	slot_html,
	stream_document,
	page_slot_chunks,
	late_region_chunks,
	merge_chunks,
	PAGE_SLOT_ID
} from './stream.js';

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
	/** WHO is this request? Derived ONCE here, read everywhere as `c.visitor` — experiments stick
	 *  on it, mounts sign it into claims, loads personalize with it. Signature-bound claims from
	 *  an upstream shell (fragment federation) take precedence over this resolver. */
	visitor?: (c: Ctx) => Visitor | undefined;
	/** Flags to PRE-DECIDE at the table, so mounts carry their buckets even when no page on this
	 *  server reads them (a shell that only ROUTES to teams still wants the visitor's world to
	 *  travel). Any flag a page DOES read auto-carries without being listed here — this is just for
	 *  the decide-but-don't-render case. `flags: [csr]`. */
	flags?: ReadonlyArray<(c: Ctx) => unknown>;
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
	/** `when()` gate — off means the route does not exist for this request. */
	when?: (c: Ctx) => boolean;
}

/**
 * Flag-gate a table entry — page or endpoint. OFF means the route DOES NOT EXIST for that
 * request: 404 (the app's error page) under an owned `base`, fall-through to the rest of the app
 * without one. The gate is any `(c) => boolean` — a boolean `flag()` slots in directly, so a
 * staged rollout of a whole page, a beta route, or an endpoint kill switch is one wrapper:
 *
 *     '/checkout-v2': when(checkoutV2, page(NewCheckout, { load })),
 *     '/api/export':  when(exportsFlag, { GET: GET(export_csv) }),
 *     '/cms/[...rest]': when(cmsRollout, mount(cms)),          // per-cohort fragment rollout
 *
 * Decided AFTER `decide({ source })` primes, so a vendor kill switch gates routes too; the
 * decision self-registers for federation carry like any flag read. Type-transparent: `$infer`
 * sees the entry exactly as if unwrapped.
 */
export function when<T extends PageDef | Endpoint>(gate: (c: Ctx) => boolean, entry: T): T {
	return { ...(entry as object), __ogwhen: gate } as unknown as T;
}

const HEAD_AS_GET = (m: string) => (m === 'HEAD' ? 'GET' : m);
// A mounted document's title lands in a RAW head string — escape it (every text-into-markup
// emitter escapes; the wire is trusted federation, the law is unconditional).
const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const escape_text = (s: string) =>
	s.replace(AMP_RE, '&amp;').replace(LT_RE, '&lt;').replace(GT_RE, '&gt;');

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
		// A `when()` gate rides the raw entry; endpoint compilation would drop it, so lift it here.
		const gate = (raw as { __ogwhen?: (c: Ctx) => boolean }).__ogwhen;
		// Endpoint objects (`{ GET, POST, … }`) compile to their method map once here; pages pass through.
		return {
			pattern,
			def: is_page(raw) ? raw : compile_endpoint(raw as Endpoint),
			...(gate ? { when: gate } : {})
		};
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
		// Unmatched — and `when()`-gated-off routes, which contractually DO NOT EXIST for the
		// request: the app's 404/error page under an owned base; fall-through without one.
		const unmatched = async (): Promise<Response | null> => {
			if (base && opts.miss) {
				const ctx = make_ctx({}, url, request, event, href_fn, '', opts.visitor);
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
			// An unmatched PAGE request under an owned base renders the root error BOUNDARY as
			// HTML with 404 — a browser hitting a dead URL deserves the app's 404 page, not JSON
			// (the long-noted `miss answers JSON` gap). Non-HTML requests (fetch/API) keep JSON.
			if (base && opts.error && (request.method === 'GET' || request.method === 'HEAD')) {
				const accept = request.headers.get('accept') ?? '';
				if (accept.includes('text/html')) {
					const ctx = make_ctx({}, url, request, event, href_fn, '', opts.visitor);
					const of = region(LayoutChain as never, {
						chain: [],
						component: opts.error,
						props: { status: 404, error: { message: 'Not found' }, data: {}, params: {} },
						data: {}
					});
					return document(of, {
						status: 404,
						head: await router_css_head([opts.error]),
						pageState: {
							url: ctx.url,
							params: {},
							route: { id: null },
							status: 404,
							data: {},
							error: { message: 'Not found' }
						}
					});
				}
			}
			if (base) return not_found();
			return null; // no base → fall through to the rest of the app
		};
		if (!hit) return unmatched();

		const leaf = by_pattern.get(hit.pattern)!;
		const ctx = make_ctx(hit.params, url, request, event, href_fn, hit.pattern, opts.visitor);
		// Resolve the flag SOURCE (if `decide({ source })` set one) ONCE for this request, so every
		// `flag(c)` read below stays sync. The routes table imported every flag module at startup, so
		// the registry the source is asked over is complete. Idempotent + no-op without a source.
		await prime_flags(ctx);
		// Pre-decide the table's `flags` — force their buckets into the request so a mount carries
		// them even if no page here reads them (each read self-records for federation auto-carry).
		if (opts.flags) for (const f of opts.flags) f(ctx);

		// `when()` gate: OFF → this route does not exist for this request (the unmatched contract,
		// verbatim). Checked AFTER the source primes, so a vendor kill switch gates whole routes,
		// and the decision self-registers for federation carry like any other flag read.
		if (leaf.when && !leaf.when(ctx)) return unmatched();

		// `c.setHeaders` must reach the Response WE build — Kit's own setHeaders only applies to
		// `resolve()`-built responses, and a router-rendered document bypasses resolve entirely
		// (found when a load's Server-Timing header silently vanished). Existing headers win so a
		// handler's explicit Response headers are never clobbered.
		const with_collected = (res: Response): Response => {
			if (ctx.collected_headers?.size) {
				for (const [k, v] of ctx.collected_headers) {
					if (!res.headers.has(k)) res.headers.set(k, v);
				}
			}
			return res;
		};

		try {
			// Table-wide load (the no-chrome guard) runs before every route, gating endpoints too. A
			// load may return a Response to short-circuit (a guard's redirect/deny) — v1 parity.
			if (root_load) {
				const rl = await root_load(ctx);
				if (rl instanceof Response) return with_collected(rl);
			}
			if ((leaf.def as { __ogkind?: string }).__ogkind === 'endpoint')
				return with_collected(await run_endpoint(leaf.def as EndpointDef, ctx, request.method));
			return with_collected(await render_page(leaf.def as PageDef, ctx, request.method, url));
		} catch (thrown) {
			return with_collected(await handle_thrown(thrown, leaf.def, ctx));
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
		// ONE slot resolution — bare component, ComponentPick, and mount()'s html view all take
		// the same door: a branded per-request resolver, run post-loads (so a mounted wire doc
		// rides `data`). Resolver ARMS are covered by build-time CSS discovery exactly like bare
		// components — discovery walks the router module's .svelte IMPORT specs, never the table
		// values, so anything an arm can return was already an import. Free for `$infer`: types
		// come from LOADS, never components.
		// STREAMED page (`page(async function* (c, data) { yield region(...); ... })`): the FIRST
		// yield renders in the document and the page flushes; later yields ride the same response
		// as late template chunks (see stream.ts). Non-GET renders run the generator to COMPLETION
		// and show the final yield — actions need a whole answer, streaming is a GET affair.
		let gen_rest: AsyncGenerator<unknown> | null = null;
		let gen_first_html: string | null = null;
		if (is_stream_slot(node.component)) {
			const it = (
				node.component as unknown as (c: Ctx, d: Record<string, unknown>) => AsyncGenerator<unknown>
			)(ctx, data);
			const first = await it.next();
			if (first.done) error(500, 'a streamed page must yield at least one region');
			if (m === 'GET' && method !== 'HEAD') {
				gen_first_html = await bake_yield(first.value);
				gen_rest = it;
			} else {
				let last = first.value;
				for (;;) {
					const n = await it.next();
					if (n.done) break;
					last = n.value;
				}
				gen_first_html = await bake_yield(last);
			}
		}

		const resolved =
			gen_first_html !== null
				? { __oghtml: true as const, html: slot_html(PAGE_SLOT_ID, gen_first_html) }
				: typeof node.component === 'object' &&
					  node.component !== null &&
					  '__ogpick' in node.component
					? (
							node.component as { __ogpick: (c: Ctx, data: Record<string, unknown>) => unknown }
						).__ogpick(ctx, data)
					: node.component;
		// An html view renders through ogygia's OWN pure-HTML region component (og_html_region's
		// RawHtml) — the wire document is just html + css, no bespoke page component. Its css tags
		// + escaped title join the DOCUMENT head (the router owns the head; a component would have
		// needed <svelte:head>).
		const html_view =
			typeof resolved === 'object' && resolved !== null && '__oghtml' in resolved
				? (resolved as PageHtmlView)
				: null;
		const page_component = html_view ? (RawHtml as AnyComponent) : (resolved as AnyComponent);
		// STATUS CHANNEL: a view carrying an error status (a mounted app's own 404/500 page)
		// answers with THAT status through the shell — never a 200-wrapped error page. 2xx/3xx
		// view statuses don't override (redirects already threw; action-fail status stands).
		if (html_view?.status && html_view.status >= 400) status = html_view.status;
		const of = region(LayoutChain as never, {
			chain,
			component: page_component,
			props: html_view ? { html: html_view.html } : { data, form, params: ctx.params },
			data,
			fallback: node.fallback
		});
		const css_head =
			(await router_css_head(html_view ? chain : [...chain, page_component])) +
			(html_view
				? (html_view.title ? `<title>${escape_text(html_view.title)}</title>` : '') +
					(html_view.css?.join('') ?? '') +
					(html_view.head ?? '')
				: '');
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
		if (method === 'HEAD') return new Response(null, res);
		// Late content remains — a page generator's later yields, and/or LATE REGIONS the render
		// registered (`<Region of={promise}>` holes, armed via the handle's ALS) — chunk it all
		// down THIS response in readiness order (one connection, closes when every source ends).
		const late = take_late_regions();
		const chunk_src =
			gen_rest && late?.length
				? merge_chunks(page_slot_chunks(gen_rest), late_region_chunks(late))
				: gen_rest
					? page_slot_chunks(gen_rest)
					: late?.length
						? late_region_chunks(late)
						: null;
		if (chunk_src && m === 'GET') return stream_document(await res.text(), res, chunk_src);
		return res;
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

		// The failing DEPTH is knowable: loads are memoized on ctx, so re-awaiting settles
		// instantly for anything that already ran (and runs the rest — an action's throw still
		// wants live chrome, exactly like Kit rendering +error under working layouts). The
		// shallowest REJECTED load names the failing layer; everything above it has real data.
		const load_defs: (LoadDef | undefined)[] = [
			root_load,
			...pnode.layouts.map((l) => l.load),
			pnode.load
		];
		// async-wrapped: a load that throws SYNCHRONOUSLY (plain `error(404)` body) must become a
		// rejection here, not escape the map — allSettled can only see promises that exist
		const settled = await Promise.allSettled(
			load_defs.map(async (l) => (l ? await l(ctx) : undefined))
		);
		let failing = settled.length; // nothing rejected → the throw came from an action/handler
		for (let i = 0; i < settled.length; i++) {
			if (settled[i].status === 'rejected') {
				failing = i;
				break;
			}
		}
		// layouts whose loads SUCCEEDED (index 0 = the table-wide load, i+1 = layouts[i]):
		// the failing layout's own chrome cannot render — it has no data
		const renderable = failing === 0 ? 0 : Math.min(failing - 1, pnode.layouts.length);
		// merged data of every fulfilled load — the surviving chrome (and the boundary) read it
		const data: Record<string, unknown> = {};
		for (const s of settled) {
			if (
				s.status === 'fulfilled' &&
				s.value &&
				typeof s.value === 'object' &&
				!(s.value instanceof Response)
			)
				Object.assign(data, s.value);
		}

		// Nearest boundary whose OWN layout still has data — its error page renders INSIDE that
		// layout's chrome (Kit's shape: +error.svelte lives inside its layout). A failure in
		// layout k can only use a boundary above k; a page-load failure can use the innermost.
		let boundary = -1;
		for (let i = renderable - 1; i >= 0; i--) {
			if (pnode.layouts[i].error) {
				boundary = i;
				break;
			}
		}
		const err_component = boundary >= 0 ? pnode.layouts[boundary].error! : opts.error;
		if (!err_component) return json_response({ error: message, status }, { status });

		// chrome INCLUDES the boundary's own layout — the error page renders inside it
		const chrome = (boundary >= 0 ? pnode.layouts.slice(0, boundary + 1) : []).map(
			(l) => l.component
		);
		const of = region(LayoutChain as never, {
			chain: chrome,
			component: err_component,
			props: { status, error: { message }, data, params: ctx.params },
			data
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
				data,
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
				if (!is_page(leaf.def)) continue;
				if (!leaf.pattern.includes('[')) {
					out.push({ path: base + leaf.pattern });
					continue;
				}
				// a DYNAMIC pattern with declared param sets prerenders each filled path (Kit's
				// per-route `entries` export); without them it's skipped (crawled or SSR'd live)
				const list = leaf.def.entries ? await leaf.def.entries() : null;
				if (list) for (const params of list) out.push({ path: base + fill(leaf.pattern, params) });
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

// `fill` moved to match.ts — shared with the typed `api()` client (one token grammar).

// re-export the component type so LayoutChain's props stay in one vocabulary
export type { Component };
