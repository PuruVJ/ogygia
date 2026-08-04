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
	import { resolve, asset } from '$app/paths';
	import { building } from '$app/environment';
	import { sign } from './server/hmac.js';
	import { b64urlEncode } from './server/payload.js';
	import { DEFAULT_ISLANDS_ENDPOINT } from './server/endpoint.js';
	import { isNested, setNested } from './context.js';

	/**
	 * @typedef {Object} Props
	 * @property {string} __entry island id (manifest key on the server)
	 * @property {import('svelte').Component<Record<string, unknown>>} [__component] island component — imported by the host purely so its CSS
	 *   lands in the page import graph; NOT rendered here (the endpoint renders it).
	 * @property {Record<string, unknown>} __props captured props (server-rendered with these)
	 * @property {import('svelte').Snippet} [fallback] rendered into the page immediately
	 */

	/** @type {Props} */
	let { __entry, __component: Component, __props, fallback } = $props();

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

	// HMAC-signed devalue payload. Base64url so it rides in the query string untouched.
	const payload = nested ? '' : b64urlEncode(stringify(__props));
	const sig = nested ? '' : sign(secret, payload);

	// base-prefixed endpoint PATH in DECODED (raw-emoji) form. The browser encodes it to
	// percent-encoded UTF-8 when the runtime fetches / preloads it — we never hand-roll that.
	const endpoint = nested
		? ''
		: `${resolve(DEFAULT_ISLANDS_ENDPOINT)}?id=${encodeURIComponent(__entry)}&props=${payload}&sig=${sig}`;

	// Build tag strings without literal angle brackets so Svelte's raw-text <script>/<link>
	// lexer never mistakes them for real tags.
	const LT = String.fromCharCode(60);
	const GT = String.fromCharCode(62);

	// <link rel="preload" as="fetch"> so the browser starts the endpoint fetch during HTML
	// parse, before the runtime module even loads. The runtime fetch reuses this response.
	// Skipped when prerendering: a static page has no request context, and emitting the hint
	// would make Kit's prerender crawler fetch the (dynamic) endpoint. `data-endpoint` still
	// drives the runtime fetch at request time — a prerendered server island just loses the hint.
	const href_attr = endpoint.split('&').join('&amp;');
	const preload_link =
		nested || building ? '' : LT + 'link rel="preload" as="fetch" href="' + href_attr + '"' + GT;

	// runtime module: browsers dedupe identical module URLs, so one tag per island is fine.
	// Match Island.svelte's URL exactly (asset()) so the module de-dupes across mixed pages.
	const src = asset(runtimeUrl);
	const runtime_script = LT + 'script type="module" src="' + src + '"' + GT + LT + '/script' + GT;
</script>

{#if nested}<Component {...__props} />{:else}<ogygia-region
		entry={__entry}
		defer
		endpoint={endpoint}
	>{#if fallback}{@render fallback()}{/if}</ogygia-region>{@html preload_link}{@html runtime_script}{/if}
