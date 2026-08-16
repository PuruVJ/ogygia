import { hydrate, unmount } from 'svelte';
import { parse } from 'devalue';
import { frameAddress } from '../frame.js';
import { set_current_region } from '../current-region.js';
import { set_page, reset_page } from '../shims/page-store.svelte.js';
import NestedProvider from '../NestedProvider.svelte';
import { document_has_kit_bootstrap } from './kit-boot.js';
import { runtime_session } from './session.js';
import {
	is_allowed_region_endpoint,
	is_same_origin_response,
	island_module_url,
	warm_island_module
} from './region-endpoint-url.js';
import {
	is_awake,
	is_deferred,
	phase2_hydrate_schedule,
	region_hydrate_schedule,
	region_schedule,
	region_ssr_truncated
} from './region-attrs.js';
import { slots, type LiftedLake } from './slots.js';

/**
 * Parse the `<script data-ogygia-props>` that follows a region (skipping `<link>` hints). Uses the
 * client reviver (`remember: true`) so a named/shared transportable reunites with its live instance.
 * Returns `{}` when there is no props sibling.
 */
// The devalue revivers only depend on `slots.wire`, which is set once at boot and never changes.
// Building this object (plus its two closures) fresh for every island was pure per-hydrate GC churn;
// memoize it against the wire identity so N islands share ONE revivers object.
let cached_wire: (typeof slots)['wire'] | undefined;
let cached_revivers: Record<string, (d: never) => unknown> | undefined;
function region_prop_revivers(): Record<string, (d: never) => unknown> | undefined {
	const wire = slots.wire;
	if (wire === cached_wire) return cached_revivers;
	cached_wire = wire;
	cached_revivers = wire
		? {
				[wire.TRANSPORT_WIRE_KEY]: (d: never) => wire.revive_transportable(d, true),
				[wire.REGION_SNIPPET_WIRE_KEY]: (d: never) => wire.revive_region_snippet(d)
			}
		: undefined;
	return cached_revivers;
}

function read_region_props(region: Element): Record<string, unknown> {
	let sib = region.nextElementSibling;
	while (sib) {
		if (sib.tagName === 'SCRIPT' && sib.matches('script[data-ogygia-props]')) {
			return parse(sib.textContent, region_prop_revivers());
		}
		if (sib.tagName === 'LINK') {
			sib = sib.nextElementSibling;
			continue;
		}
		break;
	}
	return {};
}

/** Load a hydrate island module from `<ogygia-region entry>` (dev + prod). */
const load_island = (entry: string) => {
	const url = island_module_url(entry);
	return import(/* @vite-ignore */ url) as Promise<{
		default: import('svelte').Component<Record<string, unknown>>;
	}>;
};

/**
 * DEV-ONLY captured-snapshot mutation guard. Captured host props cross the boundary as a
 * serialized devalue snapshot; writing to them inside the island updates nothing.
 */
class PropMutationGuard {
	#warned = new Set<string>();

	#warn(entry: string, prop_path: string) {
		const key = entry + '' + prop_path;
		if (this.#warned.has(key)) return;
		this.#warned.add(key);
		console.warn(
			`[ogygia] mutating captured host snapshot '${prop_path}' inside island ${entry} — this updates nothing ` +
				`(captured host state is a serialized snapshot; move mutable state inside the island component).`
		);
	}

	#guard_map(map: Map<unknown, unknown>, entry: string, prop_path: string) {
		const mutators = new Set(['set', 'delete', 'clear']);
		return new Proxy(map, {
			get: (target, prop) => {
				const value = Reflect.get(target, prop);
				if (typeof value !== 'function') return value;
				if (typeof prop === 'string' && mutators.has(prop)) {
					return (...args: unknown[]) => {
						this.#warn(entry, `${prop_path}.${prop}()`);
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return (value as (...a: unknown[]) => unknown).bind(target);
			}
		});
	}

	#guard_set(set: Set<unknown>, entry: string, prop_path: string) {
		const mutators = new Set(['add', 'delete', 'clear']);
		return new Proxy(set, {
			get: (target, prop) => {
				const value = Reflect.get(target, prop);
				if (typeof value !== 'function') return value;
				if (typeof prop === 'string' && mutators.has(prop)) {
					return (...args: unknown[]) => {
						this.#warn(entry, `${prop_path}.${prop}()`);
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
				return (value as (...a: unknown[]) => unknown).bind(target);
			}
		});
	}

	#guard_value(value: unknown, entry: string, prop_path: string): unknown {
		if (value === null || typeof value !== 'object') return value;
		if (value instanceof Map) return this.#guard_map(value as Map<unknown, unknown>, entry, prop_path);
		if (value instanceof Set) return this.#guard_set(value as Set<unknown>, entry, prop_path);
		if (value instanceof Date || value instanceof RegExp || value instanceof URL) return value;
		// A class INSTANCE must never be wrapped. A wired live object (e.g. a `Cart` whose `$state`
		// fields Svelte compiles to private `#fields`) breaks under a Proxy: private-field access and
		// `this`-dependent getters/methods run against the proxy, not the real instance, and throw
		// ("cannot read private member … from an object whose class did not declare it"). The guard
		// only needs to catch mutation of captured SNAPSHOT props, which are always plain data —
		// devalue serializes exactly plain objects, arrays, Map/Set/Date. So guard those; pass class
		// instances (the intentionally-live wired objects) straight through.
		const proto = Object.getPrototypeOf(value);
		if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
		return new Proxy(value as Record<string | symbol, unknown>, {
			get: (target, prop, receiver) => {
				const child = Reflect.get(target, prop, receiver);
				if (typeof prop === 'symbol') return child;
				return this.#guard_value(
					child,
					entry,
					prop_path ? `${prop_path}.${String(prop)}` : String(prop)
				);
			},
			set: (target, prop, next, receiver) => {
				if (typeof prop !== 'symbol') {
					this.#warn(entry, prop_path ? `${prop_path}.${String(prop)}` : String(prop));
				}
				return Reflect.set(target, prop, next, receiver);
			},
			deleteProperty: (target, prop) => {
				if (typeof prop !== 'symbol') {
					this.#warn(entry, prop_path ? `${prop_path}.${String(prop)}` : String(prop));
				}
				return Reflect.deleteProperty(target, prop);
			},
			defineProperty: (target, prop, descriptor) => {
				if (typeof prop !== 'symbol') {
					this.#warn(entry, prop_path ? `${prop_path}.${String(prop)}` : String(prop));
				}
				return Reflect.defineProperty(target, prop, descriptor);
			}
		});
	}

	wrap(props: Record<string, unknown>, entry: string): Record<string, unknown> {
		if (!(import.meta.env && import.meta.env.DEV)) return props;
		return this.#guard_value(props, entry, '') as Record<string, unknown>;
	}
}

const prop_guard = new PropMutationGuard();

function dom_ready() {
	if (typeof document === 'undefined' || document.readyState !== 'loading') return Promise.resolve();
	return new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
}

/**
 * Parse a fetched region's HTML into a fragment, HOISTING any `<link data-ogygia-region-css>` it
 * carries into `<head>` (deduped by href). A held / server-picked region's component was never
 * imported by the page, so its scoped CSS is in no stylesheet the page loaded; the region response
 * ships the links and the runtime lifts them to the head — where they load once and stick. (A link
 * left in the body would also fail to load inside a `<template>` batch parcel.)
 */
function region_fragment(html: string): { frag: DocumentFragment; ready: Promise<void> } {
	const frag = document.createRange().createContextualFragment(html);
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
			if (!href || seen.has(href)) continue;
			seen.add(href);
			pending.push(import(/* @vite-ignore */ href).then(
				() => undefined,
				() => undefined
			));
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
	// Cap the wait so a genuinely hung stylesheet eventually paints (unstyled) rather than blocking
	// forever — generous, because the caller shows a placeholder meanwhile, so a slow-link stylesheet
	// (seconds on 4G) should still win the race and paint styled.
	const ready = pending.length
		? Promise.race([
				Promise.all(pending).then(() => undefined),
				new Promise<void>((r) => setTimeout(r, 5000))
			])
		: Promise.resolve();
	return { frag, ready };
}

/** Apply `application/ogygia-remote` text into the reused Kit query seed bag. */
function apply_remote_seed_text(text: string | null | undefined) {
	if (!text) return;
	slots.remoteSeeds?.seed_query_responses(text);
}

/** Apply `application/ogygia-page` text into the `$app/state` page snapshot. */
function apply_page_seed_text(text: string | null | undefined) {
	if (!text) return;
	try {
		const raw = parse(text) as Partial<{
			url: string | URL;
			params: Record<string, string>;
			route: { id: string | null };
			status: number;
			data: Record<string, unknown>;
			form: unknown;
			error: { message: string } | null;
			state: Record<string, unknown>;
		}>;
		let url: URL | undefined;
		if (raw.url instanceof URL) url = raw.url;
		else if (typeof raw.url === 'string') {
			try {
				url = new URL(raw.url);
			} catch {
				url = undefined;
			}
		}
		set_page({ ...raw, url });
	} catch {
		/* ignore malformed seed */
	}
}

/** Keep the live document's side-channel `<script>` in sync with a freshly fetched doc. */
function sync_side_channel_script(
	live_doc: Document,
	type: 'application/ogygia-remote' | 'application/ogygia-page',
	from: Element | null
) {
	const existing = live_doc.querySelector(`script[type="${type}"]`);
	if (from?.textContent != null) {
		if (existing) {
			existing.textContent = from.textContent;
		} else {
			const clone = live_doc.importNode(from, true);
			(live_doc.body || live_doc.documentElement).appendChild(clone);
		}
	} else {
		existing?.remove();
	}
}

/**
 * Soft invalidate: refresh document-level page + remote **seeds** from a fetched HTML
 * document without replacing `<body>`, remounting islands, or clearing live query/live
 * instance maps. Used by `invalidateAll` so Kit remote `form()` success does not
 * view-transition wipe live island state. Does **not** auto-refresh live queries —
 * callers that need that use `.refresh()`, or `submit().updates(q)` with server
 * `requested(q).refreshAll()` (updates alone does not populate response `q`).
 */
export function apply_soft_invalidate_doc(doc: Document) {
	if (typeof document === 'undefined') return;
	// Seed bag only — never clear_remote_instances() here (live Query/LiveQuery stay mounted).
	slots.remoteSeeds?.clear_remote_seeds();
	const remote = doc.querySelector('script[type="application/ogygia-remote"]');
	apply_remote_seed_text(remote?.textContent);
	sync_side_channel_script(document, 'application/ogygia-remote', remote);

	const page_el = doc.querySelector('script[type="application/ogygia-page"]');
	apply_page_seed_text(page_el?.textContent);
	sync_side_channel_script(document, 'application/ogygia-page', page_el);
}

// Flicker fix: seed the reused Kit client query cache from the server's side-channel script
// (emitted by `ogygiaHandle` on csr=false pages) exactly ONCE per document, before any island's
// reused `Query` constructor reads `query_responses`. Cleared on SPA body swap.
function seed_remote_once() {
	if (runtime_session.remote_seeded) return;
	runtime_session.mark_remote_seeded();
	if (typeof document === 'undefined') return;
	const el = document.querySelector('script[type="application/ogygia-remote"]');
	apply_remote_seed_text(el?.textContent);
}

/** Document-level page seed (one script from ogygiaHandle) — once per document. */
function seed_page_once() {
	if (runtime_session.page_seeded) return;
	runtime_session.mark_page_seeded();
	if (typeof document === 'undefined') return;
	const el = document.querySelector('script[type="application/ogygia-page"]');
	apply_page_seed_text(el?.textContent);
}

// Mixed mode: on a csr=true page, Kit boots and hydrates the whole tree (including our
// island components). Detect Kit bootstrap only in non-ogygia inline scripts (P0: side-channel
// payloads can reflect `__sveltekit_` from the URL). Cached per document; cleared on SPA swap.
function kit_hydrates_page() {
	if (runtime_session.kit_page === undefined) {
		runtime_session.kit_page =
			typeof document !== 'undefined' && document_has_kit_bootstrap();
	}
	return runtime_session.kit_page;
}

/**
 * Reset per-document session + SSR remote seeds before a new body connects.
 *
 * Do **not** clear `query_map` / `live_query_map` here — old islands are still
 * mounted, and Kit's LiveQueryProxy throws if its cache entry vanishes mid-render.
 * Instance sweep happens in {@link finish_spa_document} after `replaceWith`.
 */
export function prepare_spa_document() {
	runtime_session.reset();
	slots.remoteSeeds?.clear_remote_seeds();
	reset_page();
}

/**
 * After `body.replaceWith`: old islands have disconnected; new ones have only
 * scheduled `#hydrate` (first `await` yields). Sweep Kit query/live instance
 * maps so the next page cannot reuse a LiveQuery whose `#start` is already
 * spent (`once`) — that reuse never opens SSE again and leaves "connecting…".
 */
export function finish_spa_document() {
	slots.remoteSeeds?.clear_remote_instances();
	// A client-injected speculation script does not survive the SPA head-merge — re-add it.
	slots.speculate?.reinstall();
}

class OgygiaRegion extends HTMLElement {
	#scheduled = false;
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
	#app: unknown = null;
	#io: IntersectionObserver | null = null;
	/** Removes the `wake="interaction"` wake listeners (set while armed, cold). */
	#disarm_interaction: (() => void) | null = null;
	/** A persist island's LiveHost app — lets the next page push fresh props into the relocated app. */
	#persist_host: { setProps?: (p: Record<string, unknown>) => void } | null = null;

	/**
	 * CONTINUITY: this persisted island is relocating onto `next` (the incoming page's SSR region).
	 * Push the new page's props into the live app so a `persist`ed component reflects the new route
	 * (e.g. a player's `track` changes) instead of freezing at first-mount props. Called by the
	 * router just before `next` is discarded.
	 */
	absorbPersistProps(next: Element): void {
		if (!this.#persist_host?.setProps) return;
		try {
			this.#persist_host.setProps(read_region_props(next));
		} catch {
			/* malformed incoming props — keep the current live props */
		}
	}
	#mql: { mql: MediaQueryList; on: (e: MediaQueryListEvent) => void } | null = null;
	/** Abort in-flight region HTML fetch on disconnect (P-ABORT). */
	#fetch_abort: AbortController | null = null;
	/** Cancel idle schedule when disconnected. */
	#idle_handle: number | null = null;
	/** Live region (`<ogygia-region live>`): driven imperatively by Region.svelte's applyLive. */
	#live_ready = false;
	#live_app: { setProps?: (p: Record<string, unknown>) => void } | null = null;
	#live_module = '';

	connectedCallback() {
		// Live region: a `<Region of={liveQuery.current}>` whose ticket carries server-rendered
		// HTML. Region.svelte drives it through `applyLive` (swap → morph / keep-alive); the element
		// does nothing automatic here — no fetch, no self-hydrate.
		if (this.hasAttribute('live')) return;
		const lake_arm = {
			idle: (fire: () => void) => this.#on_idle(fire),
			visible: (fire: () => void, margin?: string) => this.#on_visible(fire, margin),
			media: (when: string, fire: () => void) => this.#on_media(when, fire),
			fetch_revalidate: () => void this.#fetch_html({ revalidate: true }),
			wake_children: () => this.#wake_waiting_regions()
		};
		if (slots.lakes.on_frozen_connect(this, lake_arm)) return;
		if (this.#scheduled) return;
		// Region rule (DESIGN.md): a nested region rides its awake ancestor's hydration — its SSR DOM
		// is already inside that parent, so self-running would double-hydrate. Two exceptions self-run:
		// a DEFERRED region (its HTML is remote, never in the parent's DOM), and a region inside an
		// ADOPTED SLOT (`<ogygia-slot>`) — slot children are host-page content the parent island adopts
		// as opaque DOM; they are NOT part of its hydrated graph, so nothing else will wake them.
		const boundary = this.parentElement && this.parentElement.closest('ogygia-region');
		const slot = this.parentElement && this.parentElement.closest('ogygia-slot');
		const in_adopted_slot = !!(boundary && slot && boundary.contains(slot));
		if (boundary && is_awake(boundary) && !is_deferred(this) && !in_adopted_slot) {
			this.setAttribute('data-nested', '');
			if (import.meta.env.DEV) {
				console.warn(
					`[ogygia] nested region "${this.getAttribute('entry')}" skipped self-run; the nearest region above it is awake, so it rides that hydration (inner hydrate "${this.getAttribute('wake') || 'load'}" ignored).`
				);
			}
			return;
		}
		if (slots.lakes.wait_for_boundary(this, boundary)) return;
		this.#scheduled = true;
		// Two axes: `render="defer"` + `when` fetches HTML; `wake` wakes JS (possibly after swap).
		const deferred = is_deferred(this);
		const when = region_schedule(this);
		const fire = deferred ? () => this.#server() : () => this.#hydrate();
		// A `visible` island won't hydrate until it scrolls into view — and only THEN fetches its JS
		// chunk, stalling hydration on a real network. Warm the module during idle so the scroll-in is
		// instant. Kept to `visible` on purpose: `idle` fires imminently anyway, while `interaction`
		// and `media` are "maybe never" schedules where NOT downloading is the whole point.
		if (!deferred && when === 'visible') this.#warm_module();
		this.#arm(when, fire);
	}

	/** Idle-import this island's JS so a later `visible` wake hydrates without a cold chunk fetch. */
	#warm_module() {
		const entry = this.getAttribute('entry');
		if (!entry) return;
		const warm = () => warm_island_module(entry);
		if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 2000 });
		else setTimeout(warm, 200);
	}

	/** Arm idle / visible / load / interaction / media for a schedule callback. */
	#arm(when: string, fire: () => void, visible_margin?: string) {
		if (when === 'idle') this.#on_idle(fire);
		else if (when === 'visible') this.#on_visible(fire, visible_margin);
		else if (when === 'load') fire();
		else if (when === 'interaction') this.#on_interaction(fire);
		else this.#on_media(when, fire); // a media query string
	}

	/**
	 * `wake="interaction"`: sleep until a pointer/key/focus/click lands inside the region, then
	 * hydrate and replay what arrived meanwhile (see runtime/interaction.ts). `pointerenter` warms
	 * the module so the wake is usually served from cache. On a csr=true page Kit already hydrated
	 * this island — do not arm (our click-cancel would eat live clicks); #hydrate's own guard
	 * handles the marking if it ever fires.
	 */
	#on_interaction(fire: () => void) {
		if (kit_hydrates_page() && !is_deferred(this)) {
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

	/**
	 * Deferred hole: get its HTML and swap it in. When `hydrate` is also set (deferred client
	 * island), schedule phase-2 hydrate — coalescing matching schedules to immediate load.
	 */
	async #server() {
		// Bind to the store: this region applies whatever frame lands at its address — from its own
		// fetch, a navigation batch stream, or (later) a mutation. subscribe() replays current
		// content immediately, so a late-mounting twin catches up free.
		const endpoint = this.getAttribute('endpoint');
		if (endpoint && !this.#frame_unsub) {
			const address = (this.#frame_address = frameAddress(endpoint));
			this.#frame_unsub = slots.frames?.subscribe(address, (f) => void (this.#applying = this.#apply(f.html))) ?? null;
		}
		await this.#deliver_html();
		// The subscribe callback fired #apply, but #apply awaits the stylesheet before swapping —
		// wait for it, or `#done` below reads stale `false` and phase-2 hydrate is never armed
		// (an interactive deferred leaf would swap in and stay dead).
		await this.#applying;
		if (!this.#done || !this.isConnected) return;
		const hydrate = region_hydrate_schedule(this);
		if (!hydrate) return;
		const defer_when = this.getAttribute('when') || 'load';
		const phase2 = phase2_hydrate_schedule(defer_when, hydrate);
		const margin =
			phase2 === 'visible'
				? this.getAttribute('hydrate-margin') || this.getAttribute('margin') || undefined
				: undefined;
		this.#arm(phase2, () => void this.#hydrate(), margin);
	}

	/** Get the hole's HTML by fetching its signed capability endpoint. */
	async #deliver_html() {
		await this.#fetch_html();
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
		// A refresh is either an explicit SWR revalidate or a later frame after the first swap.
		const revalidate = this.#revalidating || this.#done;
		this.#revalidating = false;
		const { frag, ready } = region_fragment(html);
		await ready; // let the server-picked component's stylesheet load before painting (no FOUC)
		if (!this.isConnected) return;
		slots.lakes.settle_in(frag);
		slots.lakes.mark_frozen_settled(this);
		this.replaceChildren(frag);
		this.#done = true;
		if (revalidate) this.setAttribute('data-revalidated', '');
		else if (!is_awake(this)) this.setAttribute('data-hydrated', '');
		slots.lakes.after_html_swap(this, { revalidate });
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
		const endpoint = this.getAttribute('endpoint');
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
			this.#frame_unsub = slots.frames?.subscribe(address, (f) => void (this.#applying = this.#apply(f.html))) ?? null;
		}
		if (opts.revalidate) this.#revalidating = true;
		try {
			// Network → STORE (never straight to DOM). N regions with the same address ⇒ one request;
			// a stale response can't overwrite a newer one (the store tickets at request time).
			const html = await slots.frames?.ensure(
				address,
				(signal) =>
					runtime_session.server_gate.run(async () => {
						const res = await fetch(endpoint, {
							credentials: 'same-origin',
							cache: opts.revalidate ? 'no-store' : 'default',
							signal
						});
						if (!is_same_origin_response(res)) throw new Error('cross-origin redirect');
						if (!res.ok) throw new Error('status ' + res.status);
						return res.text();
					}),
				{ force: opts.revalidate }
			);
			// Network went to the STORE, not the DOM: the write notifies our subscriber (set in
			// #server), which is the single apply path. If our subscription was severed (disconnect)
			// or a twin already applied before us, this is a no-op. `outer.aborted` / relevance is
			// handled by #apply's isConnected guard; `html` is intentionally unused here.
			void html;
		} catch (err) {
			if ((err as { name?: string })?.name === 'AbortError' || outer.aborted) return;
			if (import.meta.env.DEV) {
				console.warn('[ogygia] region fetch failed for', endpoint, err);
			}
			this.#fetch_attempts++;
			// Allow connectedCallback / a delayed retry to schedule again.
			this.#scheduled = false;
			if (this.isConnected && this.#fetch_attempts < 3) {
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

	#on_visible(fire: () => void, root_margin?: string) {
		const rootMargin = root_margin || this.getAttribute('margin') || '0px';
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						io.disconnect();
						this.#io = null;
						fire();
					}
				}
			},
			{ rootMargin }
		);
		io.observe(this);
		this.#io = io;
	}

	#on_media(q: string, fire: () => void) {
		if (!q) return fire();
		const mql = matchMedia(q);
		if (mql.matches) return fire();
		const on = (e) => {
			if (e.matches) {
				mql.removeEventListener('change', on);
				this.#mql = null;
				fire();
			}
		};
		mql.addEventListener('change', on);
		this.#mql = { mql, on };
	}

	async #hydrate() {
		if (this.#app || this.#hydrating) return;
		this.#hydrating = true;
		let lifted: Array<LiftedLake> | null = null;
		try {
			// wait for full parse so we can reliably detect a Kit-booted (csr=true) page.
			// On an SPA swap (and any post-load hydrate) the document is already parsed, so skip the
			// await entirely — no need to burn a microtask turn before every island wakes.
			if (typeof document !== 'undefined' && document.readyState === 'loading') await dom_ready();
			// SWR remount (and SPA swaps) can disconnect an island-in-lake while its module load is
			// in flight — abort rather than hydrate into a detached tree (SWR-ORPHAN-HYDRATE).
			if (!this.isConnected) return;
			// Seed SSR-resolved remote queries + document page snapshot once before hydrate.
			seed_remote_once();
			seed_page_once();
			const entry = this.getAttribute('entry');
			const mod = await load_island(entry);
			if (!this.isConnected) return;
			const Component = mod.default;

			const props = read_region_props(this);

			// Mixed mode: on a csr=true page Kit already hydrates this component — skip. EXCEPT a
			// deferred region (server island / <Region>): its HTML was FETCHED after load and swapped
			// in, so it was never part of Kit's SSR tree — Kit didn't hydrate it and won't. We must.
			// (connectedCallback carries the same is_deferred exception for the fetch phase.)
			if (kit_hydrates_page() && !is_deferred(this)) {
				this.setAttribute('data-kit-hydrated', '');
				if (import.meta.env.DEV) {
					console.warn(
						`[ogygia] island "${entry}" is on a csr=true page; Kit hydrates it, so the island directive is redundant here (it behaves as a normal component).`
					);
				}
				return;
			}

			// INVALID-NESTING GUARD: the browser parser hoists a BLOCK island rendered inline inside a
			// `<p>` out of its region before any JS runs (see region_ssr_truncated). The region is now
			// empty, so the hydrate below fresh-mounts a SECOND copy while the server copy lingers as an
			// orphan sibling of the paragraph. This is invalid HTML the framework cannot un-parse — warn
			// loudly (dev) instead of silently duplicating; the real fix lives in authoring (render an
			// inline element, or place the island in block context).
			if (import.meta.env.DEV && !is_deferred(this) && region_ssr_truncated(this)) {
				console.warn(
					`[ogygia] island "${entry}" rendered a BLOCK element inline inside a <p> (or other ` +
						`phrasing-only context). The browser's HTML parser hoisted that block out of the ` +
						`paragraph before hydration, so this region is empty and a SECOND copy is about to mount ` +
						`here — the server-rendered copy is now an orphaned sibling of the paragraph. Fix: make ` +
						`the component render an inline element (e.g. <span> instead of <div>), or place the ` +
						`island on its own line (block context) rather than inside a sentence.`
				);
			}

			lifted = slots.lakes.lift(this);
			if (!this.isConnected) return;

			// Hydration envelope: `hydrate()` anchors on a top-level `<!--[-->` comment and then
			// expects the component's OWN region envelope — but embedded SSR (Region.svelte)
			// emits only the inner layer. `render()` (region endpoint / deferred swap) has BOTH
			// layers — do not wrap again or hydration mismatches. (Verified against svelte 5.56.)
			if (!is_deferred(this)) {
				this.insertBefore(document.createComment('['), this.firstChild);
				this.appendChild(document.createComment(']'));
			}

			// Hydrate through NestedProvider so descendants see the "inside a hydrated island"
			// context — any nested island wrapper then degrades to a plain inline component
			// (single hydration with this parent). The provider adds no DOM, so this matches SSR.
			set_current_region(this);
			try {
				const wrapped = prop_guard.wrap(props, entry || '');
				// A PERSIST island hydrates through LiveHost (same no-DOM render as NestedProvider) so
				// that when it relocates onto the next page its props can be pushed in reactively.
				const LiveHost = slots.live;
				if (this.hasAttribute('data-ogygia-keep') && LiveHost) {
					// Keep needs SPA navigation — a full-page load throws the DOM away, so there is
					// nothing to relocate. Warn (dev) when the router is off on this page.
					if (import.meta.env.DEV && !document.querySelector('meta[name="ogygia-router"]')) {
						console.warn(
							`[ogygia] island "${entry}" has keep:'${this.getAttribute('data-ogygia-keep')}' but the SPA router is off (ogygia({ router: false })) — keep relies on SPA navigation; a full-page load replaces the DOM, so the attribute is a no-op here.`
						);
					}
					this.#app = hydrate(LiveHost, {
						target: this,
						props: { component: Component, initialProps: wrapped }
					});
					this.#persist_host = this.#app as unknown as {
						setProps?: (p: Record<string, unknown>) => void;
					};
				} else {
					this.#app = hydrate(NestedProvider, {
						target: this,
						props: { component: Component, props: wrapped }
					});
				}
			} finally {
				set_current_region(null);
			}

			// Restore each frozen region's SSR DOM AFTER hydrate. An inner waking region whose
			// `<ogygia-region wake="…">` (re)connects then self-runs — the freeze made its
			// subtree dead again, so the nearest-boundary rule wakes that inner region.
			slots.lakes.restore(this, lifted);
			lifted = null; // ownership transferred

			// Region was torn out during hydrate (SWR replaceChildren on an ancestor lake) — drop
			// the orphan app; disconnectedCallback may have run before `#app` was assigned.
			if (!this.isConnected) {
				try {
					unmount(this.#app);
				} catch {
					/* noop */
				}
				this.#app = null;
				return;
			}

			this.setAttribute('data-hydrated', '');
			this.dispatchEvent(new CustomEvent('ogygia:hydrated', { bubbles: true }));
		} catch (err) {
			console.error('[ogygia] hydration failed for', this.getAttribute('entry'), err);
		} finally {
			// If hydrate threw after lift, put lake DOM back so the page isn't permanently blank.
			if (lifted) slots.lakes.restore(this, lifted);
			this.#hydrating = false;
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
				this.#frame_unsub = slots.frames?.subscribe(this.#frame_address, (f) => this.#morph_live(f.html)) ?? null;
			}
			this.#morph_live(desc.html);
			return;
		}

		// Keep-alive: same interactive module, already mounted → reactive prop push, no DOM churn.
		if (this.#live_ready && interactive && this.#live_app && desc.module === this.#live_module) {
			this.#live_app.setProps?.(prop_guard.wrap(desc.props, desc.module));
			this.dispatchEvent(new CustomEvent('ogygia:live', { bubbles: true }));
			return;
		}

		// First tick, or the interactive module changed: (unmount and) swap + maybe hydrate.
		if (this.#live_app) {
			try {
				unmount(this.#live_app);
			} catch {
				/* noop */
			}
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

	/** Hydrate a live region's swapped-in HTML through {@link LiveHost} (props-pushable). */
	async #live_hydrate(props: Record<string, unknown>) {
		await dom_ready();
		if (!this.isConnected) return;
		seed_remote_once();
		seed_page_once();
		const entry = this.getAttribute('entry');
		const mod = await load_island(entry);
		if (!this.isConnected) return;
		// A live region's HTML comes from svelte `render()` (both envelope layers) — same as the
		// deferred swap path, so we do NOT wrap it in extra `[..]` hydration comments.
		const LiveHost = slots.live;
		if (!LiveHost) {
			if (import.meta.env.DEV) {
				console.warn('[ogygia] live region needs the live feature plugin (LiveHost missing)');
			}
			return;
		}
		this.#live_app = hydrate(LiveHost, {
			target: this,
			props: {
				component: mod.default,
				initialProps: prop_guard.wrap(props, entry || '')
			}
		}) as { setProps?: (p: Record<string, unknown>) => void };
		this.setAttribute('data-hydrated', '');
		this.dispatchEvent(new CustomEvent('ogygia:hydrated', { bubbles: true }));
		this.dispatchEvent(new CustomEvent('ogygia:live', { bubbles: true }));
	}

	disconnectedCallback() {
		// Persist move: node is relocated into the next document body — keep the island mounted.
		if (slots.persist.is_persist_preserving(this)) return;
		if (this.#live_app) {
			try {
				unmount(this.#live_app);
			} catch {
				/* noop */
			}
			this.#live_app = null;
		}
		this.#fetch_abort?.abort();
		this.#fetch_abort = null;
		// Unbind from the store + release our stake in the shared fetch (aborted only if we were the
		// last waiter). A persist move returns early above, so a relocating island keeps its binding.
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
		this.#io?.disconnect();
		this.#io = null;
		this.#disarm_interaction?.();
		this.#disarm_interaction = null;
		if (this.#mql) {
			this.#mql.mql.removeEventListener('change', this.#mql.on);
			this.#mql = null;
		}
		if (this.#app) {
			try {
				unmount(this.#app);
			} catch {
				/* noop */
			}
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
export function boot(installers: Array<() => void> = []): void {
	// Core owns the per-document lifecycle; the router reads it through this slot so router modules
	// never import core (and its Svelte component graph). Set before features install.
	slots.spaLifecycle = {
		prepare: prepare_spa_document,
		finish: finish_spa_document,
		softInvalidate: apply_soft_invalidate_doc
	};
	for (const install of installers) install();

	if (typeof customElements !== 'undefined' && !customElements.get('ogygia-region')) {
		customElements.define('ogygia-region', OgygiaRegion);
	}

	if (typeof window !== 'undefined' && window.__marker === undefined) {
		window.__marker = Math.random();
	}
}
