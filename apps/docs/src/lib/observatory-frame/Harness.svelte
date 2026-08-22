<script lang="ts">
	/**
	 * THE ISOLATED PREVIEW HARNESS — runs inside the Observatory's <iframe> (this page is its own
	 * csr=false document with its OWN ogygia runtime + svelte instance). The parent Observatory sends
	 * the compiled app over postMessage; we link the islands HERE (so they share THIS frame's svelte),
	 * inject them into #obs-app, and this frame's runtime hydrates them — full isolation, no shared
	 * runtime/CSS/state with the host. Nav drives the REAL reconcile on the frame body; runtime events
	 * + nav-link clicks are relayed back to the parent. It's a headless boot island (renders nothing).
	 */
	import { mount, unmount } from 'svelte';
	import { add_sink } from 'ogygia/devtools';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type Any = any;
	type Linked = { default?: (...a: unknown[]) => unknown } & Record<string, unknown>;
	type Require = (spec: string) => Linked;

	const origin = typeof location !== 'undefined' ? location.origin : '*';
	const post = (msg: Record<string, unknown>) => window.parent?.postMessage({ __obs: true, ...msg }, origin);

	/** ESM→CJS eval of a svelte-compiled CLIENT module, linking bare + relative specifiers via `req`. */
	function eval_client(code: string, req: Require, sc: Linked): Linked {
		const body = code
			.replace(/import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const $1 = __require("$2");')
			.replace(/import\s+([\w$]+)\s*,\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const __m_$1 = __require("$3"); const $1 = __m_$1.default; const {$2} = __m_$1;')
			.replace(/import\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const $1 = (__require("$2")).default;')
			.replace(/import\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]\s*(?:with\s*\{[^}]*\})?\s*;?/g, 'const {$1} = __require("$2");')
			.replace(/import\s+['"][^'"]+['"]\s*;?/g, '')
			.replace(/export\s+default\s+/g, '__exports.default = ')
			.replace(/export\s*\{([^}]+)\}\s*;?/g, (_m: string, names: string) =>
				names.split(',').map((n: string) => { const p = n.trim().split(/\s+as\s+/); return `__exports[${JSON.stringify((p[1] || p[0]).trim())}] = ${p[0].trim()};`; }).join(' ')
			)
			.replace(/export\s+(const|let|var|function|class)\s+/g, '$1 ');
		const __exports: Linked = {};
		// eslint-disable-next-line no-new-func
		new Function('__require', '__exports', '__sc', body.replace(/__require\("svelte\/internal\/client"\)/g, '__sc'))(req, __exports, sc);
		return __exports;
	}

	/** Build a page's real-island DOM offline: link each island's blob entry (reads a frame-window
	 *  global the blob re-exports, so it hydrates against THIS frame's svelte). */
	function link_page_dom(html: string, modules: Record<string, string>, sc: Linked) {
		const store: Record<string, unknown> = ((window as Any).__OBS_ISLANDS__ ||= {});
		const blobs: string[] = [];
		const cache = new Map<string, Linked>();
		const resolveName = (spec: string): string | null => {
			const bare = spec.replace(/^\.\//, '').replace(/^\//, '');
			if (modules[bare] != null) return bare;
			const base = spec.split('/').pop();
			return base && modules[base] != null ? base : null;
		};
		const require: Require = (spec) => {
			if (spec === 'svelte/internal/client') return sc;
			const name = resolveName(spec);
			if (name) {
				const hit = cache.get(name);
				if (hit) return hit;
				const ex: Linked = {};
				cache.set(name, ex);
				Object.assign(ex, eval_client(modules[name], require, sc));
				return ex;
			}
			return { default: () => {} };
		};
		const container = document.createElement('div');
		container.innerHTML = html;
		for (const region of container.querySelectorAll('ogygia-region[entry^="__ISLAND__:"]')) {
			const entryAttr = region.getAttribute('entry');
			if (!entryAttr) continue;
			const file = entryAttr.slice('__ISLAND__:'.length);
			if (modules[file] == null) continue;
			const Comp = eval_client(modules[file], require, sc).default;
			const key = 'k' + Math.random().toString(36).slice(2);
			store[key] = Comp;
			const blob = URL.createObjectURL(new Blob([`export default window.__OBS_ISLANDS__[${JSON.stringify(key)}]`], { type: 'text/javascript' }));
			blobs.push(blob);
			region.setAttribute('entry', blob);
		}
		return { container, blobs };
	}

	$effect(() => {
		let svelteClient: Linked | null = null;
		let reconcileMod: { reconcile_body?: Any; morph_children?: Any } = {};
		let mountedApp: Any = null; // csr=true: the whole-app mount (Kit-style)
		const liveNodes = new Map<string, Element & { applyLive?: (d: unknown) => void }>();
		const fpNames: Record<string, string> = {}; // data-og-fp → island name, for the event labels

		// BOUNDARY LENS (x-ray): the parent's x-ray mode is this same real render + a `.lens` class on
		// #obs-app. The overlay CSS (frame +page.svelte) keys off the REAL region attributes the runtime
		// already sets — data-obs-real-island / -live / -deferred, `wake`, and data-hydrated (the true
		// woke signal) — so islands stay interactive and wake on their real schedule. We only stamp the
		// per-island byte count (from the parent) + a +Xms since render when each region hydrates.
		let lensOn = false;
		let lensBytes: Record<string, number> = {};
		let renderT0 = 0;
		const apply_lens = () => {
			const el = app();
			el.classList.toggle('lens', lensOn);
			for (const r of el.querySelectorAll('ogygia-region[data-name]')) {
				// derive the kind from the real attributes the runtime set (colours + the ::before label)
				const kind = r.hasAttribute('data-obs-live')
					? 'live'
					: r.hasAttribute('data-obs-deferred')
						? 'server hole'
						: r.hasAttribute('data-obs-real-island')
							? 'island'
							: 'region';
				r.setAttribute('data-kind', kind);
				const b = lensBytes[r.getAttribute('data-name') || ''];
				if (b != null) r.setAttribute('data-bytes', String(b));
			}
		};
		// Stamp +Xms (since the render) the moment the runtime marks a region hydrated — the lens label.
		const woke_obs = new MutationObserver((muts) => {
			for (const m of muts) {
				const t = m.target as Element;
				if (t.matches?.('ogygia-region[data-hydrated]') && !t.hasAttribute('data-woke-ms'))
					t.setAttribute('data-woke-ms', String(Math.round(performance.now() - renderT0)));
			}
		});

		// deferred (server islands): serve /__obs_defer/* from a map the parent sends; pass the rest.
		if (!(window as Any).__OBS_FETCH_PATCHED__) {
			(window as Any).__OBS_FETCH_PATCHED__ = true;
			(window as Any).__OBS_DEFER__ = {};
			const orig = window.fetch.bind(window);
			window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
				const m = /\/__obs_defer\/([^/?#]+)/.exec(url);
				if (m) {
					const dhtml = ((window as Any).__OBS_DEFER__ || {})[m[1]];
					if (dhtml != null) return new Promise((res) => setTimeout(() => res(new Response(dhtml, { status: 200, headers: { 'content-type': 'text/html' } })), 260));
					return Promise.resolve(new Response('', { status: 404 }));
				}
				return orig(input, init);
			};
		}

		// THEME SYNC: track the shared `og-theme` (the docs ThemeToggle's key). Same-origin → the iframe
		// shares localStorage, so a host/docs theme change fires a `storage` event here → re-theme live.
		const apply_theme = () => {
			try {
				const t = localStorage.getItem('og-theme');
				const r = document.documentElement;
				if (t === 'light' || t === 'dark') r.setAttribute('data-theme', t);
				else r.removeAttribute('data-theme');
			} catch {
				/* private mode */
			}
		};
		const onStorage = (e: StorageEvent) => {
			if (e.key === 'og-theme' || e.key === null) apply_theme();
		};
		window.addEventListener('storage', onStorage);
		apply_theme();

		// relay this frame's runtime events to the parent (its Rung-0 bus panel), labelled by island.
		const unsub = add_sink((ev) => {
			const e = ev as { domain?: string; fp?: string };
			if (e.domain === 'runtime' && typeof e.fp === 'string' && e.fp.startsWith('obsfp_'))
				post({ obsType: 'event', ev, label: fpNames[e.fp] || e.fp });
		});

		const app = () => document.getElementById('obs-app')!;
		// a nav link inside the preview → ask the parent to render that page (it owns the worker).
		const onNavClick = (ev: Event) => {
			const link = (ev.target as Element | null)?.closest?.('[data-obs-nav]');
			if (!link) return;
			ev.preventDefault();
			post({ obsType: 'navReq', entry: link.getAttribute('data-obs-nav') || '' });
		};
		app().addEventListener('click', onNavClick);
		woke_obs.observe(app(), { attributes: true, attributeFilter: ['data-hydrated'], subtree: true });

		const unmount_kit = () => {
			if (mountedApp) {
				try {
					unmount(mountedApp);
				} catch {
					/* noop */
				}
				mountedApp = null;
			}
		};
		/** csr=TRUE: mount the WHOLE app as ONE hydration root (what Kit does) — no islands, everything
		 *  interactive from load. The counterpoint to islands, so the csr switch shows both realities. */
		function renderKit(modules: Record<string, string>, entry: string) {
			if (!svelteClient) return;
			unmount_kit();
			liveNodes.clear();
			const el = app();
			el.innerHTML = '';
			const cache = new Map<string, Linked>();
			const resolveName = (spec: string): string | null => {
				const bare = spec.replace(/^\.\//, '').replace(/^\//, '');
				if (modules[bare] != null) return bare;
				const base = spec.split('/').pop();
				return base && modules[base] != null ? base : null;
			};
			const require: Require = (spec) => {
				if (spec === 'svelte/internal/client') return svelteClient!;
				const name = resolveName(spec);
				if (name) {
					const hit = cache.get(name);
					if (hit) return hit;
					const ex: Linked = {};
					cache.set(name, ex);
					Object.assign(ex, eval_client(modules[name], require, svelteClient!));
					return ex;
				}
				return { default: () => {} };
			};
			const App = eval_client(modules[entry], require, svelteClient).default;
			if (typeof App === 'function') mountedApp = mount(App as Any, { target: el });
		}
		function render(html: string, modules: Record<string, string>, deferred: Record<string, string>) {
			if (!svelteClient) return;
			unmount_kit();
			(window as Any).__OBS_DEFER__ = deferred || {};
			liveNodes.clear();
			const el = app();
			el.innerHTML = '';
			const { container } = link_page_dom(html, modules, svelteClient);
			for (const r of container.querySelectorAll('ogygia-region[data-og-fp]')) {
				const fp = r.getAttribute('data-og-fp');
				if (fp) fpNames[fp] = r.getAttribute('data-name') || fp;
			}
			renderT0 = performance.now();
			while (container.firstChild) el.appendChild(container.firstChild);
			apply_lens();
			for (const node of el.querySelectorAll('ogygia-region[live][data-og-fp]')) {
				const fp = node.getAttribute('data-og-fp')!;
				liveNodes.set(fp, node as Element & { applyLive?: (d: unknown) => void });
				(node as Any).applyLive?.({ id: fp, module: '', props: {}, html: node.innerHTML, url: '/__obs_live/' + fp });
			}
		}
		function nav(html: string, modules: Record<string, string>, deferred: Record<string, string>) {
			if (!svelteClient || !reconcileMod.reconcile_body) return render(html, modules, deferred);
			(window as Any).__OBS_DEFER__ = { ...((window as Any).__OBS_DEFER__ || {}), ...(deferred || {}) };
			const { container } = link_page_dom(html, modules, svelteClient);
			for (const r of container.querySelectorAll('ogygia-region[data-og-fp]')) {
				const fp = r.getAttribute('data-og-fp');
				if (fp) fpNames[fp] = r.getAttribute('data-name') || fp;
			}
			const el = app();
			const liveNames = [...el.querySelectorAll('ogygia-region[data-name]')].map((r) => r.getAttribute('data-name') || '');
			const nextNames = [...container.querySelectorAll('ogygia-region[data-name]')].map((r) => r.getAttribute('data-name') || '');
			const keepNames = new Set([...el.querySelectorAll('ogygia-region[data-ogygia-keep]')].map((r) => r.getAttribute('data-name') || ''));
			renderT0 = performance.now();
			reconcileMod.reconcile_body(el, container, reconcileMod.morph_children);
			apply_lens(); // re-stamp bytes on the reconciled DOM (kept regions keep their +Xms)
			post({
				obsType: 'reconciled',
				kept: nextNames.filter((n) => liveNames.includes(n) && keepNames.has(n)),
				mounted: nextNames.filter((n) => !liveNames.includes(n)),
				removed: liveNames.filter((n) => !nextNames.includes(n))
			});
			liveNodes.clear();
			for (const node of el.querySelectorAll('ogygia-region[live][data-og-fp]')) {
				const fp = node.getAttribute('data-og-fp')!;
				liveNodes.set(fp, node as Element & { applyLive?: (d: unknown) => void });
			}
		}

		const onMsg = (e: MessageEvent) => {
			const d = e.data;
			if (!d || d.__obs !== true) return;
			if (d.obsType === 'render') {
				lensOn = !!d.xray;
				lensBytes = d.bytes || {};
				render(d.html, d.modules, d.deferred);
			} else if (d.obsType === 'renderKit') renderKit(d.modules, d.entry);
			else if (d.obsType === 'nav') {
				if (d.bytes) lensBytes = d.bytes;
				if ('xray' in d) lensOn = !!d.xray;
				nav(d.html, d.modules, d.deferred);
			} else if (d.obsType === 'lens') {
				// pure overlay toggle — no re-render, so the hydrated islands keep their state.
				lensOn = !!d.on;
				apply_lens();
			} else if (d.obsType === 'theme') apply_theme(); // parent set og-theme; re-read + apply
			else if (d.obsType === 'liveTick') {
				const node = liveNodes.get(d.fp);
				if (node && d.html) (node as Any).applyLive?.({ id: d.fp, module: '', props: {}, html: d.html, url: '/__obs_live/' + d.fp });
			}
		};
		window.addEventListener('message', onMsg);

		Promise.all([import('svelte/internal/client'), import('ogygia/internal/reconcile')])
			.then(([sc, om]) => {
				svelteClient = sc as Linked;
				reconcileMod = { reconcile_body: (om as Any).reconcile_body, morph_children: (om as Any).morph_children };
				post({ obsType: 'ready' }); // tell the parent to send the first render
			})
			.catch((err) => post({ obsType: 'error', message: String(err) }));

		return () => {
			window.removeEventListener('message', onMsg);
			window.removeEventListener('storage', onStorage);
			app().removeEventListener('click', onNavClick);
			woke_obs.disconnect();
			unsub();
		};
	});
</script>
