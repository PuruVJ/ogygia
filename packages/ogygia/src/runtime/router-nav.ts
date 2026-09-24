/**
 * THE NAVIGATION — the router's heavy half, loaded lazily by ./router.ts on the first prefetch or
 * intercepted click: page fetch + cache, head merge, the body reconcile / morph, seeds, a11y.
 * Nothing here runs at boot; a visitor who never leaves the page never downloads it.
 *
 * A navigation is TWO tasks. The first — this module's `navigate` after the fetch — does everything
 * that needs no live DOM change: parse the HTML, read the route facts, batch the incoming holes,
 * stamp reconcile keys, parse the incoming page seed, drop hints for modules already warm, preload
 * stylesheets. Then it yields. The second task is the view transition's callback and does ONLY the
 * DOM: head merge, seeds, body morph, title. The old single-task swap ran a whole-document regex,
 * two `'*'` walks and a seed parse inside `startViewTransition`, on the frame the transition
 * captures.
 */
import { PageCache } from './page-cache.js';
import { boot_link, router_link, slots } from './slots.js';
import { dispose_scope } from '../ref.js';
import {
	NO_RECONCILE_SELECTOR,
	reconcile_body,
	stamp_region_keys,
	swap_body
} from './reconcile.js';
import {
	apply_soft_invalidate_doc,
	finish_spa_document,
	page_seed_of,
	prepare_spa_document
} from './seeds.js';
import type { SpaRouter } from './router.js';
import { spa_html_cacheable } from './spa-cacheable.js';
import { emit as dt_emit } from '../devtools/bus.js';

// What this lazy chunk uses from the boot and from the router, handed over through the registry — it
// never imports a boot module (./slots.ts `BootLink`: a module both import is split out of the runtime
// chunk). The router's helpers exist only with the router feature; the MPA `invalidateAll` path (no
// router) touches none of them.
const KitBoot = { document_has: (doc: ParentNode) => boot_link().KitBoot.document_has(doc) };
const regions_in_shadow = () => boot_link().regions_in_shadow();
const session = () => boot_link().runtime_session;
const is_warmed_module = (entry: string, base?: string) => boot_link().is_warmed_module(entry, base);
const warm_island_module = (entry: string, base?: string) => boot_link().warm_island_module(entry, base);
const yield_task = () => boot_link().yield_task();
const document_key = (url: URL) => router_link().document_key(url);
const jump_to_hash = (hash: string) => router_link().jump_to_hash(hash);
const push_state = (state: unknown, url: string) => router_link().push_state(state, url);
const replace_state = (state: unknown, url?: string) => router_link().replace_state(state, url);

// DEVTOOLS gate — module-local const from the Vite `define` (proven DCE pattern); off → folds out.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;
/** High-res clock for devtools nav timings (guarded — dead when off). */
const dt_now = () =>
	typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/** RECONCILER R1: when on (and morph is installed), a nav diffs the body IN PLACE — matched regions
 *  keep their live islands, changed regions re-mount, the shell morphs — instead of a full-body
 *  replaceWith. Flip to `false` to fall back to the legacy full-swap path (the e2e safety net). */
const RECONCILE_NAV = true;

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
 * Why a page fetch is happening — sent to the server so it can skip side effects a speculative or
 * restorative fetch must not fire (analytics beacons, "last seen" writes, one-time banners):
 *  • `nav`      — a real, user-driven navigation (default). No purpose header.
 *  • `prefetch` — warmed on hover / press / viewport, BEFORE any intent to visit. Marked so the
 *                 server can treat it as a dry run (htmx's `HX-Preloaded`).
 *  • `history`  — a back/forward restore, re-fetched because we snapshot no DOM (htmx's
 *                 `HX-History-Restore-Request`). The visitor has seen this page already.
 * The header is advisory: a server that ignores it still renders correctly.
 */
export type NavPurpose = 'nav' | 'prefetch' | 'history';

/**
 * SERVER-DELTA NAV (D2): headers for a nav/prefetch fetch. Always `x-ogygia-spa`. When `purpose` is
 * not a plain nav, `x-ogygia-purpose` names it (see {@link NavPurpose}). Plus, when the current
 * document has HYDRATED islands carrying a `data-og-fp`, `x-ogygia-known` lists their fingerprints so
 * the server can SKIP re-rendering the ones this page already has live. Only data-hydrated regions
 * are claimed (never assert a region we don't actually have), and the header is omitted past a size
 * cap → the server renders everything (progressive enhancement: every header here is an optimization
 * the server may ignore, and its absence is always correct).
 */
function nav_headers(purpose: NavPurpose = 'nav'): Record<string, string> {
	const headers: Record<string, string> = { 'x-ogygia-spa': '1' };
	if (purpose !== 'nav') headers['x-ogygia-purpose'] = purpose;
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

const PREFETCH_TTL_MS = 8_000;
const PAGE_CACHE_MAX_ENTRIES = 32;
const PAGE_CACHE_MAX_BYTES = 4_000_000; // ~4MB of UTF-16-ish HTML
/** Cap on waiting for a destination stylesheet to load before the body swap (cold-cache FOUC guard). */
const STYLESHEET_WAIT_MS = 2_000;
/** Kit remote-function POSTs live under `…/_app/remote/…` (or custom `appDir`). */
const REMOTE_MUTATION_PATH = /\/remote(?:\/|$|\?)/;
/** `entry="…"` on an `<ogygia-region>` open tag (shared `g` regex — reset `lastIndex` per scan). */
const REGION_ENTRY_ATTR_G = /<ogygia-region\b[^>]*?\bentry="([^"]+)"/g;

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
			// An INLINED region sheet (server/region-css.ts): keyed by the href it stands for, so
			// the same sheet on the next document is one node, kept, never stacked.
			const region_css = node.getAttribute('data-ogygia-region-css');
			if (region_css) return `STYLE:og-css:${region_css}`;
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
export function install_head_style(
	source: Element,
	head: HTMLHeadElement = document.head,
	before: Node | null = null
) {
	const el = document.createElement('style');
	for (const attr of Array.from(source.attributes)) {
		el.setAttribute(attr.name, attr.value);
	}
	el.textContent = source.textContent || '';
	head.insertBefore(el, before);
	return el;
}

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

/**
 * Move keyboard focus to `el` without scrolling (so it never fights the post-nav scroll restore),
 * making it momentarily focusable via `tabindex=-1` and then cleaning that up so the target does not
 * linger in the tab order. For `<body>` the attribute is removed immediately (body stays the active
 * element regardless). For a normal element — a `#hash` heading — removing `tabindex` while it is
 * focused would BLUR it back to `<body>`, so the cleanup is deferred to the element's next `blur`.
 */
function focus_reset(el: HTMLElement) {
	const is_body = el === document.body || el === document.documentElement;
	const had = el.hasAttribute('tabindex');
	const prev = el.getAttribute('tabindex');
	const restore = () => {
		if (had) el.setAttribute('tabindex', prev as string);
		else el.removeAttribute('tabindex');
	};
	el.tabIndex = -1; // focusable for this one call
	el.focus({ preventScroll: true });
	if (is_body) {
		restore(); // body keeps focus even without the attribute
	} else {
		el.addEventListener('blur', () => restore(), { once: true });
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

// ── navigation state (one per document lifetime, module-level: this chunk loads once) ──────────
const page_cache = new PageCache({
	ttlMs: PREFETCH_TTL_MS,
	maxEntries: PAGE_CACHE_MAX_ENTRIES,
	maxBytes: PAGE_CACHE_MAX_BYTES
});
const inflight = new Map<string, Promise<string | null>>();
/** requested href → the FINAL href a fetch landed on after following server redirects, when it
 *  differs. One-shot: `navigate()` reads it to correct the address bar (a redirect is invisible to
 *  `fetch` beyond `response.url`), then deletes it. See {@link fetch_page}. */
const final_url = new Map<string, string>();
/** Hrefs whose prefetched HTML was already scanned for island entries — parse once. (URL-level
 *  import dedupe lives in the shared `warm_island_module`.) */
const warmed_pages = new Set<string>();
/** Hard SPA navigations only — never shared with soft invalidate. */
let nav_gen = 0;
let nav_abort: AbortController | null = null;
/** Soft invalidate fetches only — aborting these must not cancel a real click nav. */
let soft_gen = 0;
let soft_abort: AbortController | null = null;
/** The visually-hidden `aria-live` region that announces each navigation to screen readers. Created
 *  lazily on the first nav and reused (a live region must persist so assistive tech observes its
 *  mutations). It lives in `<body>` but is DETACHED before each body swap so the reconcile never
 *  removes it, then re-attached. See {@link announce} / {@link reset_focus}. */
let announcer: HTMLElement | null = null;

export function bust_page_cache() {
	page_cache.clear();
	inflight.clear();
	final_url.clear();
}

export function page_cache_size() {
	return page_cache.size;
}

/**
 * Bust the SPA HTML cache after any successful Kit remote mutation (command/form POST).
 * Forms also call `invalidateAll` (soft seed refresh + bust); commands only refresh queries —
 * without this fetch hook, prefetched pages stay stale. Installed once, when this chunk loads —
 * before it there is no cache to bust.
 */
function install_remote_mutation_cache_bust() {
	if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
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
				if (REMOTE_MUTATION_PATH.test(href)) bust_page_cache();
			}
		} catch {
			/* never break fetch */
		}
		return res;
	};
}
install_remote_mutation_cache_bust();

export function fetch_page(href: string, signal?: AbortSignal, purpose: NavPurpose = 'nav') {
	// Warm cache hit (a prefetched page, or an in-flight prefetch): serving it is instant, so
	// even an abortable navigation uses it — there is nothing to abort on a resolved cache hit
	// or a shared prefetch promise. Without this, a click after a hover-prefetch would re-fetch
	// (the whole point of prefetch is to skip that second request). Real navigations delete the
	// entry after use (one-shot — see navigate()), so the next visit is still fresh. PREFETCH-HIT.
	const cached = page_cache.get(href);
	if (cached != null) return Promise.resolve(cached);
	const pending = inflight.get(href);
	if (pending) return pending;

	// A fresh fetch is about to define this href's redirect fate — drop any stale mapping from an
	// earlier (now cache-expired) prefetch so a non-redirecting response isn't shadowed by it.
	final_url.delete(href);

	const settled = fetch(href, {
		signal,
		headers: nav_headers(purpose)
	})
		.then(async (res) => {
			const ct = res.headers.get('content-type') || '';
			if (!ct.includes('text/html')) return { html: null as string | null, cacheable: false };
			// A server redirect (a Kit `redirect()` in load, a trailing-slash canonicalization) is
			// followed transparently by `fetch`; the only trace is `response.url`. Record the landing
			// href so `navigate()` can correct the address bar it optimistically pushed BEFORE the
			// fetch — otherwise the old URL sits over the redirected content.
			if (res.redirected && res.url && res.url !== href) final_url.set(href, res.url);
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
		inflight.set(href, html_p);
		html_p.finally(() => {
			if (inflight.get(href) === html_p) inflight.delete(href);
		});
		settled
			.then((r) => {
				if (r.html == null) return;
				if (r.cacheable) page_cache.set(href, r.html);
				// Warm the destination's island JS during the hover/idle runway, so the click path is
				// swap + hydrate with no first-time import() per island — the module graph is already
				// resolved when load_island() runs. This is the biggest prefetch win: without it, a warm
				// (HTML-cached) navigation still stalls hydration on cold island chunks.
				warm_modules(href, r.html);
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
function warm_modules(href: string, html: string) {
	if (warmed_pages.has(href)) return;
	warmed_pages.add(href);
	// Match `entry="…"` on ogygia-region open tags in our own SSR output (module URLs never contain
	// a double-quote), collecting the distinct client-island module specifiers. URL-level dedupe +
	// failure-retry live in the shared warmer (one scheme for router/visible/interaction warms).
	REGION_ENTRY_ATTR_G.lastIndex = 0; // shared `g` regex — start each scan at 0
	let m: RegExpExecArray | null;
	while ((m = REGION_ENTRY_ATTR_G.exec(html))) warm_island_module(m[1], href);
}

/**
 * PREFLIGHT — the incoming document's read-only preparation, in the task BEFORE the transition:
 *  • `<link rel="modulepreload">` hints for modules this page already warmed are dropped, so the
 *    head merge never re-issues a fetch for bytes the module map holds;
 *  • reconcile keys are stamped on the incoming regions (the fingerprint reads, off the DOM change);
 *  • the incoming page seed is parsed once, on the document (runtime/seeds.ts) — a kept island's
 *    props absorb and the soft-invalidate both reuse that parse inside the transition.
 */
function preflight(doc: Document, dest: URL) {
	for (const l of Array.from(doc.querySelectorAll('link[rel="modulepreload"]'))) {
		const href = l.getAttribute('href');
		if (href && is_warmed_module(href, dest.href)) l.remove();
	}
	stamp_region_keys(doc.body);
	page_seed_of(doc);
}

// NOTE: the library does NO script processing. Scripts inserted via a client-side body swap do
// not execute (standard browser behaviour for parsed/adopted <script> nodes) — if you need code
// to run per navigation, use an island. Our own runtime module script is marked
// `data-ogygia-runtime` and is the only module script merge_head retains across swaps.
export async function navigate(
	r: SpaRouter,
	url: URL,
	from: URL,
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
	if (!r.run_before(from, url, type)) return; // a beforeNavigate hook cancelled

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
	nav_abort?.abort();
	nav_abort = new AbortController();
	const { signal } = nav_abort;
	const gen = ++nav_gen;
	// the address being navigated to, while the fetch + swap are in flight (click listener)
	r.nav_target = url.href;
	signal.addEventListener('abort', () => {
		if (r.nav_target === url.href) r.nav_target = null;
	});

	// Update history SYNCHRONOUSLY (before any await) so the URL is correct and
	// races between overlapping navigations can't drop the pushState.
	if (replace) {
		replace_state({ ...(history.state || {}), ogygia: true }, url.href);
	} else if (push) {
		// save outgoing scroll into the current entry, then push the new URL
		replace_state({ ...(history.state || {}), scroll: { x: scrollX, y: scrollY } });
		push_state({ ogygia: true }, url.href);
	}

	// A back/forward restore re-fetches (we hold no DOM snapshot); mark it so the server can skip
	// side effects the visitor already triggered on the first visit. A plain click is `nav`.
	const purpose: NavPurpose = type === 'popstate' ? 'history' : 'nav';

	let html: string | null;
	try {
		html = await fetch_page(url.href, signal, purpose);
	} catch (err) {
		if ((err as { name?: string })?.name === 'AbortError' || gen !== nav_gen) return;
		location.href = url.href;
		return;
	}
	if (gen !== nav_gen) return;
	if (html == null) {
		location.href = url.href;
		return;
	}
	page_cache.delete(url.href); // one-shot; always fresh on real navigation

	// REDIRECT: the fetch may have landed on a different href (a Kit `redirect()` in load, a
	// canonical trailing-slash bounce). `dest` is the address the content actually belongs to —
	// used from here on for the address bar, doc key, current URL, and hash scroll. A cross-origin
	// redirect can't be a body swap, so hand it to the browser. `dest` === `url` in the common case.
	let dest = url;
	const landed = final_url.get(url.href);
	final_url.delete(url.href); // one-shot, like the page cache
	if (landed) {
		let final: URL;
		try {
			final = new URL(landed, url);
		} catch {
			final = url;
		}
		if (final.origin !== location.origin) {
			location.href = final.href;
			return;
		}
		dest = final;
		// A redirect REPLACES the intermediate URL (browser semantics), so the back button skips it.
		replace_state({ ...(history.state || {}), ogygia: true }, dest.href);
	}

	// ── TASK ONE: parse + facts + preflight — no live DOM change ──
	const doc = new DOMParser().parseFromString(html, 'text/html');

	// csr=true Kit pages boot via inline/module scripts that cloneNode will NOT execute.
	// Hand off to a full navigation instead of a half-broken SPA swap (BRK-HEAD). Read off the
	// parsed document (the route meta, else its inline scripts) — never a regex over the string.
	if (KitBoot.document_has(doc)) {
		location.href = dest.href;
		return;
	}

	// Mixed sites: if the target page has no `ogygia-router` marker (the handle injects it on
	// every ogygia page), it is not an ogygia page — hand over to a real document navigation
	// (and stop SPA behaviour from here on).
	const marker = doc.querySelector('meta[name="ogygia-router"]');
	if (!marker) {
		location.href = dest.href;
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
	batch_regions(doc);
	preflight(doc, dest);

	// Cold-cache FOUC guard: get the destination's stylesheets loaded and applied BEFORE the body
	// swap, so the first post-deploy navigation never flashes unstyled content (a full-width column
	// snapping to its styled width). Warm caches resolve this instantly. Old body keeps its styles
	// until the swap, so adding the sheets early is invisible.
	await preload_stylesheets(doc.head);
	if (gen !== nav_gen) return;
	// The transition starts in a task of its own: everything above is a finished task by then, and
	// the frame it captures is not the one that parsed 2 MB of HTML.
	await yield_task();
	if (gen !== nav_gen) return;

	// Reconcile in place unless a region lives where a body morph cannot reach it (a shadow root —
	// counted, not walked), or an author opted the page out on either side.
	const reconcile =
		RECONCILE_NAV &&
		!!slots.morph &&
		!regions_in_shadow() &&
		!document.body.querySelector(NO_RECONCILE_SELECTOR) &&
		!doc.body.querySelector(NO_RECONCILE_SELECTOR);

	// ── TASK TWO: the DOM — head, seeds, body, title ──
	const swap = () => {
		// Stale nav: do not mutate the DOM (view-transition can otherwise commit a superseded swap).
		if (gen !== nav_gen) return;
		// Pull the a11y announcer out of the body before the reconcile — it isn't in the incoming
		// HTML, so a body morph would remove it. Re-attached (with the new title) by `announce`.
		announcer?.remove();
		// LIFECYCLE (Astro-parity DOM events): last chance to read the OUTGOING page's DOM.
		document.dispatchEvent(new Event('og:before-swap'));
		merge_head(doc.head); // keeps our runtime module script alive across swaps
		if (gen !== nav_gen) return;
		// CONTINUITY: snapshot the LEAVING page's changed island form fields (session-scoped) so
		// returning to it restores what the visitor was mid-typing. Read the old body now.
		if (slots.forms.enabled && r.current_url) {
			slots.forms.snapshot(document.body, r.current_url.pathname);
		}
		// Clear session state BEFORE body connect so new regions never see the previous page; then
		// seed the shared page store + remote seeds from the new doc (the parse preflight made) —
		// `$app/state` page.url/params/data update reactively inside KEPT islands, and every island
		// that connects below reads the new page, never a stale script. Seeds first, DOM second.
		prepare_spa_document();
		apply_soft_invalidate_doc(doc);
		if (gen !== nav_gen) return;
		if (reconcile) {
			// THE nav path: diff the live body toward the parsed one IN PLACE. Matched regions
			// (same fingerprint) keep their live hydrated node and island state; changed regions
			// re-mount; shell + keep-chrome (data-ogygia-keep) morph in place. Selective dispose of
			// only REMOVED regions' hub ids happens inside reconcile_body.
			reconcile_body(document.body, doc.body, slots.morph!);
			dt_reconciled = true;
			document.title = doc.title;
			session().settle_lakes_in(document.body);
		} else {
			// FALLBACK (reconcile off, or a region nested in an open shadow root morph can't pierce):
			// an outerSync body swap — keep the live <body> node (and everything attached to it),
			// sync its attributes, replace its children. keep-continuity does NOT survive here —
			// islands re-mount like a hard nav. This path is rare; the reconcile path above is the norm.
			if (DEVTOOLS)
				dt_emit({
					domain: 'nav',
					name: 'nav.fallback',
					reason: !slots.morph ? 'no-morph' : 'shadow-region'
				});
			swap_body(document.body, doc.body);
			document.title = doc.title;
			session().settle_lakes_in(document.body);
			dispose_scope('page');
		}
		// STREAMED pages fetched over SPA nav arrive COMPLETE (fetch buffers the stream), so any
		// late templates still inert in the parsed doc apply now — the inline boot script that
		// handles them on a full load never executes across a body swap.
		apply_late_templates(document.body);
		// Old islands disconnected; new hydrates are queued — sweep stale Kit remotes now.
		finish_spa_document();
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
	if (gen !== nav_gen) return;

	// From here on, `dest` is the address the swapped content belongs to (== `url` unless a
	// server redirect moved it).
	r.doc_key = document_key(dest);
	r.current_url = dest;
	r.nav_target = null; // applied — a later same-address click is a refresh, not a duplicate
	if (DEVTOOLS)
		dt_emit({
			domain: 'nav',
			name: 'nav.finish',
			to: dest.pathname + dest.search,
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
		jump_to_hash(dest.hash);
	}

	// ACCESSIBILITY (scroll has settled): announce the new page to screen readers, then reset
	// keyboard focus to the top of it — the two things a full navigation gives for free and a body
	// swap does not.
	announce(dest);
	reset_focus(dest.hash);

	r.run_after(from, dest, type);
	// LIFECYCLE: the navigation is COMPLETE (head merged, body in place, scroll settled) — the
	// per-navigation hook for code that a body swap's inert <script> tags can never run. Also
	// fired once on initial load by the runtime boot, so ONE listener covers every page view.
	document.dispatchEvent(new Event('og:page-load'));
	// new <body> -> re-evaluate eager/viewport preload links on the freshly-swapped page
	r.scan_preload_links();
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
export async function invalidate_all() {
	bust_page_cache();
	const url = new URL(location.href);

	soft_abort?.abort();
	soft_abort = new AbortController();
	const { signal } = soft_abort;
	const gen = ++soft_gen;

	let html: string | null;
	try {
		html = await fetch_page(url.href, signal);
	} catch (err) {
		if ((err as { name?: string })?.name === 'AbortError' || gen !== soft_gen) return;
		return;
	}
	if (gen !== soft_gen || html == null) return;

	const doc = new DOMParser().parseFromString(html, 'text/html');
	if (KitBoot.document_has(doc)) return;
	if (!doc.querySelector('meta[name="ogygia-router"]')) return;

	merge_head(doc.head);
	apply_soft_invalidate_doc(doc);
}

/**
 * ACCESSIBILITY — announce the new page. A body swap is invisible to assistive tech: no document
 * `load`, so a screen reader is never told the page changed. Mirror what a full navigation (and
 * SvelteKit) give for free — a visually-hidden `aria-live` region whose text becomes the new
 * `<title>`, so the page is spoken on arrival. The region is created once and reused (it must
 * already be in the DOM when its text changes for AT to observe it); it was detached before the
 * swap so the reconcile couldn't remove it, and is re-attached here before its text is set.
 */
function announce(dest: URL) {
	let el = announcer;
	if (!el) {
		el = document.createElement('div');
		el.setAttribute('data-ogygia-announcer', '');
		el.setAttribute('aria-live', 'assertive');
		el.setAttribute('aria-atomic', 'true');
		// Visually hidden but readable by AT (the standard sr-only recipe — NOT display:none).
		el.style.cssText =
			'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
			'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0';
		announcer = el;
	}
	if (el.parentNode !== document.body) document.body.appendChild(el);
	el.textContent = document.title || dest.pathname;
}

/**
 * ACCESSIBILITY — reset keyboard focus after a navigation, so a keyboard or screen-reader user
 * lands at the top of the new page instead of wherever focus was on the old one (a full navigation
 * does this natively; a body swap does not). SvelteKit's algorithm: a `[autofocus]` element wins;
 * else a `#hash` target; else focus falls back to `<body>` (made momentarily focusable). The one
 * ogygia twist: a control INSIDE kept/persisted chrome (`data-ogygia-keep` / `data-persist`) that
 * survived the nav is left focused — the visitor is still using that persistent widget.
 */
function reset_focus(hash: string) {
	const active = document.activeElement as HTMLElement | null;
	if (
		active &&
		active !== document.body &&
		active.isConnected &&
		active.closest('[data-ogygia-keep],[data-persist]')
	) {
		return; // focus is on surviving persistent chrome — don't yank it to the top
	}

	if (hash) {
		const id = decodeURIComponent(hash.slice(1));
		const target = id ? document.getElementById(id) : null;
		if (target) return focus_reset(target);
	}
	const autofocus = document.querySelector<HTMLElement>('[autofocus]');
	if (autofocus) {
		autofocus.focus();
		return;
	}
	focus_reset(document.body);
}

/** Merge <head>: keep nodes present in both, remove stale, add new. Keeps runtime scripts alive. */
function merge_head(new_head: HTMLHeadElement) {
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
	// A `<style>` the next document carries goes at the TOP of <head>, in document order — exactly
	// where `preload_stylesheets` puts an SPA `<link>`, and for the same reason: an island's
	// `<svelte:head>` hydration on the new page reclaims a TRAILING head-node range, so a sheet
	// appended at the end goes with it. Kit inlines a route's small sheets as `<style>` under
	// `kit.inlineStyleThreshold`, and ogygia inlines small region sheets the same way; one such
	// destination page lost its `ogygia-region{display:block}` and the layout collapsed
	// (e2e/context, "Context after SPA navigation"). `anchor` is the head's first child BEFORE this
	// merge, so the new sheets land above everything old and keep their own order.
	const anchor = current.firstChild;
	for (const node of Array.from(new_head.children)) {
		if (is_dangerous_head_node(node)) continue;
		const key = head_node_key(node);
		const existing = current_nodes.get(key);
		// Kit FOUC bag: always refresh content (same key every page, different CSS).
		if (key === 'STYLE:data-sveltekit') {
			existing?.remove();
			install_head_style(node, current, anchor);
			continue;
		}
		if (existing) continue;
		if (node.tagName === 'STYLE') {
			install_head_style(node, current, anchor);
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
 * `merge_head` then dedupes these by key so nothing is added twice. Capped so a stalled sheet
 * can't hang navigation.
 */
function preload_stylesheets(new_head: HTMLHeadElement): Promise<unknown> {
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

/**
 * SINGLE-FLIGHT NAVIGATION. Collect the incoming page's deferred, load-timed region calls and stream them as
 * one batch. Reads the RENDERED holes (`<ogygia-region render="defer" endpoint>`), so it covers
 * both placed server islands and held `region()` deferred regions alike — authoring syntax is
 * irrelevant. Only `when="load"` (or unset) is batched: a region scheduled `visible`/`idle`/media
 * stays lazy and fetches on its own trigger, so dynamic schedules are preserved, not eagerly pulled.
 */
function batch_regions(doc: Document) {
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
