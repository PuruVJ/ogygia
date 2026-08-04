<script>
	import { stringify } from 'devalue';
	import runtimeUrl from 'virtual:sk-islands/runtime-url';
	import { base, assets } from '$app/paths';
	import { page } from '$app/state';

	/**
	 * @typedef {Object} Props
	 * @property {boolean|string} [visible] hydrate when scrolled into view (string = IntersectionObserver rootMargin)
	 * @property {boolean} [idle] hydrate on requestIdleCallback
	 * @property {string} [media] hydrate when the media query matches
	 * @property {boolean} [load] hydrate immediately (default)
	 * @property {string} __entry island id
	 * @property {any} __component the extracted island component
	 * @property {Record<string, any>} __props captured props
	 */

	/** @type {Props} */
	let { visible, idle, media, load, __entry, __component: Component, __props } = $props();

	const strategy = media ? 'media' : idle ? 'idle' : visible ? 'visible' : 'load';
	const rootMargin = typeof visible === 'string' ? visible : undefined;

	// Build tag strings without any literal angle brackets so Svelte's raw-text
	// <script> lexer never mistakes them for real tags.
	const LT = String.fromCharCode(60); // <
	const GT = String.fromCharCode(62); // >

	// devalue payload, escaped so a nested closing script tag in string data can't break out.
	const payload = stringify(__props).split(LT).join('\\u003C');
	const propsScript =
		LT + 'script type="application/sk-island-props" data-sk-props' + GT + payload + LT + '/script' + GT;

	// Per-island snapshot of `page` so the client `$app/state` shim can seed it.
	// `page.data` must be devalue-serializable; if not, we fall back to no data.
	function pageSnapshot() {
		const base = {
			url: page.url?.href,
			params: page.params,
			route: page.route,
			status: page.status
		};
		try {
			const full = { ...base, data: page.data, form: page.form ?? null, error: page.error ?? null };
			return stringify(full).split(LT).join('\\u003C');
		} catch {
			return stringify(base).split(LT).join('\\u003C');
		}
	}
	const pageScript =
		LT + 'script type="application/sk-island-page" data-sk-page' + GT + pageSnapshot() + LT + '/script' + GT;

	// runtime module: browsers dedupe identical module URLs, so one tag per island is fine.
	const src = (assets || base || '') + runtimeUrl;
	const runtimeScript =
		LT + 'script type="module" src="' + src + '"' + GT + LT + '/script' + GT;
</script>

<sk-island
	data-entry={__entry}
	data-strategy={strategy}
	data-media={media || undefined}
	data-root-margin={rootMargin || undefined}
><Component {...__props} /></sk-island>{@html propsScript}{@html pageScript}{@html runtimeScript}
