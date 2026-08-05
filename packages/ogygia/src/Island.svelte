<script>
	import { untrack } from 'svelte';
	import { stringify } from 'devalue';
	import runtimeUrl from 'virtual:ogygia/runtime-url';
	import { asset } from '$app/paths';
	import { isNested, setNested } from './context.js';

	/**
	 * @typedef {Object} Props
	 * @property {boolean|string} [visible] hydrate when scrolled into view (string = IntersectionObserver root_margin)
	 * @property {boolean} [idle] hydrate on requestIdleCallback
	 * @property {string} [media] hydrate when the media query matches
	 * @property {boolean} [load] hydrate immediately (default)
	 * @property {string} __entry island id
	 * @property {import('svelte').Component<Record<string, unknown>>} __component the extracted island component
	 * @property {Record<string, unknown>} __props captured props
	 */

	/** @type {Props} */
	let { visible, idle, media, load, __entry, __component: Component, __props } = $props();

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

	// runtime module: browsers dedupe identical module URLs, so one tag per island is fine.
	const src = asset(runtimeUrl);
	const runtime_script =
		LT + 'script type="module" src="' + src + '"' + GT + LT + '/script' + GT;
</script>

{#if nested}<Component {...__props} />{:else}<ogygia-region
		entry={__entry}
		hydrate={hydrate_attr}
		margin={root_margin || undefined}
	><Component {...__props} /></ogygia-region>{@html props_script}{@html runtime_script}{/if}
