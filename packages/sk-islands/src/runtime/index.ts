import { hydrate, unmount } from 'svelte';
import { parse } from 'devalue';
import * as manifest from 'virtual:ogygia/manifest';
import { startRouter } from './router.js';
import NestedProvider from '../NestedProvider.svelte';

/** @type {(entry: string) => Promise<any>} */
const loadIsland = manifest.dev
	? (entry) => import(/* @vite-ignore */ entry)
	: (entry) => manifest.islands[entry]();

function domReady() {
	if (typeof document === 'undefined' || document.readyState !== 'loading') return Promise.resolve();
	return new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
}

// Mixed mode: on a csr=true page, Kit boots and hydrates the whole tree (including our
// island components). Kit's bootstrap is an inline script near </body>, so we detect it
// only once the document is fully parsed. Cached.
let _kitPage;
function kitHydratesPage() {
	if (_kitPage === undefined) {
		_kitPage =
			typeof document !== 'undefined' &&
			Array.from(document.querySelectorAll('script:not([src])')).some((s) =>
				/__sveltekit_/.test(s.textContent || '')
			);
	}
	return _kitPage;
}

class SkIsland extends HTMLElement {
	#scheduled = false;
	#done = false;
	#hydrating = false;
	#app: unknown = null;
	#io: IntersectionObserver | null = null;
	#mql: { mql: MediaQueryList; on: (e: MediaQueryListEvent) => void } | null = null;

	connectedCallback() {
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
		this.#scheduled = true;
		if (this.hasAttribute('defer')) return this.#server();
		const hydrate = this.getAttribute('hydrate') || 'load';
		if (hydrate === 'idle') this.#onIdle();
		else if (hydrate === 'visible') this.#onVisible();
		else if (hydrate === 'load') this.#hydrate();
		else this.#onMedia(hydrate); // a media query string
	}

	// SERVER island: fetch the rendered HTML from the `/_islands` endpoint (same-origin,
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
			this.dispatchEvent(new CustomEvent('sk:server', { bubbles: true }));
		} catch (err) {
			// keep the fallback; surface the reason in dev
			if (manifest.dev) {
				console.warn('[ogygia] server island fetch failed for', endpoint, err);
			}
		}
	}

	#onIdle() {
		const cb = () => this.#hydrate();
		if ('requestIdleCallback' in window) requestIdleCallback(cb, { timeout: 2000 });
		else setTimeout(cb, 200);
	}

	#onVisible() {
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

	#onMedia(q: string) {
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
			await domReady();
			const entry = this.getAttribute('entry');
			const mod = await loadIsland(entry);
			const Component = mod.default;

			let props = {};
			let pageSnap = null;
			let sib = this.nextElementSibling;
			while (sib && sib.tagName === 'SCRIPT') {
				if (sib.matches('script[data-sk-props]')) props = parse(sib.textContent);
				else if (sib.matches('script[data-sk-page]')) pageSnap = parse(sib.textContent);
				else break;
				sib = sib.nextElementSibling;
			}

			// seed the $app/state / $app/stores shims from this page's snapshot (also
			// needed on csr=true pages, where the island component is aliased to the shims)
			if (pageSnap) {
				try {
					if (typeof pageSnap.url === 'string') pageSnap.url = new URL(pageSnap.url);
				} catch {
					/* keep string url */
				}
				window.__ogygiaPage = pageSnap;
			}

			// Mixed mode: on a csr=true page Kit already hydrates this component — skip.
			if (kitHydratesPage()) {
				this.setAttribute('data-kit-hydrated', '');
				if (manifest.dev) {
					console.warn(
						`[ogygia] island "${entry}" is on a csr=true page; Kit hydrates it, so the island directive is redundant here (it behaves as a normal component).`
					);
				}
				return;
			}

			// Hydrate through NestedProvider so descendants see the "inside a hydrated island"
			// context — any nested island wrapper then degrades to a plain inline component
			// (single hydration with this parent). The provider adds no DOM, so this matches SSR.
			this.#app = hydrate(NestedProvider, {
				target: this,
				props: { component: Component, props }
			});
			this.setAttribute('data-hydrated', '');
			this.dispatchEvent(new CustomEvent('sk:hydrated', { bubbles: true }));
		} catch (err) {
			console.error('[ogygia] hydration failed for', this.getAttribute('entry'), err);
		} finally {
			this.#hydrating = false;
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
	customElements.define('ogygia-region', SkIsland);
}

// A stable marker set once per full page load; survives SPA navigations (module
// is not re-evaluated) but changes on a real reload. Used to prove SPA nav.
if (typeof window !== 'undefined' && window.__marker === undefined) {
	window.__marker = Math.random();
}

// The SPA router is OPT-IN: it activates only when a <ClientRouter /> rendered a
// marker into the page <head>. Without it, links are plain MPA navigations.
startRouter();
