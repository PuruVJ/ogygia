/**
 * Minimal SPA router for ogygia (Astro's ClientRouter equivalent).
 *
 * Intercepts same-origin <a> clicks, fetches the target page, swaps <body>,
 * merges <head>, and updates history. `data-ogygia-keep` keeps matching chrome.
 * Islands on the new page auto-initialise via custom-element connection; old ones
 * auto-unmount via disconnection (except inside persisted subtrees).
 */
import { html_has_kit_bootstrap, document_has_kit_bootstrap } from './kit-boot.js';
import { PageCache } from './page-cache.js';
import { slots } from './slots.js';
import { dispose_scope } from '../ref.js';
import { reconcile_body, region_in_shadow } from './reconcile.js';
import { emit as dt_emit } from '../devtools/bus.js';

// DEVTOOLS gate — module-local const from the Vite `define` (proven DCE pattern); off → folds out.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;
/** High-res clock for devtools nav timings (guarded — dead when off). */
const dt_now = () =>
	typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/** RECONCILER R1: when on (and morph is installed), a nav diffs the body IN PLACE — matched regions
 *  keep their live islands, changed regions re-mount, the shell morphs — instead of a full-body
 *  replaceWith. Flip to `false` to fall back to the legacy full-swap path (the e2e safety net). */
const RECONCILE_NAV = true;
import { runtime_session } from './session.js';
import { island_module_url, warm_island_module } from './region-endpoint-url.js';
import { speculate_url } from './speculate-hint.js';

const WS = /\s+/;

/** Max bytes for the `x-ogygia-known` header — past this we OMIT it, so the server renders every
 *  region (the safe full-render fallback). Keeps request headers well under proxy/server limits. */
const KNOWN_HEADER_CAP = 6144;

/** SERVER-DELTA NAV is OPT-IN for the first release (a new client↔server protocol). Off → the client
 *  never sends `x-ogygia-known`, so `known_region_fps()` is always empty server-side and every region
 *  full-renders (the documented safe fallback). Compile-time constant (Vite `define`); typeof-guarded
 *  so a plain node import of dist/ without the define falls back to OFF. */
const SERVER_DELTA =
	typeof __OGYGIA_SERVER_DELTA__ !== 'undefined' ? __OGYGIA_SERVER_DELTA__ : false;

/**
 * SERVER-DELTA NAV (D2): headers for a nav/prefetch fetch. Always `x-ogygia-spa`. Plus, when the
 * current document has HYDRATED islands carrying a `data-og-fp`, `x-ogygia-known` lists their
 * fingerprints so the server can SKIP re-rendering the ones this page already has live. Only
 * data-hydrated regions are claimed (never assert a region we don't actually have), and the header
 * is omitted past a size cap → the server renders everything (progressive enhancement: the header
 * is an optimization the server may ignore, and its absence is always correct).
 */
function nav_headers(): Record<string, string> {
	const headers: Record<string, string> = { 'x-ogygia-spa': '1' };
	if (!SERVER_DELTA || typeof document === 'undefined') return headers;
	const seen = new Set<string>();
	for (const el of document.querySelectorAll('ogygia-region[data-og-fp][data-hydrated]')) {
		const fp = el.getAttribute('data-og-fp');
		if (fp) seen.add(fp);
	}
	if (seen.size === 0) return headers;
	const joined = [...seen].join(',');
	if (joined.length <= KNOWN_HEADER_CAP) headers['x-ogygia-known'] = joined;
	return headers;
}

/**
 * Fold ORPHANED `view-transition-name`s into the page-level cross-fade. A name promotes its element
 * to a standalone transition group, LIFTED OUT of the root snapshot. When the element has no
 * counterpart on the other page — a sidebar full of named nav rows navigating to a marketing page
 * that has none — each one runs a solo enter/exit AND leaves a hole in the root cross-fade: a visible
 * stutter, worst in dev where the destination paints late. Names present on BOTH pages (the docs↔docs
 * active-highlight slide) are KEPT, so matched animations still play. Only INLINE names are touched
 * (nav rows carry theirs inline; the single CSS-set highlight chip is left alone). Returns a restore
 * fn to re-apply the stripped names AFTER the transition, so a page entered across a shell change
 * still animates on its next same-shell nav.
 */
function fold_orphan_vt_names(current: ParentNode, incoming: ParentNode): () => void {
	const names_in = (root: ParentNode): Map<string, HTMLElement[]> => {
		const map = new Map<string, HTMLElement[]>();
		for (const el of root.querySelectorAll<HTMLElement>('[style*="view-transition-name"]')) {
			const n = el.style.getPropertyValue('view-transition-name').trim();
			if (!n || n === 'none') continue;
			let arr = map.get(n);
			if (!arr) map.set(n, (arr = []));
			arr.push(el);
		}
		return map;
	};
	const cur = names_in(current);
	const inc = names_in(incoming);
	const stripped: Array<[HTMLElement, string]> = [];
	const fold = (map: Map<string, HTMLElement[]>, other: Map<string, HTMLElement[]>) => {
		for (const [name, els] of map) {
			if (other.has(name)) continue; // matched on both pages — keep (the slide)
			for (const el of els) {
				stripped.push([el, name]);
				el.style.setProperty('view-transition-name', 'none');
			}
		}
	};
	fold(cur, inc); // current-only (docs→marketing): fold into the root exit
	fold(inc, cur); // incoming-only (marketing→docs): fold into the root enter
	return () => {
		for (const [el, name] of stripped) el.style.setProperty('view-transition-name', name);
	};
}

// SvelteKit's remote-function client (which ogygia reuses for query/command) patches
// `history.pushState`/`replaceState` on the instance and warns whenever they are called directly.
// On csr=false pages ogygia owns navigation — Kit's router is not running — so we update history via
// the un-patched `History.prototype` methods. Same effect on the history stack, without the spurious
// "conflict with SvelteKit's router" warning. Captured lazily so a test/SSR without `History` is safe.
const native_push = typeof History !== 'undefined' ? History.prototype.pushState : null;
const native_replace = typeof History !== 'undefined' ? History.prototype.replaceState : null;
const push_state = (state: unknown, url: string) =>
	(native_push ?? history.pushState).call(history, state, '', url);
const replace_state = (state: unknown, url?: string) => {
	const fn = native_replace ?? history.replaceState;
	return url === undefined ? fn.call(history, state, '') : fn.call(history, state, '', url);
};

// ---- navigation lifecycle hooks (for the $app/navigation shim + `ogygia/app`) ----

/** Resolved navigation target (URL + Kit-shaped stubs for params/route). */
export interface NavTarget {
	url: URL;
	params: Record<string, string>;
	route: { id: string | null };
}

/** Payload for {@link beforeNavigate} callbacks. */
export interface BeforeNavigation {
	from: NavTarget;
	to: NavTarget;
	type: string;
	cancel: () => void;
	willUnload: boolean;
}

/** Payload for {@link afterNavigate} callbacks. */
export interface AfterNavigation {
	from: NavTarget | null;
	to: NavTarget;
	type: string;
	willUnload: boolean;
}

/** Callback registered with {@link beforeNavigate}. */
export type BeforeNavigateCallback = (nav: BeforeNavigation) => void;
/** Callback registered with {@link afterNavigate}. */
export type AfterNavigateCallback = (nav: AfterNavigation) => void;

const PREFETCH_TTL_MS = 8_000;
const PAGE_CACHE_MAX_ENTRIES = 32;
const PAGE_CACHE_MAX_BYTES = 4_000_000; // ~4MB of UTF-16-ish HTML
/** Cap on waiting for a destination stylesheet to load before the body swap (cold-cache FOUC guard). */
const STYLESHEET_WAIT_MS = 2_000;
/** Responses that must never warm the SPA HTML cache (personalized / must revalidate). */
const CC_UNCACHEABLE = /(?:^|,)\s*(?:private|no-store|no-cache)\b/i;
/** Kit remote-function POSTs live under `…/_app/remote/…` (or custom `appDir`). */
const REMOTE_MUTATION_PATH = /\/remote(?:\/|$|\?)/;

// In this router a page's "code" is delivered by the HTML body swap (+ island chunks fetched on
// connect), so BOTH `data-sveltekit-preload-data` and `-code` warm the SAME page-HTML cache. We
// honour Kit's value grammar + nearest-ancestor inheritance: 'eager' | 'viewport' | 'hover' | 'tap'
// | 'off'/'false'. An anchor's effective trigger is the MOST-EAGER of the two attributes; an empty
// value means 'hover' (Kit's default). `-data` is normally hover/tap; `-code` adds eager/viewport.
const PRELOAD_RANK: Record<string, number> = {
	eager: 0,
	viewport: 1,
	hover: 2,
	tap: 3,
	off: 4,
	false: 4
};

/** Stable-ish head node identity without serializing full outerHTML when possible. */
export function head_node_key(node: Element): string {
	const tag = node.tagName;
	switch (tag) {
		case 'TITLE':
			return 'TITLE';
		case 'META': {
			const charset = node.getAttribute('charset');
			if (charset != null) return 'META:charset';
			const http_equiv = node.getAttribute('http-equiv');
			if (http_equiv) return `META:http:${http_equiv}:${node.getAttribute('content') || ''}`;
			const name = node.getAttribute('name') || node.getAttribute('property') || '';
			if (name) return `META:${name}:${node.getAttribute('content') || ''}`;
			return `META:${node.outerHTML}`;
		}
		case 'LINK':
			return `LINK:${node.getAttribute('rel') || ''}:${node.getAttribute('href') || ''}:${node.getAttribute('as') || ''}`;
		case 'SCRIPT': {
			const src = node.getAttribute('src');
			if (src) return `SCRIPT:src:${src}:${node.getAttribute('type') || ''}`;
			const type = node.getAttribute('type') || '';
			const text = node.textContent || '';
			return `SCRIPT:inline:${type}:${text.length}:${text.slice(0, 48)}`;
		}
		case 'STYLE': {
			// Kit's FOUC bag is one per document — key by role so SPA swaps replace it
			// instead of stacking length-prefixed duplicates or keeping a stale bag.
			if (node.hasAttribute('data-sveltekit')) return 'STYLE:data-sveltekit';
			const vite_id = node.getAttribute('data-vite-dev-id');
			if (vite_id) return `STYLE:vite:${vite_id}`;
			const text = node.textContent || '';
			return `STYLE:${text.length}:${text.slice(0, 48)}`;
		}
		default:
			return `${tag}:${node.outerHTML}`;
	}
}

/**
 * Head nodes that must survive SPA swaps even when absent from the next SSR head.
 * @internal
 */
export function keep_head_node_across_spa(node: Element): boolean {
	if (
		node.tagName === 'SCRIPT' &&
		node.getAttribute('type') === 'module' &&
		(node.hasAttribute('data-ogygia-runtime') || node.hasAttribute('data-ogygia-dev-hmr'))
	) {
		return true;
	}
	// Vite soft-HMR CSS injections — not present in SSR HTML; dropping them blanks
	// styles that only lived in the client graph after the FOUC bag was replaced.
	if (node.tagName === 'STYLE' && node.hasAttribute('data-vite-dev-id')) return true;
	if (
		node.tagName === 'LINK' &&
		node.getAttribute('rel') === 'stylesheet' &&
		node.hasAttribute('data-vite-dev-id')
	) {
		return true;
	}
	return false;
}

/**
 * Install a `<style>` into the live document. `cloneNode` from a `DOMParser` tree
 * often fails to register the sheet; recreate with textContent instead.
 * @internal
 */
export function install_head_style(source: Element, head: HTMLHeadElement = document.head) {
	const el = document.createElement('style');
	for (const attr of Array.from(source.attributes)) {
		el.setAttribute(attr.name, attr.value);
	}
	el.textContent = source.textContent || '';
	head.appendChild(el);
	return el;
}

/**
 * Whether a fetch response may warm the SPA page-HTML cache.
 * @param cacheControl - Response `Cache-Control` header value.
 * @param setCookie - True if the response included `Set-Cookie`.
 * @returns False when the response is private / no-store / no-cache or set a cookie.
 */
export function spa_html_cacheable(cacheControl: string, setCookie: boolean): boolean {
	return !CC_UNCACHEABLE.test(cacheControl || '') && !setCookie;
}

/** Same document = pathname + search. Hash is not part of document identity. */
/** Apply STREAMED-page late chunks after an SPA body swap: move each inert
 *  `<template data-og-late>` into its `og-late-slot` (stylesheets hoisted first via the same
 *  keyed head installer, so the swap never paints unstyled). On a full load the inline boot
 *  script in the streamed head does this progressively during parse — this is the swap-path
 *  twin. Islands inside the adopted content are custom elements: they connect and wake alone. */
export function apply_late_templates(root: ParentNode) {
	for (const tpl of Array.from(root.querySelectorAll('template[data-og-late]'))) {
		const id = tpl.getAttribute('data-og-late') ?? '';
		const slot = document.querySelector(`og-late-slot[data-og-slot="${CSS.escape(id)}"]`);
		if (slot) {
			const content = (tpl as HTMLTemplateElement).content;
			for (const sheet of Array.from(content.querySelectorAll('link[rel="stylesheet"], style'))) {
				install_head_style(sheet);
			}
			slot.replaceChildren(content);
		}
		tpl.remove();
	}
}

function same_document(a: URL, b: URL) {
	return a.pathname === b.pathname && a.search === b.search;
}

function document_key(url: URL) {
	return url.pathname + url.search;
}

/** Instant scroll to a hash target (or top). Ignores CSS `scroll-behavior: smooth`. */
function jump_to_hash(hash: string) {
	const html_el = document.documentElement;
	const prev = html_el.style.scrollBehavior;
	html_el.style.scrollBehavior = 'auto';
	try {
		if (hash) {
			let id: string;
			try {
				id = decodeURIComponent(hash.startsWith('#') ? hash.slice(1) : hash);
			} catch {
				id = hash.startsWith('#') ? hash.slice(1) : hash;
			}
			const el = document.getElementById(id);
			if (el) {
				el.scrollIntoView();
				return;
			}
		}
		window.scrollTo(0, 0);
	} finally {
		html_el.style.scrollBehavior = prev;
	}
}

/** Head nodes that must never be adopted from SPA HTML (rewrite relative fetches / CSP). */
function is_dangerous_head_node(node: Element): boolean {
	const tag = node.tagName;
	if (tag === 'BASE') return true;
	if (tag === 'META') {
		const http_equiv = (node.getAttribute('http-equiv') || '').toLowerCase();
		if (
			http_equiv === 'refresh' ||
			http_equiv === 'content-security-policy' ||
			http_equiv === 'content-security-policy-report-only'
		) {
			return true;
		}
	}
	return false;
}

class SpaRouter {
	#started = false;
	#before_hooks = new Set<BeforeNavigateCallback>();
	#after_hooks = new Set<AfterNavigateCallback>();
	#page_cache = new PageCache({
		ttlMs: PREFETCH_TTL_MS,
		maxEntries: PAGE_CACHE_MAX_ENTRIES,
		maxBytes: PAGE_CACHE_MAX_BYTES
	});
	#inflight = new Map<string, Promise<string | null>>();
	/** Hrefs whose prefetched HTML was already scanned for island entries — parse once. (URL-level
	 *  import dedupe lives in the shared `warm_island_module`.) */
	#warmed_pages = new Set<string>();
	#remote_bust_installed = false;
	/** Hard SPA navigations only — never shared with soft invalidate. */
	#nav_gen = 0;
	#nav_abort: AbortController | null = null;
	/** Soft invalidate fetches only — aborting these must not cancel a real click nav. */
	#soft_gen = 0;
	#soft_abort: AbortController | null = null;
	#viewport_io: IntersectionObserver | null = null;
	#viewport_seen = new WeakSet<Element>();
	/** pathname+search of the document currently in the DOM (hash ignored). */
	#doc_key = '';
	/**
	 * Full URL of the document currently displayed in the DOM. `navigate()` uses this as its `from`
	 * instead of `location.href`, because on a `popstate` (back/forward) the browser has ALREADY
	 * changed `location` to the target — so `location.href` would equal the target and the
	 * same-document guard would wrongly bail into the hash-only branch, never swapping the body
	 * (browser back left the old page's DOM in place). POP-FROM.
	 */
	#current_url: URL | null = null;

	beforeNavigate(fn: BeforeNavigateCallback) {
		this.#before_hooks.add(fn);
		return () => this.#before_hooks.delete(fn);
	}

	afterNavigate(fn: AfterNavigateCallback) {
		this.#after_hooks.add(fn);
		// $app/navigation's afterNavigate fires immediately on mount too
		try {
			fn({
				from: null,
				to: this.#build_nav_target(new URL(location.href)),
				type: 'enter',
				willUnload: false
			});
		} catch {
			/* noop */
		}
		return () => this.#after_hooks.delete(fn);
	}

	bust_page_cache() {
		this.#page_cache.clear();
		this.#inflight.clear();
	}

	_page_cache_size() {
		return this.#page_cache.size;
	}

	install_remote_mutation_cache_bust() {
		if (
			this.#remote_bust_installed ||
			typeof window === 'undefined' ||
			typeof window.fetch !== 'function'
		) {
			return;
		}
		this.#remote_bust_installed = true;
		const orig = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const res = await orig(input, init);
			try {
				const method = (
					init?.method ||
					(typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
				).toUpperCase();
				if (method !== 'GET' && method !== 'HEAD' && res.ok) {
					const href =
						typeof input === 'string'
							? input
							: input instanceof URL
								? input.href
								: (input as Request).url;
					if (REMOTE_MUTATION_PATH.test(href)) this.bust_page_cache();
				}
			} catch {
				/* never break fetch */
			}
			return res;
		};
	}

	fetch_page(href: string, signal?: AbortSignal) {
		// Warm cache hit (a prefetched page, or an in-flight prefetch): serving it is instant, so
		// even an abortable navigation uses it — there is nothing to abort on a resolved cache hit
		// or a shared prefetch promise. Without this, a click after a hover-prefetch would re-fetch
		// (the whole point of prefetch is to skip that second request). Real navigations delete the
		// entry after use (one-shot — see navigate()), so the next visit is still fresh. PREFETCH-HIT.
		const cached = this.#page_cache.get(href);
		if (cached != null) return Promise.resolve(cached);
		const pending = this.#inflight.get(href);
		if (pending) return pending;

		const settled = fetch(href, {
			signal,
			headers: nav_headers()
		})
			.then(async (res) => {
				const ct = res.headers.get('content-type') || '';
				if (!ct.includes('text/html')) return { html: null as string | null, cacheable: false };
				// NOTE: we intentionally swap even non-2xx HTML (e.g. Kit's SSR'd 404/500
				// +error.svelte page) so error pages render without a full reload.
				const html = await res.text();
				const cc = res.headers.get('cache-control') || '';
				const cacheable = spa_html_cacheable(cc, res.headers.has('set-cookie'));
				return { html, cacheable };
			})
			.catch((err) => {
				if (err && (err as { name?: string }).name === 'AbortError') throw err;
				return { html: null as string | null, cacheable: false };
			});

		const html_p = settled.then((r) => r.html);

		// Prefetch (no signal): coalesce in-flight + insert only after cacheable is known.
		if (!signal) {
			this.#inflight.set(href, html_p);
			html_p.finally(() => {
				if (this.#inflight.get(href) === html_p) this.#inflight.delete(href);
			});
			settled
				.then((r) => {
					if (r.html == null) return;
					if (r.cacheable) this.#page_cache.set(href, r.html);
					// Warm the destination's island JS during the hover/idle runway, so the click path is
					// swap + hydrate with no first-time import() per island — the module graph is already
					// resolved when load_island() runs. This is the biggest prefetch win: without it, a warm
					// (HTML-cached) navigation still stalls hydration on cold island chunks.
					this.#warm_modules(href, r.html);
				})
				.catch(() => {});
		}
		return html_p;
	}

	/**
	 * Kick off import() for every island module the prefetched page will hydrate, so they are in the
	 * browser's module cache before the click. `import()` is idempotent (the loader dedupes by URL),
	 * and a warmed-URL guard skips re-parsing / re-importing across repeated hover+viewport triggers.
	 * A cheap attribute scan avoids building a whole detached Document during the hover window.
	 */
	#warm_modules(href: string, html: string) {
		if (this.#warmed_pages.has(href)) return;
		this.#warmed_pages.add(href);
		// Match `entry="…"` on ogygia-region open tags in our own SSR output (module URLs never contain
		// a double-quote), collecting the distinct client-island module specifiers. URL-level dedupe +
		// failure-retry live in the shared warmer (one scheme for router/visible/interaction warms).
		const re = /<ogygia-region\b[^>]*?\bentry="([^"]+)"/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(html))) warm_island_module(m[1], href);
	}

	// NOTE: the library does NO script processing. Scripts inserted via a client-side body swap do
	// not execute (standard browser behaviour for parsed/adopted <script> nodes) — if you need code
	// to run per navigation, use an island. Our own runtime module script is marked
	// `data-ogygia-runtime` and is the only module script merge_head retains across swaps.
	async navigate(
		url: URL,
		{
			push = true,
			pop_scroll = null,
			type = 'link',
			replace = false
		}: {
			push?: boolean;
			pop_scroll?: { x: number; y: number } | null;
			type?: string;
			replace?: boolean;
		} = {}
	) {
		const from = this.#current_url ?? new URL(location.href);

		// Same document, hash-only (or identical URL): never fetch / swap / view-transition.
		// (`invalidateAll` is a soft seed refresh — it does not call navigate.)
		if (same_document(url, from) && !replace) {
			if (!this.#run_before(from, url, type)) return;
			if (push && url.href !== location.href) {
				push_state({ ...(history.state || {}), ogygia: true }, url.href);
			} else if (url.href !== location.href) {
				replace_state({ ...(history.state || {}), ogygia: true }, url.href);
			}
			jump_to_hash(url.hash);
			this.#current_url = url;
			this.#run_after(from, url, type);
			return;
		}

		if (!this.#run_before(from, url, type)) return; // a beforeNavigate hook cancelled

		const dt_t0 = DEVTOOLS ? dt_now() : 0;
		let dt_reconciled = false;
		if (DEVTOOLS)
			dt_emit({
				domain: 'nav',
				name: 'nav.start',
				from: from.pathname + from.search,
				to: url.pathname + url.search,
				type
			});

		// Cancel any in-flight navigation; only the latest gen may apply a body swap (P2).
		this.#nav_abort?.abort();
		this.#nav_abort = new AbortController();
		const { signal } = this.#nav_abort;
		const gen = ++this.#nav_gen;

		// Update history SYNCHRONOUSLY (before any await) so the URL is correct and
		// races between overlapping navigations can't drop the pushState.
		if (replace) {
			replace_state({ ...(history.state || {}), ogygia: true }, url.href);
		} else if (push) {
			// save outgoing scroll into the current entry, then push the new URL
			replace_state({ ...(history.state || {}), scroll: { x: scrollX, y: scrollY } });
			push_state({ ogygia: true }, url.href);
		}

		let html: string | null;
		try {
			html = await this.fetch_page(url.href, signal);
		} catch (err) {
			if ((err as { name?: string })?.name === 'AbortError' || gen !== this.#nav_gen) return;
			location.href = url.href;
			return;
		}
		if (gen !== this.#nav_gen) return;
		if (html == null) {
			location.href = url.href;
			return;
		}
		this.#page_cache.delete(url.href); // one-shot; always fresh on real navigation

		// csr=true Kit pages boot via inline/module scripts that cloneNode will NOT execute.
		// Hand off to a full navigation instead of a half-broken SPA swap (BRK-HEAD).
		if (html_has_kit_bootstrap(html)) {
			location.href = url.href;
			return;
		}

		const doc = new DOMParser().parseFromString(html, 'text/html');

		// Mixed sites: if the target page has no `ogygia-router` marker (the handle injects it on
		// every ogygia page), it is not an ogygia page — hand over to a real document navigation
		// (and stop SPA behaviour from here on).
		const marker = doc.querySelector('meta[name="ogygia-router"]');
		if (!marker) {
			location.href = url.href;
			return;
		}
		// Same-document hash jumps already returned above (no VT). Cross-route swaps keep VT
		// even when the target has a hash (A → B#C); scroll snaps after the transition.
		const prefer_reduced_motion =
			typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
		const use_vt = marker.getAttribute('content') !== 'plain' && !prefer_reduced_motion;

		// SINGLE-FLIGHT NAV: prescan the incoming page for its load-timed deferred region calls and stream
		// them ALL in one batch request, kicked off now (before the swap). Each region binder joins the
		// batch via the store when it connects — no per-region fetch waterfall on navigation. Fired
		// synchronously so every reservation is in place before the body swap connects any binder.
		this.#batch_regions(doc);

		// Cold-cache FOUC guard: get the destination's stylesheets loaded and applied BEFORE the body
		// swap, so the first post-deploy navigation never flashes unstyled content (a full-width column
		// snapping to its styled width). Warm caches resolve this instantly. Old body keeps its styles
		// until the swap, so adding the sheets early is invisible.
		await this.#preload_stylesheets(doc.head);
		if (gen !== this.#nav_gen) return;

		const swap = () => {
			// Stale nav: do not mutate the DOM (view-transition can otherwise commit a superseded swap).
			if (gen !== this.#nav_gen) return;
			// LIFECYCLE (Astro-parity DOM events): last chance to read the OUTGOING page's DOM.
			document.dispatchEvent(new Event('og:before-swap'));
			this.#merge_head(doc.head); // keeps our runtime module script alive across swaps
			if (gen !== this.#nav_gen) return;
			// CONTINUITY: snapshot the LEAVING page's changed island form fields (session-scoped) so
			// returning to it restores what the visitor was mid-typing. Read the old body now.
			if (slots.forms.enabled && this.#current_url) {
				slots.forms.snapshot(document.body, this.#current_url.pathname);
			}
			// Clear session state BEFORE body connect so new regions never see the previous page.
			slots.spaLifecycle?.prepare();
			if (gen !== this.#nav_gen) return;
			if (
				RECONCILE_NAV &&
				slots.morph &&
				!region_in_shadow(document.body) &&
				!region_in_shadow(doc.body)
			) {
				// THE nav path: diff the live body toward the parsed one IN PLACE. Matched regions
				// (same fingerprint) keep their live hydrated node and island state; changed regions
				// re-mount; shell + keep-chrome (data-ogygia-keep) morph in place. Selective dispose of
				// only REMOVED regions' hub ids happens inside reconcile_body.
				reconcile_body(document.body, doc.body, slots.morph);
				dt_reconciled = true;
				document.title = doc.title;
				// KEPT islands don't remount, so re-seed the shared page store + remote seeds from the
				// new doc — `$app/state` page.url/params/data update reactively inside kept islands.
				slots.spaLifecycle?.softInvalidate(doc);
				runtime_session.settle_lakes_in(document.body);
			} else {
				// FALLBACK (reconcile off, or a region nested in an open shadow root morph can't pierce):
				// a plain full-body swap. Correct and safe, but keep-continuity does NOT survive here —
				// islands re-mount like a hard nav. This path is rare; the reconcile path above is the norm.
				if (DEVTOOLS)
					dt_emit({
						domain: 'nav',
						name: 'nav.fallback',
						reason: !slots.morph ? 'no-morph' : 'shadow-region'
					});
				document.body.replaceWith(doc.body);
				document.title = doc.title;
				runtime_session.settle_lakes_in(document.body);
				dispose_scope('page');
			}
			// STREAMED pages fetched over SPA nav arrive COMPLETE (fetch buffers the stream), so any
			// late templates still inert in the parsed doc apply now — the inline boot script that
			// handles them on a full load never executes across a body swap.
			apply_late_templates(document.body);
			// Old islands disconnected; new hydrates are awaiting — sweep stale Kit remotes now.
			slots.spaLifecycle?.finish();
			// CONTINUITY: restore fields the visitor left on THIS page in a prior visit (this session).
			if (slots.forms.enabled) slots.forms.restore(url.pathname);
			// LIFECYCLE: the INCOMING page's DOM is in place (islands may still be waking on their
			// own schedules — this is the DOM milestone, not a hydration barrier).
			document.dispatchEvent(new Event('og:after-swap'));
		};

		if (use_vt && document.startViewTransition) {
			// Fold names with no counterpart on the destination into the page cross-fade, so a shell
			// change (docs sidebar ↔ marketing page) doesn't fire dozens of solo enter/exits over a
			// holed-out root snapshot. Matched names (the docs↔docs highlight slide) are untouched.
			// Captured NOW — before the transition snapshots `before` — and restored after it settles.
			const restore_vt_names = fold_orphan_vt_names(document.body, doc.body);
			const t = document.startViewTransition(swap);
			// A rapid follow-up navigation skips this transition; the browser then rejects `.ready`
			// and `.finished` with "Transition was skipped". Nothing awaits those, so without a catch
			// they surface as unhandled rejections (console noise, no functional effect). Swallow them.
			t.ready?.catch(() => {});
			// Restore folded names once the transition settles (resolve OR skip) — the next same-shell
			// nav needs them back, and this doubles as the `.finished` rejection catch.
			(t.finished ?? Promise.resolve()).then(restore_vt_names, restore_vt_names);
			await t.updateCallbackDone.catch(() => {});
		} else {
			swap();
		}
		if (gen !== this.#nav_gen) return;

		this.#doc_key = document_key(url);
		this.#current_url = url;
		if (DEVTOOLS)
			dt_emit({
				domain: 'nav',
				name: 'nav.finish',
				to: url.pathname + url.search,
				ms: dt_now() - dt_t0,
				reconciled: dt_reconciled,
				vt: !!(use_vt && document.startViewTransition)
			});

		// Instant after a body swap — CSS smooth must not animate programmatic post-nav scroll.
		if (replace) {
			// same-URL replace navigate — keep current scroll
		} else if (pop_scroll) {
			const html_el = document.documentElement;
			const prev = html_el.style.scrollBehavior;
			html_el.style.scrollBehavior = 'auto';
			try {
				window.scrollTo(pop_scroll.x, pop_scroll.y);
			} finally {
				html_el.style.scrollBehavior = prev;
			}
		} else {
			jump_to_hash(url.hash);
		}

		this.#run_after(from, url, type);
		// LIFECYCLE: the navigation is COMPLETE (head merged, body in place, scroll settled) — the
		// per-navigation hook for code that a body swap's inert <script> tags can never run. Also
		// fired once on initial load by the runtime boot, so ONE listener covers every page view.
		document.dispatchEvent(new Event('og:page-load'));
		// new <body> -> re-evaluate eager/viewport preload links on the freshly-swapped page
		this.#scan_eager_viewport();
	}

	goto(url: string | URL, opts: { replaceState?: boolean; external?: boolean } = {}) {
		const target = new URL(url, location.href);
		if (target.protocol !== 'http:' && target.protocol !== 'https:') {
			throw new Error('[ogygia] goto() only supports http(s) URLs');
		}
		if (target.origin !== location.origin) {
			if (opts.external) {
				location.assign(target.href);
				return Promise.resolve();
			}
			throw new Error(
				'[ogygia] goto() only supports same-origin URLs (pass { external: true } to leave)'
			);
		}
		return this.navigate(target, { push: !opts.replaceState, replace: false, type: 'goto' });
	}

	/**
	 * Soft invalidate: refresh page/remote seeds for the current URL without navigation.
	 *
	 * Kit's `invalidateAll` re-runs loads in place — it is **not** a navigation (no
	 * `beforeNavigate` / `afterNavigate`). Remote `form()` always calls this on success; a
	 * full SPA navigate+VT here was wiping live island state. We bust the HTML cache,
	 * re-fetch, merge head, and refresh document seeds only — no VT, no body swap, no
	 * island remount, no live query-map clear, no auto-refresh of live queries. Islands
	 * that need query updates use `.refresh()`, or `submit().updates(q)` with server
	 * `requested(q).refreshAll()` (updates alone does not populate response `q`).
	 *
	 * Uses a separate abort/generation from hard `navigate()` so soft fetches never cancel
	 * an in-flight click navigation (and vice versa).
	 */
	async invalidateAll() {
		this.bust_page_cache();
		const url = new URL(location.href);

		this.#soft_abort?.abort();
		this.#soft_abort = new AbortController();
		const { signal } = this.#soft_abort;
		const gen = ++this.#soft_gen;

		let html: string | null;
		try {
			html = await this.fetch_page(url.href, signal);
		} catch (err) {
			if ((err as { name?: string })?.name === 'AbortError' || gen !== this.#soft_gen) return;
			return;
		}
		if (gen !== this.#soft_gen || html == null) return;
		if (html_has_kit_bootstrap(html)) return;

		const doc = new DOMParser().parseFromString(html, 'text/html');
		if (!doc.querySelector('meta[name="ogygia-router"]')) return;

		this.#merge_head(doc.head);
		slots.spaLifecycle?.softInvalidate(doc);
	}

	invalidate() {
		return this.invalidateAll();
	}

	preloadData(url: string | URL) {
		const target = new URL(url, location.href);
		if (target.origin !== location.origin)
			return Promise.resolve({ type: 'loaded', status: 200, data: {} });
		this.fetch_page(target.href);
		return Promise.resolve({ type: 'loaded', status: 200, data: {} });
	}

	preloadCode() {
		// island chunks are code-split & fetched on connect; nothing to warm here.
		return Promise.resolve();
	}

	disableScrollHandling() {
		if (typeof console !== 'undefined') {
			console.warn('[ogygia] disableScrollHandling() is a no-op in the islands SPA router.');
		}
	}

	pushState() {
		console.warn('[ogygia] pushState() shallow routing is not supported; use goto().');
	}

	replaceState() {
		console.warn('[ogygia] replaceState() shallow routing is not supported; use goto().');
	}

	start() {
		if (this.#started || typeof document === 'undefined') return;
		// Only activate when the page carries the `ogygia-router` marker (the handle injects it
		// globally unless `ogygia({ router: false })`).
		if (!document.querySelector('meta[name="ogygia-router"]')) return;
		// Gradual migration: the marker is on every ogygia page, but some routes may stay csr=true.
		// On those pages Kit owns navigation — do not intercept clicks alongside it.
		if (document_has_kit_bootstrap()) return;
		this.#started = true;
		this.#doc_key = document_key(new URL(location.href));
		this.#current_url = new URL(location.href);
		this.install_remote_mutation_cache_bust();

		document.addEventListener('click', (event) => {
			const anchor = event.target instanceof Element ? event.target.closest('a') : null;
			const url = this.#should_intercept(event, anchor);
			if (!url) return;
			// Same document (incl. #hash-only): let the browser handle — never SPA-swap.
			if (same_document(url, new URL(location.href))) return;
			event.preventDefault();
			this.navigate(url, { push: true });
		});

		this.#install_prefetch();

		window.addEventListener('popstate', () => {
			const url = new URL(location.href);
			// Hash-only back/forward on the same document — browser already updated the URL;
			// do not fetch or swap. Scroll to the target if present.
			if (document_key(url) === this.#doc_key) {
				jump_to_hash(url.hash);
				return;
			}
			const pop_scroll = history.state?.scroll || null;
			this.navigate(url, { push: false, pop_scroll });
		});

		// seed initial history entry so scroll is restored on the first back
		replace_state({ ...(history.state || {}), ogygia: true });
	}

	/** Merge <head>: keep nodes present in both, remove stale, add new. Keeps runtime scripts alive. */
	#merge_head(new_head: HTMLHeadElement) {
		const current = document.head;
		const current_nodes = new Map<string, Element>();
		for (const node of Array.from(current.children)) {
			current_nodes.set(head_node_key(node), node);
		}
		const next_keys = new Set<string>();
		for (const node of Array.from(new_head.children)) {
			if (is_dangerous_head_node(node)) continue;
			next_keys.add(head_node_key(node));
		}
		// remove stale nodes — keep runtime / vite-dev CSS across swaps
		for (const [key, node] of current_nodes) {
			if (next_keys.has(key)) continue;
			if (keep_head_node_across_spa(node)) continue;
			node.remove();
		}
		// add / replace nodes (skip dangerous head policy tags)
		for (const node of Array.from(new_head.children)) {
			if (is_dangerous_head_node(node)) continue;
			const key = head_node_key(node);
			const existing = current_nodes.get(key);
			// Kit FOUC bag: always refresh content (same key every page, different CSS).
			if (key === 'STYLE:data-sveltekit') {
				existing?.remove();
				install_head_style(node);
				continue;
			}
			if (existing) continue;
			if (node.tagName === 'STYLE') {
				install_head_style(node);
			} else {
				current.appendChild(node.cloneNode(true));
			}
		}
	}

	/**
	 * Load the destination page's stylesheets into the live `<head>` and resolve once they have
	 * applied — call this BEFORE the body swap. A freshly appended `<link rel="stylesheet">` loads
	 * asynchronously, so swapping the body first shows the new route unstyled (e.g. a content column
	 * at full width) until the sheet arrives. That window is invisible on a warm cache but flashes on
	 * the first visit after a deploy, when the route CSS isn't cached yet. Preloading here closes it;
	 * `#merge_head` then dedupes these by key so nothing is added twice. Capped so a stalled sheet
	 * can't hang navigation.
	 */
	#preload_stylesheets(new_head: HTMLHeadElement): Promise<unknown> {
		const present = new Set<string>();
		for (const node of Array.from(document.head.children)) {
			if (node.tagName === 'LINK' && node.getAttribute('rel') === 'stylesheet') {
				present.add(head_node_key(node));
			}
		}
		const pending: Promise<void>[] = [];
		for (const node of Array.from(new_head.children)) {
			if (node.tagName !== 'LINK' || node.getAttribute('rel') !== 'stylesheet') continue;
			if (is_dangerous_head_node(node)) continue;
			const key = head_node_key(node);
			if (present.has(key)) continue;
			present.add(key);
			const link = node.cloneNode(true) as HTMLLinkElement;
			pending.push(
				new Promise<void>((resolve) => {
					link.addEventListener('load', () => resolve(), { once: true });
					link.addEventListener('error', () => resolve(), { once: true });
				})
			);
			// Insert at the TOP of <head>, not the end: an island's `<svelte:head>` hydration removes a
			// trailing node range, so a stylesheet appended after the island head blocks gets reclaimed.
			document.head.insertBefore(link, document.head.firstChild);
		}
		if (!pending.length) return Promise.resolve();
		// Never let a hung stylesheet block the swap indefinitely.
		return Promise.race([
			Promise.all(pending),
			new Promise((resolve) => setTimeout(resolve, STYLESHEET_WAIT_MS))
		]);
	}

	#should_intercept(event: MouseEvent, anchor: HTMLAnchorElement | null) {
		if (event.defaultPrevented) return false;
		if (event.button !== 0) return false;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
		if (!anchor || !anchor.href) return false;
		if (anchor.target && anchor.target !== '_self') return false;
		if (anchor.hasAttribute('download')) return false;
		if (anchor.hasAttribute('data-no-spa')) return false;
		if (anchor.closest('[data-sveltekit-reload]')) return false; // SPA opt-out
		const rel = (anchor.getAttribute('rel') || '').split(WS);
		if (rel.includes('external')) return false;
		const url = new URL(anchor.href);
		if (url.origin !== location.origin) return false;
		return url;
	}

	#run_before(from: URL, to: URL, type: string) {
		let cancelled = false;
		const nav = {
			from: this.#build_nav_target(from),
			to: this.#build_nav_target(to),
			type,
			cancel: () => (cancelled = true),
			willUnload: false
		};
		for (const fn of this.#before_hooks) {
			try {
				fn(nav);
			} catch {
				/* noop */
			}
		}
		return !cancelled;
	}

	#run_after(from: URL, to: URL, type: string) {
		for (const fn of this.#after_hooks) {
			try {
				fn({
					from: this.#build_nav_target(from),
					to: this.#build_nav_target(to),
					type,
					willUnload: false
				});
			} catch {
				/* noop */
			}
		}
	}

	#install_prefetch() {
		// hover -> warm links whose trigger is hover-or-eager (rank <= 2)
		document.addEventListener(
			'mouseover',
			(event) => {
				const anchor = event.target instanceof Element ? event.target.closest('a') : null;
				if (anchor && this.#preload_rank(anchor) <= PRELOAD_RANK.hover) this.#warm_anchor(anchor);
			},
			{ passive: true }
		);
		// tap -> warm on the press (mousedown + touchstart), for links whose trigger is tap-or-eager
		const on_press = (event: Event) => {
			const t = event.target;
			const anchor = t instanceof Element ? t.closest('a') : null;
			if (anchor && this.#preload_rank(anchor) <= PRELOAD_RANK.tap) this.#warm_anchor(anchor);
		};
		document.addEventListener('mousedown', on_press, { passive: true });
		document.addEventListener('touchstart', on_press, { passive: true });

		this.#scan_eager_viewport();
	}

	/** After start + every navigation: drop detached IO targets, then re-observe the live body. */
	#reset_viewport_io() {
		this.#viewport_io?.disconnect();
		this.#viewport_seen = new WeakSet();
		this.#viewport_io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						this.#viewport_io!.unobserve(e.target);
						this.#warm_anchor(e.target);
					}
				}
			},
			{ rootMargin: '0px' }
		);
	}

	/** After start + every navigation: eager links warm now; viewport links get observed. */
	#scan_eager_viewport() {
		// P-IO: recreate observer so detached anchors from the previous body are not retained.
		this.#reset_viewport_io();
		if (!this.#viewport_io) return;
		for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
			const rank = this.#preload_rank(anchor);
			if (rank === PRELOAD_RANK.eager) this.#warm_anchor(anchor);
			else if (rank === PRELOAD_RANK.viewport && !this.#viewport_seen.has(anchor)) {
				this.#viewport_seen.add(anchor);
				this.#viewport_io.observe(anchor);
			}
		}
	}

	/** Warm the page-HTML cache for an anchor if it's a same-origin SPA target. */
	#warm_anchor(anchor: Element) {
		const url = this.#should_intercept(
			{ button: 0, defaultPrevented: false } as MouseEvent,
			anchor as HTMLAnchorElement
		);
		if (!url) return;
		// Same document — nothing to prefetch (hash links / self links).
		if (same_document(url, new URL(location.href))) return;
		if (url.href !== location.href) this.fetch_page(url.href);
	}

	/** Rank of the most-eager preload trigger that applies to `anchor` (5 = none). */
	#preload_rank(anchor: Element): number {
		let rank = 5;
		const d = this.#preload_attr(anchor, 'data-sveltekit-preload-data');
		const c = this.#preload_attr(anchor, 'data-sveltekit-preload-code');
		if (d != null) rank = Math.min(rank, PRELOAD_RANK[d] ?? 5);
		if (c != null) rank = Math.min(rank, PRELOAD_RANK[c] ?? 5);
		return rank;
	}

	/** Nearest-ancestor value of `name` (Kit inheritance); empty value -> 'hover'. null if unset. */
	#preload_attr(el: Element, name: string): string | null {
		const holder = el.closest('[' + name + ']');
		if (!holder) return null;
		const v = holder.getAttribute(name);
		return v === '' || v == null ? 'hover' : v;
	}

	#build_nav_target(url: URL): NavTarget {
		return { url, params: {}, route: { id: null } };
	}

	/**
	 * SINGLE-FLIGHT NAVIGATION. Collect the incoming page's deferred, load-timed region calls and stream them as
	 * one batch. Reads the RENDERED holes (`<ogygia-region render="defer" endpoint>`), so it covers
	 * both placed server islands and held `region()` deferred regions alike — authoring syntax is
	 * irrelevant. Only `when="load"` (or unset) is batched: a region scheduled `visible`/`idle`/media
	 * stays lazy and fetches on its own trigger, so dynamic schedules are preserved, not eagerly pulled.
	 */
	#batch_regions(doc: Document) {
		const endpoints: string[] = [];
		const batched = new Set<string>();
		for (const el of Array.from(doc.querySelectorAll('ogygia-region[render="defer"][endpoint]'))) {
			const when = el.getAttribute('when') || 'load';
			if (when !== 'load') continue; // lazy schedules keep their own timing — never batch them early
			const ep = el.getAttribute('endpoint');
			if (ep) {
				endpoints.push(ep);
				batched.add(ep);
			}
		}
		if (!endpoints.length) return;
		// Drop the per-region `<link rel="preload" as="fetch">` hints for these calls before the head is
		// merged: on initial load they front-run the fetch, but on a single-flight navigation the batch serves
		// them — left in, the browser would fire the very GET waterfall the single-flight batch exists to remove.
		for (const link of Array.from(doc.querySelectorAll('link[rel="preload"][as="fetch"]'))) {
			if (batched.has(link.getAttribute('href') || '')) link.remove();
		}
		if (DEVTOOLS) dt_emit({ domain: 'nav', name: 'nav.batch', count: endpoints.length });
		// Through the seam, never a static `frame-nav` import: an app with `router` but no
		// deferred/live/lake region has no `frames` feature (and no `render="defer"` holes — so
		// `endpoints` is empty above and we already returned). Optional-chain keeps that honest.
		void slots.frames?.stream?.(endpoints);
	}
}

const spa = new SpaRouter();

/**
 * Register a callback before a client-side navigation.
 * Call `nav.cancel()` to abort. Returns an unsubscribe function.
 */
export function beforeNavigate(fn: BeforeNavigateCallback) {
	return spa.beforeNavigate(fn);
}

/**
 * Register a callback after a successful client-side navigation.
 * Returns an unsubscribe function.
 */
export function afterNavigate(fn: AfterNavigateCallback) {
	return spa.afterNavigate(fn);
}

/** Drop all warmed page HTML (call after mutations / auth changes). */
export function bust_page_cache() {
	spa.bust_page_cache();
}

/** Test helper — current warmed entry count. */
export function _page_cache_size() {
	return spa._page_cache_size();
}

/**
 * Bust the SPA HTML cache after any successful Kit remote mutation (command/form POST).
 * Forms also call `invalidateAll` (soft seed refresh + bust); commands only refresh queries —
 * without this fetch hook, prefetched pages stay stale. Installed once from `startRouter`.
 */
export function install_remote_mutation_cache_bust() {
	spa.install_remote_mutation_cache_bust();
}

/**
 * Programmatic same-origin navigation. Mirrors Kit's `goto()` subset.
 * @param url - Absolute or relative URL (http(s) only).
 * @param opts.replaceState - Replace the current history entry instead of pushing.
 */
export function goto(url: string | URL, opts: { replaceState?: boolean } = {}) {
	return spa.goto(url, opts);
}

/**
 * Soft-refresh the current URL's document seeds + head (not a navigation).
 * Busts the SPA HTML cache so the next real route change is fresh. Coarser than
 * Kit's dependency-scoped invalidate — see {@link SpaRouter.invalidateAll}.
 */
export function invalidateAll() {
	return spa.invalidateAll();
}

/**
 * Refresh navigation data. Without Kit's client we cannot invalidate a single
 * dependency, so this refreshes everything (same as {@link invalidateAll}).
 */
export function invalidate() {
	return spa.invalidate();
}

/**
 * Warm the next page. Router ON (SPA): fetch the page into the swap-readable HTML cache (+ its
 * island modules) — this is what makes the eventual click instant, and no browser cache can feed a
 * body swap. Router OFF (MPA, this module reached via the `$app/navigation` shim / `ogygia/app`):
 * the browser owns navigation, so hint a native Speculation Rules PRERENDER for the URL — Chromium
 * activates it on the real navigation; unsupporting browsers silently ignore it.
 */
export function preloadData(url: string | URL) {
	if (!slots.nav) {
		speculate_url(url, 'prerender');
		return Promise.resolve({ type: 'loaded' as const, status: 200, data: {} });
	}
	return spa.preloadData(url);
}

/**
 * Router ON: no-op — page “code” arrives with the HTML body swap (+ island chunks on connect).
 * Router OFF: hint a native Speculation Rules PREFETCH for the URL (the code-only speculation leg —
 * Firefox supports it; a prerender-capable browser treats prefetch as prerender's first stage).
 */
export function preloadCode(url?: string | URL) {
	if (!slots.nav) {
		if (url != null) speculate_url(url, 'prefetch');
		return Promise.resolve();
	}
	return spa.preloadCode();
}

/** Skip scroll restoration / scroll-to-top on the next client-side navigation. */
export function disableScrollHandling() {
	spa.disableScrollHandling();
}

/**
 * Shallow routing is not supported without Kit's client runtime.
 * @throws Always — use full navigations instead.
 */
export function pushState() {
	spa.pushState();
}

/**
 * Shallow routing is not supported without Kit's client runtime.
 * @throws Always — use full navigations instead.
 */
export function replaceState() {
	spa.replaceState();
}

/**
 * Install click/popstate listeners and start SPA navigation.
 * Invoked by the runtime once the module loads (handle-injected on every ogygia page, or by an island).
 * @internal
 */
export function startRouter() {
	spa.start();
}

/**
 * Feature entry: start the SPA router once the DOM is ready, but only when the page carries
 * `<meta name="ogygia-router">` (the handle injects it globally unless `ogygia({ router: false })`)
 * and Kit is not already booting it.
 */
export function install() {
	if (typeof document === 'undefined') return;
	// Expose SPA nav to the kit-remote client stub (remote commands that navigate/invalidate) without
	// that stub statically importing this ~10 KB module. Only set when the router feature is loaded.
	slots.nav = { goto, invalidateAll };
	const start = () => {
		if (!document.querySelector('meta[name="ogygia-router"]')) return;
		if (document_has_kit_bootstrap()) return;
		startRouter();
		// LIFECYCLE: fire the per-page-view event for the INITIAL load too — one `og:page-load`
		// listener then covers first paint AND every SPA navigation (Astro's page-load parity).
		document.dispatchEvent(new Event('og:page-load'));
	};
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start, { once: true });
	} else {
		start();
	}
}
