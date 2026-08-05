<script>
	// Private wrapper the compile-time transform emits for a SERVER island
	//   (import ... with { island: 'server' }).
	// Renders the `fallback` snippet into the page immediately; the island component
	// itself is NOT rendered here. Instead it emits a signed reference to the
	// `<base>/🏝️ogygia🏝️` endpoint (served by the `ogygiaHandle()` handle) which the runtime
	// fetches and swaps in. NOT part of the public API.
	import { stringify } from 'devalue';
	import runtimeUrl from 'virtual:ogygia/runtime-url';
	import { secret } from 'virtual:ogygia/secret';
	import { sessionCookie } from 'virtual:ogygia/session-cookie';
	import { sign, region_mac_message } from 'virtual:ogygia/sign';
	import { resolve, asset } from '$app/paths';
	import { building } from '$app/environment';
	import { getRequestEvent } from 'virtual:ogygia/request-event';
	import { B64Url } from './server/payload.js';
	import { DEFAULT_ISLANDS_ENDPOINT } from './server/endpoint.js';
	import { isNested, setNested } from './context.js';

	/**
	 * @typedef {Object} Props
	 * @property {string} __entry island id (manifest key on the server)
	 * @property {import('svelte').Component<Record<string, unknown>>} [__component] island component — imported by the host purely so its CSS
	 *   lands in the page import graph; NOT rendered here (the endpoint renders it).
	 * @property {Record<string, unknown>} __props captured props (server-rendered with these)
	 * @property {string} [__defer] fetch-timing of the hole: 'load' | 'idle' | 'visible' | media query
	 * @property {string} [__margin] IntersectionObserver rootMargin for `__defer: 'visible'`
	 * @property {import('svelte').Snippet} [fallback] rendered into the page immediately
	 */

	/** @type {Props} */
	let { __entry, __component: Component, __props, __defer = 'load', __margin, fallback } = $props();

	// Nested server island (inside another island): a server island can't render its fallback-
	// then-fetch dance inside a parent island's hydration. Degrade to a plain inline component
	// (render it directly, like a normal component) — 'server' strategy is ignored.
	const nested = isNested();
	if (!nested) setNested();
	if (nested && import.meta.env && import.meta.env.DEV) {
		console.warn(
			`[ogygia] nested server island "${__entry}" is inside another island; rendering it inline as a normal component ('server' strategy ignored).`
		);
	}

	/** Session sealed into the MAC when `ogygia({ bindSession })` is set; empty at prerender. */
	function region_session() {
		if (!sessionCookie || nested) return '';
		try {
			return getRequestEvent().cookies.get(sessionCookie) ?? '';
		} catch {
			return '';
		}
	}

	// HMAC-signed region capability: region id + expiry + props (+ optional session).
	// Expiry is always 24h — prerendered holes use the same window (no decade-long bearer URLs).
	const payload = nested ? '' : B64Url.encode(stringify(__props));
	const session = region_session();
	const exp = nested ? 0 : Math.floor(Date.now() / 1000) + 86400;
	const sig = nested ? '' : sign(secret, region_mac_message(__entry, exp, payload, session));

	// base-prefixed endpoint PATH in DECODED (raw-emoji) form. The browser encodes it to
	// percent-encoded UTF-8 when the runtime fetches / preloads it — we never hand-roll that.
	const endpoint = nested
		? ''
		: `${resolve(DEFAULT_ISLANDS_ENDPOINT)}?id=${encodeURIComponent(__entry)}&props=${payload}&exp=${exp}&sig=${sig}`;

	// Build tag strings without literal angle brackets so Svelte's raw-text <script>/<link>
	// lexer never mistakes them for real tags.
	const LT = String.fromCharCode(60);
	const GT = String.fromCharCode(62);

	// <link rel="preload" as="fetch"> so the browser starts the endpoint fetch during HTML
	// parse, before the runtime module even loads. The runtime fetch reuses this response.
	// Emitted ONLY for `__defer: 'load'` (immediate fetch): 'idle'/'visible'/media defer the fetch,
	// so preloading would defeat the deferral (the whole point is NOT to fetch until the schedule
	// fires). Skipped when prerendering: a static page has no request context, and emitting the hint
	// would make Kit's prerender crawler fetch the (dynamic) endpoint. `endpoint` still drives the
	// runtime fetch at request time — a prerendered / deferred server island just loses the hint.
	const href_attr = endpoint.split('&').join('&amp;');
	const preload_link =
		nested || building || __defer !== 'load'
			? ''
			: LT + 'link rel="preload" as="fetch" href="' + href_attr + '"' + GT;

	// runtime module: browsers dedupe identical module URLs, so one tag per island is fine.
	// Match Island.svelte's URL exactly (asset()) so the module de-dupes across mixed pages.
	const src = asset(runtimeUrl);
	const runtime_script = LT + 'script type="module" src="' + src + '"' + GT + LT + '/script' + GT;
</script>

<!--
	`defer` (bare) is the server-region MARKER; the runtime reads `defer-when` for the fetch timing.
	It must be a SEPARATE attribute because `defer` is an HTML boolean attribute — Svelte would render
	`defer="visible"` as a valueless `defer=""` and drop the timing. `defer-when` is not boolean, so it
	keeps its string value.
-->
{#if nested}<Component {...__props} />{:else}<ogygia-region
		entry={__entry}
		defer
		defer-when={__defer}
		margin={__margin || undefined}
		endpoint={endpoint}
	>{#if fallback}{@render fallback()}{/if}</ogygia-region>{@html preload_link}{@html runtime_script}{/if}
