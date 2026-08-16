/**
 * `defineSite()` — mints a docs site over an outline (or a bare collection, which it auto-wraps). Returns
 * BRAINS ONLY: `load` / `entries` for the mount, `nav()` for the sidebar, `doc()` for the page. Every
 * one returns plain serializable data — no components, nothing global, nothing registered. A weird
 * route can ignore the site entirely; the ceiling is the app.
 *
 * ```ts
 * export const site = defineSite(nav, { prevNext: 'graph' });   // defineSite(docs) wraps a single collection
 *
 * // (docs)/[...slug]/+page.ts
 * export const prerender = true;
 * export const { load, entries } = site;
 * ```
 */
import { error, redirect } from '@sveltejs/kit';
import type { Component } from 'svelte';
import type { Entry } from '../index.js';
import { format_findings, run_page_checks, run_site_checks, type Check, type Finding } from './checks.js';
import { build_llms, build_rss, build_sitemap, strip_frontmatter } from './emit.js';
import type { RssItem } from './emit.js';
import { href_of, outline, type Collection, type Outline, type OutlineSpec, type TrailScope } from './outline.js';
import { is_dimensioned, type Switcher } from './dimensions.js';
import { build_docs, create_search, orama_engine, type SearchBrain, type SearchEngine } from './search.js';
import type { BaseOption, DocView, Heading, NavRef, NavTree, PrevNext } from './types.js';

/** Site-level facts, surfaced as `site.data` and used as the default for every emission. */
export type SiteData = {
	/** Site name — llms.txt header, `<title>` suffix, shell brand default. */
	title: string;
	/** One-line description — llms.txt, meta description. */
	description: string;
	/** Absolute origin for machine emissions (sitemap/llms), which can't read the request when prerendered. */
	origin: string;
};

/** The SHELL bundle — everything `<Shell>` needs as plain data, so the corpus can stay server-only.
 *  `site.meta(slug)` returns it; expose it as a remote and pass the result to `<Shell {meta}>`. */
export type SiteMeta = {
	nav: NavTree;
	switcher: Switcher | null;
	data?: SiteData;
};

/** A request context the site derives per read (preview, roles) and threads into collection filters. */
export type ReadContext = Record<string, unknown>;

/** The single-object argument to `defineSite()`. `outline` is the only required key. */
export type SiteOptions = {
	/** The arrangement: a collection, an outline node[], or `dimensions()`. Auto-woven into an `Outline`. */
	outline: Outline | OutlineSpec;
	/** Site facts → `site.data`; emissions default their title/description/origin from here. */
	data?: SiteData;
	/** Default mount prefix for every read (`nav`/`doc`/emit). Per-call `{ base }` still overrides. */
	base?: string;
	/**
	 * Derive a request context (preview, roles) from the request. Threaded into the collection `filter`
	 * as its second argument; the empty context `{}` is the public/prerendered projection.
	 */
	context?: (event: { url: URL; request?: Request; cookies?: unknown }) => ReadContext;
	/** How "keep reading" is chosen. `'graph'` = content relations then order; default `'order'`. */
	prevNext?: PrevNext;
	/** Reading-order scope for prev/next: `'weave'` (whole corpus, default) or `'group'` (stop at the
	 *  top-level section boundary, so a multi-topic site never links across topics). */
	trail?: TrailScope;
	/**
	 * Content CHECKS — corpus invariants as pluggable values (`links()`, and your own). Each runs
	 * per-page in `load` (an ERROR finding throws, in every render mode) AND whole-corpus via
	 * `site.check()` (plain data, never throws). `[links()]` reproduces the old `audit: true`.
	 * Structural invariants (orphans, slug collisions, `NN-`) stay always-on build errors, not checks.
	 */
	checks?: Check[];
	/**
	 * Override markdown element rendering with components — real VALUES, in app code (no import
	 * paths). Reaches the compiled `SiteSlot` via context. Built-in default: `a → Link`.
	 */
	components?: Record<string, Component<Record<string, unknown>>>;
	/** Full-text search config. The default engine is Orama (optional peer); swap via `engine`. */
	search?: { engine?: SearchEngine };
	/** Old addresses an entry declares for itself (redirect history). Default reads `data.redirect_from`. */
	redirects?: (entry: import('../index.js').ContentRef) => string[] | string | undefined;
};

/** The minimal SvelteKit `load` event shape the guard reads (kept narrow so it stays isomorphic). */
type LoadLike = { params: Record<string, string | undefined>; url: URL | { pathname: string } };

/** The minimal request-event shape an emission handler reads. Assignable from Kit's `RequestEvent`. */
type EmitEvent = { url: URL };
/** A GET handler an emission mounts as. `export const GET = site.emit.sitemap({ base })`. */
export type EmitHandler = (event: EmitEvent) => Promise<Response>;
/** Common emission options. `origin` overrides the request origin (needed for prerendered output). */
export type EmitOptions = { base?: string; origin?: string };
export type LlmsEmitOptions = EmitOptions & { title?: string; description?: string };
export type RssEmitOptions = EmitOptions & {
	title: string;
	description?: string;
	items: () => Promise<RssItem[]> | RssItem[];
};

/** The raw-markdown emission: a GET handler + its prerender entries, for a `[...slug].md/+server.ts`. */
export type RawEmit = {
	GET: (event: { params: Record<string, string | undefined> }) => Promise<Response>;
	entries: () => Promise<Array<{ slug: string }>>;
};

/** The site brains. All data-returning, all browser-safe. */
export interface Site {
	/** The underlying outline, for tier-2 chrome that wants the raw tree/resolver. */
	outline: Outline;
	/** Site facts (title/description/origin), or `undefined` if none were declared. Shells read `title`. */
	data?: SiteData;
	/** The element-override component map (user overrides; `SiteSlot` adds the `a → Link` default).
	 *  `Shell` provides this via context; tier-2 renders can provide it themselves. */
	components: Record<string, Component<Record<string, unknown>>>;
	/** SvelteKit `load` — the 404 guard, alias 308s, and (when enabled) the per-page link audit. */
	load: (event: LoadLike) => Promise<void>;
	/** SvelteKit `entries` — every leaf slug PLUS declared old addresses (so redirect stubs bake). */
	entries: () => Promise<Array<{ slug: string }>>;
	/** The sidebar tree, hrefs resolved for `base` (default `''`). On a `dimensions()` site pass the
	 *  current `slug` so the tree reflects that coordinate; ignored otherwise. */
	nav: (opts?: BaseOption & { slug?: string; context?: ReadContext }) => Promise<NavTree>;
	/** On a `dimensions()` site: the version/locale switcher for the coordinate in `slug` (hrefs baked
	 *  for `base`). `null` on a plain site. Serializable — the shell renders a `<select>`. */
	switcher: (slug: string, opts?: BaseOption & { context?: ReadContext }) => Promise<Switcher | null>;
	/** The whole SHELL bundle in one browser-safe call: `{ nav, switcher, data }` for a slug. Feed it
	 *  to `<Shell {meta}>` so the corpus stays server-only — this is what a `meta` remote returns. */
	meta: (opts?: BaseOption & { slug?: string; context?: ReadContext }) => Promise<SiteMeta>;
	/** Everything one page position needs, or `null` for an unknown slug. Call in the page component.
	 *  Pass `context` (e.g. `{ preview: true }`) to see the same projection the load guard used. */
	doc: <Data extends Record<string, unknown> = Record<string, unknown>, Meta = unknown>(slug: string, opts?: BaseOption & { context?: ReadContext }) => Promise<DocView<Data, Meta> | null>;
	/** Run all `checks` over the whole corpus as plain data (never throws) — for vitest/CI, and for
	 *  dynamic sites where the prerender crawler never runs. */
	check: (opts?: { base?: string; context?: ReadContext }) => Promise<Finding[]>;
	/** Full-text search brain — lazy in-memory index over the collections' section documents. Query
	 *  from a server load / remote; scope with `{ in: [collection] }`. Server-side (or the worker over
	 *  the emitted index); do not call over a glob collection in the browser. */
	search: SearchBrain;
	/** Machine-facing serializations — each mints a GET handler for a `+server.ts`. */
	emit: {
		/** `sitemap.xml` over every leaf. Pass `origin` for correct absolute URLs when prerendered. */
		sitemap: (opts?: EmitOptions) => EmitHandler;
		/** `llms.txt` index (llmstxt.org) from the nav tree. */
		llms: (opts?: LlmsEmitOptions) => EmitHandler;
		/** Per-page raw markdown from each entry's own lazy `source`. Mount at `[...slug].md`. */
		raw: (opts?: { frontmatter?: 'keep' | 'strip' }) => RawEmit;
		/** Prerendered `search.json` — the section documents the client worker indexes with Orama. */
		search: (opts?: EmitOptions) => EmitHandler;
		/** RSS 2.0 over dated items (the blog genre's feed). `items` typically maps a collection's
		 *  refs; hrefs are root-relative and absolutized against the origin at emit time. */
		rss: (opts: RssEmitOptions) => EmitHandler;
	};
}

function is_outline(x: unknown): x is Outline {
	return (
		!!x &&
		typeof x === 'object' &&
		typeof (x as Outline).tree === 'function' &&
		typeof (x as Outline).resolve === 'function' &&
		typeof (x as Outline).addresses === 'function'
	);
}

/**
 * The site brains as a class — state (outline, prevNext, checks, search) as fields, each brain a
 * method. `defineSite()` mints one; nothing here is global or registered.
 */
class OgygiaSite implements Site {
	readonly outline: Outline;
	readonly data?: SiteData;
	readonly components: Record<string, Component<Record<string, unknown>>>;
	readonly search: SearchBrain;
	readonly #prevNext: PrevNext;
	readonly #trail: TrailScope;
	readonly #checks: Check[];
	readonly #base: string;
	readonly #context?: SiteOptions['context'];

	constructor(opts: SiteOptions) {
		const source = opts.outline;
		this.outline = is_outline(source)
			? source
			: outline(source as OutlineSpec, opts.redirects ? { redirects: opts.redirects } : {});
		this.#prevNext = opts.prevNext ?? 'order';
		this.#trail = opts.trail ?? 'weave';
		this.#checks = opts.checks ?? [];
		this.components = opts.components ?? {};
		if (opts.data) this.data = opts.data;
		this.#base = opts.base ?? '';
		this.#context = opts.context;
		this.search = create_search(this.outline, opts.search?.engine ?? orama_engine());
	}

	// `load`/`entries` are arrow FIELDS (bound) because the three-file mount detaches them —
	// `export const { load, entries } = site` — so a plain method would lose `this`.
	load = async (event: LoadLike) => {
		const { params, url } = event;
		const ol = this.outline;
		const slug = params.slug ?? '';
		// Derive the request context (preview, roles) here — this is the one place holding the event.
		const ctx = this.#deriveCtx(event);
		const hit = await ol.resolve(slug, ctx);
		if (hit) {
			if (this.#checks.length) {
				const base = mountBase(url, slug);
				const findings = await run_page_checks(this.#checks, slug, { outline: ol, base, ctx });
				const warns = findings.filter((f) => f.severity === 'warn');
				const errors = findings.filter((f) => f.severity === 'error');
				if (warns.length) console.warn(format_findings(slug, warns, hit.record.filePath));
				if (errors.length) throw new Error(format_findings(slug, errors, hit.record.filePath));
			}
			return;
		}
		// A declared old address: serve the redirect (prerender bakes it — aliases are in entries()).
		const canonical = await ol.alias(slug, ctx);
		if (canonical) redirect(308, href_of(mountBase(url, slug), canonical));
		error(404, 'Not found');
	};

	/** Run the `context` derivation over a request-ish event, defensively (missing fields → `{}`). */
	#deriveCtx(event: unknown): ReadContext {
		if (!this.#context) return {};
		try {
			return this.#context(event as { url: URL; request?: Request; cookies?: unknown }) ?? {};
		} catch {
			return {};
		}
	}

	entries = async () => {
		const ol = this.outline;
		const slugs = (await ol.addresses()).map((slug) => ({ slug }));
		// Old addresses prerender too — each becomes a baked redirect artifact.
		const aliases = await ol.aliases();
		return [...slugs, ...[...aliases.keys()].map((slug) => ({ slug }))];
	};

	async check(o: { base?: string; context?: ReadContext } = {}) {
		return run_site_checks(this.#checks, { outline: this.outline, base: o.base ?? this.#base, ctx: o.context ?? {} });
	}

	nav(o: BaseOption & { slug?: string; context?: ReadContext } = {}) {
		const ol = this.outline;
		const ctx = o.context ?? {};
		if (is_dimensioned(ol) && o.slug !== undefined) {
			return ol.tree(o.base ?? this.#base, ol.coordinateOf(o.slug), ctx);
		}
		return ol.tree(o.base ?? this.#base, ctx);
	}

	async switcher(slug: string, o: BaseOption & { context?: ReadContext } = {}) {
		const ol = this.outline;
		return is_dimensioned(ol) ? ol.switcher(slug, o.base ?? this.#base, o.context ?? {}) : null;
	}

	async meta(o: BaseOption & { slug?: string; context?: ReadContext } = {}): Promise<SiteMeta> {
		const slug = o.slug ?? '';
		return {
			nav: await this.nav(o),
			switcher: await this.switcher(slug, o),
			...(this.data ? { data: this.data } : {})
		};
	}

	async doc<Data extends Record<string, unknown> = Record<string, unknown>, Meta = unknown>(slug: string, o: BaseOption & { context?: ReadContext } = {}): Promise<DocView<Data, Meta> | null> {
		const ol = this.outline;
		const base = o.base ?? this.#base;
		const ctx = o.context ?? {};
		const hit = await ol.resolve(slug, ctx);
		if (!hit) return null;
		const { record, collection } = hit;
		const entry = await collection.get(record.entryId, ctx);
		if (!entry) return null;

		const headings = extract_headings(entry.meta);
		const { prev, next } = await ol.neighbors(record.slug, base, ctx, this.#trail);
		const related = await resolve_related(entry, collection, ol, base, ctx);
		const suggested = choose_suggested(this.#prevNext, related, next);

		const view: DocView = {
			slug: record.slug,
			href: href_of(base, record.slug),
			entry: entry as Entry<Record<string, unknown>, unknown>,
			section: record.section,
			crumbs: record.crumbs,
			headings,
			trail: {
				...(prev ? { prev } : {}),
				...(next ? { next } : {}),
				related,
				suggested
			},
			...(is_dimensioned(ol)
				? { coordinate: ol.coordinateOf(slug), fallback: await ol.fallbackOf(slug) }
				: {})
		};
		return view as DocView<Data, Meta>;
	}

	get emit(): Site['emit'] {
		const ol = this.outline;
		const data = this.data;
		const base0 = this.#base;
		return {
			sitemap: (o: EmitOptions = {}) => async (event) => {
				const origin = o.origin ?? data?.origin ?? event.url.origin;
				const tree = await ol.tree(o.base ?? base0);
				return new Response(build_sitemap(tree, origin), { headers: { 'content-type': 'application/xml' } });
			},
			llms: (o: LlmsEmitOptions = {}) => async (event) => {
				const origin = o.origin ?? data?.origin ?? event.url.origin;
				const tree = await ol.tree(o.base ?? base0);
				const body = build_llms(tree, origin, { title: o.title ?? data?.title, description: o.description ?? data?.description });
				return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
			},
			search: () => async () => {
				// Mount-independent section documents; the client worker applies base + indexes them.
				const docs = await build_docs(ol);
				return new Response(JSON.stringify(docs), { headers: { 'content-type': 'application/json' } });
			},
			rss: (o: RssEmitOptions) => async (event) => {
				const origin = o.origin ?? data?.origin ?? event.url.origin;
				const body = build_rss(origin, {
					title: o.title,
					...(o.description ? { description: o.description } : {}),
					base: o.base ?? base0,
					items: await o.items()
				});
				return new Response(body, { headers: { 'content-type': 'application/xml' } });
			},
			raw: (o: { frontmatter?: 'keep' | 'strip' } = {}) => {
				const strip = (o.frontmatter ?? 'strip') === 'strip';
				const source_of = async (slug: string): Promise<string | null> => {
					const hit = await ol.resolve(slug);
					if (!hit) return null;
					const entry = await hit.collection.get(hit.record.entryId);
					return entry?.source ? entry.source() : null;
				};
				return {
					// Only prerender slugs whose entry carries source — a data-only collection (JSON) woven
					// into the same site has no `.md`, and must not be crawled into a 404.
					entries: async () => {
						const out: Array<{ slug: string }> = [];
						for (const slug of await ol.addresses()) if ((await source_of(slug)) != null) out.push({ slug });
						return out;
					},
					GET: async ({ params }) => {
						const raw = await source_of(params.slug ?? '');
						if (raw == null) return new Response('Not found', { status: 404 });
						return new Response(strip ? strip_frontmatter(raw) : raw, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
					}
				};
			}
		};
	}
}

/** Mint the site brains. `defineSite({ outline })` is the only required key; a bare collection auto-weaves. */
export function defineSite(opts: SiteOptions): Site {
	return new OgygiaSite(opts);
}

/** Pull `headings` off a source-derived meta (`markdown` supplies it), defensively. */
function extract_headings(meta: unknown): Heading[] {
	if (meta && typeof meta === 'object' && 'headings' in meta) {
		const h = (meta as { headings: unknown }).headings;
		if (Array.isArray(h)) return h as Heading[];
	}
	return [];
}

/** Resolve an entry's content-graph `related` refs to nav refs (address + display fields). */
async function resolve_related(entry: Entry<Record<string, unknown>, unknown>, collection: Collection, ol: Outline, base: string, ctx: ReadContext = {}): Promise<NavRef[]> {
	const rel = entry.rel?.related;
	if (!rel) return [];
	const refs = Array.isArray(rel) ? rel : [rel];
	const out: NavRef[] = [];
	for (const ref of refs) {
		if (!ref) continue;
		const slug = await ol.slug_for(collection, ref.id, ctx);
		if (!slug) continue;
		const data = ref.data as Record<string, unknown>;
		const title = typeof data.title === 'string' ? data.title : ref.id;
		const summary = typeof data.summary === 'string' && data.summary ? data.summary : undefined;
		out.push({ slug, href: href_of(base, slug), title, ...(summary ? { summary } : {}) });
	}
	return out;
}

/** Apply the `prevNext` policy: graph = related else next; order = next; false = none. */
function choose_suggested(policy: PrevNext, related: NavRef[], next: NavRef | undefined): NavRef[] {
	if (policy === false) return [];
	if (policy === 'graph' && related.length) return related;
	return next ? [next] : [];
}

/**
 * Derive the mount prefix by subtraction: the catch-all's `url.pathname` minus its matched `slug` is
 * the group's base. Call it once in the layout — the one place guaranteed to hold the request. Root
 * mount → `''`; a `(docs)` group at `/docs` → `'/docs'`. Composes with `paths.base` (already in the
 * pathname). No global config, no registry.
 */
export function mountBase(url: URL | string | { pathname: string }, slug: string): string {
	const pathname = typeof url === 'string' ? url : url.pathname;
	const path = pathname.replace(/\/+$/, '');
	const s = slug.replace(/^\/+|\/+$/g, '');
	if (!s) return path; // index page: the whole path is the base
	if (path.endsWith('/' + s)) return path.slice(0, path.length - s.length - 1);
	if (path.endsWith(s)) return path.slice(0, path.length - s.length).replace(/\/+$/, '');
	return path;
}
