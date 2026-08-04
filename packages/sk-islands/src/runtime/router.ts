/**
 * Minimal SPA router for sk-islands (Astro ClientRouter equivalent).
 *
 * Intercepts same-origin <a> clicks, fetches the target page, swaps <body>,
 * merges <head>, and updates history. Islands on the new page auto-initialise
 * via custom-element connection; old ones auto-unmount via disconnection.
 */

let started = false;

// ---- navigation lifecycle hooks (for the $app/navigation shim) ----
const beforeHooks = new Set();
const afterHooks = new Set();

export function beforeNavigate(fn) {
	beforeHooks.add(fn);
	return () => beforeHooks.delete(fn);
}
export function afterNavigate(fn) {
	afterHooks.add(fn);
	// $app/navigation's afterNavigate fires immediately on mount too
	try {
		fn({ from: null, to: buildNavTarget(new URL(location.href)), type: 'enter', willUnload: false });
	} catch {
		/* noop */
	}
	return () => afterHooks.delete(fn);
}

function buildNavTarget(url) {
	return { url, params: {}, route: { id: null } };
}
function runBefore(from, to, type) {
	let cancelled = false;
	const nav = { from: buildNavTarget(from), to: buildNavTarget(to), type, cancel: () => (cancelled = true), willUnload: false };
	for (const fn of beforeHooks) {
		try {
			fn(nav);
		} catch {
			/* noop */
		}
	}
	return !cancelled;
}
function runAfter(from, to, type) {
	for (const fn of afterHooks) {
		try {
			fn({ from: buildNavTarget(from), to: buildNavTarget(to), type, willUnload: false });
		} catch {
			/* noop */
		}
	}
}

function shouldIntercept(event, anchor) {
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
function mergeHead(newHead) {
	const current = document.head;
	const currentNodes = new Map();
	for (const node of Array.from(current.children)) {
		currentNodes.set(node.outerHTML, node);
	}
	const nextKeys = new Set();
	for (const node of Array.from(newHead.children)) {
		nextKeys.add(node.outerHTML);
	}
	// remove stale nodes (but never remove module scripts that boot the runtime)
	for (const [key, node] of currentNodes) {
		if (!nextKeys.has(key)) {
			if (node.tagName === 'SCRIPT' && node.getAttribute('type') === 'module') continue;
			node.remove();
		}
	}
	// add new nodes
	for (const node of Array.from(newHead.children)) {
		if (!currentNodes.has(node.outerHTML)) {
			current.appendChild(node.cloneNode(true));
		}
	}
}

const pageCache = new Map(); // href -> Promise<string html> (prefetch cache)

function fetchPage(href) {
	if (!pageCache.has(href)) {
		pageCache.set(
			href,
			fetch(href, { headers: { 'x-sk-islands-spa': '1' } })
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
		pageCache.get(href).then((html) => {
			if (html == null) pageCache.delete(href);
		});
	}
	return pageCache.get(href);
}

// Scripts parsed via DOMParser + adopted into the DOM never execute. Recreate the
// ones that should run, following Astro ClientRouter rules:
//  - module scripts with src: run once per URL (tracked; browser module-map also dedupes)
//  - classic src scripts: re-run on every swap
//  - inline scripts: only re-run if they carry `data-rerun`
//  - scripts identical to one already on the previous page never re-run
const executedModuleSrcs = new Set();
function reactivateScripts(root, oldScripts) {
	for (const old of Array.from(root.querySelectorAll('script'))) {
		if (oldScripts.has(old.outerHTML)) continue; // unchanged between pages -> don't re-run
		const src = old.getAttribute('src');
		const isModule = old.getAttribute('type') === 'module';
		if (src) {
			if (isModule) {
				const abs = new URL(src, location.href).href;
				if (executedModuleSrcs.has(abs)) continue;
				executedModuleSrcs.add(abs);
			}
		} else if (!old.hasAttribute('data-rerun')) {
			continue; // inline script without data-rerun -> do not re-run on swap
		}
		const fresh = document.createElement('script');
		for (const attr of old.attributes) fresh.setAttribute(attr.name, attr.value);
		fresh.textContent = old.textContent;
		old.replaceWith(fresh);
	}
}

async function navigate(url, { push = true, popScroll = null, type = 'link', replace = false } = {}) {
	const from = new URL(location.href);
	if (!runBefore(from, url, type)) return; // a beforeNavigate hook cancelled

	// Update history SYNCHRONOUSLY (before any await) so the URL is correct and
	// races between overlapping navigations can't drop the pushState.
	if (replace) {
		history.replaceState({ ...(history.state || {}), skIslands: true }, '', url.href);
	} else if (push) {
		// save outgoing scroll into the current entry, then push the new URL
		history.replaceState({ ...(history.state || {}), scroll: { x: scrollX, y: scrollY } }, '');
		history.pushState({ skIslands: true }, '', url.href);
	}

	const html = await fetchPage(url.href);
	if (html == null) {
		location.href = url.href;
		return;
	}
	pageCache.delete(url.href); // one-shot; always fresh on real navigation

	const doc = new DOMParser().parseFromString(html, 'text/html');

	// Mixed sites: if the target page has no <ClientRouter/> marker, hand over to a
	// real document navigation (and stop SPA behaviour from here on).
	const marker = doc.querySelector('meta[name="sk-islands-router"]');
	if (!marker) {
		location.href = url.href;
		return;
	}
	const useVT = marker.getAttribute('content') !== 'plain';

	const swap = () => {
		const oldScripts = new Set(
			Array.from(document.querySelectorAll('script')).map((s) => s.outerHTML)
		);
		mergeHead(doc.head);
		document.body.replaceWith(doc.body);
		document.title = doc.title;
		reactivateScripts(document.body, oldScripts);
	};

	if (useVT && document.startViewTransition) {
		const t = document.startViewTransition(swap);
		await t.updateCallbackDone.catch(() => {});
	} else {
		swap();
	}

	// scroll handling
	if (replace) {
		// invalidate/refresh — keep current scroll
	} else if (popScroll) {
		window.scrollTo(popScroll.x, popScroll.y);
	} else if (url.hash) {
		const el = document.getElementById(decodeURIComponent(url.hash.slice(1)));
		if (el) el.scrollIntoView();
		else window.scrollTo(0, 0);
	} else {
		window.scrollTo(0, 0);
	}

	runAfter(from, url, type);
}

// ---------- $app/navigation shim surface ----------
/** Programmatic navigation. Mirrors Kit's goto(). */
export function goto(url, opts = {}) {
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
	fetchPage(new URL(url, location.href).href);
	return Promise.resolve({ type: 'loaded', status: 200, data: {} });
}
export function preloadCode() {
	// island chunks are code-split & fetched on connect; nothing to warm here.
	return Promise.resolve();
}
export function disableScrollHandling() {
	if (typeof console !== 'undefined') {
		console.warn('[sk-islands] disableScrollHandling() is a no-op in the islands SPA router.');
	}
}
/** Shallow routing is not supported without Kit's client runtime. */
export function pushState() {
	console.warn('[sk-islands] pushState() shallow routing is not supported; use goto().');
}
export function replaceState() {
	console.warn('[sk-islands] replaceState() shallow routing is not supported; use goto().');
}

export function startRouter() {
	if (started || typeof document === 'undefined') return;
	// OPT-IN: only activate when a <ClientRouter/> put its marker in the head.
	if (!document.querySelector('meta[name="sk-islands-router"]')) return;
	started = true;

	document.addEventListener('click', (event) => {
		const anchor = event.target instanceof Element ? event.target.closest('a') : null;
		const url = shouldIntercept(event, anchor);
		if (!url) return;
		// same page + hash only -> let the browser handle
		if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
		event.preventDefault();
		navigate(url, { push: true });
	});

	// prefetch on hover/tap when opted in via data-sveltekit-preload-data
	const maybePrefetch = (event) => {
		const anchor = event.target instanceof Element ? event.target.closest('a') : null;
		if (!anchor) return;
		const mode = anchor.closest('[data-sveltekit-preload-data]')?.getAttribute('data-sveltekit-preload-data');
		if (mode !== 'hover' && mode !== 'tap') return;
		const url = shouldIntercept({ button: 0, defaultPrevented: false }, anchor);
		if (url && url.pathname !== location.pathname) fetchPage(url.href);
	};
	document.addEventListener('mouseover', maybePrefetch, { passive: true });
	document.addEventListener('touchstart', maybePrefetch, { passive: true });

	window.addEventListener('popstate', () => {
		const popScroll = history.state?.scroll || null;
		navigate(new URL(location.href), { push: false, popScroll });
	});

	// seed initial history entry so scroll is restored on the first back
	history.replaceState({ ...(history.state || {}), skIslands: true }, '');
}
