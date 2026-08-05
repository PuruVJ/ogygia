import { hydrate, unmount } from 'svelte';
import { parse } from 'devalue';
import * as manifest from 'virtual:ogygia/manifest';
import { set_page, reset_page } from '../shims/page-store.svelte.js';
import { seed_query_responses } from '../shims/kit-remote/client-stub.js';
import { clear_remote_responses } from '../shims/kit-remote/remote-cache.js';
import NestedProvider from '../NestedProvider.svelte';
import { relocate_trailing_empty_comments } from './lake-anchors.js';
import { document_has_kit_bootstrap } from './kit-boot.js';
import { runtime_session } from './session.js';
import { is_persist_preserving } from './persist.js';

/** @type {(entry: string) => Promise<{ default: import('svelte').Component<Record<string, unknown>> }>} */
const load_island = manifest.dev
	? (entry) => import(/* @vite-ignore */ entry)
	: (entry) => manifest.regions[entry].load();

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
 * Reset every per-document runtime session before a new body connects.
 * Cleared BEFORE `body.replaceWith` so connecting regions never see the previous page's
 * kit/seed/lake/query/page state (fixes cross-page remote leak + stale lake restore races).
 */
export function prepare_spa_document() {
	runtime_session.reset();
	clear_remote_responses();
	reset_page();
}

class OgygiaRegion extends HTMLElement {
	#scheduled = false;
	#done = false;
	#hydrating = false;
	#app: unknown = null;
	#io: IntersectionObserver | null = null;
	#mql: { mql: MediaQueryList; on: (e: MediaQueryListEvent) => void } | null = null;

	connectedCallback() {
		// LAKE region: a frozen, non-boundary subtree. It never hydrates; its parent island lifts
		// and restores its SSR DOM. On {#if} re-creation Svelte makes a fresh empty region — restore
		// the cached frozen DOM (policy 'cache'). Handled before the island logic below.
		if (this.hasAttribute('data-lake')) return this.#lake_connected();
		if (this.#scheduled) return;
		// The region rule (DESIGN.md): a region self-hydrates iff the NEAREST region boundary
		// above it is not hydrated. A boundary is "hydrated" iff it carries a `hydrate` attribute
		// (a client island); a `defer` hole and lakes (future) have no `hydrate` attr, so a region
		// inside them self-hydrates again. `parentElement.closest` excludes self. (Island-in-island
		// normally degrades to an inline component, so this element never appears — this is the
		// general rule + defense for regions inserted via server-hole fill / SPA swaps.)
		const boundary = this.parentElement && this.parentElement.closest('ogygia-region');
		if (boundary && boundary.hasAttribute('hydrate')) {
			this.setAttribute('data-nested', '');
			if (manifest.dev) {
				console.warn(
					`[ogygia] nested island "${this.getAttribute('entry')}" skipped self-hydration; the nearest region above it hydrates, so it rides that hydration (inner strategy "${this.getAttribute('hydrate') || 'load'}" ignored).`
				);
			}
			return;
		}
		// Island INSIDE a not-yet-settled lake (island-in-lake): defer. The parent island lifts the
		// lake's DOM (detaching us) then restores it (reconnecting us) with the lake marked settled —
		// that reconnection re-runs connectedCallback and we self-hydrate then, exactly once. Waking
		// now would race the parent's lift (double hydration / mismatch).
		if (
			boundary &&
			boundary.hasAttribute('data-lake') &&
			!runtime_session.settled_lakes.has(boundary)
		)
			return;
		this.#scheduled = true;
		// One scheduler drives BOTH axes: a hydrate island wakes its component, a defer (server)
		// island fetches its hole. The attribute VALUE is the timing in each case — 'load' | 'idle'
		// | 'visible' | media query — so the machinery is shared (the hydrate/defer symmetry).
		const is_defer = this.hasAttribute('defer');
		// server region: timing rides on `defer-when` (not `defer` — that's an HTML boolean attribute,
		// so its string value would be dropped); hydrate region: timing is the `hydrate` value.
		const when = (is_defer ? this.getAttribute('defer-when') : this.getAttribute('hydrate')) || 'load';
		const fire = is_defer ? () => this.#server() : () => this.#hydrate();
		if (when === 'idle') this.#on_idle(fire);
		else if (when === 'visible') this.#on_visible(fire);
		else if (when === 'load') fire();
		else this.#on_media(when, fire); // a media query string
	}

	// SERVER island: fetch the rendered HTML from the `/🏝️ogygia🏝️` endpoint (same-origin,
	// cookies flow) and swap it in. No client hydration in v1 (server+client is future work).
	// The fallback stays visible on failure. A <link rel="preload"> emitted next to us has
	// usually already started this exact request, so the browser serves it from cache.
	async #server() {
		if (this.#done) return;
		this.#done = true;
		const endpoint = this.getAttribute('endpoint');
		if (!endpoint) return;
		try {
			await runtime_session.server_gate.run(async () => {
				const res = await fetch(endpoint, { credentials: 'same-origin' });
				if (!res.ok) throw new Error('status ' + res.status);
				const html = await res.text();
				// Parse offline so we can settle lakes BEFORE custom elements connect — otherwise an
				// island-in-lake inside the hole waits forever on an unsettled lake boundary.
				// createContextualFragment — signed same-origin HTML trust boundary (HOLE-TRUST).
				const frag = document.createRange().createContextualFragment(html);
				runtime_session.settle_lakes_in(frag);
				this.replaceChildren(frag);
				this.setAttribute('data-hydrated', '');
				this.dispatchEvent(new CustomEvent('ogygia:server', { bubbles: true }));
			});
		} catch (err) {
			// keep the fallback; surface the reason in dev
			if (manifest.dev) {
				console.warn('[ogygia] server island fetch failed for', endpoint, err);
			}
		}
	}

	#on_idle(fire: () => void) {
		if ('requestIdleCallback' in window) requestIdleCallback(fire, { timeout: 2000 });
		else setTimeout(fire, 200);
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
		let lifted: Array<{ id: string; frag: DocumentFragment }> | null = null;
		try {
			// wait for full parse so we can reliably detect a Kit-booted (csr=true) page
			await dom_ready();
			// Seed SSR-resolved remote queries + document page snapshot once before hydrate.
			seed_remote_once();
			seed_page_once();
			const entry = this.getAttribute('entry');
			const mod = await load_island(entry);
			const Component = mod.default;

			let props: Record<string, unknown> = {};
			let sib = this.nextElementSibling;
			while (sib && sib.tagName === 'SCRIPT') {
				if (sib.matches('script[data-ogygia-props]')) props = parse(sib.textContent);
				else break;
				sib = sib.nextElementSibling;
			}

			// Mixed mode: on a csr=true page Kit already hydrates this component — skip.
			if (kit_hydrates_page()) {
				this.setAttribute('data-kit-hydrated', '');
				if (manifest.dev) {
					console.warn(
						`[ogygia] island "${entry}" is on a csr=true page; Kit hydrates it, so the island directive is redundant here (it behaves as a normal component).`
					);
				}
				return;
			}

			// LAKES: lift frozen SSR DOM before hydrate; leave trailing empty-comment delimiters
			// in the region so Boundary+Placeholder still matches (avoids hydration_mismatch).
			lifted = this.#lift_lakes();

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

			// Restore each lake's frozen DOM. A lake inside it may itself contain an island whose
			// `<ogygia-region hydrate>` now (re)connects and self-hydrates — the lake reset its
			// subtree to "dead", so the nearest-boundary rule makes that inner island wake up.
			this.#restore_lakes(lifted);
			lifted = null; // ownership transferred

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
	#lift_lakes() {
		const lifted: Array<{ id: string; frag: DocumentFragment }> = [];
		for (const lake of this.querySelectorAll('ogygia-region[data-lake]')) {
			if (lake.parentElement?.closest('ogygia-region') !== this) continue;
			const id = lake.getAttribute('entry') || '';
			const frag = document.createDocumentFragment();
			while (lake.firstChild) frag.appendChild(lake.firstChild);
			relocate_trailing_empty_comments(frag, lake);
			// No clone at lift — cache is filled once after restore (LAKE-CLONE).
			lifted.push({ id, frag });
		}
		return lifted;
	}

	// Re-insert each lake's frozen DOM AFTER the island hydrated. We re-QUERY the region by id
	// rather than reuse the lifted reference: Svelte's hydration may replace the region element
	// while adopting the (emptied) SSR DOM, so the current live element is the correct restore
	// target. Mark it settled first so an island-in-lake reconnecting inside it self-hydrates.
	#restore_lakes(lifted: Array<{ id: string; frag: DocumentFragment }>) {
		for (const { id, frag } of lifted) {
			const lake = this.querySelector(`ogygia-region[data-lake][entry="${CSS.escape(id)}"]`);
			if (!lake) continue;
			runtime_session.settle_lakes_in(lake);
			runtime_session.settle_lakes_in(frag);
			runtime_session.initialized_lakes.add(id);
			lake.appendChild(frag);
			// One clone for {#if} re-create — after the hot-path restore, not before.
			if (manifest.lake_restore === 'cache' && id && !runtime_session.lake_cache.has(id)) {
				const cached = document.createDocumentFragment();
				for (const child of Array.from(lake.childNodes)) {
					cached.appendChild(child.cloneNode(true));
				}
				runtime_session.lake_cache.set(id, cached);
			}
		}
	}

	// A lake region connected. Initial SSR connect: content present -> leave it for the parent
	// island's lift/restore. {#if} RE-creation: Svelte made a fresh EMPTY region -> restore the
	// cached frozen DOM (policy 'cache'); 'empty' leaves it blank. Mark settled either way so an
	// inner island reconnecting inside it wakes.
	#lake_connected() {
		const id = this.getAttribute('entry') || '';
		// Only a genuine {#if}-toggle RE-creation restores here — i.e. after the parent island has
		// done its one-time lift/restore (`initialized_lakes`). Before that, the parent owns the fill;
		// self-restoring now (e.g. on a region Svelte re-creates mid-mismatch-recovery) would double
		// the content.
		if (!runtime_session.initialized_lakes.has(id)) return;
		// Initial SSR content (an ELEMENT subtree) present -> leave it. Empty (placeholder anchor
		// only) -> restore the cached frozen DOM (policy 'cache'; 'empty' stays blank).
		if (this.querySelector('*')) return;
		runtime_session.settled_lakes.add(this);
		if (manifest.lake_restore === 'cache') {
			const cached = runtime_session.lake_cache.get(id);
			if (cached) this.appendChild(cached.cloneNode(true));
		}
	}

	disconnectedCallback() {
		// Persist move: node is relocated into the next document body — keep the island mounted.
		if (is_persist_preserving(this)) return;
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
	const { startRouter, set_after_body_swap } = await import('./router.js');
	set_after_body_swap(prepare_spa_document);
	startRouter();
}

if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => void boot_router_if_needed(), { once: true });
	} else {
		void boot_router_if_needed();
	}
}
