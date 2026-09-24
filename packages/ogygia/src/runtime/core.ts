import { frameAddress } from '../frame.js';
import { kit_hydrates_page } from './kit-boot.js';
import { parse_region_html } from './parse-html.js';
import { runtime_session } from './session.js';
import {
	is_allowed_region_endpoint,
	is_document_answer,
	is_redirected_answer,
	is_same_origin_response,
	island_module_url,
	RegionAnswerRefused
} from './region-endpoint-url.js';
import {
	is_awake,
	is_deferred,
	is_frozen,
	ours_on_kit_document,
	phase2_hydrate_schedule,
	region_hydrate_schedule,
	region_schedule
} from './region-attrs.js';
import { slots } from './slots.js';
import { KEEP_FALLBACK_HTML } from '../keep-fallback-marker.js';
import { NAV_HANDLE_KEY, mpa_nav, publish_nav } from './nav-handle.js';
import { link_boot } from './boot-link.js';
import {
	background_start,
	hydrate_settled,
	hydrate_started,
	hydrate_turn,
	register_region,
	unregister_region
} from './schedule.js';
import { once_visible } from './observe.js';
import { connected_regions } from './connected.js';
import { restore_props_sidecar } from './sidecar.js';
import { hole_facts_of } from './hole-facts.js';
import { beacon_hydrated } from './beacon.js';
import type { IslandHandle, IslandModule } from './hydrate-core.js';
import { emit as dt_emit } from '../devtools/bus.js';
import {
	install_window_sink as dt_install_window_sink,
	ingest_server_events as dt_ingest_server
} from '../devtools/sinks.js';
import { install_devtools_ui as dt_install_ui } from '../devtools/ui.js';

// DEVTOOLS gate — module-local const from the Vite `define` (the proven DCE pattern): when off, every
// `if (DEVTOOLS) dt_emit({…})` folds to `if (false)` and the whole devtools graph tree-shakes away.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

/** Above this many characters an island keeps no server copy (its hydration falls back to
 *  Svelte's own recovery on a mismatch) — a bound on memory, not a behaviour anyone tunes. */
const SSR_SNAPSHOT_MAX = 1 << 19;

/** Per-node stash of a nested island's PRISTINE server markup, captured from a fetched fragment WHILE it
 *  is still disconnected — nothing has upgraded it — so the island repairs against its true server bytes
 *  instead of a DOM a swapped-in foreign runtime may have already mutated. See region_fragment. */
const PRISTINE_SSR = Symbol('ogygia.pristine-ssr');
type PristineHost = { [PRISTINE_SSR]?: string };

/** A dynamic-import failure of the island ENTRY (network/stale), not a hydration throw. The browser
 *  message is `Failed to fetch dynamically imported module: <url>` across engines. */
const ENTRY_FETCH_FAILED_RE =
	/failed to fetch dynamically imported module|error loading dynamically imported module/i;

// A real `.css` asset href (vs a dev MODULE url masquerading as a region-css sheet) — see
// apply_dev_head_region_css.
const CSS_ASSET_HREF_RE = /\.css(\?|$)/;

/** The island's server markup to hydrate against later (#ssr_html), or `null` when there is
 *  nothing worth keeping: no children, or more than SSR_SNAPSHOT_MAX characters. */
function snapshot_markup(region: Element): string | null {
	if (!region.firstChild) return null;
	const html = region.innerHTML;
	return html.length > SSR_SNAPSHOT_MAX ? null : html;
}

/** The same copy for a hole's answer BEFORE it is put in the document: serialized through a
 *  detached box (a fragment has no `innerHTML`; nothing connects, so no element reacts) and the
 *  nodes handed back. Taken after the swap it would be the DOM as the custom elements inside the
 *  answer left it — their connect reactions run at insertion, before any line after it. */
function fragment_markup(frag: DocumentFragment): string | null {
	if (!frag.firstChild) return null;
	const box = document.createElement('div');
	box.appendChild(frag);
	const html = box.innerHTML;
	frag.append(...Array.from(box.childNodes));
	return html.length > SSR_SNAPSHOT_MAX ? null : html;
}

const HOLE_WITHOUT_ADDRESS_WARNING =
	'[ogygia] deferred region %s was rendered in the browser with no server-minted address, and the ' +
	'document records none for it (a client-side navigation mounted it, or its props differ from ' +
	'the server render) — its fallback stands. A hole is server HTML: render it on the server.';

/** Read the identity fields devtools events correlate on, off a region element. Cheap — attributes
 *  already in hand. Only ever called from behind an `if (DEVTOOLS)` guard, so it costs nothing off. */
function dt_ids(el: Element): { entry?: string; fp?: string } {
	const entry = el.getAttribute('entry') || undefined;
	const fp = el.getAttribute('data-og-fp') || undefined;
	return { entry, fp };
}

/** High-res clock for devtools timings (guarded — dead when devtools is off). */
function now_ms(): number {
	return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * THE HYDRATE CORE, loaded once, lazily (./hydrate-core.ts): Svelte's `hydrate`, the provider
 * host, the props parse, the page seed, and the HYDRATE-phase features (link/runtime-entry.ts), which
 * it installs as it evaluates. Nothing in this always-on module — nor in any boot-phase feature —
 * imports Svelte: in a real app Svelte's client runtime is ONE shared chunk (~200 KB), and anything in
 * the boot's static graph downloads first in `<head>`, ahead of the page's own LCP image, before a
 * single island needs it. It arrives with this one import instead, when the first island hydrates. A
 * page whose islands all wake on `visible` / `interaction` boots without fetching it at all.
 * `test/runtime-boot-svelte-free.test.ts` pins the invariant over the whole boot graph.
 * `loaded_core` is the synchronous view once it has arrived (a kept island's props absorb runs
 * inside the reconciler, synchronously, and only ever for an island that already hydrated).
 */
type HydrateCore = typeof import('./hydrate-core.js');
let core_promise: Promise<HydrateCore> | null = null;
let loaded_core: HydrateCore | null = null;
function hydrate_core(): Promise<HydrateCore> {
	if (!core_promise) {
		core_promise = import('./hydrate-core.js').then((m) => (loaded_core = m));
	}
	return core_promise;
}

/** What counts as intent for an ON-DEMAND hole (`render: 'deferred'` + `wake: 'interaction'`).
 *  `pointerover` (not `pointerenter`) so it fires on hover AND bubbles through the boxless
 *  `display: contents` wrapper from a descendant the pointer actually moves over. */
const ON_DEMAND_EVENTS = [
	'pointerover',
	'focusin',
	'pointerdown',
	'touchstart',
	'keydown'
] as const;
const ON_DEMAND_SELECTOR = 'ogygia-region[render="defer"][when="interaction"]';

/**
 * ON-DEMAND holes, delegated: ONE set of capture listeners on the document for every armed hole
 * (five listeners per hole used to be five hundred on a page of mega-menus). Intent lands anywhere
 * inside a hole; the nearest ARMED hole above the target fires once and is forgotten.
 */
const on_demand_armed = new Map<Element, () => void>();
let on_demand_installed = false;
function on_demand_event(e: Event): void {
	if (on_demand_armed.size === 0) return;
	let region = e.target instanceof Element ? e.target.closest(ON_DEMAND_SELECTOR) : null;
	while (region && !on_demand_armed.has(region)) {
		region = region.parentElement?.closest(ON_DEMAND_SELECTOR) ?? null;
	}
	if (!region) return;
	const fire = on_demand_armed.get(region)!;
	on_demand_armed.delete(region);
	fire();
}
function arm_on_demand(region: Element, fire: () => void): void {
	on_demand_armed.set(region, fire);
	if (on_demand_installed) return;
	on_demand_installed = true;
	for (const type of ON_DEMAND_EVENTS)
		document.addEventListener(type, on_demand_event, { capture: true, passive: true });
}

/** Load a hydrate island module from `<ogygia-region entry>` (dev + prod). */
const load_island = (entry: string) => {
	const url = island_module_url(entry);
	return import(/* @vite-ignore */ url) as Promise<IslandModule>;
};

/**
 * DEV watchdog for a stranded tab (dev only; the branch is dead in a production build). Under
 * `csr = false` Kit ships no client bootstrap, so a Vite dep re-optimization — which rotates the
 * optimizer's browserHash — can leave a tab that was loaded under the old hash importing island dep
 * URLs (`svelte.js?v=<old>`) that now 404, and Vite's own full-reload does not always reach a
 * csr=false page. The island entry then throws `Failed to fetch dynamically imported module` on
 * wake, and nothing recovers it.
 *
 * We CONFIRM it is staleness, not a genuinely-missing module: re-fetch the entry URL, and reload
 * only when the server still serves it (200) — a real 404 is a different bug and must stay visible.
 * A timestamp in `sessionStorage` bounds it to one reload per few seconds, so a genuinely broken
 * entry (200 that keeps failing to import) never loops.
 */
const STALE_DEP_RELOAD_KEY = 'ogygia:dev:dep-reload';
const STALE_DEP_RELOAD_WINDOW_MS = 6000;
async function recover_from_stale_deps(entry: string | null): Promise<void> {
	if (!import.meta.env.DEV || !entry || typeof location === 'undefined') return;
	try {
		const last = Number(sessionStorage.getItem(STALE_DEP_RELOAD_KEY) || 0);
		if (Date.now() - last < STALE_DEP_RELOAD_WINDOW_MS) return; // already reloaded — don't loop
		const res = await fetch(island_module_url(entry), { cache: 'no-store' });
		if (!res.ok) return; // a real 404 — leave the error visible, it is not a re-optimize
		sessionStorage.setItem(STALE_DEP_RELOAD_KEY, String(Date.now()));
		location.reload();
	} catch {
		/* storage blocked / fetch blocked — the dev sees the error and reloads by hand */
	}
}

function dom_ready() {
	if (typeof document === 'undefined' || document.readyState !== 'loading')
		return Promise.resolve();
	return new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
}

/**
 * Parse a fetched region's HTML into a fragment, HOISTING any `<link data-ogygia-region-css>` (or
 * inlined `<style data-ogygia-region-css="href">`) it carries into `<head>` (deduped by href). A held / server-picked region's component was never
 * imported by the page, so its scoped CSS is in no stylesheet the page loaded; the region response
 * ships the links and the runtime lifts them to the head — where they load once and stick. (A link
 * left in the body would also fail to load inside a `<template>` batch parcel.)
 */
export function region_fragment(html: string): { frag: DocumentFragment; ready: Promise<void> } {
	const frag = parse_region_html(html);
	const links = frag.querySelectorAll('link[data-ogygia-region-css]');
	const pending: Array<Promise<void>> = [];
	if (links.length && import.meta.env.DEV) {
		// DEV: there is no linkable CSS asset — Vite serves component CSS only as an importable module
		// (importing it injects the scoped `<style>`). `islandCss` handed us the region's dev module URL
		// as the href, so import it here. Same region-css channel as prod, resolved for the dev server;
		// this is why one mechanism now covers held regions AND server-island holes in both environments.
		const seen = new Set<string>();
		for (const link of links) {
			const href = link.getAttribute('href');
			link.remove();
			if (!href) continue;
			// Document-relative href → resolve against the document, never this module (see
			// island_module_url: a bare import() of `../../@id/…` lands on `/node_modules/@id/…`).
			const url = island_module_url(href);
			if (seen.has(url)) continue;
			seen.add(url);
			pending.push(
				import(/* @vite-ignore */ url).then(
					() => undefined,
					() => undefined
				)
			);
		}
	} else if (links.length) {
		const existing = new Map(
			Array.from(document.querySelectorAll('link[rel="stylesheet"]'), (l) => [
				l.getAttribute('href'),
				l as HTMLLinkElement
			])
		);
		// Resolve on load OR error (a broken sheet must not wedge the paint) so the caller can await
		// the stylesheet before swapping the HTML in — no flash of unstyled server-picked content.
		const until_loaded = (l: HTMLLinkElement) =>
			new Promise<void>((resolve) => {
				l.addEventListener('load', () => resolve(), { once: true });
				l.addEventListener('error', () => resolve(), { once: true });
				// Attach-then-check closes the race where the sheet finished between our lookup and the
				// listener registration (`sheet` is set synchronously with the load event).
				if (l.sheet) resolve();
			});
		for (const link of links) {
			const href = link.getAttribute('href');
			link.remove();
			if (!href) continue;
			const present = existing.get(href);
			if (present) {
				// Already in the document — but "present" is not "loaded". A concurrent applier (frame
				// morph vs applyLive of the same ticket) hoists first and awaits; every later applier
				// must await the SAME in-flight sheet, or it paints unstyled mid-download.
				if (!present.sheet) pending.push(until_loaded(present));
				continue;
			}
			const clone = document.createElement('link');
			clone.rel = 'stylesheet';
			clone.href = href;
			clone.setAttribute('data-ogygia-region-css', '');
			pending.push(until_loaded(clone));
			existing.set(href, clone);
			document.head.appendChild(clone);
		}
	}
	// An INLINED region sheet (server/region-css.ts — under Kit's `inlineStyleThreshold` the server
	// ships `<style data-ogygia-region-css="href">` instead of a link): hoist it into <head> the same
	// way, once per identity — the href it stands for — against the sheets the page already has in
	// either shape. Nothing to await: the text is right here.
	const styles = frag.querySelectorAll('style[data-ogygia-region-css]');
	if (styles.length) {
		const present = new Set<string>();
		for (const n of document.head.querySelectorAll(
			'[data-ogygia-region-css], link[rel="stylesheet"]'
		)) {
			const id =
				n.tagName === 'STYLE' ? n.getAttribute('data-ogygia-region-css') : n.getAttribute('href');
			if (id) present.add(id);
		}
		for (const style of styles) {
			const id = style.getAttribute('data-ogygia-region-css') || '';
			style.remove();
			if (!id || present.has(id)) continue;
			present.add(id);
			const el = document.createElement('style');
			el.setAttribute('data-ogygia-region-css', id);
			el.textContent = style.textContent || '';
			// At the TOP of <head>, like the router's SPA sheets (router-nav.ts): an island's
			// `<svelte:head>` hydration reclaims a trailing head-node range, and a sheet appended at
			// the end can go with it.
			document.head.insertBefore(el, document.head.firstChild);
		}
	}
	// Cap the wait so a genuinely hung stylesheet eventually paints (unstyled) rather than blocking
	// forever — generous, because the caller shows a placeholder meanwhile, so a slow-link stylesheet
	// (seconds on 4G) should still win the race and paint styled.
	const ready = pending.length
		? Promise.race([
				Promise.all(pending).then(() => undefined),
				new Promise<void>((r) => setTimeout(r, 5000))
			])
		: Promise.resolve();
	// Pre-capture each nested self-hydrating island's PRISTINE markup while the fragment is still
	// disconnected. Once inserted, a swapped-in foreign runtime (a web-component upgrade) can reach a raw
	// custom element inside the island — attaching a shadow, its normalization dropping neighbouring
	// whitespace text nodes — BEFORE ogygia hydrates the island. The island would then snapshot that
	// already-mutated DOM at connect, its own drift-check would see a mismatch it did not cause, and it
	// would discard + re-render (invisible but noisy). Captured here, it repairs against the server's
	// real bytes. The hole ITSELF already does this (fragment_markup, see #apply); this extends the same
	// guarantee to the islands nested inside it.
	for (const el of frag.querySelectorAll('ogygia-region')) {
		if (el.getAttribute('entry') && !is_deferred(el) && !is_frozen(el)) {
			(el as unknown as PristineHost)[PRISTINE_SSR] = el.innerHTML;
		}
	}

	return { frag, ready };
}

/** TEST: the pristine server markup {@link region_fragment} stashed on a nested island, if any. */
export function pristine_ssr_of(el: Element): string | undefined {
	return (el as unknown as PristineHost)[PRISTINE_SSR];
}

class OgygiaRegion extends HTMLElement {
	#scheduled = false;
	/** The server-minted `endpoint` of a deferred hole, captured at connect. On a Kit-hydrated
	 *  (csr=true) document the wrapper's client leg cannot mint (the virtual is stubbed to ''), so
	 *  Kit's hydration pass reconciles the attribute to '' — after the runtime saw it at parse time.
	 *  The fetch reads this copy and restores the attribute (lakes, devtools and the router's
	 *  next-page warm all read the DOM). */
	#minted_endpoint: string | null = null;
	/** THE HYDRATION SOURCE OF TRUTH: this island's server markup as it connected (or, for a
	 *  hydrating hole, as its answer was swapped in). An island can sleep a long time and other
	 *  scripts edit the page meanwhile; on wake, hydrate-core hydrates against THIS when the live
	 *  DOM drifted, instead of letting Svelte re-render the island client-side. Dropped once the
	 *  island is awake. `null` for a nested region (rides its parent) and above SSR_SNAPSHOT_MAX. */
	#ssr_html: string | null = null;
	/** True after a successful HTML swap — failures leave this false so a later schedule can retry. */
	#done = false;
	/** In-flight `#apply` run. `#apply` awaits the region's stylesheet before swapping, so anyone
	 * who needs the post-swap state (`#done`, phase-2 hydrate arming) must await this first —
	 * sampling `#done` right after the fetch races the CSS wait and reads stale `false`. */
	#applying: Promise<void> | undefined;
	/** In-flight fetch guard (separate from `#done` so a failed fetch does not one-shot the region). */
	#fetching = false;
	/** Bounded automatic retries after a failed defer/SWR fetch. */
	#fetch_attempts = 0;
	/** Frame-store address (endpoint call) this region is fetching, so disconnect can release it. */
	#frame_address: string | null = null;
	/** Unsubscribe from the frame store (a defer region binds to its address). */
	#frame_unsub: (() => void) | null = null;
	/** Set while an SWR revalidate is in flight, so the next apply marks `data-revalidated`. */
	#revalidating = false;
	#hydrating = false;
	/** The hydrated island (hydrate core handle): dispose, and for a kept island, props push. */
	#app: IslandHandle | null = null;
	/** Stops the shared `visible` observation (set while armed, cold). */
	#stop_visible: (() => void) | null = null;
	/** Removes the `wake="interaction"` wake listeners (set while armed, cold). */
	#disarm_interaction: (() => void) | null = null;
	#mql: { mql: MediaQueryList; on: (e: MediaQueryListEvent) => void } | null = null;
	/** The hole answered `keepFallback()`: the page's fallback stands, no phase-2 wake. */
	#kept = false;
	/** Abort in-flight region HTML fetch on disconnect (P-ABORT). */
	#fetch_abort: AbortController | null = null;
	/** Cancel idle schedule when disconnected. */
	#idle_handle: number | null = null;
	/** Live region (`<ogygia-region live>`): driven imperatively by Region.svelte's applyLive. */
	#live_ready = false;
	#live_app: IslandHandle | null = null;
	#live_module = '';
	// The two wake targets, bound once per element (not per connect): `#arm` hands them to a
	// schedule, and `load` calls them straight — no closure built on the connect path. Each returns
	// its promise: the interaction feature awaits it to know when the island is live (replay).
	#fire_hydrate = () => this.#hydrate();
	#fire_server = () => this.#server();
	#fire_prefetch = () => this.#prefetch_html();

	/**
	 * CONTINUITY: this persisted island is relocating onto `next` (the incoming page's SSR region).
	 * Push the new page's props into the live app so a `persist`ed component reflects the new route
	 * (e.g. a player's `track` changes) instead of freezing at first-mount props. Called by the
	 * router just before `next` is discarded. Synchronous by contract — a kept island has hydrated,
	 * so the hydrate core is loaded.
	 */
	absorbKeptProps(next: Element): void {
		if (!this.#app?.set_props || !loaded_core) return;
		try {
			this.#app.set_props(loaded_core.read_region_props(next));
		} catch {
			/* malformed incoming props — keep the current live props */
		}
	}

	connectedCallback() {
		connected_regions.add(this); // the navigation's shadow-root check counts these (connected.ts)
		// Live region: a `<Region of={liveQuery.current}>` whose ticket carries server-rendered
		// HTML. Region.svelte drives it through `applyLive` (swap → morph / keep-alive); the element
		// does nothing automatic here — no fetch, no self-hydrate.
		if (this.hasAttribute('live')) return;
		// A deferred hole's signed endpoint is only ever minted on the server — keep the copy Kit's
		// hydration cannot reach (see #minted_endpoint). Parse-time connect runs before Kit's start().
		if (this.#minted_endpoint === null && is_deferred(this)) {
			const minted = this.getAttribute('endpoint');
			if (minted) this.#minted_endpoint = minted;
			else {
				// NO address: Kit rendered this hole in the browser — it gave up hydrating the document
				// (a component threw, the markup mismatched) and mounted it fresh, and the client leg
				// cannot mint. The same hole (same id, same props) was on the SSR document, and the
				// handle recorded its facts in the document tail, outside Kit's root (hole-facts.ts):
				// hand them back by identity, and the hole fetches exactly as the SSR element would
				// have. A site header's account holes went dark this way on a customer's client-on page.
				const identity = this.getAttribute('data-og-hole');
				const facts = identity ? hole_facts_of(this.ownerDocument, identity) : null;
				if (facts) {
					this.#minted_endpoint = facts.endpoint;
					this.setAttribute('endpoint', facts.endpoint);
					if (facts.sidecar)
						restore_props_sidecar(this, facts.sidecar.cloneNode(true) as HTMLScriptElement);
				} else if (import.meta.env.DEV && identity) {
					console.warn(HOLE_WITHOUT_ADDRESS_WARNING, this.getAttribute('entry') || identity);
				}
			}
		}
		// A frozen region (lake) settles through the lakes feature; the arm hooks it needs are built
		// only for one (five closures per region at upgrade was the cost of building them for all).
		if (is_frozen(this) && slots.lakes.on_frozen_connect(this, this.#lake_arm())) return;
		if (this.#scheduled) return;
		// Region rule (DESIGN.md): a nested region rides its awake ancestor's hydration — its SSR DOM
		// is already inside that parent, so self-running would double-hydrate. Two exceptions self-run:
		// a DEFERRED region (its HTML is remote, never in the parent's DOM), and a region inside an
		// ADOPTED SLOT (`<ogygia-slot>`) — slot children are host-page content the parent island adopts
		// as opaque DOM; they are NOT part of its hydrated graph, so nothing else will wake them.
		const boundary = this.parentElement && this.parentElement.closest('ogygia-region');
		const slot = this.parentElement && this.parentElement.closest('ogygia-slot');
		const in_adopted_slot = !!(boundary && slot && boundary.contains(slot));
		// Third exception (fragment federation): a FOREIGN-ORIGIN entry — a stitched fragment's
		// island, possibly swapped in post-hoc by a client-stitch hole — is by construction NOT
		// part of the parent's compiled tree; the parent's hydration cannot reach it, so nothing
		// else will ever wake it. It always self-runs.
		const entry_attr = this.getAttribute('entry') || '';
		const foreign_entry =
			entry_attr.indexOf(':') > 0 && // an absolute URL has a scheme; relative / root paths never do
			/^[a-z][a-z0-9+.-]*:/i.test(entry_attr) &&
			new URL(entry_attr).origin !== location.origin;
		if (
			boundary &&
			is_awake(boundary) &&
			!is_deferred(this) &&
			!in_adopted_slot &&
			!foreign_entry
		) {
			this.setAttribute('data-nested', '');
			if (DEVTOOLS)
				dt_emit({
					domain: 'runtime',
					name: 'region.connected',
					...dt_ids(this),
					wake: this.getAttribute('wake') || undefined,
					deferred: false,
					nested: true
				});
			if (import.meta.env.DEV) {
				console.warn(
					`[ogygia] nested region "${this.getAttribute('entry')}" skipped self-run; the nearest region above it is awake, so it rides that hydration (inner hydrate "${this.getAttribute('wake') || 'load'}" ignored).`
				);
			}
			return;
		}
		// Two axes: `render="defer"` + `when` fetches HTML; `wake` wakes JS (possibly after swap).
		const deferred = is_deferred(this);
		// Keep the server markup a self-running island connected with (see #ssr_html) — at the FIRST
		// connect, before anything else about the schedule: an island inside a lake still waiting on
		// its boundary reconnects later, and by then another script may have edited it. The runtime
		// is the first script in `<head>` (server/head-presence.ts `runtime_first`), so this copy is
		// the parsed document as the server sent it. A hole's copy is taken from its answer instead.
		// Prefer the PRISTINE markup captured from the fetched fragment (region_fragment) over a live
		// snapshot: inside a just-swapped hole a foreign runtime may already have upgraded a custom element
		// here, so the live DOM is no longer the server's bytes. A top-level island (no stash) snapshots
		// live as before — there the runtime connected before anything else could touch it.
		if (!deferred && this.#ssr_html === null)
			this.#ssr_html = (this as unknown as PristineHost)[PRISTINE_SSR] ?? snapshot_markup(this);
		if (slots.lakes.wait_for_boundary(this, boundary)) return;
		this.#scheduled = true;
		const when = region_schedule(this);
		if (DEVTOOLS) {
			dt_emit({
				domain: 'runtime',
				name: 'region.connected',
				...dt_ids(this),
				wake: this.getAttribute('wake') || undefined,
				deferred,
				nested: false
			});
			dt_emit({ domain: 'runtime', name: 'wake.scheduled', ...dt_ids(this), when });
		}
		// The hydration scheduler: order stamp + viewport snapshot, so when this island's turn comes
		// the queue knows where it stands (schedule.ts).
		if (!deferred) register_region(this);
		// A `visible` island fetches its code when it intersects — `visible.margin` is the lead time —
		// and not before: the `'load'` preload policy promises "nothing downloads before there is a
		// reason to", and an idle-time `import()` here broke that promise for every visible island on
		// the page (a customer home page downloaded 1.1 MB of below-the-fold island code one second
		// after load, for islands the visitor might never scroll to). A page that wants every island's
		// bytes early says so: `regions.preload: 'all'` hints them from the HTML at low priority.
		this.#arm(when, deferred ? this.#fire_server : this.#fire_hydrate);
		// `prefetch="<schedule>"`: a deferred hole warms its HTML on a second, EARLIER schedule
		// (load / idle / visible / media) while `when` still decides the swap — an on-demand menu
		// whose bytes sit in the frame store before the first hover, so the gesture joins the warm
		// frame instead of paying the origin round trip. Never `interaction` (that is `when`'s job:
		// arming it here would replace the hole's own on-demand fire) and never the same schedule
		// as `when` (nothing to gain) — the compiler refuses both; the guard keeps a hand-written
		// attribute harmless.
		const prefetch = deferred ? this.getAttribute('prefetch') : null;
		if (prefetch && prefetch !== when && prefetch !== 'interaction') {
			this.#arm(prefetch, this.#fire_prefetch, this.getAttribute('margin') || undefined);
		}
	}

	/**
	 * Warm this hole's HTML into the frame store ahead of its `when` — the `prefetch` schedule. No
	 * subscription is taken, so nothing is applied now; the later wake (`#server`) subscribes, the
	 * store replays the warm frame at once, and its `ensure` joins instead of fetching. A failed
	 * warm is harmless: the wake falls back to its own fetch. A hole already done or fetching has
	 * nothing left to warm.
	 */
	#prefetch_html() {
		if (this.#done || this.#fetching || !this.isConnected) return;
		const endpoint = this.#endpoint();
		if (!endpoint || !is_allowed_region_endpoint(endpoint)) return;
		const address = frameAddress(endpoint);
		if (DEVTOOLS) dt_emit({ domain: 'runtime', name: 'region.prefetch', ...dt_ids(this) });
		void slots.frames?.ensure(address, this.#frame_fetcher(endpoint, false))?.catch(() => {});
	}

	/**
	 * The one network fetch for this hole's HTML — its own wake and a `prefetch` warm share it, so
	 * the frame store sees one fetcher shape per address. The endpoint's text, or the keep-fallback
	 * marker on a 204 (`keepFallback()` on the server). A revalidate bypasses the browser cache
	 * (the endpoint may answer `private, max-age`, and stale is the whole point of revalidating).
	 */
	#frame_fetcher(endpoint: string, revalidate: boolean) {
		return (signal: AbortSignal) =>
			runtime_session.server_gate.run(async () => {
				const res = await fetch(endpoint, {
					credentials: 'same-origin',
					cache: revalidate ? 'no-store' : 'default',
					signal
				});
				if (!is_same_origin_response(res)) throw new Error('cross-origin redirect');
				// THE ANSWER MUST BE THE REGION'S. ogygia's handle answers a region request in place —
				// a fragment, a 204, an error status — and never redirects; a redirected response, or a
				// body that is a whole document, means a handle in front of `ogygia.handle()` took the
				// request (an auth wall, a locale bounce, a 404 handler) and the browser followed it.
				// Swapping that in put a site's account page — scripts, skeletons, a second header —
				// into every hole of its header for signed-in visitors. Refused: the fallback stands.
				if (is_redirected_answer(res)) throw new RegionAnswerRefused('redirected', res.url);
				if (!res.ok) throw new Error('status ' + res.status);
				// 204: the hole said keepFallback() — the page's fallback stands, nothing to swap.
				if (res.status === 204) return KEEP_FALLBACK_HTML;
				const text = await res.text();
				if (is_document_answer(text)) throw new RegionAnswerRefused('document', res.url);
				return text;
			});
	}

	/** The schedule hooks a frozen region (lake) drives its revalidation through. */
	#lake_arm() {
		return {
			idle: (fire: () => void) => this.#on_idle(fire),
			visible: (fire: () => void, margin?: string) => this.#on_visible(fire, margin),
			media: (when: string, fire: () => void) => this.#on_media(when, fire),
			fetch_revalidate: () => void this.#fetch_html({ revalidate: true }),
			wake_children: () => this.#wake_waiting_regions()
		};
	}

	/** Arm idle / visible / load / interaction / media for a schedule callback. */
	#arm(when: string, fire: () => unknown, visible_margin?: string) {
		if (DEVTOOLS) {
			// Wrap so the schedule FIRING is observable (interaction/visible/idle "when did it actually
			// wake, and why" is the story a timeline instrument tells). Off → `fire` is used directly.
			const raw = fire;
			fire = () => {
				dt_emit({ domain: 'runtime', name: 'wake.fired', ...dt_ids(this), when });
				return raw();
			};
		}
		// NON-user-initiated wakes hydrate at BACKGROUND priority so they never race the LCP paint: `load`
		// fires at boot, and a `visible`/`media` island above the fold (or a media query that matches at
		// load) fires right then too — same competition. `background_start` yields to rendering, so the
		// paint and its image win the main thread and network first and the island fills in the gap after;
		// a below-the-fold `visible` island fires on scroll (post-LCP) where "when free" is still instant.
		// `idle` is skipped — it already waits for requestIdleCallback, so wrapping it would double-defer.
		// `interaction` is skipped — the user clicked and is waiting for THIS island to wake and replay the
		// click, so it must hydrate immediately (and it ships no JS until the click, so it never competes).
		if (when === 'idle') this.#on_idle(fire);
		else if (when === 'visible') this.#on_visible(() => background_start(fire), visible_margin);
		else if (when === 'load') background_start(fire);
		else if (when === 'interaction') {
			if (is_deferred(this)) arm_on_demand(this, fire);
			else this.#on_interaction(fire);
		} else this.#on_media(when, () => background_start(fire)); // a media query string
	}

	/**
	 * `wake="interaction"`: sleep until a pointer/key/focus/click lands inside the region, then
	 * hydrate and replay what arrived meanwhile (see runtime/interaction.ts). `pointerenter` warms
	 * the module so the wake is usually served from cache. On a csr=true page Kit already hydrated
	 * this island — do not arm (our click-cancel would eat live clicks); #hydrate's own guard
	 * handles the marking if it ever fires. Unless the island is ours even there: inside a lake
	 * (Kit adopts it as opaque DOM) or inside a hole's fetched answer (Kit never sees it).
	 */
	#on_interaction(fire: () => void) {
		if (kit_hydrates_page() && !ours_on_kit_document(this)) {
			this.setAttribute('data-kit-hydrated', '');
			return;
		}
		const arm = slots.interaction;
		if (!arm) {
			// No interaction plugin — fall back to immediate hydrate.
			fire();
			return;
		}
		const disarm = arm(this, fire);
		this.#disarm_interaction = typeof disarm === 'function' ? disarm : null;
	}

	/** The hole's endpoint: the attribute, or the server-minted copy when Kit's hydration wiped it
	 *  (restored on the element so every other DOM reader agrees). */
	#endpoint(): string | null {
		const attr = this.getAttribute('endpoint');
		if (attr) return attr;
		if (!this.#minted_endpoint) return null;
		this.setAttribute('endpoint', this.#minted_endpoint);
		return this.#minted_endpoint;
	}

	/**
	 * Deferred hole: get its HTML and swap it in. When `hydrate` is also set (deferred client
	 * island), schedule phase-2 hydrate — coalescing matching schedules to immediate load.
	 */
	async #server() {
		// Bind to the store: this region applies whatever frame lands at its address — from its own
		// fetch, a navigation batch stream, or (later) a mutation. subscribe() replays current
		// content immediately, so a late-mounting twin catches up free.
		const endpoint = this.#endpoint();
		if (endpoint && !this.#frame_unsub) {
			const address = (this.#frame_address = frameAddress(endpoint));
			this.#frame_unsub =
				slots.frames?.subscribe(address, (f) => void (this.#applying = this.#apply(f.html))) ??
				null;
		}
		await this.#fetch_html();
		// The subscribe callback fired #apply, but #apply awaits the stylesheet before swapping —
		// wait for it, or `#done` below reads stale `false` and phase-2 hydrate is never armed
		// (an interactive deferred leaf would swap in and stay dead).
		await this.#applying;
		if (!this.#done || !this.isConnected) return;
		// A kept fallback is the page's own static markup — there is no fetched island to wake.
		if (this.#kept) return;
		const hydrate = region_hydrate_schedule(this);
		if (!hydrate) return;
		const defer_when = this.getAttribute('when') || 'load';
		const phase2 = phase2_hydrate_schedule(defer_when, hydrate);
		const margin =
			phase2 === 'visible'
				? this.getAttribute('hydrate-margin') || this.getAttribute('margin') || undefined
				: undefined;
		register_region(this);
		this.#arm(phase2, this.#fire_hydrate, margin);
	}

	/**
	 * THE single apply path. A frame's HTML lands here from any source (own fetch, stream parcel,
	 * navigation batch, mutation). First arrival hydrates the hole; a later arrival at a newer
	 * version (SWR revalidate, live refresh) re-applies. Keeps all the DOM-side work — lakes settle
	 * offline before custom elements connect, then swap, mark, event. HOLE-TRUST: the HTML is our own
	 * signed same-origin SSR.
	 */
	async #apply(html: string) {
		if (!this.isConnected) return;
		// The hole answered "the fallback is right" (`keepFallback()` on the server — a 204, or the
		// marker parcel in a batch): keep what the page rendered, mark the region done, wake nothing.
		if (html === KEEP_FALLBACK_HTML) {
			this.#revalidating = false;
			this.#done = true;
			this.#kept = true;
			if (!is_awake(this)) this.setAttribute('data-hydrated', '');
			this.setAttribute('data-og-kept', '');
			this.dispatchEvent(new CustomEvent('ogygia:server', { bubbles: true }));
			return;
		}
		// A refresh is either an explicit SWR revalidate or a later frame after the first swap.
		const revalidate = this.#revalidating || this.#done;
		this.#revalidating = false;
		const { frag, ready } = region_fragment(html);
		await ready; // let the server-picked component's stylesheet load before painting (no FOUC)
		if (!this.isConnected) return;
		slots.lakes.settle_in(frag);
		slots.lakes.mark_frozen_settled(this);
		// A hole's answer swaps over its fallback — which may already be LIVE, on ANY schedule, not just
		// `interaction`: a foreign runtime (a web component) upgraded the fallback, or the visitor
		// opened a menu in it, before the answer landed (an idle answer arrives seconds after an
		// upgraded menu item became interactive). MORPH so those nodes and their state survive and the
		// answer's new children graft under them; a plain `replaceChildren` re-creates the fallback's
		// elements and destroys a menu that is open right now — its open branch closes and the deeper
		// links the answer just brought are never shown. Morph keys on `id`, and a hole's fallback and
		// answer render the same shell ids, so the open element keeps its identity. `replaceChildren`
		// is the floor for a build without morph (a defer-less app never reaches #apply; the `morph`
		// feature is now selected whenever the app has deferred holes — see link/runtime-entry.ts).
		const morph = slots.morph;
		// A hydrating hole's server markup IS the answer (see #ssr_html) — copied before it goes in.
		if (!this.#app && region_hydrate_schedule(this)) this.#ssr_html = fragment_markup(frag);
		if (morph) morph(this, Array.from(frag.childNodes));
		else this.replaceChildren(frag);
		this.#done = true;
		if (revalidate) this.setAttribute('data-revalidated', '');
		else if (!is_awake(this)) this.setAttribute('data-hydrated', '');
		slots.lakes.after_html_swap(this, { revalidate });
		if (DEVTOOLS)
			dt_emit({
				domain: 'runtime',
				name: 'region.server.applied',
				entry: this.getAttribute('entry') || undefined,
				endpoint: this.getAttribute('endpoint') || undefined,
				bytes: html.length,
				revalidate
			});
		this.dispatchEvent(new CustomEvent('ogygia:server', { bubbles: true }));
	}

	/**
	 * Store applicator for a STATIC live/held region (`<ogygia-region live>` with no interactive
	 * module). Every frame at its address lands here — first paint (store replay), a live-query tick,
	 * or a single-flight mutation. First paint swaps in; a later frame morphs in place (same node
	 * survives — the breathing update live partials rely on). Interactive live regions never reach
	 * here: they keep the imperative keep-alive path in {@link applyLive}.
	 */
	async #morph_live(html: string) {
		if (!this.isConnected) return;
		const { frag, ready } = region_fragment(html);
		// Wait for the component's stylesheet before painting. On first paint the region's placeholder
		// CHILDREN stay visible meanwhile; on a later morph the OLD content stays — either way no flash
		// of unstyled or missing content. An already-loaded sheet resolves instantly, so live ticks
		// (query.live breathing) stay fast.
		await ready;
		if (!this.isConnected) return;
		slots.lakes.settle_in(frag);
		if (!this.#live_ready) {
			this.replaceChildren(frag);
			this.#live_ready = true;
			this.setAttribute('data-hydrated', '');
		} else {
			const nodes = Array.from(frag.childNodes);
			const morph = slots.morph;
			if (morph) morph(this, nodes);
			else this.replaceChildren(...nodes);
		}
		this.dispatchEvent(new CustomEvent('ogygia:live', { bubbles: true }));
	}

	/**
	 * Fetch `endpoint` HTML and swap it in.
	 * Success sets `#done` (at most one successful swap per element). Failure leaves `#done` false
	 * so a reconnect, remount, or deferred retry can try again — previously `#done` was set up front
	 * and a transient network error permanently killed the hole.
	 * A deferred hole reuses the browser's `<link rel="preload">` response; an swr REVALIDATE must
	 * not (the endpoint answers `cache-control: private, max-age=30`, and stale is the whole point).
	 */
	async #fetch_html(opts: { revalidate?: boolean } = {}) {
		// A revalidate re-fetches even after the first swap; a plain fetch is one-shot.
		if (this.#fetching || (this.#done && !opts.revalidate)) return;
		const endpoint = this.#endpoint();
		// Don't start a fetch without an endpoint (would block a later remount retry on the same
		// element if one were ever scheduled).
		if (!endpoint) return;
		// HOLE-TRUST defense-in-depth: mint emits path-only; reject absolute/cross-origin attrs.
		if (!is_allowed_region_endpoint(endpoint)) {
			if (import.meta.env.DEV) {
				console.warn('[ogygia] refused non-same-origin region endpoint', endpoint);
			}
			return;
		}
		this.#fetching = true;
		// Per-element relevance signal: aborting it (on disconnect / {#if}-toggle) skips the APPLY.
		// The network fetch is owned by the frame store, keyed by `address`, shared across twins and
		// aborted only when the last waiter abandons — so one element toggling off never kills a fetch
		// a sibling with the same call still needs.
		this.#fetch_abort?.abort();
		this.#fetch_abort = new AbortController();
		const outer = this.#fetch_abort.signal;
		const address = (this.#frame_address = frameAddress(endpoint));
		// Bind if we haven't (SWR/lake remount reaches #fetch_html without going through #server).
		// Idempotent: #server already subscribed for the normal defer flow.
		if (!this.#frame_unsub) {
			this.#frame_unsub =
				slots.frames?.subscribe(address, (f) => void (this.#applying = this.#apply(f.html))) ??
				null;
		}
		if (opts.revalidate) this.#revalidating = true;
		try {
			// Network → STORE (never straight to DOM). N regions with the same address ⇒ one request;
			// a stale response can't overwrite a newer one (the store tickets at request time).
			const html = await slots.frames?.ensure(
				address,
				this.#frame_fetcher(endpoint, !!opts.revalidate),
				{ force: opts.revalidate }
			);
			// Network went to the STORE, not the DOM: the write notifies our subscriber (set in
			// #server), which is the single apply path. If our subscription was severed (disconnect)
			// or a twin already applied before us, this is a no-op. `outer.aborted` / relevance is
			// handled by #apply's isConnected guard; `html` is intentionally unused here.
			void html;
		} catch (err) {
			if ((err as { name?: string })?.name === 'AbortError' || outer.aborted) return;
			// A refused answer is deterministic (a redirect rule in front of the handle, not a flaky
			// network): say what answered instead and do not retry.
			const refused = err instanceof RegionAnswerRefused;
			if (import.meta.env.DEV) {
				if (refused) {
					console.warn(
						`[ogygia] region answer refused for ${endpoint}: the request was ${err.reason === 'redirected' ? 'redirected to' : 'answered with a whole document at'} ${err.final_url}. ` +
							`A handle in front of ogygia.handle() (an auth redirect, a locale bounce, a 404 handler) took the region request — exempt the islands endpoint there. The fallback stands.`
					);
				} else {
					console.warn('[ogygia] region fetch failed for', endpoint, err);
				}
			}
			this.#fetch_attempts++;
			// Allow connectedCallback / a delayed retry to schedule again.
			this.#scheduled = false;
			if (!refused && this.isConnected && this.#fetch_attempts < 3) {
				const delay = 500 * this.#fetch_attempts;
				setTimeout(() => {
					if (!this.isConnected || this.#done || this.#fetching) return;
					if (opts.revalidate) void this.#fetch_html({ revalidate: true });
					else this.connectedCallback();
				}, delay);
				return;
			}
			slots.lakes.after_fetch_exhausted(this, opts, () => this.#wake_waiting_regions());
		} finally {
			this.#fetching = false;
		}
	}

	/** Re-enter connectedCallback for descendants that early-returned on an unsettled lake. */
	#wake_waiting_regions() {
		for (const el of this.querySelectorAll('ogygia-region')) {
			if (el instanceof OgygiaRegion) el.connectedCallback();
		}
	}

	#on_idle(fire: () => void) {
		if ('requestIdleCallback' in window) {
			this.#idle_handle = requestIdleCallback(
				() => {
					this.#idle_handle = null;
					fire();
				},
				{ timeout: 2000 }
			) as unknown as number;
		} else {
			this.#idle_handle = setTimeout(() => {
				this.#idle_handle = null;
				fire();
			}, 200) as unknown as number;
		}
	}

	/** `visible`: the shared observer for this margin (observe.ts) — fires once, on first entry. */
	#on_visible(fire: () => void, root_margin?: string) {
		const rootMargin = root_margin || this.getAttribute('margin') || '0px';
		this.#stop_visible = once_visible(this, rootMargin, () => {
			this.#stop_visible = null;
			fire();
		});
	}

	#on_media(q: string, fire: () => void) {
		if (!q) return fire();
		const mql = matchMedia(q);
		if (mql.matches) return fire();
		const on = (e: MediaQueryListEvent) => {
			if (e.matches) {
				mql.removeEventListener('change', on);
				this.#mql = null;
				fire();
			}
		};
		mql.addEventListener('change', on);
		this.#mql = { mql, on };
	}

	/**
	 * Wake this island: load its module and the hydrate core in parallel, then take a SCHEDULER
	 * TURN (one island per task, viewport first — schedule.ts) and run the synchronous hydrate step
	 * (hydrate-core.ts) inside it.
	 */
	async #hydrate() {
		if (this.#app || this.#hydrating) return;
		this.#hydrating = true;
		const t0 = now_ms();
		const dt_t0 = DEVTOOLS ? t0 : 0;
		let t_loaded = t0;
		if (DEVTOOLS) dt_emit({ domain: 'runtime', name: 'region.hydrate.start', ...dt_ids(this) });
		try {
			// wait for full parse so the end-of-body props sidecars (and the seed) are in the DOM. On an
			// SPA swap (and any post-load hydrate) the document is already parsed, so skip the await
			// entirely — no need to burn a microtask turn before every island wakes.
			if (typeof document !== 'undefined' && document.readyState === 'loading') await dom_ready();
			// SWR remount (and SPA swaps) can disconnect an island-in-lake while its module load is
			// in flight — abort rather than hydrate into a detached tree (SWR-ORPHAN-HYDRATE).
			if (!this.isConnected) return;
			const entry = this.getAttribute('entry');
			if (!entry) return;
			hydrate_started(this); // a viewport island in flight holds ready islands below the fold
			const [core, mod] = await Promise.all([hydrate_core(), load_island(entry)]);
			t_loaded = now_ms();
			if (!this.isConnected) return;
			// An island of OURS on a Kit-hydrated document reads Kit's page through the bridge Kit's
			// client entry publishes; it must not hydrate before Kit applied it (kit-page-thread.svelte.ts).
			await this.#kit_page_ready(core);
			if (!this.isConnected) return;
			await hydrate_turn(this);
			if (!this.isConnected || this.#app) return;
			// ── the turn: everything below is one synchronous step ──
			const ssr_html = this.#ssr_html;
			this.#app = core.hydrate_island(this, entry, mod, ssr_html);
			this.#ssr_html = null; // awake (or not ours): the server copy has done its job
			if (!this.#app) return; // not ours (Kit-hydrated page) or torn out mid-hydrate
			this.setAttribute('data-hydrated', '');
			beacon_hydrated(this, t0, t_loaded, now_ms(), ssr_html); // the profiler's browser half (no-op without its tag)
			if (DEVTOOLS)
				dt_emit({
					domain: 'runtime',
					name: 'region.hydrate.done',
					...dt_ids(this),
					ms: now_ms() - dt_t0
				});
			this.dispatchEvent(new CustomEvent('ogygia:hydrated', { bubbles: true }));
		} catch (err) {
			if (DEVTOOLS)
				dt_emit({
					domain: 'runtime',
					name: 'region.hydrate.failed',
					...dt_ids(this),
					message: (err as { message?: string })?.message ?? String(err)
				});
			// Distinguish the ENTRY FETCH failing (the module never loaded) from the hydrate throwing
			// (the module loaded, its code ran and failed). A `Failed to fetch dynamically imported
			// module` on the island's own entry is not a hydration problem: in dev it almost always
			// means Vite re-optimized deps and rotated the optimizer hash, so this already-loaded tab
			// is importing dep URLs that no longer exist — a reload picks up the new graph (the dev
			// bridge carries `@vite/client`, so Vite's own full-reload does this on the next signal).
			const msg = (err as { message?: string })?.message ?? '';
			const entry = this.getAttribute('entry');
			if (ENTRY_FETCH_FAILED_RE.test(msg)) {
				if (import.meta.env.DEV) {
					console.error(
						`[ogygia] island entry failed to load: ${entry}\n` +
							`The module could not be FETCHED (not a hydration error). In dev this almost always ` +
							`means Vite re-optimized dependencies and rotated its optimizer hash while this tab ` +
							`was open, so its dep imports 404. Recovering… Original error:`,
						err
					);
					void recover_from_stale_deps(entry);
				} else {
					console.error('[ogygia] island entry failed to load:', entry, err);
				}
			} else {
				console.error('[ogygia] hydration failed for', entry, err);
			}
		} finally {
			this.#hydrating = false;
			hydrate_settled(this);
		}
	}

	/**
	 * Apply a live region tick (called by Region.svelte for a deferred region whose ticket
	 * carries server-rendered HTML). No fetch — the HTML is already here.
	 *
	 * - **First tick:** parse + swap the HTML in. Interactive (`hydrate` + `module`) → hydrate a
	 *   {@link LiveHost} so later ticks can push props. Static → done (no JS ever ships).
	 * - **Later tick, same interactive module:** keep-alive — push the new props to the mounted
	 *   component (focus + local state survive; Svelte reconciles). No swap, no re-hydrate.
	 * - **Later tick, static:** morph the new HTML in place (see {@link morph_children}).
	 * - **Later tick, module changed:** unmount, swap, re-hydrate.
	 */
	async applyLive(desc: {
		id: string;
		module: string;
		props: Record<string, unknown>;
		html: string;
		url?: string;
		hydrate?: string;
		hydrateMargin?: string;
	}) {
		// Keep the element self-describing so the fallback fetch path still works if ever needed.
		this.setAttribute('render', 'defer');
		this.setAttribute('entry', desc.module || desc.id);
		if (desc.url) this.setAttribute('endpoint', desc.url);
		if (desc.hydrate) this.setAttribute('wake', desc.hydrate);
		else this.removeAttribute('wake');
		if (desc.hydrateMargin) this.setAttribute('hydrate-margin', desc.hydrateMargin);

		const interactive = !!desc.hydrate && !!desc.module;

		// Static live/held region → the frame store is its single applicator. Every static frame — the
		// first paint, a `query.live` tick, or a SINGLE-FLIGHT mutation — flows through `#morph_live`
		// (first swap, then breathing morph). Binding also catches OUT-OF-BAND writes: a command that
		// returns `await region(C, props)` is decoded on its own response and written at this same
		// address (id|props), so the mounted region morphs with NO extra fetch. Subscribe once.
		if (!interactive) {
			if (desc.url && !this.#frame_unsub) {
				this.#frame_address = frameAddress(desc.url);
				this.#frame_unsub =
					slots.frames?.subscribe(this.#frame_address, (f) => this.#morph_live(f.html)) ?? null;
			}
			this.#morph_live(desc.html);
			return;
		}

		// Keep-alive: same interactive module, already mounted → reactive prop push, no DOM churn.
		if (this.#live_ready && interactive && this.#live_app && desc.module === this.#live_module) {
			this.#live_app.set_props?.(desc.props);
			this.dispatchEvent(new CustomEvent('ogygia:live', { bubbles: true }));
			return;
		}

		// First tick, or the interactive module changed: (unmount and) swap + maybe hydrate.
		if (this.#live_app) {
			this.#live_app.dispose();
			this.#live_app = null;
		}
		this.#live_ready = true;
		this.#live_module = desc.module;
		// createContextualFragment — signed same-origin HTML trust boundary (HOLE-TRUST). The HTML is
		// our own SSR under a verified MAC (or, for a live tick, rendered in-process on the server).
		const { frag, ready } = region_fragment(desc.html);
		await ready; // stylesheet before paint — an interactive held region has CSS too (no FOUC)
		if (!this.isConnected) return;
		slots.lakes.settle_in(frag);
		this.replaceChildren(frag);
		if (interactive) {
			await this.#live_hydrate(desc.props);
		} else {
			this.setAttribute('data-hydrated', '');
			this.dispatchEvent(new CustomEvent('ogygia:live', { bubbles: true }));
		}
	}

	/**
	 * On a Kit-hydrated document, a region of ours (a lake's inside, a hole's answer) waits for Kit to
	 * apply its page before it hydrates — `null` (no await) once applied. The wait lives in the lazy
	 * hydrate core (it observes Kit's reactive page, i.e. it needs Svelte), so it never reaches the boot.
	 */
	#kit_page_ready(core: HydrateCore): Promise<void> | null {
		if (!kit_hydrates_page() || !ours_on_kit_document(this)) return null;
		return core.kit_page_thread();
	}

	/** Hydrate a live region's swapped-in HTML through the hydrate core's LiveHost path. */
	async #live_hydrate(props: Record<string, unknown>) {
		await dom_ready();
		if (!this.isConnected) return;
		const entry = this.getAttribute('entry');
		if (!entry) return;
		const [core, mod] = await Promise.all([hydrate_core(), load_island(entry)]);
		if (!this.isConnected) return;
		await this.#kit_page_ready(core);
		if (!this.isConnected) return;
		this.#live_app = core.hydrate_live(this, entry, mod, props);
		if (!this.#live_app) return;
		this.setAttribute('data-hydrated', '');
		this.dispatchEvent(new CustomEvent('ogygia:hydrated', { bubbles: true }));
		this.dispatchEvent(new CustomEvent('ogygia:live', { bubbles: true }));
	}

	disconnectedCallback() {
		connected_regions.delete(this);
		unregister_region(this);
		// A disconnect now always means the island is gone: the reconcile nav MOVES kept nodes with
		// insertBefore (no detach, no disconnect), and the fallback is a full swap where old islands
		// genuinely leave.
		if (this.#live_app) {
			this.#live_app.dispose();
			this.#live_app = null;
		}
		this.#fetch_abort?.abort();
		this.#fetch_abort = null;
		// Unbind from the store + release our stake in the shared fetch (aborted only if we were the
		// last waiter).
		this.#frame_unsub?.();
		this.#frame_unsub = null;
		if (this.#frame_address) {
			slots.frames?.abandon(this.#frame_address);
			this.#frame_address = null;
		}
		if (this.#idle_handle != null) {
			if ('cancelIdleCallback' in window) {
				cancelIdleCallback(this.#idle_handle);
			} else {
				clearTimeout(this.#idle_handle);
			}
			this.#idle_handle = null;
		}
		this.#stop_visible?.();
		this.#stop_visible = null;
		on_demand_armed.delete(this);
		this.#disarm_interaction?.();
		this.#disarm_interaction = null;
		if (this.#mql) {
			this.#mql.mql.removeEventListener('change', this.#mql.on);
			this.#mql = null;
		}
		if (this.#app) {
			this.#app.dispose();
			this.#app = null;
		}
		this.#scheduled = false;
	}
}

/**
 * Boot the always-on custom element after each selected feature has filled its {@link slots} entry.
 * Core never statically imports an optional feature — the generated entry (or {@link ./full.js})
 * passes each feature's `install` here, in {@link ../vite/runtime-entry.js FEATURE_ORDER}. Order is
 * load-bearing: `live` needs `morph` present first.
 */
/**
 * DEV ONLY: apply the region-CSS `<link data-ogygia-region-css>`s the SSR baked into the document.
 * In dev there is no extracted `.css` asset — `islandCss` hands a region its dev MODULE url as the
 * href, and a `<link rel="stylesheet">` to a JS module makes an EMPTY sheet (the server serves it as
 * `text/javascript`), so CSS authored in any hole or region silently never applied on first load.
 * Import each module instead — executing it injects the scoped `<style>` (Vite's dev CSS mechanism),
 * the exact rescue {@link region_fragment} already runs for a FETCHED answer, here for the links that
 * shipped on the page. Prod links a real `.css` asset, so `import.meta.env.DEV` DCEs this whole path.
 * Deferred to {@link dom_ready}: the runtime bootstrap is the FIRST node in `<head>`, so the region
 * links below it are not parsed yet at boot.
 */
function apply_dev_head_region_css(): void {
	if (!import.meta.env.DEV || typeof document === 'undefined') return;
	void dom_ready().then(() => {
		// EVERY region-css link is imported here — including one for an island that will wake on its
		// own. The server-rendered markup must be styled BEFORE the island wakes: a `visible` island
		// below the fold, or an `interaction` island nobody clicks, may not wake for a long time or ever,
		// and until then its markup sits unstyled (a hero's `min-height` collapsing to 0 — the CLS the
		// region-css link exists to prevent). Prod styles an unwoken island from load (its link is a
		// real `.css` asset); dev matches only by executing the module now, so the scoped `<style>`
		// injects now. (An earlier cut skipped waking islands to avoid front-loading their dep
		// discovery — wrong trade, and moot: island deps are pre-bundled at server start through
		// `optimizeDeps.entries`, so importing every island here discovers nothing and re-optimizes
		// nothing. Importing early is also what `warm_island_module` already does on hover/prefetch.)
		const seen = new Set<string>();
		for (const link of document.querySelectorAll('link[data-ogygia-region-css]')) {
			const href = link.getAttribute('href');
			// A real `.css` asset is a valid stylesheet — leave it. Only a dev MODULE url (`islandCss`'s
			// dev href) masquerading as a sheet loads empty and needs importing instead.
			if (!href || CSS_ASSET_HREF_RE.test(href)) continue;
			link.remove(); // inert either way (an empty sheet) — drop it so nothing dedupes against it
			// The href is DOCUMENT-relative (`../../@id/…` on a nested route, base-aware by design). A bare
			// `import()` would resolve it against THIS module's url (`/node_modules/…/og-runtime.js` in an
			// app) and 404 on `/node_modules/@id/…` — the same trap island entries avoid via this resolver.
			const url = island_module_url(href);
			if (seen.has(url)) continue;
			seen.add(url);
			void import(/* @vite-ignore */ url).catch(() => {});
		}
	});
}

export function boot(installers: Array<() => void> = []): void {
	// The navigation handle island code reaches the runtime through (./nav-handle.ts): the MPA one
	// first, which the router feature's install replaces with the SPA router's when it is present.
	if (typeof document !== 'undefined' && !(NAV_HANDLE_KEY in globalThis)) publish_nav(mpa_nav());
	// What the lazy chunks use from the boot, handed over through the registry (./boot-link.ts).
	link_boot();
	for (const install of installers) install();

	if (import.meta.env.DEV) apply_dev_head_region_css();

	if (DEVTOOLS) {
		// Publish `window.__ogygia_devtools` so instruments + our own e2e can read the stream with no
		// app wiring — the default sink when the build compiled devtools in. (No-op off the browser.)
		dt_install_window_sink();
		// Fold the SERVER realm's events (the handle's `application/ogygia-devtools` side-channel) into
		// the same stream — a region's server render + client wake now share one fingerprint-keyed timeline.
		dt_ingest_server();
		// The devtools UI — one mounted Svelte app (launcher + tabbed window: Lens / Bytes / Timeline).
		// A pure bus/DOM consumer, starting hidden (Alt+O). DCEs with the whole devtools graph when off.
		dt_install_ui();
		// Which optional features this per-app runtime shipped — the byte-ledger / boundary-lens read
		// this to know what's even possible on the page. Names come off each installer's slot presence.
		const features: string[] = [];
		if (slots.interaction) features.push('interaction');
		if (slots.morph) features.push('morph');
		// Hydrate-phase features (live / wire / remoteSeeds / context) install with the hydrate core,
		// after this boot report — they are listed once an island has hydrated.
		if (slots.frames) features.push('frames');
		if (slots.nav) features.push('router');
		if (slots.forms.enabled) features.push('forms');
		dt_emit({ domain: 'runtime', name: 'runtime.boot', features });
	}

	if (typeof customElements !== 'undefined' && !customElements.get('ogygia-region')) {
		customElements.define('ogygia-region', OgygiaRegion);
	}
}
