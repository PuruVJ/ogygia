/**
 * `pharos()` — mints a docs site over an outline (or a bare collection, which it auto-wraps). Returns
 * BRAINS ONLY: `load` / `entries` for the mount, `nav()` for the sidebar, `doc()` for the page. Every
 * one returns plain serializable data — no components, nothing global, nothing registered. A weird
 * route can ignore the site entirely; the ceiling is the app.
 *
 * ```ts
 * export const site = pharos(nav, { prevNext: 'graph' });   // pharos(docs) wraps a single collection
 *
 * // (docs)/[...slug]/+page.ts
 * export const prerender = true;
 * export const { load, entries } = site;
 * ```
 */
import { error, redirect } from '@sveltejs/kit';
import type { Component } from 'svelte';
import type { Entry, LinkRef } from '../content/index.js';
import { build_llms, build_sitemap, strip_frontmatter } from './emit.js';
import { href_of, outline, type Collection, type Outline, type OutlineSpec } from './outline.js';
import { is_dimensioned, type Switcher } from './dimensions.js';
import { build_docs, create_search, orama_engine, type SearchBrain, type SearchEngine } from './search.js';
import type { BaseOption, DocView, Heading, NavRef, NavTree, PrevNext } from './types.js';

/** Link-audit tuning. `audit: true` = all defaults. */
export type AuditOptions = {
	/** Validate `#fragments` against the target page's collected headings (default `true`).
	 *  Turn off if your pages link to hand-placed ids the h2–h4 collector can't see. */
	anchors?: boolean;
	/** Policy for links that resolve through a declared redirect: they WORK (308), but are stale.
	 *  `'warn'` (default) logs; `'error'` fails like a broken link; `'ok'` stays silent. */
	redirected?: 'error' | 'warn' | 'ok';
	/** Skip hrefs the audit should not judge (e.g. generated or intentionally external-ish paths). */
	ignore?: (href: string) => boolean;
};

/** Site-level facts, surfaced as `site.data` and used as the default for every emission. */
export type SiteData = {
	/** Site name — llms.txt header, `<title>` suffix, shell brand default. */
	title: string;
	/** One-line description — llms.txt, meta description. */
	description: string;
	/** Absolute origin for machine emissions (sitemap/llms), which can't read the request when prerendered. */
	origin: string;
};

/** A request context the site derives per read (preview, roles) and threads into collection filters. */
export type ReadContext = Record<string, unknown>;

/** The single-object argument to `pharos()`. `outline` is the only required key. */
export type PharosOptions = {
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
	/**
	 * Validate each page's markdown links (`meta.links`) against the site's address space inside
	 * `load`. A broken link THROWS: the build fails during prerender, and dev errors on page open —
	 * the same check in every render mode, which Kit's prerender-only crawler can't give you.
	 */
	audit?: boolean | AuditOptions;
	/**
	 * Override markdown element rendering with components — real VALUES, in app code (no import
	 * paths). Reaches the compiled `PharosSlot` via context. Built-in default: `a → Link`.
	 */
	components?: Record<string, Component<Record<string, unknown>>>;
	/** Full-text search config. The default engine is Orama (optional peer); swap via `engine`. */
	search?: { engine?: SearchEngine };
	/** Old addresses an entry declares for itself (redirect history). Default reads `data.redirect_from`. */
	redirects?: (entry: import('../content/index.js').ContentRef) => string[] | string | undefined;
};

/** One broken link: the page that holds it, the href, and why it failed. */
export type AuditFinding = {
	page: string;
	href: string;
	text?: string;
	/** Approximate (relative to post-frontmatter source). */
	line?: number;
	reason: 'missing-page' | 'missing-anchor';
};
/** A link that works but goes through declared redirect history — update it when convenient. */
export type AuditRedirected = { page: string; href: string; canonical: string; line?: number };
export type AuditReport = { broken: AuditFinding[]; redirected: AuditRedirected[] };

/** The minimal SvelteKit `load` event shape the guard reads (kept narrow so it stays isomorphic). */
type LoadLike = { params: Record<string, string | undefined>; url: URL | { pathname: string } };

/** The minimal request-event shape an emission handler reads. Assignable from Kit's `RequestEvent`. */
type EmitEvent = { url: URL };
/** A GET handler an emission mounts as. `export const GET = site.emit.sitemap({ base })`. */
export type EmitHandler = (event: EmitEvent) => Promise<Response>;
/** Common emission options. `origin` overrides the request origin (needed for prerendered output). */
export type EmitOptions = { base?: string; origin?: string };
export type LlmsEmitOptions = EmitOptions & { title?: string; description?: string };

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
	/** The element-override component map (user overrides; `PharosSlot` adds the `a → Link` default).
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
	/** Everything one page position needs, or `null` for an unknown slug. Call in the page component.
	 *  Pass `context` (e.g. `{ preview: true }`) to see the same projection the load guard used. */
	doc: <Data extends Record<string, unknown> = Record<string, unknown>, Meta = unknown>(slug: string, opts?: BaseOption & { context?: ReadContext }) => Promise<DocView<Data, Meta> | null>;
	/** Whole-site link audit as plain data (never throws) — for vitest/CI, and for dynamic sites
	 *  where the prerender crawler never runs. */
	audit: (opts?: { base?: string; ignore?: (href: string) => boolean }) => Promise<AuditReport>;
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

type AuditCfg =
	| (Required<Pick<AuditOptions, 'anchors' | 'redirected'>> & Pick<AuditOptions, 'ignore'>)
	| null;

/**
 * The site brains as a class — state (outline, prevNext, audit policy, search) as fields, each brain
 * a method. `pharos()` mints one; nothing here is global or registered.
 */
class PharosSite implements Site {
	readonly outline: Outline;
	readonly data?: SiteData;
	readonly components: Record<string, Component<Record<string, unknown>>>;
	readonly search: SearchBrain;
	readonly #prevNext: PrevNext;
	readonly #audit: AuditCfg;
	readonly #base: string;
	readonly #context?: PharosOptions['context'];
	/** Collections already warned about (audit on, but the format collects no `meta.links`). Warn once. */
	readonly #auditWarned = new WeakSet<object>();

	constructor(opts: PharosOptions) {
		const source = opts.outline;
		this.outline = is_outline(source)
			? source
			: outline(source as OutlineSpec, opts.redirects ? { redirects: opts.redirects } : {});
		this.#prevNext = opts.prevNext ?? 'order';
		this.#audit = opts.audit
			? {
					anchors: (opts.audit === true ? undefined : opts.audit.anchors) ?? true,
					redirected: (opts.audit === true ? undefined : opts.audit.redirected) ?? 'warn',
					...(opts.audit !== true && opts.audit.ignore ? { ignore: opts.audit.ignore } : {})
				}
			: null;
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
			if (this.#audit) {
				const base = mountBase(url, slug);
				const entry = await hit.collection.get(hit.record.entryId, ctx);
				// The audit reads `meta.links`, which only the markdown format collects. A blocks/CMS
				// corpus provides none, so the audit silently passes it — warn once so that isn't mistaken
				// for "no broken links". Any format can fill `meta.links` to opt this collection back in.
				if (!has_link_data(entry?.meta) && !this.#auditWarned.has(hit.collection)) {
					this.#auditWarned.add(hit.collection);
					if (import.meta.env?.DEV) {
						console.warn(`[ogygia/pharos] audit is on, but '${slug}' comes from a collection whose entries carry no 'meta.links' (only markdown collects them). Link checking is a NO-OP for this corpus — fill 'meta.links' in the format to enable it.`);
					}
				}
				const { broken, redirected } = await check_links(ol, slug, extract_links(entry?.meta), base, this.#audit, ctx);
				if (redirected.length && this.#audit.redirected !== 'ok') {
					const lines = redirected.map((r) => `  '${r.href}' works via redirect_from → update to ${r.canonical}`);
					if (this.#audit.redirected === 'error') broken.push(...redirected.map((r) => ({ page: r.page, href: r.href, reason: 'missing-page' as const, ...(r.line !== undefined ? { line: r.line } : {}) })));
					else console.warn(`[ogygia/pharos] ${slug}: stale link${redirected.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
				}
				if (broken.length) throw new Error(format_findings(slug, broken, hit.record.filePath));
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

	async audit(o: { base?: string; ignore?: (href: string) => boolean } = {}) {
		const ol = this.outline;
		const report: AuditReport = { broken: [], redirected: [] };
		const base = o.base ?? this.#base;
		for (const slug of await ol.addresses()) {
			const hit = await ol.resolve(slug);
			if (!hit) continue;
			const entry = await hit.collection.get(hit.record.entryId);
			const { broken, redirected } = await check_links(ol, slug, extract_links(entry?.meta), base, { anchors: true, ...(o.ignore ? { ignore: o.ignore } : {}) });
			report.broken.push(...broken);
			report.redirected.push(...redirected);
		}
		return report;
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
		const { prev, next } = await ol.neighbors(record.slug, base, ctx);
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

/** Mint the site brains. `pharos({ outline })` is the only required key; a bare collection auto-weaves. */
export function pharos(opts: PharosOptions): Site {
	return new PharosSite(opts);
}

/** Pull `headings` off a source-derived meta (`markdown` supplies it), defensively. */
function extract_headings(meta: unknown): Heading[] {
	if (meta && typeof meta === 'object' && 'headings' in meta) {
		const h = (meta as { headings: unknown }).headings;
		if (Array.isArray(h)) return h as Heading[];
	}
	return [];
}

/** Did the source's format collect link data at all? `links: []` counts; an absent property does not. */
function has_link_data(meta: unknown): boolean {
	return !!meta && typeof meta === 'object' && 'links' in meta;
}

/** Pull `links` off a source-derived meta (`markdown` supplies it), defensively. */
function extract_links(meta: unknown): LinkRef[] {
	if (meta && typeof meta === 'object' && 'links' in meta) {
		const l = (meta as { links: unknown }).links;
		if (Array.isArray(l)) return l as LinkRef[];
	}
	return [];
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Classify + resolve one page's collected links against the address space. Judges only what is
 * OURS: `#self-anchors` and absolute paths under the mount `base`. External URLs, paths outside the
 * mount, and relative asset links pass through unjudged.
 */
async function check_links(
	ol: Outline,
	page: string,
	links: LinkRef[],
	base: string,
	opts: { anchors: boolean; ignore?: (href: string) => boolean },
	ctx: ReadContext = {}
): Promise<{ broken: AuditFinding[]; redirected: AuditRedirected[] }> {
	const broken: AuditFinding[] = [];
	const redirected: AuditRedirected[] = [];
	const b = (base || '').replace(/\/+$/, '');

	for (const link of links) {
		const href = link.href;
		if (!href || opts.ignore?.(href)) continue;

		let path: string;
		let frag: string | undefined;
		if (href.startsWith('#')) {
			path = page;
			frag = href.slice(1);
		} else if (URL_SCHEME.test(href) || href.startsWith('//')) {
			continue; // external — not ours to judge
		} else if (href.startsWith('/')) {
			let rest: string;
			if (b && (href === b || href.startsWith(b + '/'))) rest = href.slice(b.length);
			else if (!b) rest = href;
			else continue; // absolute, but outside the mount — the app's business, not the site's
			const [p, f] = rest.split('#');
			path = p.replace(/^\/+|\/+$/g, '');
			frag = f;
		} else {
			continue; // relative (colocated asset etc.) — not judged
		}

		const at = { page, href, ...(link.text ? { text: link.text } : {}), ...(link.line !== undefined ? { line: link.line } : {}) };
		const hit = await ol.resolve(path, ctx);
		if (hit) {
			if (frag && opts.anchors) {
				const target = await hit.collection.get(hit.record.entryId, ctx);
				if (!extract_headings(target?.meta).some((h) => h.id === frag)) {
					broken.push({ ...at, reason: 'missing-anchor' });
				}
			}
			continue;
		}
		const canonical = await ol.alias(path, ctx);
		if (canonical) {
			redirected.push({ page, href, canonical: href_of(b, canonical), ...(link.line !== undefined ? { line: link.line } : {}) });
			continue;
		}
		broken.push({ ...at, reason: 'missing-page' });
	}

	return { broken, redirected };
}

/** One thrown message for a page's broken links — file-anchored, every finding named. */
function format_findings(slug: string, findings: AuditFinding[], filePath: string | undefined): string {
	const rows = findings.map((f) => `  - '${f.href}'${f.line !== undefined ? ` (line ~${f.line})` : ''}: ${f.reason}${f.text ? ` — link text "${f.text}"` : ''}`);
	return `[ogygia/pharos] broken link${findings.length === 1 ? '' : 's'} on '${slug}'${filePath ? ` (${filePath})` : ''}:\n${rows.join('\n')}`;
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
