/**
 * Minimal SPA router for ogygia (Astro's ClientRouter equivalent).
 *
 * Intercepts same-origin <a> clicks, fetches the target page, swaps <body>,
 * merges <head>, and updates history. `data-ogygia-persist` keeps matching chrome.
 * Islands on the new page auto-initialise via custom-element connection; old ones
 * auto-unmount via disconnection (except inside persisted subtrees).
 */
import { html_has_kit_bootstrap, document_has_kit_bootstrap } from './kit-boot.js';
import { PageCache } from './page-cache.js';
import {
	collect_persist_pairs,
	end_persist_preserve,
	relocate_persist_pairs,
	type PersistPair
} from './persist.js';
import { runtime_session } from './session.js';

const WS = /\s+/;

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
/** Responses that must never warm the SPA HTML cache (personalized / must revalidate). */
const CC_UNCACHEABLE = /(?:^|,)\s*(?:private|no-store|no-cache)\b/i;
/** Kit remote-function POSTs live under `…/_app/remote/…` (or custom `appDir`). */
const REMOTE_MUTATION_PATH = /\/remote(?:\/|$|\?)/;

// In this router a page's "code" is delivered by the HTML body swap (+ island chunks fetched on
// connect), so BOTH `data-sveltekit-preload-data` and `-code` warm the SAME page-HTML cache. We
// honour Kit's value grammar + nearest-ancestor inheritance: 'eager' | 'viewport' | 'hover' | 'tap'
// | 'off'/'false'. An anchor's effective trigger is the MOST-EAGER of the two attributes; an empty
// value means 'hover' (Kit's default). `-data` is normally hover/tap; `-code` adds eager/viewport.
const PRELOAD_RANK: Record<string, number> = { eager: 0, viewport: 1, hover: 2, tap: 3, off: 4, false: 4 };

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
	#after_body_swap: (() => void) | undefined;
	#after_body_connected: (() => void) | undefined;
	/** Apply page/remote seeds from fetched HTML without a body swap (`invalidateAll`). */
	#apply_soft_invalidate: ((doc: Document) => void) | undefined;
	#started = false;
	#before_hooks = new Set<BeforeNavigateCallback>();
	#after_hooks = new Set<AfterNavigateCallback>();
	#page_cache = new PageCache({
		ttlMs: PREFETCH_TTL_MS,
		maxEntries: PAGE_CACHE_MAX_ENTRIES,
		maxBytes: PAGE_CACHE_MAX_BYTES
	});
	#inflight = new Map<string, Promise<string | null>>();
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

	set_after_body_swap(fn: () => void) {
		this.#after_body_swap = fn;
	}

	set_after_body_connected(fn: () => void) {
		this.#after_body_connected = fn;
	}

	set_apply_soft_invalidate(fn: (doc: Document) => void) {
		this.#apply_soft_invalidate = fn;
	}

	beforeNavigate(fn: BeforeNavigateCallback) {
		this.#before_hooks.add(fn);
		return () => this.#before_hooks.delete(fn);
	}

	afterNavigate(fn: AfterNavigateCallback) {
		this.#after_hooks.add(fn);
		// $app/navigation's afterNavigate fires immediately on mount too
		try {
			fn({ from: null, to: this.#build_nav_target(new URL(location.href)), type: 'enter', willUnload: false });
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
		if (this.#remote_bust_installed || typeof window === 'undefined' || typeof window.fetch !== 'function') {
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
		// Warm cache hit (prefetch path only — navigations use signal and must be abortable).
		if (!signal) {
			const cached = this.#page_cache.get(href);
			if (cached != null) return Promise.resolve(cached);
			const pending = this.#inflight.get(href);
			if (pending) return pending;
		}

		const settled = fetch(href, {
			signal,
			headers: { 'x-ogygia-spa': '1' }
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
					if (r.html != null && r.cacheable) this.#page_cache.set(href, r.html);
				})
				.catch(() => {});
		}
		return html_p;
	}

	// NOTE: the library does NO script processing. Scripts inserted via a client-side body swap do
	// not execute (standard browser behaviour for parsed/adopted <script> nodes) — if you need code
	// to run per navigation, use an island. Our own runtime module script is marked
	// `data-ogygia-runtime` and is the only module script merge_head retains across swaps.
	async navigate(
		url: URL,
		{ push = true, pop_scroll = null, type = 'link', replace = false }: {
			push?: boolean;
			pop_scroll?: { x: number; y: number } | null;
			type?: string;
			replace?: boolean;
		} = {}
	) {
		const from = new URL(location.href);

		// Same document, hash-only (or identical URL): never fetch / swap / view-transition.
		// (`invalidateAll` is a soft seed refresh — it does not call navigate.)
		if (same_document(url, from) && !replace) {
			if (!this.#run_before(from, url, type)) return;
			if (push && url.href !== location.href) {
				history.pushState({ ...(history.state || {}), ogygia: true }, '', url.href);
			} else if (url.href !== location.href) {
				history.replaceState({ ...(history.state || {}), ogygia: true }, '', url.href);
			}
			jump_to_hash(url.hash);
			this.#run_after(from, url, type);
			return;
		}

		if (!this.#run_before(from, url, type)) return; // a beforeNavigate hook cancelled

		// Cancel any in-flight navigation; only the latest gen may apply a body swap (P2).
		this.#nav_abort?.abort();
		this.#nav_abort = new AbortController();
		const { signal } = this.#nav_abort;
		const gen = ++this.#nav_gen;

		// Update history SYNCHRONOUSLY (before any await) so the URL is correct and
		// races between overlapping navigations can't drop the pushState.
		if (replace) {
			history.replaceState({ ...(history.state || {}), ogygia: true }, '', url.href);
		} else if (push) {
			// save outgoing scroll into the current entry, then push the new URL
			history.replaceState({ ...(history.state || {}), scroll: { x: scrollX, y: scrollY } }, '');
			history.pushState({ ogygia: true }, '', url.href);
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

		// Mixed sites: if the target page has no <OgygiaRouter/> marker, hand over to a
		// real document navigation (and stop SPA behaviour from here on).
		const marker = doc.querySelector('meta[name="ogygia-router"]');
		if (!marker) {
			location.href = url.href;
			return;
		}
		// Same-document hash jumps already returned above (no VT). Cross-route swaps keep VT
		// even when the target has a hash (A → B#C); scroll snaps after the transition.
		const prefer_reduced_motion =
			typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
		const use_vt =
			marker.getAttribute('content') !== 'plain' && !prefer_reduced_motion;

		let persist_pairs: PersistPair[] = [];
		const swap = () => {
			// Stale nav: do not mutate the DOM (view-transition can otherwise commit a superseded swap).
			if (gen !== this.#nav_gen) return;
			this.#merge_head(doc.head); // keeps our runtime module script alive across swaps
			if (gen !== this.#nav_gen) return;
			// Clear session state BEFORE body connect so new regions never see the previous page.
			this.#after_body_swap?.();
			if (gen !== this.#nav_gen) return;
			// Relocate immediately before replaceWith — never leave live nodes in a discarded parse tree.
			persist_pairs = collect_persist_pairs(document.body, doc.body);
			relocate_persist_pairs(persist_pairs);
			document.body.replaceWith(doc.body);
			document.title = doc.title;
			// Lakes inside persisted chrome survived reset — re-mark settled so island-in-lake can wake.
			for (const { live } of persist_pairs) runtime_session.settle_lakes_in(live);
			end_persist_preserve(persist_pairs);
			// Old islands disconnected; new hydrates are awaiting — sweep stale Kit remotes now.
			this.#after_body_connected?.();
		};

		if (use_vt && document.startViewTransition) {
			const t = document.startViewTransition(swap);
			await t.updateCallbackDone.catch(() => {});
		} else {
			swap();
		}
		if (gen !== this.#nav_gen) return;

		this.#doc_key = document_key(url);

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
		// new <body> -> re-evaluate eager/viewport preload links on the freshly-swapped page
		this.#scan_eager_viewport();
	}

	goto(url: string | URL, opts: { replaceState?: boolean; external?: boolean } = {}) {
		const target = new URL(url, location.href);
		if (target.protocol !== 'http:' && target.protocol !== 'https:') {
			throw new Error('ogygia: goto() only supports http(s) URLs');
		}
		if (target.origin !== location.origin) {
			if (opts.external) {
				location.assign(target.href);
				return Promise.resolve();
			}
			throw new Error('ogygia: goto() only supports same-origin URLs (pass { external: true } to leave)');
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
	 * that need query updates use `.refresh()` / `submit().updates(...)`.
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
		this.#apply_soft_invalidate?.(doc);
	}

	invalidate() {
		return this.invalidateAll();
	}

	preloadData(url: string | URL) {
		const target = new URL(url, location.href);
		if (target.origin !== location.origin) return Promise.resolve({ type: 'loaded', status: 200, data: {} });
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
		// OPT-IN: only activate when a <OgygiaRouter/> put its marker in the head.
		if (!document.querySelector('meta[name="ogygia-router"]')) return;
		// Gradual migration: <OgygiaRouter/> may sit in the root layout while some routes stay
		// csr=true. On those pages Kit owns navigation — do not intercept clicks alongside it.
		if (document_has_kit_bootstrap()) return;
		this.#started = true;
		this.#doc_key = document_key(new URL(location.href));
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
			// do not fetch or swap. Scroll to the fragment if present.
			if (document_key(url) === this.#doc_key) {
				jump_to_hash(url.hash);
				return;
			}
			const pop_scroll = history.state?.scroll || null;
			this.navigate(url, { push: false, pop_scroll });
		});

		// seed initial history entry so scroll is restored on the first back
		history.replaceState({ ...(history.state || {}), ogygia: true }, '');
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
				fn({ from: this.#build_nav_target(from), to: this.#build_nav_target(to), type, willUnload: false });
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
}

const spa = new SpaRouter();

/** Called after a successful body swap so the runtime can reset per-document session state. */
export function set_after_body_swap(fn: () => void) {
	spa.set_after_body_swap(fn);
}

/**
 * Called after `body.replaceWith` (old islands disconnected; new hydrates still pending).
 * Used to sweep Kit query/live instance caches before the next page mounts remotes.
 */
export function set_after_body_connected(fn: () => void) {
	spa.set_after_body_connected(fn);
}

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

/** Wire soft-invalidate seed application (called from the runtime bootstrap). */
export function set_apply_soft_invalidate(fn: (doc: Document) => void) {
	spa.set_apply_soft_invalidate(fn);
}

/**
 * Warm the SPA HTML cache for a URL.
 * Note: this fetches the **page**, not Kit `load` data in isolation.
 */
export function preloadData(url: string | URL) {
	return spa.preloadData(url);
}

/**
 * No-op under ogygia — page “code” arrives with the HTML body swap (+ island chunks on connect).
 * Kept for Kit `$app/navigation` API parity.
 */
export function preloadCode() {
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
 * Invoked by the runtime when `<OgygiaRouter />` (or an island) loads the runtime module.
 * @internal
 */
export function startRouter() {
	spa.start();
}
