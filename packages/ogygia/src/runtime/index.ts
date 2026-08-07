import { hydrate, unmount } from 'svelte';
import { parse } from 'devalue';
import { set_page, reset_page } from '../shims/page-store.svelte.js';
import { seed_query_responses } from '../shims/kit-remote/client-stub.js';
import {
	clear_remote_seeds,
	clear_remote_instances
} from '../shims/kit-remote/remote-cache.js';
import NestedProvider from '../NestedProvider.svelte';
import { relocate_trailing_empty_comments } from './lake-anchors.js';
import { document_has_kit_bootstrap } from './kit-boot.js';
import { runtime_session } from './session.js';
import { is_persist_preserving } from './persist.js';
import {
	is_allowed_region_endpoint,
	is_same_origin_response,
	island_module_url
} from './region-endpoint-url.js';
import {
	FROZEN_SELECTOR,
	is_awake,
	is_deferred,
	is_frozen,
	region_is_vacant,
	region_max_age_ms,
	region_on_expire,
	region_remount,
	region_schedule
} from './region-attrs.js';

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
			`ogygia: mutating captured host snapshot '${prop_path}' inside island ${entry} — this updates nothing ` +
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

// Flicker fix: seed the reused Kit client query cache from the server's side-channel script
// (emitted by `ogygiaHandle` on csr=false pages) exactly ONCE per document, before any island's
// reused `Query` constructor reads `query_responses`. Cleared on SPA body swap.
function seed_remote_once() {
	if (runtime_session.remote_seeded) return;
	runtime_session.mark_remote_seeded();
	if (typeof document === 'undefined') return;
	const el = document.querySelector('script[type="application/ogygia-remote"]');
	if (el && el.textContent) seed_query_responses(el.textContent);
}

/** Document-level page seed (one script from ogygiaHandle) — once per document. */
function seed_page_once() {
	if (runtime_session.page_seeded) return;
	runtime_session.mark_page_seeded();
	if (typeof document === 'undefined') return;
	const el = document.querySelector('script[type="application/ogygia-page"]');
	if (!el?.textContent) return;
	try {
		const raw = parse(el.textContent) as Partial<{
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
	clear_remote_seeds();
	reset_page();
}

/**
 * After `body.replaceWith`: old islands have disconnected; new ones have only
 * scheduled `#hydrate` (first `await` yields). Sweep Kit query/live instance
 * maps so the next page cannot reuse a LiveQuery whose `#start` is already
 * spent (`once`) — that reuse never opens SSE again and leaves "connecting…".
 */
export function finish_spa_document() {
	clear_remote_instances();
}

/** A frozen region's SSR DOM detached before hydrate, plus the SSR-only attrs read at lift time. */
type LiftedLake = {
	id: string;
	frag: DocumentFragment;
	/** signed revalidate URL minted at SSR (remount:'swr'); '' otherwise */
	endpoint: string;
	when: string;
	maxAgeMs: number;
};

	class OgygiaRegion extends HTMLElement {
	#scheduled = false;
	/** True after a successful HTML swap — failures leave this false so a later schedule can retry. */
	#done = false;
	/** In-flight fetch guard (separate from `#done` so a failed fetch does not one-shot the region). */
	#fetching = false;
	/** Bounded automatic retries after a failed defer/SWR fetch. */
	#fetch_attempts = 0;
	#hydrating = false;
	#app: unknown = null;
	#io: IntersectionObserver | null = null;
	#mql: { mql: MediaQueryList; on: (e: MediaQueryListEvent) => void } | null = null;
	/** Abort in-flight region HTML fetch on disconnect (P-ABORT). */
	#fetch_abort: AbortController | null = null;
	/** Cancel idle schedule when disconnected. */
	#idle_handle: number | null = null;

	connectedCallback() {
		// Frozen region (`hydrate="none"`): SSR DOM preserved; parent lifts/restores. On {#if}
		// re-creation Svelte makes a fresh empty region — restore from cache (policy 'cache').
		if (is_frozen(this)) return this.#lake_connected();
		if (this.#scheduled) return;
		// Region rule (DESIGN.md): self-run iff the nearest ancestor region is not awake.
		const boundary = this.parentElement && this.parentElement.closest('ogygia-region');
		if (boundary && is_awake(boundary)) {
			this.setAttribute('data-nested', '');
			if (import.meta.env.DEV) {
				console.warn(
					`[ogygia] nested region "${this.getAttribute('entry')}" skipped self-run; the nearest region above it is awake, so it rides that hydration (inner hydrate "${this.getAttribute('hydrate') || 'load'}" ignored).`
				);
			}
			return;
		}
		// Region inside a not-yet-settled frozen ancestor: wait for parent lift/restore.
		if (boundary && is_frozen(boundary) && !runtime_session.settled_lakes.has(boundary)) return;
		this.#scheduled = true;
		// One scheduler, two axes: `hydrate` wakes JS; `render="defer"` + `when` fetches HTML.
		const deferred = is_deferred(this);
		const when = region_schedule(this);
		const fire = deferred ? () => this.#server() : () => this.#hydrate();
		if (when === 'idle') this.#on_idle(fire);
		else if (when === 'visible') this.#on_visible(fire);
		else if (when === 'load') fire();
		else this.#on_media(when, fire); // a media query string
	}

	// SERVER island / remount:swr revalidate: fetch rendered HTML and swap it in.
	// No client hydration in v1. A <link rel="preload"> (defer:load only) may already be in flight.
	async #server() {
		await this.#fetch_html();
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
		if (this.#done || this.#fetching) return;
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
		this.#fetch_abort?.abort();
		this.#fetch_abort = new AbortController();
		const { signal } = this.#fetch_abort;
		try {
			await runtime_session.server_gate.run(async () => {
				const res = await fetch(endpoint, {
					credentials: 'same-origin',
					cache: opts.revalidate ? 'no-store' : 'default',
					signal
				});
				if (!is_same_origin_response(res)) {
					throw new Error('cross-origin redirect');
				}
				if (!res.ok) throw new Error('status ' + res.status);
				const html = await res.text();
				// The region may have been {#if}-toggled away while the fetch was in flight.
				if (!this.isConnected || signal.aborted) return;
				// Parse offline so we can settle lakes BEFORE custom elements connect — otherwise an
				// island-in-lake inside the hole waits forever on an unsettled lake boundary.
				// createContextualFragment — signed same-origin HTML trust boundary (HOLE-TRUST).
				const frag = document.createRange().createContextualFragment(html);
				runtime_session.settle_lakes_in(frag);
				// SWR remount paints cache without settling so islands wait for this swap (one hydrate).
				if (is_frozen(this)) runtime_session.settled_lakes.add(this);
				this.replaceChildren(frag);
				this.#done = true;
				// A frozen region never "hydrates" — mark an swr revalidate distinctly so the
				// `[data-hydrated]` vocabulary keeps meaning "JS woke here".
				this.setAttribute(opts.revalidate ? 'data-revalidated' : 'data-hydrated', '');
				// SWR: refresh the remount cache so the next {#if} paints this response as stale
				// (not the forever-first SSR snapshot). Map.set replaces — size stays O(unique entries).
				if (opts.revalidate && is_frozen(this)) {
					const id = this.getAttribute('entry') || '';
					if (id) {
						const cached = document.createDocumentFragment();
						for (const child of Array.from(this.childNodes)) {
							cached.appendChild(child.cloneNode(true));
						}
						const prev = runtime_session.lake_cache.get(id);
						runtime_session.set_lake_cache(id, {
							frag: cached,
							endpoint: this.getAttribute('endpoint') || prev?.endpoint || '',
							when: this.getAttribute('when') || prev?.when || 'load',
							cachedAt: Date.now(),
							maxAgeMs: region_max_age_ms(this) || prev?.maxAgeMs || 0
						});
					}
				}
				this.dispatchEvent(new CustomEvent('ogygia:server', { bubbles: true }));
			});
		} catch (err) {
			if ((err as { name?: string })?.name === 'AbortError' || signal.aborted) return;
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
			// Retries exhausted: SWR settles the painted cache so islands-in-lake wake (stale > never).
			if (opts.revalidate && is_frozen(this) && this.isConnected) {
				runtime_session.settled_lakes.add(this);
				this.#wake_waiting_regions();
			}
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

	#on_visible(fire: () => void) {
		const rootMargin = this.getAttribute('margin') || '0px';
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
			// wait for full parse so we can reliably detect a Kit-booted (csr=true) page
			await dom_ready();
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

			let props: Record<string, unknown> = {};
			let sib = this.nextElementSibling;
			// Props script is normally the next sibling; skip `<link rel=modulepreload>` (and similar)
			// that may sit between the region and the payload.
			while (sib) {
				if (sib.tagName === 'SCRIPT' && sib.matches('script[data-ogygia-props]')) {
					props = parse(sib.textContent);
					break;
				}
				if (sib.tagName === 'LINK') {
					sib = sib.nextElementSibling;
					continue;
				}
				break;
			}

			// Mixed mode: on a csr=true page Kit already hydrates this component — skip.
			if (kit_hydrates_page()) {
				this.setAttribute('data-kit-hydrated', '');
				if (import.meta.env.DEV) {
					console.warn(
						`[ogygia] island "${entry}" is on a csr=true page; Kit hydrates it, so the island directive is redundant here (it behaves as a normal component).`
					);
				}
				return;
			}

			// LAKES: lift frozen SSR DOM before hydrate; leave trailing empty-comment delimiters
			// in the region so Boundary+Placeholder still matches (avoids hydration_mismatch).
			lifted = this.#lift_lakes();
			if (!this.isConnected) return;

			// Hydration envelope: `hydrate()` anchors on a top-level `<!--[-->` comment and then
			// expects the component's OWN fragment envelope — but embedded SSR (the island content
			// rendered inside this element by Island.svelte) emits only the inner dynamic-component
			// layer. `render()` output has BOTH layers; embedded output has one (verified against
			// svelte 5.56 in isolation: one layer ⇒ hydration_mismatch + client re-render, two
			// layers ⇒ clean adoption). Supply the missing outer pair before hydrating.
			this.insertBefore(document.createComment('['), this.firstChild);
			this.appendChild(document.createComment(']'));

			// Hydrate through NestedProvider so descendants see the "inside a hydrated island"
			// context — any nested island wrapper then degrades to a plain inline component
			// (single hydration with this parent). The provider adds no DOM, so this matches SSR.
			this.#app = hydrate(NestedProvider, {
				target: this,
				props: { component: Component, props: prop_guard.wrap(props, entry || '') }
			});

			// Restore each frozen region's SSR DOM AFTER hydrate. An inner waking region whose
			// `<ogygia-region hydrate="…">` (re)connects then self-runs — the freeze made its
			// subtree dead again, so the nearest-boundary rule wakes that inner region.
			this.#restore_lakes(lifted);
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
			if (lifted) this.#restore_lakes(lifted);
			this.#hydrating = false;
		}
	}

	// Detach frozen SSR DOM from each direct lake region. Trailing empty comments are Svelte
	// delimiters — put them back so hydrate matches Boundary+Placeholder. Cache for {#if} restore.
	//
	// The SSR-minted `endpoint` (remount:'swr') is captured HERE, before hydrate: the client build's
	// `makeRegionEndpoint` stub returns '' (no secret in the browser), so Svelte REMOVES that
	// attribute while adopting the region and it would be gone by restore time (SWR-ENDPOINT).
	#lift_lakes() {
		const lifted: Array<LiftedLake> = [];
		for (const lake of this.querySelectorAll(FROZEN_SELECTOR)) {
			if (lake.parentElement?.closest('ogygia-region') !== this) continue;
			const id = lake.getAttribute('entry') || '';
			const frag = document.createDocumentFragment();
			while (lake.firstChild) frag.appendChild(lake.firstChild);
			relocate_trailing_empty_comments(frag, lake);
			// No clone at lift — cache is filled once after restore (LAKE-CLONE).
			lifted.push({
				id,
				frag,
				endpoint: lake.getAttribute('endpoint') || '',
				when: lake.getAttribute('when') || 'load',
				maxAgeMs: region_max_age_ms(lake)
			});
		}
		return lifted;
	}

	// Re-insert each lake's frozen DOM AFTER the island hydrated. We re-QUERY the region by id
	// rather than reuse the lifted reference: Svelte's hydration may replace the region element
	// while adopting the (emptied) SSR DOM, so the current live element is the correct restore
	// target. Mark it settled first so an island-in-lake reconnecting inside it self-hydrates.
	#restore_lakes(lifted: Array<LiftedLake>) {
		for (const { id, frag, endpoint, when, maxAgeMs } of lifted) {
			const lake = this.querySelector(`${FROZEN_SELECTOR}[entry="${CSS.escape(id)}"]`);
			if (!lake) continue;
			runtime_session.settle_lakes_in(lake);
			runtime_session.settle_lakes_in(frag);
			runtime_session.initialized_lakes.add(id);
			lake.appendChild(frag);
			// Put the SSR capability URL back (hydration dropped it) so the live DOM still describes
			// the region — the cache below is what a later remount actually reads.
			if (endpoint && !lake.getAttribute('endpoint')) lake.setAttribute('endpoint', endpoint);
			// Cache for `{#if}` remount when policy is cache or swr (swr paints stale first).
			const policy = region_remount(lake);
			if ((policy === 'cache' || policy === 'swr') && id && !runtime_session.lake_cache.has(id)) {
				const cached = document.createDocumentFragment();
				for (const child of Array.from(lake.childNodes)) {
					cached.appendChild(child.cloneNode(true));
				}
				runtime_session.set_lake_cache(id, {
					frag: cached,
					endpoint,
					when,
					cachedAt: Date.now(),
					maxAgeMs: maxAgeMs || region_max_age_ms(lake)
				});
			}
		}
	}

	// A lake region connected. Initial SSR connect: content present -> leave it for the parent
	// island's lift/restore. {#if} RE-creation: Svelte made a fresh EMPTY region -> remount policy.
	#lake_connected() {
		const id = this.getAttribute('entry') || '';
		// Only a genuine {#if}-toggle RE-creation restores here — i.e. after the parent island has
		// done its one-time lift/restore (`initialized_lakes`). Before that, the parent owns the fill;
		// self-restoring now (e.g. on a region Svelte re-creates mid-mismatch-recovery) would double
		// the content.
		if (!runtime_session.initialized_lakes.has(id)) return;
		// Content present (elements OR non-whitespace text) -> leave it. Vacant (comments /
		// whitespace anchors only) -> apply remount policy (REMOUNT-VACANT).
		if (!region_is_vacant(this)) return;
		const policy = region_remount(this);
		switch (policy) {
			case 'empty':
				runtime_session.settled_lakes.add(this);
				return;
			case 'cache':
			case 'swr': {
				const cached = runtime_session.lake_cache.get(id);
				if (!cached) {
					runtime_session.settled_lakes.add(this);
					return;
				}
				const max_age = region_max_age_ms(this) || cached.maxAgeMs || 0;
				const expired = max_age > 0 && Date.now() - cached.cachedAt > max_age;
				const on_expire = region_on_expire(this);

				if (expired && on_expire === 'empty') {
					runtime_session.settled_lakes.add(this);
					return;
				}

				if (expired && on_expire === 'fetch') {
					// Past TTL: do not paint stale — fetch fresh (swr only; needs endpoint).
					if (!cached.endpoint) {
						runtime_session.settled_lakes.add(this);
						return;
					}
					this.setAttribute('endpoint', cached.endpoint);
					const when = this.getAttribute('when') || cached.when || 'load';
					const fire = () => void this.#fetch_html({ revalidate: true });
					if (when === 'idle') this.#on_idle(fire);
					else if (when === 'visible') this.#on_visible(fire);
					else if (when === 'load') fire();
					else this.#on_media(when, fire);
					return;
				}

				if (policy === 'cache') {
					// Settle before append so islands-in-lake connecting during insert self-hydrate.
					runtime_session.settled_lakes.add(this);
					this.appendChild(cached.frag.cloneNode(true));
					return;
				}
				// Stale-while-revalidate: paint cache WITHOUT settling. Islands-in-lake early-return
				// until the fresh HTML swap settles this lake — one hydrate, not cache+fresh (SWR-DOUBLE).
				// The endpoint can only come from the cache — the browser has no secret to mint one.
				this.appendChild(cached.frag.cloneNode(true));
				if (!cached.endpoint) {
					runtime_session.settled_lakes.add(this);
					this.#wake_waiting_regions();
					if (import.meta.env.DEV) {
						console.warn(
							`[ogygia] region "${id}" is remount:'swr' but no signed endpoint was captured at SSR — painting the cache only.`
						);
					}
					return;
				}
				this.setAttribute('endpoint', cached.endpoint);
				const when = this.getAttribute('when') || cached.when || 'load';
				const fire = () => void this.#fetch_html({ revalidate: true });
				if (when === 'idle') this.#on_idle(fire);
				else if (when === 'visible') this.#on_visible(fire);
				else if (when === 'load') fire();
				else this.#on_media(when, fire);
				return;
			}
			default: {
				const _exhaustive: never = policy;
				return _exhaustive;
			}
		}
	}

	disconnectedCallback() {
		// Persist move: node is relocated into the next document body — keep the island mounted.
		if (is_persist_preserving(this)) return;
		this.#fetch_abort?.abort();
		this.#fetch_abort = null;
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

if (typeof customElements !== 'undefined' && !customElements.get('ogygia-region')) {
	customElements.define('ogygia-region', OgygiaRegion);
}

// A stable marker set once per full page load; survives SPA navigations (module
// is not re-evaluated) but changes on a real reload. Used to prove SPA nav.
if (typeof window !== 'undefined' && window.__marker === undefined) {
	window.__marker = Math.random();
}

// SPA router is OPT-IN via <OgygiaRouter/> meta. Dynamic-import so MPA island pages
// do not pay the router chunk up front (ROUTER-ALWAYS).
async function boot_router_if_needed() {
	if (typeof document === 'undefined') return;
	if (!document.querySelector('meta[name="ogygia-router"]')) return;
	// Same gate as SpaRouter.start — skip on Kit-booted (csr=true) documents.
	if (document_has_kit_bootstrap()) return;
	const { startRouter, set_after_body_swap, set_after_body_connected } = await import(
		'./router.js'
	);
	set_after_body_swap(prepare_spa_document);
	set_after_body_connected(finish_spa_document);
	startRouter();
}

if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => void boot_router_if_needed(), { once: true });
	} else {
		void boot_router_if_needed();
	}
}
