<script>
	import { stringify } from 'devalue';
	import runtimeUrl from 'virtual:ogygia/runtime-url';
	import { base, assets } from '$app/paths';
	import { page } from '$app/state';
	import { isNested, setNested } from './context.js';

	/**
	 * @typedef {Object} Props
	 * @property {boolean|string} [visible] hydrate when scrolled into view (string = IntersectionObserver root_margin)
	 * @property {boolean} [idle] hydrate on requestIdleCallback
	 * @property {string} [media] hydrate when the media query matches
	 * @property {boolean} [load] hydrate immediately (default)
	 * @property {string} __entry island id
	 * @property {any} __component the extracted island component
	 * @property {Record<string, any>} __props captured props
	 */

	/** @type {Props} */
	let { visible, idle, media, load, __entry, __component: Component, __props } = $props();

	// Nested island: this wrapper is already rendering inside another island's tree (SSR sets
	// the context; the runtime sets it on hydrate). Degrade to a plain inline component so the
	// island-within-an-island hydrates exactly once, with its parent. Strategy is ignored.
	const nested = isNested();
	if (!nested) setNested();
	if (nested && import.meta.env && import.meta.env.DEV) {
		console.warn(
			`[ogygia] nested island "${__entry}" is inside another island; it hydrates with its parent (strategy ignored).`
		);
	}

	// The `hydrate` attribute value IS the strategy: 'load' | 'idle' | 'visible' | a media query.
	const hydrate_attr = media ? media : idle ? 'idle' : visible ? 'visible' : 'load';
	const root_margin = typeof visible === 'string' ? visible : undefined;

	// Build tag strings without any literal angle brackets so Svelte's raw-text
	// <script> lexer never mistakes them for real tags.
	const LT = String.fromCharCode(60); // <
	const GT = String.fromCharCode(62); // >

	// devalue payload, escaped so a nested closing script tag in string data can't break out.
	const payload = nested ? '' : stringify(__props).split(LT).join('\\u003C');
	const props_script =
		LT + 'script type="application/sk-island-props" data-sk-props' + GT + payload + LT + '/script' + GT;

	// Per-island snapshot of `page` so the client `$app/state` shim can seed it.
	// `page.data` must be devalue-serializable; if not, we fall back to no data.
	function page_snapshot() {
		const b = {
			url: page.url?.href,
			params: page.params,
			route: page.route,
			status: page.status
		};
		try {
			const full = { ...b, data: page.data, form: page.form ?? null, error: page.error ?? null };
			return stringify(full).split(LT).join('\\u003C');
		} catch {
			return stringify(b).split(LT).join('\\u003C');
		}
	}
	const page_script = nested
		? ''
		: LT + 'script type="application/sk-island-page" data-sk-page' + GT + page_snapshot() + LT + '/script' + GT;

	// runtime module: browsers dedupe identical module URLs, so one tag per island is fine.
	const src = (assets || base || '') + runtimeUrl;
	const runtime_script =
		LT + 'script type="module" src="' + src + '"' + GT + LT + '/script' + GT;
</script>

{#if nested}<Component {...__props} />{:else}<ogygia-region
		entry={__entry}
		hydrate={hydrate_attr}
		margin={root_margin || undefined}
	><Component {...__props} /></ogygia-region>{@html props_script}{@html page_script}{@html runtime_script}{/if}
