// SvelteKit server `handle` for server islands. Serves GET `<base>/🏝️ogygia🏝️?id=…&props=…&sig=…`
// by verifying the HMAC-signed props payload, rendering the island component server-side (with
// the real request context — cookies, remote functions, `await` all work), and returning the
// island HTML for the runtime to swap in.
//
//   // src/hooks.server.js
//   import { ogygiaHandle } from 'ogygia/hooks';
//   import { sequence } from '@sveltejs/kit/hooks';
//   export const handle = sequence(ogygiaHandle(), myOtherHandle);
//
// Composable with `sequence()` — it only intercepts the `/🏝️ogygia🏝️` path and otherwise calls
// `resolve(event)`.
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { Handle } from '@sveltejs/kit';
import * as devalue from 'devalue';
// Route MATCHING needs the ABSOLUTE base-prefixed path to compare against `event.url.pathname`.
// `resolve()` is deliberately RELATIVE on the server (for browser-resolved link generation), so
// it's the wrong tool here — server-side pathname matching legitimately uses `base` (the
// deprecation of `base` targets href generation, which is what ServerIsland/Island use resolve/
// asset for).
import { base } from '$app/paths';
import { islands as island_modules } from 'virtual:ogygia/server-manifest';
import { secret } from 'virtual:ogygia/secret';
import { verify } from './server/hmac.js';
import { b64urlDecode } from './server/payload.js';
import { DEFAULT_ISLANDS_ENDPOINT } from './server/endpoint.js';

/**
 * @param {Object} [options]
 * @param {string} [options.endpoint] path (relative to base) the handle serves; default is the
 *   clash-safe island-emoji route. Must start with `/`.
 * @returns {import('@sveltejs/kit').Handle}
 */
export function ogygiaHandle(options: { endpoint?: string } = {}): Handle {
	// absolute base-prefixed endpoint, DECODED form (raw emoji).
	const endpoint = (base || '') + (options.endpoint || DEFAULT_ISLANDS_ENDPOINT);

	return async ({ event, resolve }) => {
		// Compare against the DECODED request pathname so the percent-encoded UTF-8 the browser
		// sends matches our raw-emoji literal regardless of how Kit hands us the URL.
		if (decodeURIComponent(event.url.pathname) !== endpoint) return resolve(event);
		return await render_island(event.url);
	};
}

/**
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function render_island(url) {
	const id = url.searchParams.get('id');
	const payload = url.searchParams.get('props') ?? '';
	const sig = url.searchParams.get('sig') ?? '';

	const load = id ? island_modules[id] : undefined;
	if (!load) {
		return new Response('Unknown island', { status: 404 });
	}
	// Reject tampered/forged payloads BEFORE decoding or rendering.
	if (!verify(secret, payload, sig)) {
		return new Response('Invalid island signature', { status: 403 });
	}

	let props;
	try {
		props = devalue.parse(b64urlDecode(payload));
	} catch {
		return new Response('Invalid island payload', { status: 400 });
	}

	let body;
	try {
		const mod = await load();
		// `render()` is thenable; awaiting settles any `await`/remote work in the component.
		const out = await render(mod.default as Component<Record<string, unknown>>, { props });
		body = out.body;
	} catch (err) {
		return new Response('Island render failed', { status: 500 });
	}

	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			// `private` keeps shared/CDN caches out (responses are cookie-personalized) while
			// letting THIS browser reuse the `<link rel="preload">` response for the runtime
			// fetch (a short max-age is enough; the runtime fetches each island once).
			'cache-control': 'private, max-age=30'
		}
	});
}
