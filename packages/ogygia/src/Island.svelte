<script>
	import { untrack } from 'svelte';
	import { stringify } from 'devalue';
	import runtimeUrl from 'virtual:ogygia/runtime-url';
	import hmrUrl from 'virtual:ogygia/dev-hmr-url';
	import { asset } from '$app/paths';
	import { isNested, setNested, claimRuntimeEmit } from './context.js';

	/**
	 * Private wrapper the compile-time transform emits for a client island
	 * (`import … with { hydrate: … }`). Emits `<ogygia-region>` + props payload.
	 * Runtime script is emitted once per page (OgygiaRouter, or this island if no router).
	 *
	 * **Not part of the public API** — do not import from app code.
	 *
	 * @component
	 * @typedef {Object} Props
	 * @property {boolean|string} [visible] Hydrate when scrolled into view (string = IntersectionObserver rootMargin).
	 * @property {boolean} [idle] Hydrate on `requestIdleCallback`.
	 * @property {string} [media] Hydrate when this CSS media query matches.
	 * @property {boolean} [load] Hydrate immediately (default when no other strategy prop is set).
	 * @property {string} __entry Importable island module URL (dev Vite URL or `/_app/immutable/ogygia-island.<id>.js`).
	 * @property {import('svelte').Component<Record<string, unknown>>} [__component] Virtual island
	 *   module for SSR (and csr=true Kit hydration). Omitted on csr=false client hosts — runtime
	 *   loads via `import(__entry)`.
	 * @property {unknown} [__css] Entry `.svelte` imported only so its CSS joins Kit's FOUC bag (not rendered).
	 * @property {Record<string, unknown>} __props Captured host props (devalue-serialized into the page).
	 */

	/** @type {Props} */
	let { visible, idle, media, load, __entry, __component: Component, __css, __props } = $props();

	// Keep the entry import alive for FOUC without rendering it (virtual already owns the tree).
	void __css;

	// Nested island: this wrapper is already rendering inside another island's tree (SSR sets
	// the context; the runtime sets it on hydrate). Degrade to a plain inline component so the
	// island-within-an-island hydrates exactly once, with its parent. Strategy is ignored.
	const nested = isNested();
	if (!nested) setNested();
	if (nested && import.meta.env && import.meta.env.DEV) {
		// Intentional one-shot read of the entry id for the warn message.
		const entry = untrack(() => __entry);
		console.warn(
			`[ogygia] nested island "${entry}" is inside another island; it hydrates with its parent (strategy ignored).`
		);
	}

	// The `hydrate` attribute value IS the strategy: 'load' | 'idle' | 'visible' | a media query.
	const hydrate_attr = $derived(media ? media : idle ? 'idle' : visible ? 'visible' : 'load');
	const root_margin = $derived(typeof visible === 'string' ? visible : undefined);

	// Build tag strings without any literal angle brackets so Svelte's raw-text
	// <script> lexer never mistakes them for real tags.
	const LT = String.fromCharCode(60); // <
	const GT = String.fromCharCode(62); // >

	// Serialize captured props with devalue. On failure (a function, a class instance, a Promise,
	// … crossed the boundary) devalue throws with the offending PATH — rethrow a friendly error that
	// names the island + the non-serializable path and states the contract (functions can't cross;
	// only devalue-serializable values do). The path (e.g. `.onClick`) is the captured identifier.
	function stringify_props(value, entry) {
		try {
			return stringify(value);
		} catch (e) {
			const detail = e && e.message ? e.message : String(e);
			throw new Error(
				`[ogygia] island "${entry}": a captured prop is not serializable — ${detail}. ` +
					`Captured host values cross the boundary via devalue; functions/class instances/Promises cannot. ` +
					`Pass a serializable value, or move that logic inside the island component.`
			);
		}
	}

	// devalue payload, escaped so a nested closing script tag in string data can't break out.
	const payload = $derived(
		nested ? '' : stringify_props(__props, __entry).split(LT).join('\\u003C')
	);
	const props_script = $derived(
		LT + 'script type="application/ogygia-props" data-ogygia-props' + GT + payload + LT + '/script' + GT
	);

	// Page snapshot is document-level (`application/ogygia-page` from ogygiaHandle) — not per island.

	// Module URL on the custom element (Astro-style).
	// `asset()` is for Kit immutable paths (`/_app/…`) and `paths.base` — it rewrites `/@id/…`
	// to `./@id/…`, which `import()` then resolves against the *runtime module* URL and 404s.
	// Vite virtual URLs must stay root-absolute.
	const module_url = $derived(
		nested ? '' : __entry.startsWith('/@') ? __entry : asset(__entry)
	);

	// `hydrate: 'load'` — modulepreload in <head> (not beside the region) so discovery is early
	// and props stay the immediate sibling of the region. Idle/visible/media skip this.
	const preload_link = $derived(
		!nested && hydrate_attr === 'load'
			? LT + 'link rel="modulepreload" href="' + module_url + '"' + GT
			: ''
	);

	// Fallback only when <OgygiaRouter/> did not claim the slot (MPA page with islands alone).
	// Same `asset(runtimeUrl)` as the router so URLs dedupe if both paths ever race.
	const runtime_script =
		!nested && claimRuntimeEmit()
			? LT +
				'script type="module" data-ogygia-runtime src="' +
				asset(runtimeUrl) +
				'"' +
				GT +
				LT +
				'/script' +
				GT +
				(hmrUrl
					? LT +
						'script type="module" data-ogygia-dev-hmr src="' +
						asset(hmrUrl) +
						'"' +
						GT +
						LT +
						'/script' +
						GT
					: '')
			: '';
</script>

{#if nested}{#if Component}<Component {...__props} />{/if}{:else}<svelte:head>{@html runtime_script}{@html preload_link}</svelte:head><ogygia-region
		entry={module_url}
		hydrate={hydrate_attr}
		margin={root_margin || undefined}
	>{#if Component}<Component {...__props} />{/if}</ogygia-region>{@html props_script}{/if}
