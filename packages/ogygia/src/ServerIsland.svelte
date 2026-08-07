<script>
	// Private wrapper the compile-time transform emits for a deferred region
	//   (import ... with { defer: 'load' | 'idle' | 'visible' | media }).
	// Optional `__hydrate` + `__module` make a deferred *client* island: fetch HTML on the
	// defer schedule, then hydrate via `import(__module)` (coalesce matching schedules).
	// Renders the reserved `ogygiaFallback` snippet into the page immediately; the region
	// component itself is NOT rendered here. Instead it emits a signed reference to the
	// `<base>/🏝️ogygia🏝️` endpoint (served by the `ogygiaHandle()` handle) which the runtime
	// fetches and swaps in. NOT part of the public API.
	import { untrack } from 'svelte';
	import { stringify } from 'devalue';
	import runtimeUrl from 'virtual:ogygia/runtime-url';
	import { islandDeps } from 'virtual:ogygia/island-deps';
	import { secret } from 'virtual:ogygia/secret';
	import { sessionCookie } from 'virtual:ogygia/session-cookie';
	import { regionTtl } from 'virtual:ogygia/region-ttl';
	import { sign, region_mac_message } from 'virtual:ogygia/sign';
	import { resolve, asset } from '$app/paths';
	import { building } from '$app/environment';
	import { getRequestEvent } from 'virtual:ogygia/request-event';
	import { B64Url } from './server/payload.js';
	import { DEFAULT_ISLANDS_ENDPOINT, MAX_REGION_PROPS_LEN } from './server/endpoint.js';
	import { isNested, setNested, claimRuntimeEmit } from './context.js';

	/**
	 * @typedef {Object} Props
	 * @property {string} __entry opaque region id (HMAC + server manifest key)
	 * @property {import('svelte').Component<Record<string, unknown>>} [__component] virtual island
	 *   module (authored attrs baked in). Used when nested inside another island — degrade to
	 *   inline render. Top-level never renders it (endpoint resolves by id). Omitted on csr=false
	 *   client hosts (`linkVirtualIsland: false`).
	 * @property {unknown} [__css] entry `.svelte` import so CSS joins Kit's FOUC bag (not rendered)
	 * @property {Record<string, unknown>} __props captured props (server-rendered with these)
	 * @property {string} [__defer] fetch-timing of the hole: 'load' | 'idle' | 'visible' | media query
	 * @property {string} [__margin] IntersectionObserver rootMargin for `__defer: 'visible'`
	 * @property {string} [__hydrate] when set: wake JS after HTML swap ('load' | 'idle' | 'visible' | media)
	 * @property {string} [__hydrateMargin] rootMargin for `__hydrate: 'visible'` (phase 2)
	 * @property {string} [__module] importable client module URL when `__hydrate` is set
	 * @property {import('svelte').Snippet} [ogygiaFallback] reserved placeholder snippet — rendered into the page immediately
	 */

	/** @type {Props} */
	let {
		__entry,
		__component: Component,
		__css,
		__props,
		__defer = 'load',
		__margin,
		__hydrate,
		__hydrateMargin,
		__module,
		ogygiaFallback
	} = $props();

	// Keep the entry import alive for FOUC without rendering it (virtual owns nested markup).
	void __css;

	// Nested server island (inside another island): a server island can't render its fallback-
	// then-fetch dance inside a parent island's hydration. Degrade to a plain inline component
	// (render it directly, like a normal component) — 'server' strategy is ignored.
	const nested = isNested();
	if (!nested) setNested();
	if (nested && import.meta.env && import.meta.env.DEV) {
		const entry = untrack(() => __entry);
		console.warn(
			`[ogygia] nested server island "${entry}" is inside another island; rendering it inline as a normal component ('server' strategy ignored).`
		);
	}

	/** Session sealed into the MAC when `ogygia({ sessionCookie })` is set; empty at prerender. */
	function region_session() {
		if (!sessionCookie || nested) return '';
		try {
			return getRequestEvent().cookies.get(sessionCookie) ?? '';
		} catch {
			return '';
		}
	}

	// Build tag strings without literal angle brackets so Svelte's raw-text <script>/<link>
	// lexer never mistakes them for real tags.
	const LT = String.fromCharCode(60);
	const GT = String.fromCharCode(62);

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

	// HMAC-signed region capability: region id + expiry + props (+ optional session).
	// TTL from `ogygia({ regionTtl })` (default 1h) — prerendered holes use the same window.
	// Mint once per render via $derived so prop reads stay reactive-correct under Svelte 5.
	const endpoint = $derived.by(() => {
		if (nested) return '';
		const payload = B64Url.encode(stringify(__props));
		if (payload.length > MAX_REGION_PROPS_LEN) {
			throw new Error(
				`[ogygia] server island "${__entry}": props payload is ${payload.length} b64 chars (max ${MAX_REGION_PROPS_LEN}). ` +
					`Shrink what you pass into the deferred region — the handle would reject this capability anyway.`
			);
		}
		const session = region_session();
		const exp = Math.floor(Date.now() / 1000) + regionTtl;
		const sig = sign(secret, region_mac_message(__entry, exp, payload, session));
		// base-prefixed endpoint PATH in DECODED (raw-emoji) form. The browser encodes it to
		// percent-encoded UTF-8 when the runtime fetches / preloads it — we never hand-roll that.
		return `${resolve(DEFAULT_ISLANDS_ENDPOINT)}?id=${encodeURIComponent(__entry)}&props=${payload}&exp=${exp}&sig=${sig}`;
	});

	// DOM `entry`: importable module URL when hydrating after swap; opaque id for defer-only.
	const region_entry = $derived(
		nested ? '' : __module ? (__module.startsWith('/@') ? __module : asset(__module)) : __entry
	);

	// Props sibling for deferred client islands (same contract as Island.svelte).
	const payload = $derived(
		nested || !__hydrate
			? ''
			: stringify_props(__props, __entry).split(LT).join('\\u003C')
	);
	const props_script = $derived(
		payload
			? LT + 'script type="application/ogygia-props" data-ogygia-props' + GT + payload + LT + '/script' + GT
			: ''
	);

	// Phase-2 load (authored hydrate:load OR coalesce with defer) → modulepreload entry + deps.
	const wants_modulepreload = $derived(
		!!__module &&
			!!__hydrate &&
			(__hydrate === 'load' || __hydrate === __defer)
	);
	const modulepreload_link = $derived.by(() => {
		if (nested || !wants_modulepreload || !region_entry) return '';
		const hrefs = [region_entry];
		for (const dep of islandDeps(__module)) {
			const href = dep.startsWith('/@') ? dep : asset(dep);
			if (href && !hrefs.includes(href)) hrefs.push(href);
		}
		let html = '';
		for (const href of hrefs) {
			html += LT + 'link rel="modulepreload" href="' + href + '"' + GT;
		}
		return html;
	});

	// <link rel="preload" as="fetch" crossorigin="anonymous"> so the browser starts the
	// endpoint fetch during HTML parse. `anonymous` maps to credentials mode `same-origin`,
	// matching the runtime's `fetch(..., { credentials: 'same-origin' })`. (`use-credentials`
	// maps to `include` — Chrome then refuses to reuse the preload and warns.)
	// Emitted ONLY for `__defer: 'load'` (immediate fetch): 'idle'/'visible'/media defer the fetch,
	// so preloading would defeat the deferral. Skipped when prerendering (crawler would hit the
	// dynamic endpoint). Hoisted to <head> for earlier discovery — not after the region.
	const fetch_preload_link = $derived.by(() => {
		if (nested || building || __defer !== 'load' || !endpoint) return '';
		const href_attr = endpoint.split('&').join('&amp;');
		return (
			LT +
			'link rel="preload" as="fetch" crossorigin="anonymous" href="' +
			href_attr +
			'"' +
			GT
		);
	});

	const preload_link = $derived(fetch_preload_link + modulepreload_link);

	// Fallback when no <OgygiaRouter/> claimed the slot (server-island-only MPA page).
	const runtime_script =
		!nested && claimRuntimeEmit()
			? LT +
				'script type="module" data-ogygia-runtime src="' +
				asset(runtimeUrl) +
				'"' +
				GT +
				LT +
				'/script' +
				GT
			: '';
</script>

<!--
	Two-axis DOM (DESIGN.md): `hydrate` = when JS wakes; `render`/`when` = when HTML arrives.
	`render="defer"` avoids HTML's boolean `defer` attribute (which would drop string values).
	Deferred client islands set both axes; `hydrate-margin` is phase-2 visible margin.
-->
<!-- svelte:head must be top-level (not inside {#if}); nested leaves these strings empty. -->
<svelte:head>{@html runtime_script}{@html preload_link}</svelte:head>
{#if nested}{#if Component}<Component {...__props} />{/if}{:else}<ogygia-region
		entry={region_entry}
		render="defer"
		when={__defer}
		hydrate={__hydrate || undefined}
		margin={__margin || undefined}
		hydrate-margin={__hydrateMargin || undefined}
		endpoint={endpoint}
	>{#if ogygiaFallback}{@render ogygiaFallback()}{/if}</ogygia-region>{@html props_script}{/if}
