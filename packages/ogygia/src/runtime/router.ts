/**
 * Minimal SPA router for ogygia (Astro ClientRouter equivalent).
 *
 * Intercepts same-origin <a> clicks, fetches the target page, swaps <body>,
 * merges <head>, and updates history. Islands on the new page auto-initialise
 * via custom-element connection; old ones auto-unmount via disconnection.
 */

let started = false;

// ---- navigation lifecycle hooks (for the $app/navigation shim) ----
interface NavTarget {
	url: URL;
	params: Record<string, string>;
	route: { id: string | null };
}
interface BeforeNavigation {
	from: NavTarget;
	to: NavTarget;
	type: string;
	cancel: () => void;
	willUnload: boolean;
}
interface AfterNavigation {
	from: NavTarget | null;
	to: NavTarget;
	type: string;
	willUnload: boolean;
}
type BeforeNavigateCallback = (nav: BeforeNavigation) => void;
type AfterNavigateCallback = (nav: AfterNavigation) => void;

const before_hooks = new Set<BeforeNavigateCallback>();
const after_hooks = new Set<AfterNavigateCallback>();

export function beforeNavigate(fn: BeforeNavigateCallback) {
	before_hooks.add(fn);
	return () => before_hooks.delete(fn);
}
export function afterNavigate(fn: AfterNavigateCallback) {
	after_hooks.add(fn);
	// $app/navigation's afterNavigate fires immediately on mount too
	try {
		fn({ from: null, to: build_nav_target(new URL(location.href)), type: 'enter', willUnload: false });
	} catch {
		/* noop */
	}
	return () => after_hooks.delete(fn);
}

function build_nav_target(url: URL): NavTarget {
	return { url, params: {}, route: { id: null } };
}
function run_before(from, to, type) {
	let cancelled = false;
	const nav = { from: build_nav_target(from), to: build_nav_target(to), type, cancel: () => (cancelled = true), willUnload: false };
	for (const fn of before_hooks) {
		try {
			fn(nav);
		} catch {
			/* noop */
		}
	}
	return !cancelled;
}
function run_after(from, to, type) {
	for (const fn of after_hooks) {
		try {
			fn({ from: build_nav_target(from), to: build_nav_target(to), type, willUnload: false });
		} catch {
			/* noop */
		}
	}
}

function should_intercept(event, anchor) {
	if (event.defaultPrevented) return false;
	if (event.button !== 0) return false;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
	if (!anchor || !anchor.href) return false;
	if (anchor.target && anchor.target !== '_self') return false;
	if (anchor.hasAttribute('download')) return false;
	if (anchor.hasAttribute('data-no-spa')) return false;
	if (anchor.closest('[data-sveltekit-reload]')) return false; // SPA opt-out
	const rel = (anchor.getAttribute('rel') || '').split(/\s+/);
	if (rel.includes('external')) return false;
	const url = new URL(anchor.href);
	if (url.origin !== location.origin) return false;
	return url;
}

/** Merge <head>: keep nodes present in both, remove stale, add new. Keeps runtime scripts alive. */
function merge_head(new_head: HTMLHeadElement) {
	const current = document.head;
	const current_nodes = new Map<string, Element>();
	for (const node of Array.from(current.children)) {
		current_nodes.set(node.outerHTML, node);
	}
	const next_keys = new Set<string>();
	for (const node of Array.from(new_head.children)) {
		next_keys.add(node.outerHTML);
	}
	// remove stale nodes (but never remove module scripts that boot the runtime)
	for (const [key, node] of current_nodes) {
		if (!next_keys.has(key)) {
			if (node.tagName === 'SCRIPT' && node.getAttribute('type') === 'module') continue;
			node.remove();
		}
	}
	// add new nodes
	for (const node of Array.from(new_head.children)) {
		if (!current_nodes.has(node.outerHTML)) {
			current.appendChild(node.cloneNode(true));
		}
	}
}

const page_cache = new Map(); // href -> Promise<string html> (prefetch cache)

function fetch_page(href) {
	if (!page_cache.has(href)) {
		page_cache.set(
			href,
			fetch(href, { headers: { 'x-ogygia-spa': '1' } })
				.then(async (res) => {
					const ct = res.headers.get('content-type') || '';
					if (!ct.includes('text/html')) return null;
					// NOTE: we intentionally swap even non-2xx HTML (e.g. Kit's SSR'd 404/500
					// +error.svelte page) so error pages render without a full reload.
					return await res.text();
				})
				.catch(() => null)
		);
		// don't cache failures forever
		page_cache.get(href).then((html) => {
			if (html == null) page_cache.delete(href);
		});
	}
	return page_cache.get(href);
}

// NOTE: the library does NO script processing. Scripts inserted via a client-side body swap do
// not execute (standard browser behaviour for parsed/adopted <script> nodes) — if you need code
// to run per navigation, use an island. Our own runtime module script lives in <head> and
// persists across swaps (merge_head keeps module scripts), so it keeps running.

async function navigate(url, { push = true, pop_scroll = null, type = 'link', replace = false } = {}) {
	const from = new URL(location.href);
	if (!run_before(from, url, type)) return; // a beforeNavigate hook cancelled

	// Update history SYNCHRONOUSLY (before any await) so the URL is correct and
	// races between overlapping navigations can't drop the pushState.
	if (replace) {
		history.replaceState({ ...(history.state || {}), ogygia: true }, '', url.href);
	} else if (push) {
		// save outgoing scroll into the current entry, then push the new URL
		history.replaceState({ ...(history.state || {}), scroll: { x: scrollX, y: scrollY } }, '');
		history.pushState({ ogygia: true }, '', url.href);
	}

	const html = await fetch_page(url.href);
	if (html == null) {
		location.href = url.href;
		return;
	}
	page_cache.delete(url.href); // one-shot; always fresh on real navigation

	const doc = new DOMParser().parseFromString(html, 'text/html');

	// Mixed sites: if the target page has no <ClientRouter/> marker, hand over to a
	// real document navigation (and stop SPA behaviour from here on).
	const marker = doc.querySelector('meta[name="ogygia-router"]');
	if (!marker) {
		location.href = url.href;
		return;
	}
	const use_vt = marker.getAttribute('content') !== 'plain';

	const swap = () => {
		merge_head(doc.head); // keeps our runtime module script alive across swaps
		document.body.replaceWith(doc.body);
		document.title = doc.title;
	};

	if (use_vt && document.startViewTransition) {
		const t = document.startViewTransition(swap);
		await t.updateCallbackDone.catch(() => {});
	} else {
		swap();
	}

	// scroll handling
	if (replace) {
		// invalidate/refresh — keep current scroll
	} else if (pop_scroll) {
		window.scrollTo(pop_scroll.x, pop_scroll.y);
	} else if (url.hash) {
		const el = document.getElementById(decodeURIComponent(url.hash.slice(1)));
		if (el) el.scrollIntoView();
		else window.scrollTo(0, 0);
	} else {
		window.scrollTo(0, 0);
	}

	run_after(from, url, type);
	// new <body> -> re-evaluate eager/viewport preload links on the freshly-swapped page
	scan_eager_viewport();
}

// ---------- $app/navigation shim surface ----------
/** Programmatic navigation. Mirrors Kit's goto(). */
export function goto(url: string | URL, opts: { replaceState?: boolean } = {}) {
	const target = new URL(url, location.href);
	return navigate(target, { push: !opts.replaceState, replace: false, type: 'goto' });
}
/** Re-fetch + re-render the current URL (server re-runs loads). Coarser than Kit's. */
export function invalidateAll() {
	return navigate(new URL(location.href), { replace: true, type: 'goto' });
}
/** We can't invalidate a single dependency without Kit's client; refresh everything. */
export function invalidate() {
	return invalidateAll();
}
/** Warm the HTML cache for a URL. Note: this fetches the PAGE, not Kit load data. */
export function preloadData(url) {
	fetch_page(new URL(url, location.href).href);
	return Promise.resolve({ type: 'loaded', status: 200, data: {} });
}
export function preloadCode() {
	// island chunks are code-split & fetched on connect; nothing to warm here.
	return Promise.resolve();
}
export function disableScrollHandling() {
	if (typeof console !== 'undefined') {
		console.warn('[ogygia] disableScrollHandling() is a no-op in the islands SPA router.');
	}
}
/** Shallow routing is not supported without Kit's client runtime. */
export function pushState() {
	console.warn('[ogygia] pushState() shallow routing is not supported; use goto().');
}
export function replaceState() {
	console.warn('[ogygia] replaceState() shallow routing is not supported; use goto().');
}

// ---------- link prefetch (SvelteKit `data-sveltekit-preload-*` parity) ----------
// In this router a page's "code" is delivered by the HTML body swap (+ island chunks fetched on
// connect), so BOTH `data-sveltekit-preload-data` and `-code` warm the SAME page-HTML cache. We
// honour Kit's value grammar + nearest-ancestor inheritance: 'eager' | 'viewport' | 'hover' | 'tap'
// | 'off'/'false'. An anchor's effective trigger is the MOST-EAGER of the two attributes; an empty
// value means 'hover' (Kit's default). `-data` is normally hover/tap; `-code` adds eager/viewport.
const PRELOAD_RANK: Record<string, number> = { eager: 0, viewport: 1, hover: 2, tap: 3, off: 4, false: 4 };

/** Nearest-ancestor value of `name` (Kit inheritance); empty value -> 'hover'. null if unset. */
function preload_attr(el: Element, name: string): string | null {
	const holder = el.closest('[' + name + ']');
	if (!holder) return null;
	const v = holder.getAttribute(name);
	return v === '' || v == null ? 'hover' : v;
}

/** Rank of the most-eager preload trigger that applies to `anchor` (5 = none). */
function preload_rank(anchor: Element): number {
	let rank = 5;
	const d = preload_attr(anchor, 'data-sveltekit-preload-data');
	const c = preload_attr(anchor, 'data-sveltekit-preload-code');
	if (d != null) rank = Math.min(rank, PRELOAD_RANK[d] ?? 5);
	if (c != null) rank = Math.min(rank, PRELOAD_RANK[c] ?? 5);
	return rank;
}

/** Warm the page-HTML cache for an anchor if it's a same-origin SPA target. */
function warm_anchor(anchor: Element) {
	const url = should_intercept({ button: 0, defaultPrevented: false }, anchor as HTMLAnchorElement);
	if (url && url.href !== location.href) fetch_page(url.href);
}

let viewport_io: IntersectionObserver | null = null;
const viewport_seen = new WeakSet<Element>();

function install_prefetch() {
	// hover -> warm links whose trigger is hover-or-eager (rank <= 2)
	document.addEventListener(
		'mouseover',
		(event) => {
			const anchor = event.target instanceof Element ? event.target.closest('a') : null;
			if (anchor && preload_rank(anchor) <= PRELOAD_RANK.hover) warm_anchor(anchor);
		},
		{ passive: true }
	);
	// tap -> warm on the press (mousedown + touchstart), for links whose trigger is tap-or-eager
	const on_press = (event: Event) => {
		const t = event.target;
		const anchor = t instanceof Element ? t.closest('a') : null;
		if (anchor && preload_rank(anchor) <= PRELOAD_RANK.tap) warm_anchor(anchor);
	};
	document.addEventListener('mousedown', on_press, { passive: true });
	document.addEventListener('touchstart', on_press, { passive: true });

	viewport_io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (e.isIntersecting) {
					viewport_io!.unobserve(e.target);
					warm_anchor(e.target);
				}
			}
		},
		{ rootMargin: '0px' }
	);
	scan_eager_viewport();
}

/** After start + every navigation: eager links warm now; viewport links get observed. */
function scan_eager_viewport() {
	if (!viewport_io) return;
	for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
		const rank = preload_rank(anchor);
		if (rank === PRELOAD_RANK.eager) warm_anchor(anchor);
		else if (rank === PRELOAD_RANK.viewport && !viewport_seen.has(anchor)) {
			viewport_seen.add(anchor);
			viewport_io.observe(anchor);
		}
	}
}

export function startRouter() {
	if (started || typeof document === 'undefined') return;
	// OPT-IN: only activate when a <ClientRouter/> put its marker in the head.
	if (!document.querySelector('meta[name="ogygia-router"]')) return;
	started = true;

	document.addEventListener('click', (event) => {
		const anchor = event.target instanceof Element ? event.target.closest('a') : null;
		const url = should_intercept(event, anchor);
		if (!url) return;
		// same page + hash only -> let the browser handle
		if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
		event.preventDefault();
		navigate(url, { push: true });
	});

	install_prefetch();

	window.addEventListener('popstate', () => {
		const pop_scroll = history.state?.scroll || null;
		navigate(new URL(location.href), { push: false, pop_scroll });
	});

	// seed initial history entry so scroll is restored on the first back
	history.replaceState({ ...(history.state || {}), ogygia: true }, '');
}
