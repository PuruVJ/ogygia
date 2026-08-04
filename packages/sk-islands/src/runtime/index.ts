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
	connectedCallback() {
		if (this._scheduled) return;
		// The region rule (DESIGN.md): a region self-hydrates iff the NEAREST region boundary
		// above it is not hydrated. We implement exactly that — not a blanket "any ancestor
		// sk-island". The nearest ancestor boundary is hydrated when it is a client island
		// (a hydrating strategy); a `defer` hole (data-strategy="server") and lakes (future)
		// are NOT hydrated, so a region inside them self-hydrates again.
		// `parentElement.closest` excludes self. (For island-in-island the wrapper usually
		// degrades to an inline component, so this element never appears — this is the general
		// rule + defense for regions inserted via server-hole fill / SPA swaps.)
		const boundary = this.parentElement && this.parentElement.closest('sk-island');
		if (boundary && boundary.getAttribute('data-strategy') !== 'server') {
			this.setAttribute('data-nested', '');
			if (manifest.dev) {
				console.warn(
					`[ogygia] nested island "${this.dataset.entry}" skipped self-hydration; the nearest region above it hydrates, so it rides that hydration (inner strategy "${this.dataset.strategy || 'load'}" ignored).`
				);
			}
			return;
		}
		this._scheduled = true;
		const strategy = this.dataset.strategy || 'load';
		if (strategy === 'server') this._server();
		else if (strategy === 'idle') this._onIdle();
		else if (strategy === 'visible') this._onVisible();
		else if (strategy === 'media') this._onMedia();
		else this._hydrate();
	}

	// SERVER island: fetch the rendered HTML from the `/_islands` endpoint (same-origin,
	// cookies flow) and swap it in. No client hydration in v1 (server+client is future work).
	// The fallback stays visible on failure. A <link rel="preload"> emitted next to us has
	// usually already started this exact request, so the browser serves it from cache.
	async _server() {
		if (this._done) return;
		this._done = true;
		const endpoint = this.dataset.endpoint;
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

	_onIdle() {
		const cb = () => this._hydrate();
		if ('requestIdleCallback' in window) requestIdleCallback(cb, { timeout: 2000 });
		else setTimeout(cb, 200);
	}

	_onVisible() {
		const rootMargin = this.dataset.rootMargin || '0px';
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						io.disconnect();
						this._io = null;
						this._hydrate();
					}
				}
			},
			{ rootMargin }
		);
		io.observe(this);
		this._io = io;
	}

	_onMedia() {
		const q = this.dataset.media;
		if (!q) return this._hydrate();
		const mql = matchMedia(q);
		if (mql.matches) return this._hydrate();
		const on = (e) => {
			if (e.matches) {
				mql.removeEventListener('change', on);
				this._mql = null;
				this._hydrate();
			}
		};
		mql.addEventListener('change', on);
		this._mql = { mql, on };
	}

	async _hydrate() {
		if (this._app || this._hydrating) return;
		this._hydrating = true;
		try {
			// wait for full parse so we can reliably detect a Kit-booted (csr=true) page
			await domReady();
			const entry = this.dataset.entry;
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
			this._app = hydrate(NestedProvider, {
				target: this,
				props: { component: Component, props }
			});
			this.setAttribute('data-hydrated', '');
			this.dispatchEvent(new CustomEvent('sk:hydrated', { bubbles: true }));
		} catch (err) {
			console.error('[ogygia] hydration failed for', this.dataset.entry, err);
		} finally {
			this._hydrating = false;
		}
	}

	disconnectedCallback() {
		this._io?.disconnect();
		this._io = null;
		if (this._mql) {
			this._mql.mql.removeEventListener('change', this._mql.on);
			this._mql = null;
		}
		if (this._app) {
			try {
				unmount(this._app);
			} catch {
				/* noop */
			}
			this._app = null;
		}
		this._scheduled = false;
	}
}

if (typeof customElements !== 'undefined' && !customElements.get('sk-island')) {
	customElements.define('sk-island', SkIsland);
}

// A stable marker set once per full page load; survives SPA navigations (module
// is not re-evaluated) but changes on a real reload. Used to prove SPA nav.
if (typeof window !== 'undefined' && window.__marker === undefined) {
	window.__marker = Math.random();
}

// The SPA router is OPT-IN: it activates only when a <ClientRouter /> rendered a
// marker into the page <head>. Without it, links are plain MPA navigations.
startRouter();
