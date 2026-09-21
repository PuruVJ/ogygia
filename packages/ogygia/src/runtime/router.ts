/**
 * Minimal SPA router for ogygia (Astro's ClientRouter equivalent).
 *
 * Intercepts same-origin <a> clicks, fetches the target page, swaps <body>,
 * merges <head>, and updates history. `data-ogygia-keep` keeps matching chrome.
 * Islands on the new page auto-initialise via custom-element connection; old ones
 * auto-unmount via disconnection (except inside persisted subtrees).
 *
 * This module is the router's BOOT half — the listeners, the lifecycle hooks, the link-preload
 * policy, and the pure helpers — and it stays small: the navigation itself (fetch + cache, head
 * merge, body reconcile, seeds, a11y) is ./router-nav.ts, loaded on the first prefetch or
 * intercepted click. A visitor who never leaves the page never downloads it.
 */
import { kit_hydrates_page } from './kit-boot.js';
import { slots } from './slots.js';
import { speculate_url } from './speculate-hint.js';

const WS = /\s+/;

/**
 * The `<a>` a pointer event is about — through SHADOW ROOTS. A click inside a web component's
 * shadow tree (a design-system `<qds-standalone-link>`, `<qds-button href>`, a breadcrumb item)
 * reaches the document with `event.target` retargeted to the host, so `target.closest('a')` finds
 * nothing and the browser navigates natively — a full reload instead of a body swap. The composed
 * path still holds the real anchor; Kit's own router reads it the same way.
 */
export function anchor_of(event: Event): HTMLAnchorElement | null {
	const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
	for (const n of path) {
		if (n instanceof Element && n.tagName === 'A') return n as HTMLAnchorElement;
	}
	const t = event.target;
	return t instanceof Element ? t.closest('a') : null;
}

/**
 * The anchor a HOVER is about, cheaply: `mouseover` fires for every element the pointer crosses,
 * so the common case — not over a link at all — must cost one `closest('a')` and nothing else.
 * Only when the retargeted `target` is a shadow HOST (the anchor may be inside its shadow tree)
 * is the composed path read.
 */
function hovered_anchor(event: Event): HTMLAnchorElement | null {
	const t = event.target;
	if (!(t instanceof Element)) return null;
	const a = t.closest('a');
	if (a) return a as HTMLAnchorElement;
	return t.shadowRoot ? anchor_of(event) : null;
}

// SvelteKit's remote-function client (which ogygia reuses for query/command) patches
// `history.pushState`/`replaceState` on the instance and warns whenever they are called directly.
// On csr=false pages ogygia owns navigation — Kit's router is not running — so we update history via
// the un-patched `History.prototype` methods. Same effect on the history stack, without the spurious
// "conflict with SvelteKit's router" warning. Captured lazily so a test/SSR without `History` is safe.
const native_push = typeof History !== 'undefined' ? History.prototype.pushState : null;
const native_replace = typeof History !== 'undefined' ? History.prototype.replaceState : null;
export const push_state = (state: unknown, url: string) =>
	(native_push ?? history.pushState).call(history, state, '', url);
export const replace_state = (state: unknown, url?: string) => {
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

/** Responses that must never warm the SPA HTML cache (personalized / must revalidate). */
const CC_UNCACHEABLE = /(?:^|,)\s*(?:private|no-store|no-cache)\b/i;

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
/** Anchors that can carry a preload policy at all — under (or on) a marked element. The post-nav
 *  scan reads only these; an unmarked anchor has no trigger and was a wasted rank computation. */
const PRELOAD_MARKED_ANCHORS =
	'[data-sveltekit-preload-data] a[href], [data-sveltekit-preload-code] a[href], ' +
	'a[href][data-sveltekit-preload-data], a[href][data-sveltekit-preload-code]';

/**
 * Whether a fetch response may warm the SPA page-HTML cache.
 * @param cacheControl - Response `Cache-Control` header value.
 * @param setCookie - True if the response included `Set-Cookie`.
 * @returns False when the response is private / no-store / no-cache or set a cookie.
 */
export function spa_html_cacheable(cacheControl: string, setCookie: boolean): boolean {
	return !CC_UNCACHEABLE.test(cacheControl || '') && !setCookie;
}

/** Does the page hold an element the fragment points at? `#top` and an empty `#` mean "the top",
 *  which the browser handles. A fragment that matches nothing is an app-managed one (a table row
 *  keyed by the hash): the browser would scroll to the top for it, so the router takes it over. */
function hash_target_exists(hash: string): boolean {
	if (!hash || hash === '#') return true;
	const raw = hash.slice(1);
	let dec = raw;
	try {
		dec = decodeURIComponent(raw);
	} catch {
		/* keep raw */
	}
	if (raw === 'top' || dec === 'top') return true;
	return !!(document.getElementById(dec) || document.getElementById(raw) || document.getElementsByName(dec).length);
}

/** Same document = pathname + search. Hash is not part of document identity. */
export function same_document(a: URL, b: URL) {
	return a.pathname === b.pathname && a.search === b.search;
}

/**
 * Kit's `data-sveltekit-reload` grammar, nearest ancestor wins (Kit walks up from the anchor and
 * takes the first element that carries the attribute): `""` / `"true"` = full-page load, `"off"` /
 * `"false"` = SPA navigation — so a layout can opt a whole subtree OUT of the SPA and a child
 * subtree can opt back IN. Presence alone used to force a reload, which turned a
 * `data-sveltekit-reload="false"` subtree (an app's way of saying "SPA here") into full loads.
 */
export function reload_opt_out(anchor: Element): boolean {
	const holder = anchor.closest('[data-sveltekit-reload]');
	if (!holder) return false;
	const v = holder.getAttribute('data-sveltekit-reload');
	return v !== 'off' && v !== 'false';
}

/**
 * What a click on a link to the CURRENT document means. `hash`: a fragment jump — the browser's.
 * `swallow`: the navigation to this exact address is already in flight — a design-system link
 * (`<qds-standalone-link>`, `<qds-button href>`) handles the click itself and re-dispatches one on
 * its inner anchor; the router pushed the URL for the first click, so the second one looks like a
 * link to the current page — left to the browser it would RELOAD the document mid-swap. `refresh`:
 * a real click on a link to the page one is on — re-render in place (Kit re-runs the navigation
 * too; a full reload is never the answer for a same-origin link).
 */
export function same_document_link(
	url: URL,
	current: URL,
	in_flight: string | null
): 'hash' | 'swallow' | 'refresh' {
	if (url.hash && url.href !== current.href) return 'hash';
	if (in_flight === url.href) return 'swallow';
	return 'refresh';
}

export function document_key(url: URL) {
	return url.pathname + url.search;
}

/** Instant scroll to a hash target (or top). Ignores CSS `scroll-behavior: smooth`. */
export function jump_to_hash(hash: string) {
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

/** Run `fn` when the browser is idle (bounded), else soon. */
function on_idle(fn: () => void, timeout = 1000) {
	if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout });
	else setTimeout(fn, 50);
}

/** THE NAVIGATION (./router-nav.ts), loaded once, on first use. */
type Nav = typeof import('./router-nav.js');
let nav_promise: Promise<Nav> | null = null;
let loaded_nav: Nav | null = null;
function nav(): Promise<Nav> {
	if (!nav_promise) nav_promise = import('./router-nav.js').then((m) => (loaded_nav = m));
	return nav_promise;
}

export class SpaRouter {
	#started = false;
	#before_hooks = new Set<BeforeNavigateCallback>();
	#after_hooks = new Set<AfterNavigateCallback>();
	/** href of the navigation in flight (set before the fetch, cleared when applied or aborted) */
	nav_target: string | null = null;
	#viewport_io: IntersectionObserver | null = null;
	#viewport_seen = new WeakSet<Element>();
	/** pathname+search of the document currently in the DOM (hash ignored). */
	doc_key = '';
	/**
	 * Full URL of the document currently displayed in the DOM. `navigate()` uses this as its `from`
	 * instead of `location.href`, because on a `popstate` (back/forward) the browser has ALREADY
	 * changed `location` to the target — so `location.href` would equal the target and the
	 * same-document guard would wrongly bail into the hash-only branch, never swapping the body
	 * (browser back left the old page's DOM in place). POP-FROM.
	 */
	current_url: URL | null = null;

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
		loaded_nav?.bust_page_cache(); // no navigation loaded yet ⇒ nothing cached
	}

	_page_cache_size() {
		return loaded_nav?.page_cache_size() ?? 0;
	}

	fetch_page(href: string, signal?: AbortSignal, purpose?: 'nav' | 'prefetch' | 'history') {
		return nav().then((n) => n.fetch_page(href, signal, purpose));
	}

	async navigate(
		url: URL,
		opts: {
			push?: boolean;
			pop_scroll?: { x: number; y: number } | null;
			type?: string;
			replace?: boolean;
		} = {}
	) {
		const { push = true, type = 'link', replace = false } = opts;
		const from = this.current_url ?? new URL(location.href);

		// Same document, hash-only (or identical URL): never fetch / swap / view-transition — and
		// never the navigation chunk. (`invalidateAll` is a soft seed refresh — it does not call
		// navigate.)
		if (same_document(url, from) && !replace) {
			if (!this.run_before(from, url, type)) return;
			if (push && url.href !== location.href) {
				push_state({ ...(history.state || {}), ogygia: true }, url.href);
			} else if (url.href !== location.href) {
				replace_state({ ...(history.state || {}), ogygia: true }, url.href);
			}
			jump_to_hash(url.hash);
			this.current_url = url;
			this.run_after(from, url, type);
			return;
		}

		const n = await nav();
		return n.navigate(this, url, from, opts);
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

	invalidateAll() {
		return nav().then((n) => n.invalidate_all());
	}

	invalidate() {
		return this.invalidateAll();
	}

	preloadData(url: string | URL) {
		const target = new URL(url, location.href);
		if (target.origin !== location.origin)
			return Promise.resolve({ type: 'loaded', status: 200, data: {} });
		this.fetch_page(target.href, undefined, 'prefetch');
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
		if (kit_hydrates_page()) return;
		this.#started = true;
		this.doc_key = document_key(new URL(location.href));
		this.current_url = new URL(location.href);

		document.addEventListener('click', (event) => {
			const anchor = anchor_of(event);
			const url = this.#should_intercept(event, anchor);
			if (!url) return;
			// Same document: a hash jump is the browser's; anything else must never reload —
			// see `same_document_link` (the re-dispatched click of a design-system link, or a real
			// click on the current page, which refreshes in place).
			if (same_document(url, new URL(location.href))) {
				const kind = same_document_link(url, new URL(location.href), this.nav_target);
				if (kind === 'hash') {
					// A fragment link. If it names a real element, the browser scrolls there — leave it
					// (native is direct and correct). If it does NOT (an app-managed fragment, e.g. a
					// table that opens a row keyed by the hash), the browser would scroll to the TOP of
					// the page for the unmatched fragment — so take it over: update the URL and fire
					// hashchange for the app's listeners, without the top jump.
					if (!hash_target_exists(url.hash)) {
						event.preventDefault();
						if (location.hash !== url.hash) {
							push_state(history.state || {}, url.href);
							window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: location.href, newURL: url.href }));
						}
					}
					return;
				}
				event.preventDefault();
				if (kind === 'refresh') this.navigate(url, { push: false, replace: true });
				return;
			}
			event.preventDefault();
			this.navigate(url, { push: true });
		});

		this.#install_prefetch();

		window.addEventListener('popstate', () => {
			const url = new URL(location.href);
			// Hash-only back/forward on the same document — browser already updated the URL;
			// do not fetch or swap. Scroll to the target if present.
			if (document_key(url) === this.doc_key) {
				jump_to_hash(url.hash);
				return;
			}
			const pop_scroll = history.state?.scroll || null;
			// `popstate` type → the fetch is marked a history restore (x-ogygia-purpose: history).
			this.navigate(url, { push: false, pop_scroll, type: 'popstate' });
		});

		// seed initial history entry so scroll is restored on the first back
		replace_state({ ...(history.state || {}), ogygia: true });
	}

	#should_intercept(event: MouseEvent, anchor: HTMLAnchorElement | null) {
		if (event.defaultPrevented) return false;
		if (event.button !== 0) return false;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
		if (!anchor || !anchor.href) return false;
		if (anchor.target && anchor.target !== '_self') return false;
		if (anchor.hasAttribute('download')) return false;
		if (anchor.hasAttribute('data-no-spa')) return false;
		if (reload_opt_out(anchor)) return false; // Kit's `data-sveltekit-reload` grammar
		const rel = (anchor.getAttribute('rel') || '').split(WS);
		if (rel.includes('external')) return false;
		const url = new URL(anchor.href);
		if (url.origin !== location.origin) return false;
		return url;
	}

	run_before(from: URL, to: URL, type: string) {
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

	run_after(from: URL, to: URL, type: string) {
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
		// hover -> warm links whose trigger is hover-or-eager (rank <= 2). `mouseover` fires for
		// every element the pointer crosses: bail on the one `closest('a')` before ranking anything.
		document.addEventListener(
			'mouseover',
			(event) => {
				const anchor = hovered_anchor(event);
				if (anchor && this.#preload_rank(anchor) <= PRELOAD_RANK.hover) this.#warm_anchor(anchor);
			},
			{ passive: true }
		);
		// tap -> warm on the press (mousedown + touchstart), for links whose trigger is tap-or-eager
		const on_press = (event: Event) => {
			const anchor = anchor_of(event);
			if (anchor && this.#preload_rank(anchor) <= PRELOAD_RANK.tap) this.#warm_anchor(anchor);
		};
		document.addEventListener('mousedown', on_press, { passive: true });
		document.addEventListener('touchstart', on_press, { passive: true });

		this.scan_preload_links();
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

	/**
	 * After start + every navigation, in IDLE: eager links warm now; viewport links get observed.
	 * Only anchors under a preload-marked element are read — an unmarked anchor has no trigger. Idle,
	 * because the scan competes with the freshly swapped page's own islands for the main thread and
	 * a warm is speculation by definition.
	 */
	scan_preload_links() {
		on_idle(() => {
			// P-IO: recreate observer so detached anchors from the previous body are not retained.
			this.#reset_viewport_io();
			if (!this.#viewport_io) return;
			for (const anchor of Array.from(document.querySelectorAll(PRELOAD_MARKED_ANCHORS))) {
				const rank = this.#preload_rank(anchor);
				if (rank === PRELOAD_RANK.eager) this.#warm_anchor(anchor);
				else if (rank === PRELOAD_RANK.viewport && !this.#viewport_seen.has(anchor)) {
					this.#viewport_seen.add(anchor);
					this.#viewport_io.observe(anchor);
				}
			}
		});
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
		// A warm is speculative — marked `prefetch` so the server can treat it as a dry run.
		if (url.href !== location.href) this.fetch_page(url.href, undefined, 'prefetch');
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

/**
 * Register a callback before a client-side navigation.
 * Call `nav.cancel()` to abort. Returns an unsubscribe function. Inside a component, prefer the
 * `$app/navigation` / `ogygia/app` export, which unsubscribes on destroy.
 */
export function beforeNavigate(fn: BeforeNavigateCallback) {
	return spa.beforeNavigate(fn);
}

/**
 * Register a callback after a successful client-side navigation.
 * Returns an unsubscribe function. Inside a component, prefer the `$app/navigation` /
 * `ogygia/app` export, which unsubscribes on destroy.
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
 * Kit's dependency-scoped invalidate — see `invalidate_all` in ./router-nav.ts.
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
	// that stub statically importing this module. Only set when the router feature is loaded.
	slots.nav = { goto, invalidateAll };
	const start = () => {
		if (!document.querySelector('meta[name="ogygia-router"]')) return;
		if (kit_hydrates_page()) return;
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
