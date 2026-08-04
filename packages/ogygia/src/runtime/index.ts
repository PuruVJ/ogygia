import { hydrate, unmount } from 'svelte';
import { parse } from 'devalue';
import * as manifest from 'virtual:ogygia/manifest';
import { startRouter } from './router.js';
import { set_page } from '../shims/page-store.svelte.js';
import { seed_query_responses } from '../shims/kit-remote/client-stub.js';
import NestedProvider from '../NestedProvider.svelte';

/** @type {(entry: string) => Promise<{ default: import('svelte').Component<Record<string, unknown>> }>} */
const load_island = manifest.dev
	? (entry) => import(/* @vite-ignore */ entry)
	: (entry) => manifest.regions[entry].load();

// LAKE DOM cache for `{#if}`-toggle re-creation (policy `lake_restore: 'cache'`), keyed by the
// lake region's `entry` id. Populated during the first lift; a clone is re-inserted whenever a
// lake region is re-created by its parent island's reactive template.
const lake_cache = new Map<string, Node>();
// Lake regions whose frozen DOM has been restored ("settled"). An island region that connects
// inside a not-yet-settled lake defers — the lake's restore re-inserts (reconnects) it, and THEN
// it self-hydrates. This is what lets an island-in-lake wake up exactly once, after its lake.
const settled_lakes = new WeakSet<Element>();
// Lake ids the parent island has already lift/restored once. Until then, a lake region connecting
// (incl. one Svelte re-creates while recovering a hydration mismatch) must NOT self-restore — the
// parent's `#restore_lakes` owns the first fill. Afterwards, an {#if}-toggle re-creation restores
// from cache via `#lake_connected`. Gating on this prevents a double-restore (the mismatch-recovery
// re-create + the parent restore both firing).
const initialized_lakes = new Set<string>();

function dom_ready() {
	if (typeof document === 'undefined' || document.readyState !== 'loading') return Promise.resolve();
	return new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
}

// Flicker fix: seed the reused Kit client query cache from the server's side-channel script
// (emitted by `ogygiaHandle` on csr=false pages) exactly ONCE, before any island's reused `Query`
// constructor reads `query_responses`. Idempotent + guarded so the first island to hydrate seeds
// the shared singleton for all of them. No script (csr=true, or no SSR-resolved queries) = no-op.
let _remote_seeded = false;
function seed_remote_once() {
	if (_remote_seeded) return;
	_remote_seeded = true;
	if (typeof document === 'undefined') return;
	const el = document.querySelector('script[type="application/ogygia-remote"]');
	if (el && el.textContent) seed_query_responses(el.textContent);
}

// Mixed mode: on a csr=true page, Kit boots and hydrates the whole tree (including our
// island components). Kit's bootstrap is an inline script near </body>, so we detect it
// only once the document is fully parsed. Cached.
let _kit_page;
function kit_hydrates_page() {
	if (_kit_page === undefined) {
		_kit_page =
			typeof document !== 'undefined' &&
			Array.from(document.querySelectorAll('script:not([src])')).some((s) =>
				/__sveltekit_/.test(s.textContent || '')
			);
	}
	return _kit_page;
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
		if (boundary && boundary.hasAttribute('data-lake') && !settled_lakes.has(boundary)) return;
		this.#scheduled = true;
		if (this.hasAttribute('defer')) return this.#server();
		const hydrate = this.getAttribute('hydrate') || 'load';
		if (hydrate === 'idle') this.#on_idle();
		else if (hydrate === 'visible') this.#on_visible();
		else if (hydrate === 'load') this.#hydrate();
		else this.#on_media(hydrate); // a media query string
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
			const res = await fetch(endpoint, { credentials: 'same-origin' });
			if (!res.ok) throw new Error('status ' + res.status);
			const html = await res.text();
			this.innerHTML = html;
			this.setAttribute('data-hydrated', '');
			this.dispatchEvent(new CustomEvent('ogygia:server', { bubbles: true }));
		} catch (err) {
			// keep the fallback; surface the reason in dev
			if (manifest.dev) {
				console.warn('[ogygia] server island fetch failed for', endpoint, err);
			}
		}
	}

	#on_idle() {
		const cb = () => this.#hydrate();
		if ('requestIdleCallback' in window) requestIdleCallback(cb, { timeout: 2000 });
		else setTimeout(cb, 200);
	}

	#on_visible() {
		const rootMargin = this.getAttribute('margin') || '0px';
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						io.disconnect();
						this.#io = null;
						this.#hydrate();
					}
				}
			},
			{ rootMargin }
		);
		io.observe(this);
		this.#io = io;
	}

	#on_media(q: string) {
		if (!q) return this.#hydrate();
		const mql = matchMedia(q);
		if (mql.matches) return this.#hydrate();
		const on = (e) => {
			if (e.matches) {
				mql.removeEventListener('change', on);
				this.#mql = null;
				this.#hydrate();
			}
		};
		mql.addEventListener('change', on);
		this.#mql = { mql, on };
	}

	async #hydrate() {
		if (this.#app || this.#hydrating) return;
		this.#hydrating = true;
		try {
			// wait for full parse so we can reliably detect a Kit-booted (csr=true) page
			await dom_ready();
			// Seed SSR-resolved remote queries before this island's reused `Query` ctor reads the
			// shared cache — must run before `hydrate()` below (idempotent across all islands).
			seed_remote_once();
			const entry = this.getAttribute('entry');
			const mod = await load_island(entry);
			const Component = mod.default;

			let props = {};
			let page_snap = null;
			let sib = this.nextElementSibling;
			while (sib && sib.tagName === 'SCRIPT') {
				if (sib.matches('script[data-ogygia-props]')) props = parse(sib.textContent);
				else if (sib.matches('script[data-ogygia-page]')) page_snap = parse(sib.textContent);
				else break;
				sib = sib.nextElementSibling;
			}

			// Seed the shared $state-backed page store so this island's `$app/state` /
			// `$app/stores` shims (and any `$derived`/`$effect`/`$page` subscribers) reflect the
			// current page — on the initial load and after every SPA nav (islands remount with
			// fresh data). Same module singleton as the shims: no global bridge needed.
			if (page_snap) {
				try {
					if (typeof page_snap.url === 'string') page_snap.url = new URL(page_snap.url);
				} catch {
					/* keep string url */
				}
				set_page(page_snap);
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

			// LAKES: lift the frozen SSR DOM out of every lake region inside this island BEFORE
			// hydrating. The client build swapped each lake import for a render-nothing placeholder,
			// so the client render of a lake region is empty; emptying the region first makes the
			// hydration walk match (no `hydration_mismatch`). Cache a clone for {#if}-toggle
			// re-creation when policy is 'cache'. The originals are re-inserted after hydration.
			const lifted = this.#lift_lakes();

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
				props: { component: Component, props }
			});

			// Restore each lake's frozen DOM. A lake inside it may itself contain an island whose
			// `<ogygia-region hydrate>` now (re)connects and self-hydrates — the lake reset its
			// subtree to "dead", so the nearest-boundary rule makes that inner island wake up.
			this.#restore_lakes(lifted);

			this.setAttribute('data-hydrated', '');
			this.dispatchEvent(new CustomEvent('ogygia:hydrated', { bubbles: true }));
		} catch (err) {
			console.error('[ogygia] hydration failed for', this.getAttribute('entry'), err);
		} finally {
			this.#hydrating = false;
		}
	}

	// Detach the frozen SSR DOM from every lake region that belongs DIRECTLY to this island (its
	// nearest region ancestor is `this` — lakes inside a nested island region are that island's to
	// lift). Emptying the region makes the swapped-in placeholder's empty client render match, so
	// Svelte reports no `hydration_mismatch`. Cache a clone for {#if}-toggle re-creation ('cache').
	#lift_lakes() {
		const lifted: Array<{ id: string; frag: DocumentFragment }> = [];
		for (const lake of this.querySelectorAll('ogygia-region[data-lake]')) {
			if (lake.parentElement?.closest('ogygia-region') !== this) continue;
			const id = lake.getAttribute('entry') || '';
			const frag = document.createDocumentFragment();
			while (lake.firstChild) frag.appendChild(lake.firstChild);
			if (manifest.lake_restore === 'cache' && id) lake_cache.set(id, frag.cloneNode(true));
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
			const lake = this.querySelector(`ogygia-region[data-lake][entry="${id}"]`);
			if (!lake) continue;
			settled_lakes.add(lake);
			initialized_lakes.add(id);
			lake.appendChild(frag);
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
		if (!initialized_lakes.has(id)) return;
		// Initial SSR content (an ELEMENT subtree) present -> leave it. Empty (placeholder anchor
		// only) -> restore the cached frozen DOM (policy 'cache'; 'empty' stays blank).
		if (this.querySelector('*')) return;
		settled_lakes.add(this);
		if (manifest.lake_restore === 'cache') {
			const cached = lake_cache.get(id);
			if (cached) this.appendChild(cached.cloneNode(true));
		}
	}

	disconnectedCallback() {
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

// The SPA router is OPT-IN: it activates only when a <ClientRouter /> rendered a
// marker into the page <head>. Without it, links are plain MPA navigations.
startRouter();
